-- Separate SMTP password-reset OTPs from login OTP sessions so reset verification
-- cannot accidentally create or grant a logged-in session.
CREATE TABLE IF NOT EXISTS public.password_reset_otp_challenges (
  id uuid PRIMARY KEY,
  auth_user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  email text NOT NULL,
  otp_hmac text NOT NULL,
  expires_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  code_consumed_at timestamptz,
  verified_at timestamptz,
  reset_token_hmac text,
  reset_expires_at timestamptz,
  grant_consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS password_reset_otp_email_created_idx ON public.password_reset_otp_challenges(email, created_at DESC);
ALTER TABLE public.password_reset_otp_challenges ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.password_reset_otp_challenges FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.password_reset_otp_challenges TO service_role;

CREATE OR REPLACE FUNCTION public.verify_password_reset_otp(
  p_challenge_id uuid, p_candidate_hmac text, p_reset_token_hmac text, p_reset_expires_at timestamptz
) RETURNS TABLE(result text, auth_user_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v public.password_reset_otp_challenges%ROWTYPE;
BEGIN
  SELECT * INTO v FROM public.password_reset_otp_challenges WHERE id = p_challenge_id FOR UPDATE;
  IF NOT FOUND OR v.code_consumed_at IS NOT NULL THEN RETURN QUERY SELECT 'invalid'::text, NULL::uuid; RETURN; END IF;
  IF v.expires_at <= now() THEN RETURN QUERY SELECT 'expired'::text, NULL::uuid; RETURN; END IF;
  IF v.attempts >= 5 THEN RETURN QUERY SELECT 'locked'::text, NULL::uuid; RETURN; END IF;
  IF v.otp_hmac IS DISTINCT FROM p_candidate_hmac THEN
    UPDATE public.password_reset_otp_challenges SET attempts = attempts + 1 WHERE id = p_challenge_id;
    RETURN QUERY SELECT CASE WHEN v.attempts + 1 >= 5 THEN 'locked' ELSE 'incorrect' END::text, NULL::uuid;
    RETURN;
  END IF;
  UPDATE public.password_reset_otp_challenges
    SET code_consumed_at = now(), verified_at = now(), reset_token_hmac = p_reset_token_hmac, reset_expires_at = p_reset_expires_at
    WHERE id = p_challenge_id;
  RETURN QUERY SELECT 'verified'::text, v.auth_user_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.consume_password_reset_grant(p_reset_token_hmac text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v public.password_reset_otp_challenges%ROWTYPE;
BEGIN
  SELECT * INTO v FROM public.password_reset_otp_challenges
    WHERE reset_token_hmac = p_reset_token_hmac AND verified_at IS NOT NULL
      AND reset_expires_at > now() AND grant_consumed_at IS NULL
    ORDER BY verified_at DESC LIMIT 1 FOR UPDATE;
  IF NOT FOUND OR v.auth_user_id IS NULL THEN RETURN NULL; END IF;
  UPDATE public.password_reset_otp_challenges SET grant_consumed_at = now(), reset_token_hmac = NULL WHERE id = v.id;
  RETURN v.auth_user_id;
END;
$$;

REVOKE ALL ON FUNCTION public.verify_password_reset_otp(uuid,text,text,timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.consume_password_reset_grant(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.verify_password_reset_otp(uuid,text,text,timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.consume_password_reset_grant(text) TO service_role;
