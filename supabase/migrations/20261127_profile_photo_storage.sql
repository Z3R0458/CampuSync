-- Profile photos live in private Storage. PostgreSQL keeps only an object path.
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS profile_photo_path TEXT;

-- Preserve any parent-specific paths that were stored before the shared profile field existed.
UPDATE public.profiles p SET profile_photo_path=pa.profile_photo_path
FROM public.parents pa
WHERE pa.profile_id=p.id AND p.profile_photo_path IS NULL AND pa.profile_photo_path IS NOT NULL;

INSERT INTO storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
VALUES('profile-photos','profile-photos',FALSE,262144,ARRAY['image/webp'])
ON CONFLICT(id) DO UPDATE SET public=FALSE,file_size_limit=262144,allowed_mime_types=ARRAY['image/webp'];

CREATE OR REPLACE FUNCTION public.can_view_profile_photo(p_owner_auth_user_id TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_profile UUID:=public.current_profile_id();
BEGIN
  IF v_profile IS NULL OR p_owner_auth_user_id IS NULL THEN RETURN FALSE; END IF;
  IF p_owner_auth_user_id=(SELECT auth.uid())::text THEN RETURN TRUE; END IF;
  IF public.has_school_role('administrator') THEN RETURN TRUE; END IF;
  IF public.has_school_role('guard') THEN
    RETURN EXISTS(SELECT 1 FROM public.profiles p WHERE p.auth_user_id::text=p_owner_auth_user_id
      AND p.is_active AND p.role IN ('student','teacher'));
  END IF;
  IF public.has_school_role('parent') THEN
    RETURN EXISTS(
      SELECT 1 FROM public.profiles student_profile
      JOIN public.students s ON s.profile_id=student_profile.id
      JOIN public.student_guardians sg ON sg.student_id=s.id
      JOIN public.parents pa ON pa.id=sg.parent_id
      JOIN auth.users parent_auth ON parent_auth.id=(SELECT p.auth_user_id FROM public.profiles p WHERE p.id=v_profile)
      WHERE student_profile.auth_user_id::text=p_owner_auth_user_id AND parent_auth.email_confirmed_at IS NOT NULL
        AND student_profile.role='student' AND pa.profile_id=v_profile
        AND sg.is_authorized AND sg.verification_status='APPROVED'
    );
  END IF;
  RETURN FALSE;
END;
$$;
REVOKE ALL ON FUNCTION public.can_view_profile_photo(TEXT) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.can_view_profile_photo(TEXT) TO authenticated;

DROP POLICY IF EXISTS profile_photos_read_authorized ON storage.objects;
DROP POLICY IF EXISTS profile_photos_insert_own ON storage.objects;
DROP POLICY IF EXISTS profile_photos_delete_own ON storage.objects;
CREATE POLICY profile_photos_read_authorized ON storage.objects FOR SELECT TO authenticated
USING(bucket_id='profile-photos' AND public.can_view_profile_photo((storage.foldername(name))[1]));
CREATE POLICY profile_photos_insert_own ON storage.objects FOR INSERT TO authenticated
WITH CHECK(bucket_id='profile-photos'
  AND (storage.foldername(name))[1]=(SELECT auth.uid())::text
  AND storage.extension(name)='webp'
  AND COALESCE(metadata->>'mimetype','')='image/webp');
CREATE POLICY profile_photos_delete_own ON storage.objects FOR DELETE TO authenticated
USING(bucket_id='profile-photos' AND (storage.foldername(name))[1]=(SELECT auth.uid())::text);

-- The browser can only set the signed-in user's path, and only to its own WebP object.
CREATE OR REPLACE FUNCTION public.set_own_profile_photo_path(p_path TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_profile UUID:=public.current_profile_id();v_old_path TEXT;
BEGIN
  IF v_profile IS NULL OR p_path IS NULL OR p_path !~ ('^'||(SELECT auth.uid())::text||'/[0-9a-fA-F-]{36}\.webp$') THEN
    RAISE EXCEPTION 'Profile photo path is invalid or does not belong to this account' USING ERRCODE='42501';
  END IF;
  SELECT profile_photo_path INTO v_old_path FROM public.profiles WHERE id=v_profile FOR UPDATE;
  UPDATE public.profiles SET profile_photo_path=p_path,updated_at=NOW() WHERE id=v_profile;
  INSERT INTO public.audit_logs(actor_id,entity_type,entity_id,action,details)
  VALUES(v_profile,'profile',v_profile,'profile_photo_updated',jsonb_build_object('old_path',v_old_path,'new_path',p_path));
  RETURN TRUE;
END;
$$;
REVOKE ALL ON FUNCTION public.set_own_profile_photo_path(TEXT) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.set_own_profile_photo_path(TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_parent_linked_student_photos()
RETURNS TABLE(student_id UUID,profile_photo_path TEXT)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_parent_profile UUID:=public.current_profile_id();
BEGIN
  IF NOT public.has_school_role('parent') OR NOT public.parent_email_is_verified() THEN
    RAISE EXCEPTION 'Verified parent access is required' USING ERRCODE='42501';
  END IF;
  RETURN QUERY SELECT s.id,p.profile_photo_path
  FROM public.parents pa JOIN public.student_guardians sg ON sg.parent_id=pa.id
  JOIN public.students s ON s.id=sg.student_id JOIN public.profiles p ON p.id=s.profile_id
  WHERE pa.profile_id=v_parent_profile AND sg.is_authorized AND sg.verification_status='APPROVED';
END;
$$;
REVOKE ALL ON FUNCTION public.get_parent_linked_student_photos() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.get_parent_linked_student_photos() TO authenticated;

-- Extend the existing authorized guard QR preview with the actual photo path.
CREATE OR REPLACE FUNCTION public.preview_guard_qr(p_qr_token TEXT)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_person JSONB;v_id UUID;v_type TEXT;
BEGIN
  IF NOT public.has_school_role('guard') THEN RAISE EXCEPTION 'Guard access required' USING ERRCODE='42501';END IF;
  IF p_qr_token IS NULL OR length(p_qr_token)<32 OR length(p_qr_token)>256 THEN RAISE EXCEPTION 'Invalid QR code' USING ERRCODE='22023';END IF;
  SELECT q.student_id,'student' INTO v_id,v_type FROM public.student_qr_codes q
    JOIN public.students s ON s.id=q.student_id JOIN public.profiles p ON p.id=s.profile_id
    WHERE q.token_hash=pg_catalog.encode(extensions.digest(p_qr_token,'sha256'),'hex') AND q.is_active AND s.status='active' AND p.is_active LIMIT 1;
  IF v_id IS NULL THEN
    SELECT q.teacher_id,'teacher' INTO v_id,v_type FROM public.teacher_qr_codes q
      JOIN public.teachers t ON t.id=q.teacher_id JOIN public.profiles p ON p.id=t.profile_id
      WHERE q.token_hash=pg_catalog.encode(extensions.digest(p_qr_token,'sha256'),'hex') AND q.is_active AND p.is_active LIMIT 1;
  END IF;
  IF v_id IS NULL THEN RAISE EXCEPTION 'QR code is invalid, revoked, expired, or the account is inactive' USING ERRCODE='22023';END IF;
  IF v_type='student' THEN
    SELECT jsonb_build_object('person_id',s.id,'person_type','student','display_id',s.student_id,'full_name',p.full_name,
      'profile_photo_path',p.profile_photo_path,'grade_level',s.grade_level,'section_name',sec.name,
      'student_details',public.get_guard_student_snapshot(s.id)) INTO v_person
    FROM public.students s JOIN public.profiles p ON p.id=s.profile_id LEFT JOIN public.sections sec ON sec.id=s.section_id WHERE s.id=v_id;
  ELSE
    SELECT jsonb_build_object('person_id',t.id,'person_type','teacher','display_id',t.teacher_id,'full_name',p.full_name,
      'profile_photo_path',p.profile_photo_path,'grade_level',t.designation) INTO v_person
    FROM public.teachers t JOIN public.profiles p ON p.id=t.profile_id WHERE t.id=v_id;
  END IF;
  RETURN v_person;
END;
$$;
REVOKE ALL ON FUNCTION public.preview_guard_qr(TEXT) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.preview_guard_qr(TEXT) TO authenticated;
