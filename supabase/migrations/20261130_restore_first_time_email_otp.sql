-- Restore per-login email OTP while allowing previously unconfirmed accounts
-- to complete a first-time verification after proving their password.
ALTER TABLE public.login_otp_challenges
  ADD COLUMN IF NOT EXISTS verification_kind text NOT NULL DEFAULT 'LOGIN';
ALTER TABLE public.login_otp_challenges DROP CONSTRAINT IF EXISTS login_otp_challenges_verification_kind_check;
ALTER TABLE public.login_otp_challenges ADD CONSTRAINT login_otp_challenges_verification_kind_check
  CHECK (verification_kind IN ('FIRST_TIME','LOGIN'));

CREATE TABLE IF NOT EXISTS public.school_email_verifications (
  auth_user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  verified_at timestamptz NOT NULL,
  verification_method text NOT NULL DEFAULT 'email_otp',
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.school_email_verifications ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.school_email_verifications FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.school_email_verifications TO service_role;

CREATE TABLE IF NOT EXISTS public.login_auth_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  event_type text NOT NULL CHECK (event_type IN (
    'login_attempt','password_validated','first_time_verification_started','otp_sent',
    'otp_verification_success','otp_verification_failure','otp_expiration','otp_resend',
    'rate_limit_triggered','successful_login','failed_login','account_access_denied','otp_delivery_failed'
  )),
  email_hmac text,
  ip_hmac text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS login_auth_events_created_at_idx ON public.login_auth_events(created_at DESC);
CREATE INDEX IF NOT EXISTS login_auth_events_user_created_idx ON public.login_auth_events(auth_user_id,created_at DESC);
ALTER TABLE public.login_auth_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.login_auth_events FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.login_auth_events TO service_role;

CREATE OR REPLACE FUNCTION public.schoolguard_login_otp_verified()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT COALESCE((auth.jwt()->>'schoolguard_otp_verified')::boolean, false)
    AND EXISTS (
      SELECT 1 FROM public.login_otp_verified_sessions s
      WHERE s.session_id = NULLIF(auth.jwt()->>'session_id','')::uuid
        AND s.auth_user_id = auth.uid() AND s.revoked_at IS NULL AND s.expires_at > now()
    )
$$;
REVOKE ALL ON FUNCTION public.schoolguard_login_otp_verified() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.schoolguard_login_otp_verified() TO authenticated;

CREATE OR REPLACE FUNCTION public.current_profile_id()
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT p.id FROM public.profiles p WHERE p.auth_user_id=(SELECT auth.uid()) AND p.is_active
    AND public.schoolguard_login_otp_verified()
$$;
CREATE OR REPLACE FUNCTION public.has_school_role(required_role text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT public.schoolguard_login_otp_verified() AND EXISTS (
    SELECT 1 FROM public.profiles p WHERE p.auth_user_id=(SELECT auth.uid()) AND p.is_active AND p.role=required_role
  )
$$;

CREATE OR REPLACE FUNCTION public.parent_email_is_verified()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM public.school_email_verifications v WHERE v.auth_user_id=auth.uid())
$$;

DO $$
DECLARE t record;
BEGIN
  FOR t IN SELECT n.nspname, c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind IN ('r','p')
      AND c.relname NOT IN ('login_otp_challenges','login_otp_verified_sessions','login_otp_rate_limits','school_email_verifications')
  LOOP
    EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY',t.nspname,t.relname);
    EXECUTE format('DROP POLICY IF EXISTS schoolguard_otp_session_required ON %I.%I',t.nspname,t.relname);
    EXECUTE format('CREATE POLICY schoolguard_otp_session_required ON %I.%I AS RESTRICTIVE FOR ALL TO authenticated USING (public.schoolguard_login_otp_verified()) WITH CHECK (public.schoolguard_login_otp_verified())',t.nspname,t.relname);
  END LOOP;
END $$;
DROP POLICY IF EXISTS schoolguard_otp_session_required ON storage.objects;
CREATE POLICY schoolguard_otp_session_required ON storage.objects AS RESTRICTIVE FOR ALL TO authenticated
  USING(public.schoolguard_login_otp_verified()) WITH CHECK(public.schoolguard_login_otp_verified());

DROP FUNCTION IF EXISTS public.login_otp_verify_challenge(uuid,text);
CREATE FUNCTION public.login_otp_verify_challenge(p_challenge_id uuid,p_candidate_hmac text)
RETURNS TABLE(result text,auth_user_id uuid,session_id uuid,encrypted_session text,email text,verification_kind text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v public.login_otp_challenges%ROWTYPE; i integer; diff integer:=0; a bytea; b bytea;
BEGIN
  SELECT * INTO v FROM public.login_otp_challenges WHERE id=p_challenge_id FOR UPDATE;
  IF NOT FOUND OR v.consumed_at IS NOT NULL THEN
    RETURN QUERY SELECT 'invalid',NULL::uuid,NULL::uuid,NULL::text,NULL::text,NULL::text; RETURN;
  END IF;
  IF v.expires_at<=now() THEN
    UPDATE public.login_otp_challenges SET encrypted_session='' WHERE id=p_challenge_id;
    RETURN QUERY SELECT 'expired',NULL::uuid,NULL::uuid,NULL::text,NULL::text,NULL::text; RETURN;
  END IF;
  IF v.attempts>=5 THEN RETURN QUERY SELECT 'locked',NULL::uuid,NULL::uuid,NULL::text,NULL::text,NULL::text; RETURN; END IF;
  BEGIN a:=decode(v.otp_hmac,'hex'); b:=decode(p_candidate_hmac,'hex');
  EXCEPTION WHEN OTHERS THEN a:=decode(repeat('00',32),'hex'); b:=decode(repeat('ff',32),'hex'); END;
  IF octet_length(a)=32 AND octet_length(b)=32 THEN
    FOR i IN 0..31 LOOP diff:=diff | (get_byte(a,i) # get_byte(b,i)); END LOOP;
  ELSE diff:=1;
  END IF;
  IF diff<>0 THEN
    UPDATE public.login_otp_challenges SET attempts=attempts+1,
      consumed_at=CASE WHEN attempts+1>=5 THEN now() ELSE consumed_at END,
      encrypted_session=CASE WHEN attempts+1>=5 THEN '' ELSE encrypted_session END WHERE id=p_challenge_id;
    RETURN QUERY SELECT CASE WHEN v.attempts+1>=5 THEN 'locked' ELSE 'incorrect' END,NULL::uuid,NULL::uuid,NULL::text,NULL::text,NULL::text; RETURN;
  END IF;
  UPDATE public.login_otp_challenges SET consumed_at=now(),encrypted_session='' WHERE id=p_challenge_id;
  INSERT INTO public.login_otp_verified_sessions(session_id,auth_user_id,expires_at)
    VALUES(v.session_id,v.auth_user_id,now()+interval '30 days')
    ON CONFLICT(session_id) DO UPDATE SET auth_user_id=EXCLUDED.auth_user_id,verified_at=now(),expires_at=EXCLUDED.expires_at,revoked_at=NULL;
  RETURN QUERY SELECT 'verified',v.auth_user_id,v.session_id,v.encrypted_session,v.email,v.verification_kind;
END;
$$;

DROP FUNCTION IF EXISTS public.login_otp_resend_challenge(uuid,text,timestamptz,timestamptz);
CREATE FUNCTION public.login_otp_resend_challenge(p_challenge_id uuid,p_new_hmac text,p_expires_at timestamptz,p_resend_after timestamptz)
RETURNS TABLE(email text,expires_at timestamptz,resend_after timestamptz,verification_kind text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v public.login_otp_challenges%ROWTYPE;
BEGIN
  SELECT * INTO v FROM public.login_otp_challenges WHERE id=p_challenge_id FOR UPDATE;
  IF NOT FOUND OR v.consumed_at IS NOT NULL OR v.expires_at<=now() OR v.resend_after>now() THEN RETURN; END IF;
  UPDATE public.login_otp_challenges SET otp_hmac=p_new_hmac,attempts=0,expires_at=p_expires_at,resend_after=p_resend_after
    WHERE id=p_challenge_id;
  RETURN QUERY SELECT v.email,p_expires_at,p_resend_after,v.verification_kind;
END;
$$;
REVOKE ALL ON FUNCTION public.login_otp_verify_challenge(uuid,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.login_otp_resend_challenge(uuid,text,timestamptz,timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.login_otp_verify_challenge(uuid,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.login_otp_resend_challenge(uuid,text,timestamptz,timestamptz) TO service_role;
