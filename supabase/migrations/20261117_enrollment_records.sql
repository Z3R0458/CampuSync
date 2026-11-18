-- Student personal details and school-year enrollment records.
ALTER TABLE public.students
  ADD COLUMN IF NOT EXISTS first_name TEXT,
  ADD COLUMN IF NOT EXISTS middle_name TEXT,
  ADD COLUMN IF NOT EXISTS last_name TEXT,
  ADD COLUMN IF NOT EXISTS suffix TEXT;

CREATE TABLE IF NOT EXISTS public.student_private_details (
  student_id UUID PRIMARY KEY REFERENCES public.students(id) ON DELETE CASCADE,
  birth_date DATE NOT NULL,
  gender TEXT NOT NULL,
  address TEXT NOT NULL,
  guardian_full_name TEXT NOT NULL,
  guardian_relationship TEXT NOT NULL,
  guardian_contact_number TEXT NOT NULL,
  guardian_address TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE public.student_private_details ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY "student_private_details_admin_only" ON public.student_private_details
    FOR SELECT TO authenticated USING (public.has_school_role('administrator'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
GRANT SELECT ON public.student_private_details TO authenticated;
GRANT ALL ON public.student_private_details TO service_role;

DO $$ BEGIN
  ALTER TABLE public.students ADD CONSTRAINT students_section_id_fkey
    FOREIGN KEY (section_id) REFERENCES public.sections(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.enrollment_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id UUID NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
  school_year TEXT NOT NULL,
  grade_level TEXT NOT NULL,
  section_id UUID REFERENCES public.sections(id) ON DELETE SET NULL,
  enrollment_type TEXT NOT NULL DEFAULT 'NEW' CHECK (enrollment_type IN ('NEW','RETURNING')),
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED','ENROLLED')),
  date_registered TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_by UUID REFERENCES public.profiles(id),
  remarks TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT enrollment_one_student_per_year UNIQUE (student_id, school_year)
);

CREATE INDEX IF NOT EXISTS enrollment_records_year_status_idx
  ON public.enrollment_records (school_year, status);
CREATE INDEX IF NOT EXISTS enrollment_records_grade_section_idx
  ON public.enrollment_records (grade_level, section_id);

CREATE TABLE IF NOT EXISTS public.enrollment_record_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  enrollment_record_id UUID NOT NULL REFERENCES public.enrollment_records(id) ON DELETE CASCADE,
  changed_by UUID REFERENCES public.profiles(id),
  old_status TEXT,
  new_status TEXT NOT NULL,
  remarks TEXT,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.enrollment_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.enrollment_record_history ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "enrollment_records_admin_read" ON public.enrollment_records
    FOR SELECT TO authenticated USING (public.has_school_role('administrator'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "enrollment_records_admin_insert" ON public.enrollment_records
    FOR INSERT TO authenticated WITH CHECK (public.has_school_role('administrator'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "enrollment_records_admin_update" ON public.enrollment_records
    FOR UPDATE TO authenticated USING (public.has_school_role('administrator'))
    WITH CHECK (public.has_school_role('administrator'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "enrollment_history_admin_read" ON public.enrollment_record_history
    FOR SELECT TO authenticated USING (public.has_school_role('administrator'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

GRANT SELECT, INSERT, UPDATE ON public.enrollment_records TO authenticated;
GRANT SELECT ON public.enrollment_record_history TO authenticated;
GRANT ALL ON public.enrollment_records, public.enrollment_record_history TO service_role;
GRANT UPDATE (first_name,middle_name,last_name,suffix) ON public.students TO authenticated;
GRANT UPDATE (full_name,phone) ON public.profiles TO authenticated;

CREATE OR REPLACE FUNCTION public.track_enrollment_status_change()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.status IS DISTINCT FROM OLD.status OR NEW.remarks IS DISTINCT FROM OLD.remarks THEN
    INSERT INTO public.enrollment_record_history
      (enrollment_record_id, changed_by, old_status, new_status, remarks)
    VALUES (NEW.id, COALESCE(public.current_profile_id(), NEW.reviewed_by),
      CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.status END, NEW.status, NEW.remarks);
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS enrollment_status_history ON public.enrollment_records;
CREATE TRIGGER enrollment_status_history AFTER INSERT OR UPDATE ON public.enrollment_records
FOR EACH ROW EXECUTE FUNCTION public.track_enrollment_status_change();

CREATE OR REPLACE FUNCTION public.admin_update_enrollment_status(
  p_enrollment_id UUID, p_status TEXT, p_remarks TEXT DEFAULT NULL
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_record public.enrollment_records%ROWTYPE;
BEGIN
  IF NOT public.has_school_role('administrator') THEN
    RAISE EXCEPTION 'Administrator permission is required' USING ERRCODE = '42501';
  END IF;
  IF p_status NOT IN ('PENDING','APPROVED','REJECTED','ENROLLED') THEN
    RAISE EXCEPTION 'Unsupported enrollment status' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_record FROM public.enrollment_records WHERE id = p_enrollment_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Enrollment record not found' USING ERRCODE = 'P0002'; END IF;
  UPDATE public.enrollment_records SET status = p_status,
    reviewed_by = public.current_profile_id(), remarks = NULLIF(trim(p_remarks), ''), updated_at = NOW()
    WHERE id = p_enrollment_id;
  IF p_status = 'ENROLLED' THEN
    UPDATE public.students SET status = 'active', grade_level = v_record.grade_level,
      section_id = v_record.section_id, updated_at = NOW() WHERE id = v_record.student_id;
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.admin_update_enrollment_status(UUID,TEXT,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_update_enrollment_status(UUID,TEXT,TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_update_enrollment_details(
  p_enrollment_id UUID, p_school_year TEXT, p_grade_level TEXT, p_section_id UUID, p_enrollment_type TEXT
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_record public.enrollment_records%ROWTYPE;
BEGIN
  IF NOT public.has_school_role('administrator') THEN
    RAISE EXCEPTION 'Administrator permission is required' USING ERRCODE = '42501';
  END IF;
  IF NULLIF(trim(p_school_year),'') IS NULL OR NULLIF(trim(p_grade_level),'') IS NULL
    OR p_enrollment_type NOT IN ('NEW','RETURNING') THEN
    RAISE EXCEPTION 'Provide a school year, grade level, and valid enrollment type' USING ERRCODE = '22023';
  END IF;
  IF p_section_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.sections s WHERE s.id = p_section_id AND s.grade_level = trim(p_grade_level)
  ) THEN RAISE EXCEPTION 'Section must belong to the selected grade level' USING ERRCODE = '22023'; END IF;
  SELECT * INTO v_record FROM public.enrollment_records WHERE id = p_enrollment_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Enrollment record not found' USING ERRCODE = 'P0002'; END IF;
  UPDATE public.enrollment_records SET school_year = trim(p_school_year), grade_level = trim(p_grade_level),
    section_id = p_section_id, enrollment_type = p_enrollment_type, updated_at = NOW()
    WHERE id = p_enrollment_id;
  UPDATE public.students SET grade_level = trim(p_grade_level), section_id = p_section_id, updated_at = NOW()
    WHERE id = v_record.student_id;
END;
$$;
REVOKE ALL ON FUNCTION public.admin_update_enrollment_details(UUID,TEXT,TEXT,UUID,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_update_enrollment_details(UUID,TEXT,TEXT,UUID,TEXT) TO authenticated;

DROP TRIGGER IF EXISTS enrollment_records_audit ON public.enrollment_records;
CREATE TRIGGER enrollment_records_audit AFTER INSERT OR UPDATE OR DELETE ON public.enrollment_records
FOR EACH ROW EXECUTE FUNCTION public.log_admin_record_change();

CREATE OR REPLACE FUNCTION public.protect_last_active_administrator()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(721944102);
  IF OLD.role = 'administrator' AND OLD.is_active
    AND (NEW.role <> 'administrator' OR NOT NEW.is_active)
    AND NOT EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.role = 'administrator' AND p.is_active AND p.id <> OLD.id
    ) THEN
    RAISE EXCEPTION 'The last active administrator cannot be deactivated or reassigned';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS protect_last_active_administrator ON public.profiles;
CREATE TRIGGER protect_last_active_administrator BEFORE UPDATE OF role,is_active ON public.profiles
FOR EACH ROW EXECUTE FUNCTION public.protect_last_active_administrator();
