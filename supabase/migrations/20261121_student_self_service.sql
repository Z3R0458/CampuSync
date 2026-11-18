-- Student self-service workflows, scoped by the authenticated student's linked record.
ALTER TABLE public.early_out_requests
  ADD COLUMN IF NOT EXISTS additional_explanation TEXT,
  ADD COLUMN IF NOT EXISTS guardian_name TEXT,
  ADD COLUMN IF NOT EXISTS guardian_contact TEXT,
  ADD COLUMN IF NOT EXISTS reviewer_remarks TEXT,
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;
ALTER TABLE public.visitor_requests
  ADD COLUMN IF NOT EXISTS visitor_id_type TEXT,
  ADD COLUMN IF NOT EXISTS expected_departure_time TIME,
  ADD COLUMN IF NOT EXISTS additional_info TEXT,
  ADD COLUMN IF NOT EXISTS reviewer_remarks TEXT,
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;

DO $$ DECLARE c RECORD; BEGIN
  FOR c IN SELECT conname,conrelid::regclass AS rel FROM pg_constraint
    WHERE conrelid IN ('public.early_out_requests'::regclass,'public.visitor_requests'::regclass)
      AND contype='c' AND pg_get_constraintdef(oid) ILIKE '%status%'
  LOOP EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I',c.rel,c.conname); END LOOP;
END $$;
ALTER TABLE public.early_out_requests ADD CONSTRAINT early_out_requests_status_check
  CHECK(status IN ('PENDING','UNDER_REVIEW','APPROVED','REJECTED','CANCELLED','EXPIRED','USED'));
ALTER TABLE public.visitor_requests ADD CONSTRAINT visitor_requests_status_check
  CHECK(status IN ('PENDING','UNDER_REVIEW','APPROVED','REJECTED','CANCELLED','EXPIRED','USED','COMPLETED'));

CREATE TABLE IF NOT EXISTS public.absence_notices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id UUID NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
  absence_date DATE NOT NULL,
  reason TEXT NOT NULL CHECK(reason IN ('Illness','Family emergency','Personal circumstances','Other')),
  explanation TEXT,
  guardian_name TEXT,
  guardian_contact TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','UNDER_REVIEW','ACCEPTED','REJECTED','CANCELLED')),
  reviewed_by UUID REFERENCES public.profiles(id),
  reviewer_remarks TEXT,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS public.attendance_correction_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id UUID NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
  attendance_date DATE NOT NULL,
  current_status TEXT NOT NULL,
  requested_status TEXT NOT NULL CHECK(requested_status IN ('present','late','absent','incomplete','early_departure')),
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','UNDER_REVIEW','APPROVED','REJECTED','CANCELLED')),
  reviewed_by UUID REFERENCES public.profiles(id),
  reviewer_remarks TEXT,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS public.student_request_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id UUID NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
  request_type TEXT NOT NULL CHECK(request_type IN ('early_out','visitor','absence','attendance_correction')),
  request_id UUID NOT NULL,
  old_status TEXT,
  new_status TEXT NOT NULL,
  changed_by UUID REFERENCES public.profiles(id),
  remarks TEXT,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS public.announcement_reads (
  profile_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  announcement_id UUID NOT NULL REFERENCES public.announcements(id) ON DELETE CASCADE,
  read_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(profile_id,announcement_id)
);

ALTER TABLE public.absence_notices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.attendance_correction_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.student_request_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.announcement_reads ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.can_review_student_request(p_student_id UUID)
RETURNS BOOLEAN LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT public.has_school_role('administrator') OR EXISTS (
    SELECT 1 FROM public.students s JOIN public.sections sec ON sec.id=s.section_id
    JOIN public.teachers t ON t.id=sec.adviser_id
    WHERE s.id=p_student_id AND t.profile_id=public.current_profile_id()
  )
