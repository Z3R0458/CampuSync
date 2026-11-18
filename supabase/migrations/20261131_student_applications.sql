-- Public student applications stay separate from live student accounts.
CREATE TABLE IF NOT EXISTS public.student_applications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reference_code TEXT NOT NULL UNIQUE,
  tracking_token_hash TEXT NOT NULL,
  email TEXT NOT NULL,
  first_name TEXT NOT NULL,
  middle_name TEXT,
  last_name TEXT NOT NULL,
  suffix TEXT,
  birth_date DATE NOT NULL,
  gender TEXT NOT NULL,
  address TEXT NOT NULL,
  phone TEXT,
  guardian_full_name TEXT NOT NULL,
  guardian_relationship TEXT NOT NULL,
  guardian_contact_number TEXT NOT NULL,
  guardian_address TEXT,
  grade_level TEXT NOT NULL,
  requested_section TEXT,
  section_id UUID REFERENCES public.sections(id) ON DELETE SET NULL,
  school_year TEXT NOT NULL,
  application_status TEXT NOT NULL DEFAULT 'PENDING' CHECK (application_status IN ('PENDING','CORRECTION_REQUESTED','APPROVED','REJECTED')),
  decision_note TEXT,
  reviewed_by UUID REFERENCES public.profiles(id),
  reviewed_at TIMESTAMPTZ,
  approved_profile_id UUID REFERENCES public.profiles(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS student_applications_status_created_idx ON public.student_applications(application_status, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS student_applications_email_active_unique ON public.student_applications(lower(email))
  WHERE application_status IN ('PENDING','CORRECTION_REQUESTED','APPROVED');
ALTER TABLE public.student_applications ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.student_applications FROM anon, authenticated;
GRANT SELECT ON public.student_applications TO authenticated;
GRANT ALL ON public.student_applications TO service_role;
DO $$ BEGIN
  CREATE POLICY student_applications_admin_read ON public.student_applications FOR SELECT TO authenticated
    USING (public.has_school_role('administrator'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE OR REPLACE FUNCTION public.complete_student_application_approval(
  p_application_id UUID, p_auth_user_id UUID, p_student_number TEXT, p_grade_level TEXT,
  p_section_id UUID, p_actor_id UUID, p_actor_name TEXT, p_actor_email TEXT
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  a public.student_applications%ROWTYPE;
  v_profile UUID;
  v_student UUID;
  v_name TEXT;
  v_token TEXT := pg_catalog.encode(extensions.gen_random_bytes(32), 'hex');
BEGIN
  SELECT * INTO a FROM public.student_applications WHERE id=p_application_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Application not found'; END IF;
  IF a.application_status='APPROVED' AND a.approved_profile_id IS NOT NULL THEN
    SELECT s.id INTO v_student FROM public.students s WHERE s.profile_id=a.approved_profile_id;
    RETURN jsonb_build_object('profile_id',a.approved_profile_id,'student_id',v_student,'already_approved',TRUE);
  END IF;
  IF a.application_status NOT IN ('PENDING','CORRECTION_REQUESTED') THEN RAISE EXCEPTION 'Application is no longer pending'; END IF;
  IF NULLIF(trim(p_student_number),'') IS NULL OR NULLIF(trim(p_grade_level),'') IS NULL THEN RAISE EXCEPTION 'Student number and grade level are required'; END IF;
  IF p_section_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.sections WHERE id=p_section_id AND grade_level=trim(p_grade_level)) THEN RAISE EXCEPTION 'Section does not match grade level'; END IF;
  IF EXISTS (SELECT 1 FROM public.students WHERE student_id=trim(p_student_number)) OR EXISTS (SELECT 1 FROM public.profiles WHERE email=a.email) THEN RAISE EXCEPTION 'Student number or email is already assigned'; END IF;
  v_name := concat_ws(' ',a.first_name,NULLIF(a.middle_name,''),a.last_name,NULLIF(a.suffix,''));
  INSERT INTO public.profiles(auth_user_id,full_name,email,phone,role,is_active)
    VALUES(p_auth_user_id,v_name,a.email,a.phone,'student',TRUE) RETURNING id INTO v_profile;
  INSERT INTO public.students(profile_id,student_id,grade_level,section_id,status,first_name,middle_name,last_name,suffix)
    VALUES(v_profile,trim(p_student_number),trim(p_grade_level),p_section_id,'active',a.first_name,a.middle_name,a.last_name,a.suffix) RETURNING id INTO v_student;
  INSERT INTO public.student_private_details(student_id,birth_date,gender,address,guardian_full_name,guardian_relationship,guardian_contact_number,guardian_address)
    VALUES(v_student,a.birth_date,a.gender,a.address,a.guardian_full_name,a.guardian_relationship,a.guardian_contact_number,a.guardian_address);
  INSERT INTO public.enrollment_records(student_id,school_year,grade_level,section_id,enrollment_type,status,reviewed_by,remarks)
    VALUES(v_student,a.school_year,trim(p_grade_level),p_section_id,'NEW','ENROLLED',p_actor_id,'Approved from student self-registration application');
  INSERT INTO public.student_qr_codes(student_id,qr_token,token_hash,is_active)
    VALUES(v_student,'HASH_ONLY:'||pg_catalog.gen_random_uuid()::text,pg_catalog.encode(extensions.digest(v_token,'sha256'),'hex'),TRUE);
  UPDATE public.student_applications SET application_status='APPROVED',reviewed_by=p_actor_id,reviewed_at=NOW(),approved_profile_id=v_profile,updated_at=NOW()
    WHERE id=p_application_id;
  INSERT INTO public.audit_logs(actor_id,actor_name_snapshot,actor_email_snapshot,actor_role_snapshot,entity_type,entity_id,entity_label,action,module,description,new_values,changed_fields,status,details)
    VALUES(p_actor_id,p_actor_name,p_actor_email,'administrator','student_applications',p_application_id,a.reference_code,'student_application_approved','enrollment','Student application approved and account provisioned',jsonb_build_object('student_number',trim(p_student_number),'grade_level',trim(p_grade_level),'section_id',p_section_id),ARRAY['application_status','student_number','grade_level','section_id'],'success','{}'::jsonb);
  RETURN jsonb_build_object('profile_id',v_profile,'student_id',v_student,'qr_token',v_token,'already_approved',FALSE);
END; $$;
REVOKE ALL ON FUNCTION public.complete_student_application_approval(UUID,UUID,TEXT,TEXT,UUID,UUID,TEXT,TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_student_application_approval(UUID,UUID,TEXT,TEXT,UUID,UUID,TEXT,TEXT) TO service_role;
