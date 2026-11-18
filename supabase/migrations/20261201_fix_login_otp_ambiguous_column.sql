-- Fix PostgreSQL 42702 (ambiguous column) in the OTP verification RPC.
-- The output parameter `session_id` collided with ON CONFLICT(session_id).
DROP FUNCTION IF EXISTS public.login_otp_verify_challenge(uuid, text);

CREATE FUNCTION public.login_otp_verify_challenge(p_challenge_id uuid, p_candidate_hmac text)
RETURNS TABLE(
  result text,
  auth_user_id uuid,
  session_id uuid,
  encrypted_session text,
  email text,
  verification_kind text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v public.login_otp_challenges%ROWTYPE;
  i integer;
  diff integer := 0;
  expected_hash bytea;
  candidate_hash bytea;
BEGIN
  SELECT c.* INTO v
  FROM public.login_otp_challenges AS c
  WHERE c.id = p_challenge_id
  FOR UPDATE;

  IF NOT FOUND OR v.consumed_at IS NOT NULL THEN
    RETURN QUERY SELECT 'invalid'::text, NULL::uuid, NULL::uuid, NULL::text, NULL::text, NULL::text;
    RETURN;
  END IF;

  IF v.expires_at <= now() THEN
    UPDATE public.login_otp_challenges AS c
      SET encrypted_session = ''
      WHERE c.id = p_challenge_id;
    RETURN QUERY SELECT 'expired'::text, NULL::uuid, NULL::uuid, NULL::text, NULL::text, NULL::text;
    RETURN;
  END IF;

  IF v.attempts >= 5 THEN
    RETURN QUERY SELECT 'locked'::text, NULL::uuid, NULL::uuid, NULL::text, NULL::text, NULL::text;
    RETURN;
  END IF;

  BEGIN
    expected_hash := decode(v.otp_hmac, 'hex');
    candidate_hash := decode(p_candidate_hmac, 'hex');
  EXCEPTION WHEN OTHERS THEN
    expected_hash := decode(repeat('00', 32), 'hex');
    candidate_hash := decode(repeat('ff', 32), 'hex');
  END;

  IF octet_length(expected_hash) = 32 AND octet_length(candidate_hash) = 32 THEN
    FOR i IN 0..31 LOOP
      diff := diff | (get_byte(expected_hash, i) # get_byte(candidate_hash, i));
    END LOOP;
  ELSE
    diff := 1;
  END IF;

  IF diff <> 0 THEN
    UPDATE public.login_otp_challenges AS c
      SET attempts = c.attempts + 1,
          consumed_at = CASE WHEN c.attempts + 1 >= 5 THEN now() ELSE c.consumed_at END,
          encrypted_session = CASE WHEN c.attempts + 1 >= 5 THEN '' ELSE c.encrypted_session END
      WHERE c.id = p_challenge_id;
    RETURN QUERY SELECT CASE WHEN v.attempts + 1 >= 5 THEN 'locked' ELSE 'incorrect' END,
      NULL::uuid, NULL::uuid, NULL::text, NULL::text, NULL::text;
    RETURN;
  END IF;

  UPDATE public.login_otp_challenges AS c
    SET consumed_at = now(), encrypted_session = ''
    WHERE c.id = p_challenge_id;

  INSERT INTO public.login_otp_verified_sessions AS verified_session (session_id, auth_user_id, expires_at)
    VALUES (v.session_id, v.auth_user_id, now() + interval '30 days')
    ON CONFLICT ON CONSTRAINT login_otp_verified_sessions_pkey
    DO UPDATE SET auth_user_id = EXCLUDED.auth_user_id,
                  verified_at = now(),
                  expires_at = EXCLUDED.expires_at,
                  revoked_at = NULL;

  RETURN QUERY SELECT 'verified'::text, v.auth_user_id, v.session_id,
    v.encrypted_session, v.email, v.verification_kind;
END;
$$;

REVOKE ALL ON FUNCTION public.login_otp_verify_challenge(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.login_otp_verify_challenge(uuid, text) TO service_role;
