-- One-time account email verification, recognized-device history, and
-- server-side session activity/revocation for all CampuSync roles.

CREATE TABLE IF NOT EXISTS public.user_devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  profile_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  device_identifier text NOT NULL CHECK (length(device_identifier) BETWEEN 8 AND 80),
  device_name text NOT NULL,
  device_type text NOT NULL CHECK (device_type IN ('Desktop','Laptop','Tablet','Mobile','Unknown')),
  operating_system text NOT NULL DEFAULT 'Unknown',
  browser text NOT NULL DEFAULT 'Unknown',
  browser_version text,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  is_recognized boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (auth_user_id, device_identifier)
);
CREATE INDEX IF NOT EXISTS user_devices_profile_last_seen_idx ON public.user_devices(profile_id,last_seen_at DESC);
ALTER TABLE public.user_devices ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.user_devices FROM PUBLIC, anon;
GRANT ALL ON public.user_devices TO service_role;
GRANT SELECT, UPDATE (is_recognized) ON public.user_devices TO authenticated;
DROP POLICY IF EXISTS user_devices_read_own_or_admin ON public.user_devices;
CREATE POLICY user_devices_read_own_or_admin ON public.user_devices FOR SELECT TO authenticated
  USING (auth_user_id=(SELECT auth.uid()) OR public.has_school_role('administrator'));
DROP POLICY IF EXISTS user_devices_update_own ON public.user_devices;
CREATE POLICY user_devices_update_own ON public.user_devices FOR UPDATE TO authenticated
  USING (auth_user_id=(SELECT auth.uid())) WITH CHECK (auth_user_id=(SELECT auth.uid()));

