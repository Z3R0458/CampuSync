-- Supabase installs pgcrypto in the extensions schema. Keep that schema explicit
-- because these SECURITY DEFINER functions use an empty search_path.
-- Compatibility wrappers keep the already deployed QR scanner, which was
-- created by the earlier migration with public.digest/public.gen_random_bytes,
-- working until all functions have been replaced. Clients cannot call wrappers.
CREATE OR REPLACE FUNCTION public.gen_random_bytes(integer)
RETURNS BYTEA LANGUAGE SQL SECURITY DEFINER SET search_path = ''
AS $$ SELECT extensions.gen_random_bytes($1) $$;
REVOKE ALL ON FUNCTION public.gen_random_bytes(integer) FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.digest(BYTEA,TEXT)
RETURNS BYTEA LANGUAGE SQL SECURITY DEFINER SET search_path = ''
AS $$ SELECT extensions.digest($1,$2) $$;
REVOKE ALL ON FUNCTION public.digest(BYTEA,TEXT) FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.issue_qr_credential(p_person_type TEXT, p_person_id UUID)
RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE v_token TEXT := pg_catalog.encode(extensions.gen_random_bytes(32), 'hex');
BEGIN
  IF NOT public.has_school_role('administrator') THEN
    RAISE EXCEPTION 'Only administrators may issue QR credentials' USING ERRCODE = '42501';
  END IF;
  IF p_person_type = 'student' THEN
    UPDATE public.student_qr_codes SET is_active = FALSE, revoked_at = NOW(), updated_at = NOW()
      WHERE student_id = p_person_id AND is_active;
    INSERT INTO public.student_qr_codes (student_id, qr_token, token_hash, is_active)
      VALUES (p_person_id, 'HASH_ONLY:' || pg_catalog.gen_random_uuid()::text,
        pg_catalog.encode(extensions.digest(v_token, 'sha256'), 'hex'), TRUE);
  ELSIF p_person_type = 'teacher' THEN
    UPDATE public.teacher_qr_codes SET is_active = FALSE, revoked_at = NOW(), updated_at = NOW()
      WHERE teacher_id = p_person_id AND is_active;
    INSERT INTO public.teacher_qr_codes (teacher_id, qr_token, token_hash, is_active)
      VALUES (p_person_id, 'HASH_ONLY:' || pg_catalog.gen_random_uuid()::text,
        pg_catalog.encode(extensions.digest(v_token, 'sha256'), 'hex'), TRUE);
  ELSE
    RAISE EXCEPTION 'Person type must be student or teacher';
  END IF;
  RETURN v_token;
END;
$$;

CREATE OR REPLACE FUNCTION public.issue_self_qr_credential()
RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_profile_id UUID := public.current_profile_id();
  v_person_id UUID;
  v_token TEXT := pg_catalog.encode(extensions.gen_random_bytes(32), 'hex');
BEGIN
  IF public.has_school_role('student') THEN
    SELECT id INTO v_person_id FROM public.students
      WHERE profile_id = v_profile_id AND status = 'active' LIMIT 1;
    IF v_person_id IS NULL THEN
      RAISE EXCEPTION 'No active student record is linked to this profile';
    END IF;
    UPDATE public.student_qr_codes SET is_active = FALSE, revoked_at = NOW(), updated_at = NOW()
      WHERE student_id = v_person_id AND is_active;
    INSERT INTO public.student_qr_codes (student_id, qr_token, token_hash, is_active)
      VALUES (v_person_id, 'HASH_ONLY:' || pg_catalog.gen_random_uuid()::text,
        pg_catalog.encode(extensions.digest(v_token, 'sha256'), 'hex'), TRUE);
  ELSIF public.has_school_role('teacher') THEN
    SELECT id INTO v_person_id FROM public.teachers WHERE profile_id = v_profile_id LIMIT 1;
    IF v_person_id IS NULL THEN
      RAISE EXCEPTION 'No teacher record is linked to this profile';
    END IF;
    UPDATE public.teacher_qr_codes SET is_active = FALSE, revoked_at = NOW(), updated_at = NOW()
      WHERE teacher_id = v_person_id AND is_active;
    INSERT INTO public.teacher_qr_codes (teacher_id, qr_token, token_hash, is_active)
      VALUES (v_person_id, 'HASH_ONLY:' || pg_catalog.gen_random_uuid()::text,
        pg_catalog.encode(extensions.digest(v_token, 'sha256'), 'hex'), TRUE);
  ELSE
    RAISE EXCEPTION 'Only students and teachers may issue their own QR credential' USING ERRCODE = '42501';
  END IF;
  RETURN v_token;
END;
$$;
