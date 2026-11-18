-- Temporarily restore password-only sign-in while retaining the historical
-- OTP schema for a later re-enable. This removes the restrictive OTP gate
-- installed by 20261128_login_email_otp.sql.
CREATE OR REPLACE FUNCTION public.schoolguard_login_otp_verified()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT true
$$;
REVOKE ALL ON FUNCTION public.schoolguard_login_otp_verified() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.schoolguard_login_otp_verified() TO authenticated;

DO $$
DECLARE t record;
BEGIN
  FOR t IN SELECT n.nspname, c.relname
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind IN ('r','p')
      AND c.relname NOT IN ('login_otp_challenges','login_otp_verified_sessions','login_otp_rate_limits')
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS schoolguard_otp_session_required ON %I.%I',t.nspname,t.relname);
  END LOOP;
END $$;

DROP POLICY IF EXISTS schoolguard_otp_session_required ON storage.objects;
