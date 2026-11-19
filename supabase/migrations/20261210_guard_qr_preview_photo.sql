-- Ensure a guard's authenticated QR identity check returns the student's
-- private profile-photo path, which the client resolves through Storage RLS.
CREATE OR REPLACE FUNCTION public.preview_guard_qr(p_qr_token TEXT)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_person JSONB;v_id UUID;v_type TEXT;
BEGIN
  IF NOT public.has_school_role('guard') THEN
    RAISE EXCEPTION 'Guard access required' USING ERRCODE='42501';
  END IF;
  IF p_qr_token IS NULL OR length(p_qr_token)<32 OR length(p_qr_token)>256 THEN
    RAISE EXCEPTION 'Invalid QR code' USING ERRCODE='22023';
  END IF;
  SELECT q.student_id,'student' INTO v_id,v_type
  FROM public.student_qr_codes q
  JOIN public.students s ON s.id=q.student_id
  JOIN public.profiles p ON p.id=s.profile_id
  WHERE q.token_hash=pg_catalog.encode(extensions.digest(p_qr_token,'sha256'),'hex')
    AND q.is_active AND s.status='active' AND p.is_active
  LIMIT 1;
  IF v_id IS NULL THEN
    SELECT q.teacher_id,'teacher' INTO v_id,v_type
    FROM public.teacher_qr_codes q
    JOIN public.teachers t ON t.id=q.teacher_id
    JOIN public.profiles p ON p.id=t.profile_id
    WHERE q.token_hash=pg_catalog.encode(extensions.digest(p_qr_token,'sha256'),'hex')
      AND q.is_active AND p.is_active
    LIMIT 1;
  END IF;
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'This QR is invalid, was replaced, or belongs to an inactive account' USING ERRCODE='22023';
  END IF;
  IF v_type='student' THEN
    SELECT jsonb_build_object(
      'person_id',s.id,'person_type','student','display_id',s.student_id,'full_name',p.full_name,
      'profile_photo_path',p.profile_photo_path,'grade_level',s.grade_level,'section_name',sec.name,
      'student_details',public.get_guard_student_snapshot(s.id)
    ) INTO v_person
    FROM public.students s JOIN public.profiles p ON p.id=s.profile_id
    LEFT JOIN public.sections sec ON sec.id=s.section_id WHERE s.id=v_id;
  ELSE
    SELECT jsonb_build_object(
      'person_id',t.id,'person_type','teacher','display_id',t.teacher_id,'full_name',p.full_name,
      'profile_photo_path',p.profile_photo_path,'grade_level',t.designation
    ) INTO v_person
    FROM public.teachers t JOIN public.profiles p ON p.id=t.profile_id WHERE t.id=v_id;
  END IF;
  RETURN v_person;
END;
$$;
REVOKE ALL ON FUNCTION public.preview_guard_qr(TEXT) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.preview_guard_qr(TEXT) TO authenticated;
