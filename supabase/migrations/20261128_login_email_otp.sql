-- Password sign-in is completed inside the login-otp Edge Function. Public
-- authenticated access is denied until that Auth session is OTP verified.
CREATE TABLE IF NOT EXISTS public.login_otp_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  session_id uuid NOT NULL,
  email text NOT NULL,
  otp_hmac text NOT NULL,
  encrypted_session text NOT NULL,
  expires_at timestamptz NOT NULL,
  resend_after timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS login_otp_challenges_user_created ON public.login_otp_challenges(auth_user_id, created_at DESC);
ALTER TABLE public.login_otp_challenges ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.login_otp_challenges FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS public.login_otp_verified_sessions (
  session_id uuid PRIMARY KEY,
  auth_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  verified_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
ALTER TABLE public.login_otp_verified_sessions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.login_otp_verified_sessions FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS public.login_otp_rate_limits (
  rate_key text PRIMARY KEY,
  window_started_at timestamptz NOT NULL,
  request_count integer NOT NULL
);
ALTER TABLE public.login_otp_rate_limits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.login_otp_rate_limits FROM PUBLIC, anon, authenticated;

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

CREATE OR REPLACE FUNCTION public.revoke_my_login_otp_session()
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  UPDATE public.login_otp_verified_sessions SET revoked_at=now()
  WHERE session_id=NULLIF(auth.jwt()->>'session_id','')::uuid AND auth_user_id=auth.uid() AND revoked_at IS NULL;
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.revoke_my_login_otp_session() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.revoke_my_login_otp_session() TO authenticated;

CREATE OR REPLACE FUNCTION public.schoolguard_custom_access_token_hook(event jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_session uuid; v_user uuid; v_verified boolean; v_claims jsonb;
BEGIN
  v_session := NULLIF(COALESCE(event->>'session_id', event->'claims'->>'session_id'),'')::uuid;
  v_user := NULLIF(COALESCE(event->>'user_id', event->'user'->>'id'),'')::uuid;
  SELECT EXISTS (SELECT 1 FROM public.login_otp_verified_sessions s
    WHERE s.session_id=v_session AND s.auth_user_id=v_user AND s.revoked_at IS NULL AND s.expires_at>now()) INTO v_verified;
  v_claims := COALESCE(event->'claims','{}'::jsonb) || jsonb_build_object('schoolguard_otp_verified',v_verified);
  RETURN jsonb_set(event,'{claims}',v_claims,true);
END;
$$;
REVOKE ALL ON FUNCTION public.schoolguard_custom_access_token_hook(jsonb) FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA public TO supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.schoolguard_custom_access_token_hook(jsonb) TO supabase_auth_admin;

CREATE OR REPLACE FUNCTION public.login_otp_allow_request(p_key text, p_window_seconds integer, p_max_requests integer)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v public.login_otp_rate_limits%ROWTYPE;
BEGIN
  INSERT INTO public.login_otp_rate_limits(rate_key,window_started_at,request_count)
  VALUES(p_key,now(),1) ON CONFLICT(rate_key) DO NOTHING;
  SELECT * INTO v FROM public.login_otp_rate_limits WHERE rate_key=p_key FOR UPDATE;
  IF v.window_started_at < now() - make_interval(secs=>p_window_seconds) THEN
    UPDATE public.login_otp_rate_limits SET window_started_at=now(),request_count=1 WHERE rate_key=p_key;
    RETURN true;
  END IF;
  IF v.request_count >= p_max_requests THEN RETURN false; END IF;
  UPDATE public.login_otp_rate_limits SET request_count=request_count+1 WHERE rate_key=p_key;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.login_otp_verify_challenge(p_challenge_id uuid, p_candidate_hmac text)
RETURNS TABLE(result text, auth_user_id uuid, session_id uuid, encrypted_session text, email text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v public.login_otp_challenges%ROWTYPE; i integer; diff integer:=0; a bytea; b bytea;
BEGIN
  SELECT * INTO v FROM public.login_otp_challenges WHERE id=p_challenge_id FOR UPDATE;
  IF NOT FOUND OR v.consumed_at IS NOT NULL THEN RETURN QUERY SELECT 'invalid',NULL::uuid,NULL::uuid,NULL::text,NULL::text; RETURN; END IF;
  IF v.expires_at<=now() THEN
    UPDATE public.login_otp_challenges SET encrypted_session='' WHERE id=p_challenge_id;
    RETURN QUERY SELECT 'expired',NULL::uuid,NULL::uuid,NULL::text,NULL::text; RETURN;
  END IF;
  IF v.attempts>=5 THEN RETURN QUERY SELECT 'locked',NULL::uuid,NULL::uuid,NULL::text,NULL::text; RETURN; END IF;
  BEGIN a:=decode(v.otp_hmac,'hex'); b:=decode(p_candidate_hmac,'hex'); EXCEPTION WHEN OTHERS THEN a:=decode(repeat('00',32),'hex'); b:=decode(repeat('ff',32),'hex'); END;
  IF octet_length(a)=32 AND octet_length(b)=32 THEN
    FOR i IN 0..31 LOOP diff:=diff | (get_byte(a,i) # get_byte(b,i)); END LOOP;
  ELSE diff:=1;
  END IF;
  IF diff<>0 THEN
    UPDATE public.login_otp_challenges SET attempts=attempts+1,
      consumed_at=CASE WHEN attempts+1>=5 THEN now() ELSE consumed_at END,
      encrypted_session=CASE WHEN attempts+1>=5 THEN '' ELSE encrypted_session END WHERE id=p_challenge_id;
    RETURN QUERY SELECT CASE WHEN v.attempts+1>=5 THEN 'locked' ELSE 'incorrect' END,NULL::uuid,NULL::uuid,NULL::text,NULL::text; RETURN;
  END IF;
  UPDATE public.login_otp_challenges SET consumed_at=now(),encrypted_session='' WHERE id=p_challenge_id;
  INSERT INTO public.login_otp_verified_sessions(session_id,auth_user_id,expires_at)
    VALUES(v.session_id,v.auth_user_id,now()+interval '30 days')
    ON CONFLICT(session_id) DO UPDATE SET auth_user_id=EXCLUDED.auth_user_id,verified_at=now(),expires_at=EXCLUDED.expires_at,revoked_at=NULL;
  RETURN QUERY SELECT 'verified',v.auth_user_id,v.session_id,v.encrypted_session,v.email;
END;
$$;
CREATE OR REPLACE FUNCTION public.login_otp_resend_challenge(p_challenge_id uuid,p_new_hmac text,p_expires_at timestamptz,p_resend_after timestamptz)
RETURNS TABLE(email text, expires_at timestamptz, resend_after timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v public.login_otp_challenges%ROWTYPE;
BEGIN
  SELECT * INTO v FROM public.login_otp_challenges WHERE id=p_challenge_id FOR UPDATE;
  IF NOT FOUND OR v.consumed_at IS NOT NULL OR v.expires_at<=now() OR v.resend_after>now() THEN RETURN; END IF;
  UPDATE public.login_otp_challenges SET otp_hmac=p_new_hmac,attempts=0,expires_at=p_expires_at,resend_after=p_resend_after
    WHERE id=p_challenge_id;
  RETURN QUERY SELECT v.email,p_expires_at,p_resend_after;
END;
$$;
REVOKE ALL ON FUNCTION public.login_otp_allow_request(text,integer,integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.login_otp_verify_challenge(uuid,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.login_otp_resend_challenge(uuid,text,timestamptz,timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.login_otp_allow_request(text,integer,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.login_otp_verify_challenge(uuid,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.login_otp_resend_challenge(uuid,text,timestamptz,timestamptz) TO service_role;

-- All browser table access requires the OTP claim and an active server-side session.
-- Existing permissive role policies remain in force after this restrictive gate.
DO $$
DECLARE t record;
BEGIN
  FOR t IN SELECT n.nspname, c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind IN ('r','p')
      AND c.relname NOT IN ('login_otp_challenges','login_otp_verified_sessions','login_otp_rate_limits')
  LOOP
    EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY',t.nspname,t.relname);
    EXECUTE format('DROP POLICY IF EXISTS schoolguard_otp_session_required ON %I.%I',t.nspname,t.relname);
    EXECUTE format('CREATE POLICY schoolguard_otp_session_required ON %I.%I AS RESTRICTIVE FOR ALL TO authenticated USING (public.schoolguard_login_otp_verified()) WITH CHECK (public.schoolguard_login_otp_verified())',t.nspname,t.relname);
  END LOOP;
END $$;

DROP POLICY IF EXISTS schoolguard_otp_session_required ON storage.objects;
CREATE POLICY schoolguard_otp_session_required ON storage.objects AS RESTRICTIVE FOR ALL TO authenticated
USING(public.schoolguard_login_otp_verified()) WITH CHECK(public.schoolguard_login_otp_verified());

DROP POLICY IF EXISTS profile_photos_insert_own ON storage.objects;
DROP POLICY IF EXISTS profile_photos_delete_own ON storage.objects;
CREATE POLICY profile_photos_insert_own ON storage.objects FOR INSERT TO authenticated
WITH CHECK(bucket_id='profile-photos' AND public.schoolguard_login_otp_verified()
  AND (storage.foldername(name))[1]=(SELECT auth.uid())::text
  AND EXISTS(SELECT 1 FROM public.profiles p WHERE p.auth_user_id=(SELECT auth.uid()) AND p.role IN ('student','teacher') AND p.is_active)
  AND storage.extension(name)='webp' AND COALESCE(metadata->>'mimetype','')='image/webp');
CREATE POLICY profile_photos_delete_own ON storage.objects FOR DELETE TO authenticated
USING(bucket_id='profile-photos' AND public.schoolguard_login_otp_verified()
  AND (storage.foldername(name))[1]=(SELECT auth.uid())::text
  AND EXISTS(SELECT 1 FROM public.profiles p WHERE p.auth_user_id=(SELECT auth.uid()) AND p.role IN ('student','teacher') AND p.is_active));

CREATE OR REPLACE FUNCTION public.set_own_profile_photo_path(p_path text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_profile uuid:=public.current_profile_id(); v_old_path text;
BEGIN
  IF v_profile IS NULL OR NOT public.schoolguard_login_otp_verified()
    OR NOT EXISTS(SELECT 1 FROM public.profiles p WHERE p.id=v_profile AND p.role IN ('student','teacher'))
    OR (p_path IS NOT NULL AND p_path !~ ('^'||(SELECT auth.uid())::text||'/[0-9a-fA-F-]{36}\.webp$')) THEN
    RAISE EXCEPTION 'Only verified student and teacher accounts may manage their own profile photo' USING ERRCODE='42501';
  END IF;
  SELECT profile_photo_path INTO v_old_path FROM public.profiles WHERE id=v_profile FOR UPDATE;
  UPDATE public.profiles SET profile_photo_path=p_path,updated_at=now() WHERE id=v_profile;
  INSERT INTO public.audit_logs(actor_id,entity_type,entity_id,action,details)
    VALUES(v_profile,'profile',v_profile,CASE WHEN p_path IS NULL THEN 'profile_photo_removed' ELSE 'profile_photo_updated' END,jsonb_build_object('old_path',v_old_path,'new_path',p_path));
  RETURN true;
END;
$$;