$$;
REVOKE ALL ON FUNCTION public.can_review_student_request(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.can_review_student_request(UUID) TO authenticated;

DROP POLICY IF EXISTS student_private_details_admin_only ON public.student_private_details;
CREATE POLICY student_private_details_self_or_admin ON public.student_private_details FOR SELECT TO authenticated
  USING (public.has_school_role('administrator') OR student_id IN (SELECT id FROM public.students WHERE profile_id=public.current_profile_id()));
DROP POLICY IF EXISTS enrollment_records_student_read ON public.enrollment_records;
CREATE POLICY enrollment_records_student_read ON public.enrollment_records FOR SELECT TO authenticated
  USING (student_id IN (SELECT id FROM public.students WHERE profile_id=public.current_profile_id()));
DROP POLICY IF EXISTS enrollment_history_student_read ON public.enrollment_record_history;
CREATE POLICY enrollment_history_student_read ON public.enrollment_record_history FOR SELECT TO authenticated
  USING (enrollment_record_id IN (SELECT e.id FROM public.enrollment_records e JOIN public.students s ON s.id=e.student_id WHERE s.profile_id=public.current_profile_id()));

CREATE POLICY absence_notices_read_scoped ON public.absence_notices FOR SELECT TO authenticated
  USING (student_id IN (SELECT id FROM public.students WHERE profile_id=public.current_profile_id()) OR public.can_review_student_request(student_id));
CREATE POLICY absence_notices_insert_self ON public.absence_notices FOR INSERT TO authenticated
  WITH CHECK(status='PENDING' AND reviewed_by IS NULL AND reviewed_at IS NULL AND student_id IN (SELECT id FROM public.students WHERE profile_id=public.current_profile_id()));
CREATE POLICY correction_requests_read_scoped ON public.attendance_correction_requests FOR SELECT TO authenticated
  USING (student_id IN (SELECT id FROM public.students WHERE profile_id=public.current_profile_id()) OR public.can_review_student_request(student_id));
CREATE POLICY correction_requests_insert_self ON public.attendance_correction_requests FOR INSERT TO authenticated
  WITH CHECK(status='PENDING' AND reviewed_by IS NULL AND reviewed_at IS NULL AND student_id IN (SELECT id FROM public.students WHERE profile_id=public.current_profile_id()));
CREATE POLICY request_history_read_scoped ON public.student_request_history FOR SELECT TO authenticated
  USING (student_id IN (SELECT id FROM public.students WHERE profile_id=public.current_profile_id()) OR public.can_review_student_request(student_id) OR public.has_school_role('administrator'));
CREATE POLICY announcement_reads_self ON public.announcement_reads FOR SELECT TO authenticated USING(profile_id=public.current_profile_id());
CREATE POLICY announcement_reads_insert_self ON public.announcement_reads FOR INSERT TO authenticated WITH CHECK(profile_id=public.current_profile_id());
CREATE POLICY announcement_reads_update_self ON public.announcement_reads FOR UPDATE TO authenticated USING(profile_id=public.current_profile_id()) WITH CHECK(profile_id=public.current_profile_id());
CREATE POLICY visitor_logs_student_read ON public.visitor_logs FOR SELECT TO authenticated
  USING(student_id IN (SELECT id FROM public.students WHERE profile_id=public.current_profile_id()));
CREATE POLICY early_out_read_teacher_adviser ON public.early_out_requests FOR SELECT TO authenticated USING(public.can_review_student_request(student_id));
CREATE POLICY visitor_request_read_teacher_adviser ON public.visitor_requests FOR SELECT TO authenticated USING(public.can_review_student_request(student_id));

GRANT SELECT ON public.absence_notices,public.attendance_correction_requests,public.student_request_history,public.announcement_reads TO authenticated;
GRANT INSERT ON public.absence_notices,public.attendance_correction_requests TO authenticated;
GRANT SELECT ON public.student_private_details,public.enrollment_records,public.enrollment_record_history,public.visitor_logs TO authenticated;
GRANT INSERT,UPDATE ON public.announcement_reads TO authenticated;
REVOKE UPDATE,DELETE ON public.absence_notices,public.attendance_correction_requests,public.student_request_history FROM authenticated;
REVOKE UPDATE,DELETE ON public.early_out_requests,public.visitor_requests,public.visitor_logs FROM authenticated;

CREATE OR REPLACE FUNCTION public.prevent_duplicate_early_out()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_date DATE;
BEGIN
  v_date:=(NEW.requested_departure AT TIME ZONE 'Asia/Manila')::date;
  PERFORM pg_advisory_xact_lock(hashtext(NEW.student_id::text),hashtext(v_date::text));
  IF EXISTS(SELECT 1 FROM public.early_out_requests r WHERE r.student_id=NEW.student_id
    AND (r.requested_departure AT TIME ZONE 'Asia/Manila')::date=v_date
    AND r.status IN ('PENDING','UNDER_REVIEW','APPROVED')) THEN
    RAISE EXCEPTION 'An active early-out request already exists for this student and date' USING ERRCODE='23505';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.prevent_duplicate_early_out() FROM PUBLIC;
DROP TRIGGER IF EXISTS prevent_duplicate_early_out ON public.early_out_requests;
CREATE TRIGGER prevent_duplicate_early_out BEFORE INSERT ON public.early_out_requests FOR EACH ROW EXECUTE FUNCTION public.prevent_duplicate_early_out();

CREATE OR REPLACE FUNCTION public.capture_student_request_event()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_type TEXT:=TG_ARGV[0]; v_student UUID; v_id UUID; v_old TEXT; v_new TEXT; v_actor UUID; v_remarks TEXT; v_label TEXT; v_action TEXT;
BEGIN
  v_student:=NULLIF(to_jsonb(NEW)->>'student_id','')::UUID;v_id:=NULLIF(to_jsonb(NEW)->>'id','')::UUID;
  v_new:=to_jsonb(NEW)->>'status';v_actor:=COALESCE(public.current_profile_id(),NULLIF(to_jsonb(NEW)->>'reviewed_by','')::UUID,NULLIF(to_jsonb(NEW)->>'approved_by','')::UUID);v_remarks:=to_jsonb(NEW)->>'reviewer_remarks';
  IF TG_OP='UPDATE' THEN v_old:=to_jsonb(OLD)->>'status';IF v_old IS NOT DISTINCT FROM v_new THEN RETURN NEW;END IF;END IF;
  INSERT INTO public.student_request_history(student_id,request_type,request_id,old_status,new_status,changed_by,remarks)
    VALUES(v_student,v_type,v_id,v_old,v_new,v_actor,v_remarks);
  v_label:=COALESCE(to_jsonb(NEW)->>'visitor_name',to_jsonb(NEW)->>'reason',to_jsonb(NEW)->>'requested_departure',to_jsonb(NEW)->>'absence_date',to_jsonb(NEW)->>'attendance_date',v_id::text);
  v_action:=v_type||'_request_'||CASE WHEN TG_OP='INSERT' THEN 'submitted' ELSE lower(v_new) END;
  INSERT INTO public.audit_logs(actor_id,entity_type,entity_id,entity_label,action,module,description,new_values,status)
    VALUES(v_actor,'student_request',v_id,v_label,v_action,'students',replace(initcap(replace(v_action,'_',' ')),'  ',' '),jsonb_build_object('request_type',v_type,'status',v_new,'remarks',v_remarks),'success');
  IF TG_OP='INSERT' THEN
    INSERT INTO public.notifications(recipient_id,actor_id,type,payload)
      SELECT p.id,v_actor,'student_request_submitted',jsonb_build_object('request_type',v_type,'request_id',v_id,'message','Your request was submitted.')
      FROM public.profiles p WHERE p.role='administrator' AND p.is_active;
  ELSIF v_old IS DISTINCT FROM v_new AND NOT (v_type IN ('early_out','visitor') AND v_new IN ('APPROVED','REJECTED')) THEN
    INSERT INTO public.notifications(recipient_id,actor_id,type,payload)
      SELECT s.profile_id,v_actor,'student_request_'||lower(v_new),jsonb_build_object('request_type',v_type,'request_id',v_id,'status',v_new,'message','Your '||replace(v_type,'_',' ')||' request status is now '||replace(lower(v_new),'_',' ')||'.')
      FROM public.students s WHERE s.id=v_student;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.capture_student_request_event() FROM PUBLIC;
DROP TRIGGER IF EXISTS early_out_history ON public.early_out_requests;
CREATE TRIGGER early_out_history AFTER INSERT OR UPDATE OF status ON public.early_out_requests FOR EACH ROW EXECUTE FUNCTION public.capture_student_request_event('early_out');
DROP TRIGGER IF EXISTS visitor_request_history ON public.visitor_requests;
CREATE TRIGGER visitor_request_history AFTER INSERT OR UPDATE OF status ON public.visitor_requests FOR EACH ROW EXECUTE FUNCTION public.capture_student_request_event('visitor');
DROP TRIGGER IF EXISTS absence_notice_history ON public.absence_notices;
CREATE TRIGGER absence_notice_history AFTER INSERT OR UPDATE OF status ON public.absence_notices FOR EACH ROW EXECUTE FUNCTION public.capture_student_request_event('absence');
DROP TRIGGER IF EXISTS attendance_correction_history ON public.attendance_correction_requests;
CREATE TRIGGER attendance_correction_history AFTER INSERT OR UPDATE OF status ON public.attendance_correction_requests FOR EACH ROW EXECUTE FUNCTION public.capture_student_request_event('attendance_correction');

CREATE OR REPLACE FUNCTION public.review_student_request(p_request_type TEXT,p_request_id UUID,p_status TEXT,p_remarks TEXT DEFAULT NULL)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_student UUID;v_id UUID:=public.current_profile_id();v_allowed TEXT[];v_date DATE;v_requested TEXT;v_current TEXT;
BEGIN
  IF v_id IS NULL OR p_status IS NULL THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE='42501';END IF;
  IF p_request_type='early_out' THEN v_allowed:=ARRAY['UNDER_REVIEW','APPROVED','REJECTED'];SELECT student_id INTO v_student FROM public.early_out_requests WHERE id=p_request_id;
  ELSIF p_request_type='visitor' THEN v_allowed:=ARRAY['UNDER_REVIEW','APPROVED','REJECTED'];SELECT student_id INTO v_student FROM public.visitor_requests WHERE id=p_request_id;
  ELSIF p_request_type='absence' THEN v_allowed:=ARRAY['UNDER_REVIEW','ACCEPTED','REJECTED'];SELECT student_id INTO v_student FROM public.absence_notices WHERE id=p_request_id;
  ELSIF p_request_type='attendance_correction' THEN v_allowed:=ARRAY['UNDER_REVIEW','APPROVED','REJECTED'];SELECT student_id,attendance_date,current_status,requested_status INTO v_student,v_date,v_current,v_requested FROM public.attendance_correction_requests WHERE id=p_request_id;
  ELSE RAISE EXCEPTION 'Unsupported request type' USING ERRCODE='22023';END IF;
  IF v_student IS NULL OR NOT public.can_review_student_request(v_student) THEN RAISE EXCEPTION 'Not authorized to review this request' USING ERRCODE='42501';END IF;
  IF NOT p_status=ANY(v_allowed) THEN RAISE EXCEPTION 'Invalid status for this request' USING ERRCODE='22023';END IF;
  IF p_request_type='early_out' THEN UPDATE public.early_out_requests SET status=p_status,reviewed_by=v_id,reviewer_remarks=NULLIF(trim(p_remarks),''),approved_at=CASE WHEN p_status='APPROVED' THEN NOW() ELSE NULL END,updated_at=NOW() WHERE id=p_request_id AND status IN ('PENDING','UNDER_REVIEW');
  ELSIF p_request_type='visitor' THEN UPDATE public.visitor_requests SET status=p_status,approved_by=v_id,reviewer_remarks=NULLIF(trim(p_remarks),''),updated_at=NOW() WHERE id=p_request_id AND status IN ('PENDING','UNDER_REVIEW');
  ELSIF p_request_type='absence' THEN UPDATE public.absence_notices SET status=p_status,reviewed_by=v_id,reviewer_remarks=NULLIF(trim(p_remarks),''),reviewed_at=NOW(),updated_at=NOW() WHERE id=p_request_id AND status IN ('PENDING','UNDER_REVIEW');
  ELSE UPDATE public.attendance_correction_requests SET status=p_status,reviewed_by=v_id,reviewer_remarks=NULLIF(trim(p_remarks),''),reviewed_at=NOW(),updated_at=NOW() WHERE id=p_request_id AND status IN ('PENDING','UNDER_REVIEW');END IF;
  IF NOT FOUND THEN RAISE EXCEPTION 'Request is no longer pending review' USING ERRCODE='40001';END IF;
  IF p_request_type='attendance_correction' AND p_status='APPROVED' THEN
    SELECT status INTO v_current FROM public.attendance_daily_summaries WHERE student_id=v_student AND summary_date=v_date;
    INSERT INTO public.attendance_daily_summaries(student_id,summary_date,status)
      VALUES(v_student,v_date,v_requested) ON CONFLICT(student_id,summary_date)
      DO UPDATE SET status=EXCLUDED.status,updated_at=NOW();
    INSERT INTO public.audit_logs(actor_id,entity_type,entity_id,entity_label,action,module,description,old_values,new_values,status)
      VALUES(v_id,'attendance_daily_summary',p_request_id,(SELECT student_id::text FROM public.students WHERE id=v_student),'attendance_correction_applied','attendance','Approved attendance correction applied',jsonb_build_object('student_id',v_student,'date',v_date,'status',v_current),jsonb_build_object('student_id',v_student,'date',v_date,'status',v_requested),'success');
  END IF;
  RETURN p_request_id;
END;
$$;
REVOKE ALL ON FUNCTION public.review_student_request(TEXT,UUID,TEXT,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.review_student_request(TEXT,UUID,TEXT,TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION public.cancel_student_request(p_request_type TEXT,p_request_id UUID)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_student UUID;v_profile UUID:=public.current_profile_id();
BEGIN
  IF v_profile IS NULL OR NOT public.has_school_role('student') THEN RAISE EXCEPTION 'Student account required' USING ERRCODE='42501';END IF;
  IF p_request_type='early_out' THEN UPDATE public.early_out_requests SET status='CANCELLED',updated_at=NOW() WHERE id=p_request_id AND status='PENDING' AND student_id IN(SELECT id FROM public.students WHERE profile_id=v_profile) RETURNING student_id INTO v_student;
  ELSIF p_request_type='visitor' THEN UPDATE public.visitor_requests SET status='CANCELLED',updated_at=NOW() WHERE id=p_request_id AND status='PENDING' AND student_id IN(SELECT id FROM public.students WHERE profile_id=v_profile) RETURNING student_id INTO v_student;
  ELSIF p_request_type='absence' THEN UPDATE public.absence_notices SET status='CANCELLED',updated_at=NOW() WHERE id=p_request_id AND status='PENDING' AND student_id IN(SELECT id FROM public.students WHERE profile_id=v_profile) RETURNING student_id INTO v_student;
  ELSIF p_request_type='attendance_correction' THEN UPDATE public.attendance_correction_requests SET status='CANCELLED',updated_at=NOW() WHERE id=p_request_id AND status='PENDING' AND student_id IN(SELECT id FROM public.students WHERE profile_id=v_profile) RETURNING student_id INTO v_student;
  ELSE RAISE EXCEPTION 'Unsupported request type' USING ERRCODE='22023';END IF;
  IF v_student IS NULL THEN RAISE EXCEPTION 'Pending request not found' USING ERRCODE='P0002';END IF;
  RETURN p_request_id;
END;
$$;
REVOKE ALL ON FUNCTION public.cancel_student_request(TEXT,UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cancel_student_request(TEXT,UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.complete_visitor_request_on_exit()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF OLD.actual_departure_time IS NULL AND NEW.actual_departure_time IS NOT NULL AND NEW.visitor_request_id IS NOT NULL THEN
    UPDATE public.visitor_requests SET status='COMPLETED',completed_at=NEW.actual_departure_time,updated_at=NOW() WHERE id=NEW.visitor_request_id AND status='USED';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.complete_visitor_request_on_exit() FROM PUBLIC;
DROP TRIGGER IF EXISTS visitor_request_complete_on_exit ON public.visitor_logs;
CREATE TRIGGER visitor_request_complete_on_exit AFTER UPDATE OF actual_departure_time ON public.visitor_logs FOR EACH ROW EXECUTE FUNCTION public.complete_visitor_request_on_exit();

CREATE OR REPLACE FUNCTION public.guard_record_visitor_exit(p_log_id UUID)
RETURNS TIMESTAMPTZ LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_departure TIMESTAMPTZ:=NOW();v_visitor TEXT;v_student UUID;
BEGIN
  IF NOT public.has_school_role('guard') THEN RAISE EXCEPTION 'Guard access required' USING ERRCODE='42501';END IF;
  UPDATE public.visitor_logs SET actual_departure_time=v_departure,updated_at=v_departure
    WHERE id=p_log_id AND authorization_status='APPROVED' AND actual_departure_time IS NULL
    RETURNING visitor_name,student_id INTO v_visitor,v_student;
  IF NOT FOUND THEN RAISE EXCEPTION 'Visitor is not checked in or has already exited' USING ERRCODE='P0002';END IF;
  INSERT INTO public.audit_logs(actor_id,entity_type,entity_id,entity_label,action,module,description,old_values,new_values,status)
    VALUES(public.current_profile_id(),'visitor_log',p_log_id,v_visitor,'visitor_exit_recorded','gate','Guard recorded visitor departure',jsonb_build_object('student_id',v_student,'actual_departure_time',NULL),jsonb_build_object('student_id',v_student,'actual_departure_time',v_departure),'success');
  RETURN v_departure;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_record_visitor_exit(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.guard_record_visitor_exit(UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.notify_student_announcement()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NEW.status='published' AND (TG_OP='INSERT' OR OLD.status IS DISTINCT FROM NEW.status) THEN
    INSERT INTO public.notifications(recipient_id,actor_id,type,payload)
    SELECT p.id,NEW.created_by,'announcement_published',jsonb_build_object('announcement_id',NEW.id,'message','A new school announcement is available.')
    FROM public.profiles p JOIN public.students s ON s.profile_id=p.id
    WHERE p.is_active AND p.role='student' AND (NEW.audience='all' OR NEW.audience='student')
      AND (NEW.target_grade_level IS NULL OR s.grade_level=NEW.target_grade_level)
      AND (NEW.target_section_id IS NULL OR s.section_id=NEW.target_section_id)
      AND NOT EXISTS(SELECT 1 FROM public.notifications n WHERE n.recipient_id=p.id AND n.type='announcement_published' AND n.payload->>'announcement_id'=NEW.id::text);
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.notify_student_announcement() FROM PUBLIC;
DROP TRIGGER IF EXISTS announcement_student_notification ON public.announcements;
CREATE TRIGGER announcement_student_notification AFTER INSERT OR UPDATE OF status ON public.announcements FOR EACH ROW EXECUTE FUNCTION public.notify_student_announcement();

DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_publication WHERE pubname='supabase_realtime') AND NOT EXISTS(
    SELECT 1 FROM pg_publication_tables WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='notifications') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.notifications;
  END IF;
END $$;

COMMENT ON TABLE public.absence_notices IS 'Student absence notices; acceptance does not alter attendance summaries.';
COMMENT ON TABLE public.attendance_correction_requests IS 'Student requests for attendance corrections; attendance is changed only through trusted reviewer action.';
