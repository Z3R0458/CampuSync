-- Atomically update profile and role-specific directory fields from User Management.
CREATE OR REPLACE FUNCTION public.admin_update_account_details(
  p_profile_id UUID,
  p_full_name TEXT,
  p_phone TEXT,
  p_student_number TEXT,
  p_grade_level TEXT,
  p_section_id UUID,
  p_teacher_number TEXT,
  p_designation TEXT
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_role TEXT;
BEGIN
  IF NOT public.has_school_role('administrator') THEN
    RAISE EXCEPTION 'Administrator permission is required' USING ERRCODE = '42501';
  END IF;
  IF NULLIF(trim(p_full_name), '') IS NULL OR length(trim(p_full_name)) > 120 THEN
    RAISE EXCEPTION 'Enter a valid full name' USING ERRCODE = '22023';
  END IF;
  SELECT role INTO v_role FROM public.profiles WHERE id = p_profile_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Account not found' USING ERRCODE = 'P0002'; END IF;

  UPDATE public.profiles SET full_name = trim(p_full_name), phone = NULLIF(trim(p_phone), ''), updated_at = NOW()
  WHERE id = p_profile_id;

  IF v_role = 'student' THEN
    IF NULLIF(trim(p_student_number), '') IS NULL OR NULLIF(trim(p_grade_level), '') IS NULL THEN
      RAISE EXCEPTION 'Student number and grade level are required' USING ERRCODE = '22023';
    END IF;
    IF p_section_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.sections s WHERE s.id = p_section_id AND s.grade_level = trim(p_grade_level)
    ) THEN RAISE EXCEPTION 'Section must belong to the selected grade level' USING ERRCODE = '22023'; END IF;
    UPDATE public.students SET student_id = trim(p_student_number), grade_level = trim(p_grade_level),
      section_id = p_section_id, updated_at = NOW() WHERE profile_id = p_profile_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Student record not found for this account' USING ERRCODE = 'P0002'; END IF;
  ELSIF v_role = 'teacher' THEN
    IF NULLIF(trim(p_teacher_number), '') IS NULL THEN
      RAISE EXCEPTION 'Teacher number is required' USING ERRCODE = '22023';
    END IF;
    UPDATE public.teachers SET teacher_id = trim(p_teacher_number), designation = NULLIF(trim(p_designation), ''), updated_at = NOW()
      WHERE profile_id = p_profile_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Teacher record not found for this account' USING ERRCODE = 'P0002'; END IF;
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.admin_update_account_details(UUID,TEXT,TEXT,TEXT,TEXT,UUID,TEXT,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_update_account_details(UUID,TEXT,TEXT,TEXT,TEXT,UUID,TEXT,TEXT) TO authenticated;

DROP TRIGGER IF EXISTS admin_teachers_audit ON public.teachers;
CREATE TRIGGER admin_teachers_audit AFTER INSERT OR UPDATE OR DELETE ON public.teachers
FOR EACH ROW EXECUTE FUNCTION public.log_admin_record_change();
