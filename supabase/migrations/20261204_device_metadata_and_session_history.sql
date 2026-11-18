-- Add browser-reported details and explicit session-end reasons without
-- replacing the existing per-session device/login tables.
ALTER TABLE public.user_devices
  ADD COLUMN IF NOT EXISTS operating_system_version text,
  ADD COLUMN IF NOT EXISTS device_model text,
  ADD COLUMN IF NOT EXISTS screen_category text NOT NULL DEFAULT 'Unknown';

ALTER TABLE public.login_activity
  ADD COLUMN IF NOT EXISTS logout_reason text;

ALTER TABLE public.login_activity DROP CONSTRAINT IF EXISTS login_activity_login_status_check;
ALTER TABLE public.login_activity ADD CONSTRAINT login_activity_login_status_check
  CHECK (login_status IN ('SUCCESS','SIGNED_OUT','REVOKED','EXPIRED','UNKNOWN'));

CREATE OR REPLACE FUNCTION public.revoke_login_session(p_session_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_current uuid:=NULLIF(auth.jwt()->>'session_id','')::uuid; v_count integer;
BEGIN
  IF auth.uid() IS NULL OR p_session_id IS NULL OR p_session_id=v_current THEN RETURN false; END IF;
  UPDATE public.login_otp_verified_sessions SET revoked_at=now()
    WHERE session_id=p_session_id AND auth_user_id=auth.uid() AND revoked_at IS NULL;
  GET DIAGNOSTICS v_count=ROW_COUNT;
  IF v_count>0 THEN UPDATE public.login_activity SET login_status='REVOKED',logout_reason='revoked_by_user'
    WHERE session_id=p_session_id AND auth_user_id=auth.uid() AND login_status='SUCCESS'; END IF;
  RETURN v_count>0;
END;
$$;
REVOKE ALL ON FUNCTION public.revoke_login_session(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.revoke_login_session(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.revoke_other_login_sessions()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_current uuid:=NULLIF(auth.jwt()->>'session_id','')::uuid; v_count integer;
BEGIN
  IF auth.uid() IS NULL OR v_current IS NULL THEN RETURN 0; END IF;
  UPDATE public.login_otp_verified_sessions SET revoked_at=now()
    WHERE auth_user_id=auth.uid() AND session_id<>v_current AND revoked_at IS NULL AND expires_at>now();
  GET DIAGNOSTICS v_count=ROW_COUNT;
  UPDATE public.login_activity SET login_status='REVOKED',logout_reason='revoked_by_user'
    WHERE auth_user_id=auth.uid() AND session_id<>v_current AND login_status='SUCCESS';
  RETURN v_count;
END;
$$;
REVOKE ALL ON FUNCTION public.revoke_other_login_sessions() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.revoke_other_login_sessions() TO authenticated;

CREATE OR REPLACE FUNCTION public.revoke_my_login_otp_session()
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_session uuid:=NULLIF(auth.jwt()->>'session_id','')::uuid;
BEGIN
  UPDATE public.login_otp_verified_sessions SET revoked_at=now()
    WHERE session_id=v_session AND auth_user_id=auth.uid() AND revoked_at IS NULL;
  UPDATE public.login_activity SET login_status='SIGNED_OUT',logout_at=now(),logout_reason='explicit_logout'
    WHERE session_id=v_session AND auth_user_id=auth.uid() AND login_status='SUCCESS';
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.revoke_my_login_otp_session() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.revoke_my_login_otp_session() TO authenticated;

CREATE OR REPLACE FUNCTION public.touch_my_login_activity()
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_session uuid:=NULLIF(auth.jwt()->>'session_id','')::uuid; v_touched integer;
BEGIN
  UPDATE public.login_activity SET last_activity_at=now()
    WHERE session_id=v_session AND auth_user_id=auth.uid() AND login_status='SUCCESS'
      AND EXISTS (SELECT 1 FROM public.login_otp_verified_sessions s WHERE s.session_id=v_session AND s.auth_user_id=auth.uid() AND s.revoked_at IS NULL AND s.expires_at>now());
  GET DIAGNOSTICS v_touched=ROW_COUNT;
  UPDATE public.login_activity la SET login_status='EXPIRED',logout_reason='session_expired'
    FROM public.login_otp_verified_sessions s
    WHERE la.session_id=s.session_id AND la.auth_user_id=auth.uid() AND la.login_status='SUCCESS' AND s.expires_at<=now();
  RETURN v_touched>0;
END;
$$;
REVOKE ALL ON FUNCTION public.touch_my_login_activity() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.touch_my_login_activity() TO authenticated;

NOTIFY pgrst, 'reload schema';
