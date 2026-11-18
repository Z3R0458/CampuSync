-- Validate OTP sessions from the server-side session registry. A Custom Access
-- Token Hook may still add the claim for offline use, but online access does
-- not depend on that optional project-level Auth setting.
CREATE OR REPLACE FUNCTION public.schoolguard_login_otp_verified()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.login_otp_verified_sessions AS s
    WHERE s.session_id = NULLIF(auth.jwt()->>'session_id', '')::uuid
      AND s.auth_user_id = auth.uid()
      AND s.revoked_at IS NULL
      AND s.expires_at > now()
  )
$$;

REVOKE ALL ON FUNCTION public.schoolguard_login_otp_verified() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.schoolguard_login_otp_verified() TO authenticated;