CREATE TABLE IF NOT EXISTS public.login_activity (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  profile_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  device_id uuid REFERENCES public.user_devices(id) ON DELETE SET NULL,
  session_id uuid NOT NULL UNIQUE REFERENCES public.login_otp_verified_sessions(session_id) ON DELETE CASCADE,
  ip_address inet,
  approximate_location text,
  login_at timestamptz NOT NULL DEFAULT now(),
  logout_at timestamptz,
  last_activity_at timestamptz NOT NULL DEFAULT now(),
  login_status text NOT NULL DEFAULT 'SUCCESS' CHECK (login_status IN ('SUCCESS','SIGNED_OUT','REVOKED')),
  is_new_device boolean NOT NULL DEFAULT false,
  email_delivery_status text CHECK (email_delivery_status IN ('PENDING','SENT','FAILED')),
  email_delivery_attempts integer NOT NULL DEFAULT 0,
  email_last_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS login_activity_profile_login_idx ON public.login_activity(profile_id,login_at DESC);
CREATE INDEX IF NOT EXISTS login_activity_auth_login_idx ON public.login_activity(auth_user_id,login_at DESC);
CREATE INDEX IF NOT EXISTS login_activity_status_idx ON public.login_activity(login_status,login_at DESC);
ALTER TABLE public.login_activity ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.login_activity FROM PUBLIC, anon;
GRANT ALL ON public.login_activity TO service_role;
GRANT SELECT ON public.login_activity TO authenticated;
DROP POLICY IF EXISTS login_activity_read_own_or_admin ON public.login_activity;
CREATE POLICY login_activity_read_own_or_admin ON public.login_activity FOR SELECT TO authenticated
  USING (auth_user_id=(SELECT auth.uid()) OR public.has_school_role('administrator'));

DROP POLICY IF EXISTS login_auth_events_admin_read ON public.login_auth_events;
GRANT SELECT ON public.login_auth_events TO authenticated;
DROP POLICY IF EXISTS login_auth_events_admin_read ON public.login_auth_events;
CREATE POLICY login_auth_events_admin_read ON public.login_auth_events FOR SELECT TO authenticated
  USING (public.has_school_role('administrator'));

DROP POLICY IF EXISTS login_verified_sessions_read_own_or_admin ON public.login_otp_verified_sessions;
GRANT SELECT ON public.login_otp_verified_sessions TO authenticated;
DROP POLICY IF EXISTS login_verified_sessions_read_own_or_admin ON public.login_otp_verified_sessions;
CREATE POLICY login_verified_sessions_read_own_or_admin ON public.login_otp_verified_sessions FOR SELECT TO authenticated
  USING (auth_user_id=(SELECT auth.uid()) OR public.has_school_role('administrator'));

-- Registration runs only from the service-role Edge Function after Supabase
-- Auth has verified the password/email. It is idempotent by auth session ID.
CREATE OR REPLACE FUNCTION public.record_login_activity(
  p_auth_user_id uuid,
  p_session_id uuid,
  p_device_identifier text,
  p_device_type text,
  p_operating_system text,
  p_browser text,
  p_browser_version text,
  p_ip_address text
)
RETURNS TABLE(activity_id uuid,device_id uuid,profile_id uuid,user_role text,full_name text,email text,is_new_device boolean,email_delivery_status text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_profile public.profiles%ROWTYPE;
  v_device_id uuid;
  v_recognized boolean;
  v_is_new boolean := false;
  v_activity public.login_activity%ROWTYPE;
BEGIN
  SELECT * INTO v_profile FROM public.profiles
    WHERE auth_user_id=p_auth_user_id AND is_active FOR UPDATE;
  IF NOT FOUND OR v_profile.role NOT IN ('administrator','guard','student','teacher','parent') THEN
    RAISE EXCEPTION 'Active school account required' USING ERRCODE='42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.login_otp_verified_sessions s
    WHERE s.session_id=p_session_id AND s.auth_user_id=p_auth_user_id
      AND s.revoked_at IS NULL AND s.expires_at>now()) THEN
    RAISE EXCEPTION 'Verified session required' USING ERRCODE='42501';
  END IF;

  SELECT * INTO v_activity FROM public.login_activity WHERE session_id=p_session_id;
  IF FOUND THEN
    RETURN QUERY SELECT v_activity.id,v_activity.device_id,v_activity.profile_id,v_profile.role,
      v_profile.full_name,v_profile.email,v_activity.is_new_device,v_activity.email_delivery_status;
    RETURN;
  END IF;

  SELECT d.id,d.is_recognized INTO v_device_id,v_recognized
    FROM public.user_devices d
    WHERE d.auth_user_id=p_auth_user_id AND d.device_identifier=p_device_identifier
    FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO public.user_devices(auth_user_id,profile_id,device_identifier,device_name,device_type,operating_system,browser,browser_version)
    VALUES(p_auth_user_id,v_profile.id,p_device_identifier,
      left(COALESCE(NULLIF(p_operating_system,''),'Unknown')||' · '||COALESCE(NULLIF(p_browser,''),'Unknown'),120),
      CASE WHEN p_device_type IN ('Desktop','Laptop','Tablet','Mobile') THEN p_device_type ELSE 'Unknown' END,
      left(COALESCE(NULLIF(p_operating_system,''),'Unknown'),80),left(COALESCE(NULLIF(p_browser,''),'Unknown'),80),nullif(left(p_browser_version,40),''))
    ON CONFLICT(auth_user_id,device_identifier) DO NOTHING RETURNING id INTO v_device_id;
    IF v_device_id IS NOT NULL THEN
      v_is_new := true;
    ELSE
      SELECT d.id,d.is_recognized INTO v_device_id,v_recognized
        FROM public.user_devices d
        WHERE d.auth_user_id=p_auth_user_id AND d.device_identifier=p_device_identifier
        FOR UPDATE;
      v_is_new := NOT COALESCE(v_recognized,false);
    END IF;
  ELSE
    v_is_new := NOT COALESCE(v_recognized,false);
  END IF;

  UPDATE public.user_devices SET profile_id=v_profile.id,device_name=left(COALESCE(NULLIF(p_operating_system,''),'Unknown')||' · '||COALESCE(NULLIF(p_browser,''),'Unknown'),120),
    device_type=CASE WHEN p_device_type IN ('Desktop','Laptop','Tablet','Mobile') THEN p_device_type ELSE 'Unknown' END,
    operating_system=left(COALESCE(NULLIF(p_operating_system,''),'Unknown'),80),browser=left(COALESCE(NULLIF(p_browser,''),'Unknown'),80),
    browser_version=nullif(left(p_browser_version,40),''),is_recognized=true,last_seen_at=now(),updated_at=now()
    WHERE id=v_device_id;

  INSERT INTO public.login_activity(auth_user_id,profile_id,device_id,session_id,ip_address,is_new_device,email_delivery_status)
  VALUES(p_auth_user_id,v_profile.id,v_device_id,p_session_id,nullif(p_ip_address,'')::inet,v_is_new,
    CASE WHEN v_is_new THEN 'PENDING' ELSE NULL END)
  RETURNING * INTO v_activity;

  RETURN QUERY SELECT v_activity.id,v_activity.device_id,v_activity.profile_id,v_profile.role,
    v_profile.full_name,v_profile.email,v_activity.is_new_device,v_activity.email_delivery_status;
END;
$$;
REVOKE ALL ON FUNCTION public.record_login_activity(uuid,uuid,text,text,text,text,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_login_activity(uuid,uuid,text,text,text,text,text,text) TO service_role;

CREATE OR REPLACE FUNCTION public.touch_my_login_activity()
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_session uuid:=NULLIF(auth.jwt()->>'session_id','')::uuid;
BEGIN
  UPDATE public.login_activity SET last_activity_at=now()
    WHERE session_id=v_session AND auth_user_id=auth.uid() AND login_status='SUCCESS'
      AND EXISTS (SELECT 1 FROM public.login_otp_verified_sessions s WHERE s.session_id=v_session AND s.auth_user_id=auth.uid() AND s.revoked_at IS NULL AND s.expires_at>now());
  RETURN FOUND;
END;
$$;
REVOKE ALL ON FUNCTION public.touch_my_login_activity() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.touch_my_login_activity() TO authenticated;

CREATE OR REPLACE FUNCTION public.revoke_login_session(p_session_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_current uuid:=NULLIF(auth.jwt()->>'session_id','')::uuid; v_count integer;
BEGIN
  IF auth.uid() IS NULL OR p_session_id IS NULL OR p_session_id=v_current THEN RETURN false; END IF;
  UPDATE public.login_otp_verified_sessions SET revoked_at=now()
    WHERE session_id=p_session_id AND auth_user_id=auth.uid() AND revoked_at IS NULL;
  GET DIAGNOSTICS v_count=ROW_COUNT;
  IF v_count>0 THEN UPDATE public.login_activity SET login_status='REVOKED',logout_at=now()
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
  UPDATE public.login_activity SET login_status='REVOKED',logout_at=now()
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
  UPDATE public.login_activity SET login_status='SIGNED_OUT',logout_at=now()
    WHERE session_id=v_session AND auth_user_id=auth.uid() AND login_status='SUCCESS';
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.revoke_my_login_otp_session() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.revoke_my_login_otp_session() TO authenticated;

CREATE OR REPLACE FUNCTION public.schoolguard_login_otp_verified()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM public.login_otp_verified_sessions s
    WHERE s.session_id=NULLIF(auth.jwt()->>'session_id','')::uuid
      AND s.auth_user_id=auth.uid() AND s.revoked_at IS NULL AND s.expires_at>now())
$$;
REVOKE ALL ON FUNCTION public.schoolguard_login_otp_verified() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.schoolguard_login_otp_verified() TO authenticated;

NOTIFY pgrst, 'reload schema';
