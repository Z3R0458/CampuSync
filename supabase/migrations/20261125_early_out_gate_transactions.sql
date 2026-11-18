-- Give early-out approvals an explicit authorized window and a distinct gate event.
ALTER TABLE public.early_out_requests
  ADD COLUMN IF NOT EXISTS approved_departure_date DATE,
  ADD COLUMN IF NOT EXISTS approved_departure_start TIME,
  ADD COLUMN IF NOT EXISTS approved_departure_end TIME,
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS used_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS actual_departure_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;

UPDATE public.early_out_requests
SET approved_departure_date=COALESCE(approved_departure_date,(requested_departure AT TIME ZONE 'Asia/Manila')::date),
    approved_departure_start=COALESCE(approved_departure_start,CASE WHEN (requested_departure AT TIME ZONE 'Asia/Manila')::time<TIME '00:30' THEN TIME '00:00' ELSE (requested_departure AT TIME ZONE 'Asia/Manila')::time - INTERVAL '30 minutes' END),
    approved_departure_end=COALESCE(approved_departure_end,CASE WHEN (requested_departure AT TIME ZONE 'Asia/Manila')::time>TIME '23:29' THEN TIME '23:59' ELSE (requested_departure AT TIME ZONE 'Asia/Manila')::time + INTERVAL '30 minutes' END),
    expires_at=COALESCE(expires_at,((requested_departure AT TIME ZONE 'Asia/Manila')::date + CASE WHEN (requested_departure AT TIME ZONE 'Asia/Manila')::time>TIME '23:29' THEN TIME '23:59' ELSE (requested_departure AT TIME ZONE 'Asia/Manila')::time + INTERVAL '30 minutes' END) AT TIME ZONE 'Asia/Manila')
WHERE status='APPROVED';
ALTER TABLE public.early_out_requests DROP CONSTRAINT IF EXISTS early_out_approved_window_check;
ALTER TABLE public.early_out_requests ADD CONSTRAINT early_out_approved_window_check CHECK(status<>'APPROVED' OR (approved_departure_date IS NOT NULL AND approved_departure_start IS NOT NULL AND approved_departure_end IS NOT NULL AND approved_departure_start<approved_departure_end AND expires_at IS NOT NULL));

DO $$ DECLARE c RECORD; BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='public.attendance_events'::regclass AND contype='c' AND pg_get_constraintdef(oid) ILIKE '%event_type%'
  LOOP EXECUTE format('ALTER TABLE public.attendance_events DROP CONSTRAINT %I',c.conname); END LOOP;
END $$;
ALTER TABLE public.attendance_events ADD CONSTRAINT attendance_events_event_type_check
  CHECK(event_type IN ('ENTRY','EXIT','EARLY_OUT','TEMPORARY_EXIT','RETURN'));

DROP POLICY IF EXISTS early_out_guard_read ON public.early_out_requests;

CREATE OR REPLACE FUNCTION public.review_early_out_request(
  p_request_id UUID,p_status TEXT,p_remarks TEXT DEFAULT NULL,
  p_approved_date DATE DEFAULT NULL,p_approved_start TIME DEFAULT NULL,p_approved_end TIME DEFAULT NULL
) RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_admin UUID:=public.current_profile_id();v_student UUID;v_requested_date DATE;v_until TIMESTAMPTZ;v_expiry TIMESTAMPTZ;
BEGIN
  IF v_admin IS NULL OR NOT public.has_school_role('administrator') THEN RAISE EXCEPTION 'Administrator access required' USING ERRCODE='42501';END IF;
  IF p_status IS NULL OR p_status NOT IN ('APPROVED','REJECTED','UNDER_REVIEW') THEN RAISE EXCEPTION 'Invalid early-out decision';END IF;
  SELECT student_id,(requested_departure AT TIME ZONE 'Asia/Manila')::date INTO v_student,v_requested_date
  FROM public.early_out_requests WHERE id=p_request_id AND status IN ('PENDING','UNDER_REVIEW') FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Pending early-out request not found' USING ERRCODE='P0002';END IF;
  IF p_status='APPROVED' THEN
    IF p_approved_date IS NULL OR p_approved_start IS NULL OR p_approved_end IS NULL OR p_approved_start>=p_approved_end THEN RAISE EXCEPTION 'Choose a valid approved date and time window';END IF;
    IF p_approved_date<>v_requested_date THEN RAISE EXCEPTION 'Approved date must match the requested departure date';END IF;
    v_until:=(p_approved_date+p_approved_end) AT TIME ZONE 'Asia/Manila';
    IF v_until<=NOW() THEN RAISE EXCEPTION 'The approved departure window must end in the future';END IF;
    v_expiry:=v_until;
  END IF;
  UPDATE public.early_out_requests SET status=p_status,reviewed_by=v_admin,reviewed_at=NOW(),approved_at=CASE WHEN p_status='APPROVED' THEN NOW() ELSE NULL END,
    reviewer_remarks=NULLIF(trim(p_remarks),''),approved_departure_date=CASE WHEN p_status='APPROVED' THEN p_approved_date ELSE NULL END,
    approved_departure_start=CASE WHEN p_status='APPROVED' THEN p_approved_start ELSE NULL END,
    approved_departure_end=CASE WHEN p_status='APPROVED' THEN p_approved_end ELSE NULL END,
    expires_at=v_expiry,updated_at=NOW() WHERE id=p_request_id;
  INSERT INTO public.audit_logs(actor_id,entity_type,entity_id,action,details)
  VALUES(v_admin,'early_out_request',p_request_id,'early_out_'||lower(p_status),jsonb_build_object('status',p_status,'student_id',v_student,'reviewer_remarks',NULLIF(trim(p_remarks),''),'approved_departure_date',CASE WHEN p_status='APPROVED' THEN p_approved_date ELSE NULL END,'approved_departure_start',CASE WHEN p_status='APPROVED' THEN p_approved_start ELSE NULL END,'approved_departure_end',CASE WHEN p_status='APPROVED' THEN p_approved_end ELSE NULL END,'expires_at',v_expiry));
  RETURN p_request_id;
END;$$;
REVOKE ALL ON FUNCTION public.review_early_out_request(UUID,TEXT,TEXT,DATE,TIME,TIME) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.review_early_out_request(UUID,TEXT,TEXT,DATE,TIME,TIME) TO authenticated;

CREATE OR REPLACE FUNCTION public.expire_early_out_requests_for_guard()
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT public.has_school_role('guard') AND NOT public.has_school_role('administrator') THEN RAISE EXCEPTION 'Guard access required' USING ERRCODE='42501';END IF;
  UPDATE public.early_out_requests SET status='EXPIRED',updated_at=NOW()
  WHERE status='APPROVED' AND expires_at IS NOT NULL AND expires_at<NOW();
END;$$;
REVOKE ALL ON FUNCTION public.expire_early_out_requests_for_guard() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.expire_early_out_requests_for_guard() TO authenticated;

CREATE OR REPLACE FUNCTION public.get_guard_early_out_approvals()
RETURNS TABLE(request_id UUID,student_id UUID,requested_departure TIMESTAMPTZ,reason TEXT,status TEXT,reviewed_by UUID,reviewed_by_name TEXT,reviewed_at TIMESTAMPTZ,reviewer_remarks TEXT,approved_at TIMESTAMPTZ,approved_departure_date DATE,approved_departure_start TIME,approved_departure_end TIME,expires_at TIMESTAMPTZ,used_at TIMESTAMPTZ,actual_departure_at TIMESTAMPTZ,student_number TEXT,student_name TEXT,grade_level TEXT,section_name TEXT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
 IF NOT public.has_school_role('guard') THEN RAISE EXCEPTION 'Guard access required' USING ERRCODE='42501';END IF;
 PERFORM public.expire_early_out_requests_for_guard();
 RETURN QUERY SELECT r.id,r.student_id,r.requested_departure,r.reason,r.status,r.reviewed_by,admin.full_name,r.reviewed_at,r.reviewer_remarks,r.approved_at,r.approved_departure_date,r.approved_departure_start,r.approved_departure_end,r.expires_at,r.used_at,r.actual_departure_at,s.student_id,p.full_name,s.grade_level,sec.name
 FROM public.early_out_requests r JOIN public.students s ON s.id=r.student_id JOIN public.profiles p ON p.id=s.profile_id LEFT JOIN public.sections sec ON sec.id=s.section_id LEFT JOIN public.profiles admin ON admin.id=r.reviewed_by
 ORDER BY r.requested_departure DESC LIMIT 500;
END;$$;
REVOKE ALL ON FUNCTION public.get_guard_early_out_approvals() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.get_guard_early_out_approvals() TO authenticated;

CREATE OR REPLACE FUNCTION public.record_early_out_scan(p_event_id UUID,p_qr_token TEXT,p_device_id UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_guard UUID:=public.current_profile_id();v_student UUID;v_name TEXT;v_number TEXT;v_grade TEXT;v_section TEXT;v_req UUID;v_last TEXT;v_now TIMESTAMPTZ;v_existing public.attendance_events%ROWTYPE;
BEGIN
  IF v_guard IS NULL OR NOT public.has_school_role('guard') THEN RAISE EXCEPTION 'Guard access required' USING ERRCODE='42501';END IF;
  IF NOT EXISTS(SELECT 1 FROM public.devices d WHERE d.id=p_device_id AND d.user_id=v_guard AND NOT d.is_revoked) THEN RAISE EXCEPTION 'Scanning device is not registered to this guard' USING ERRCODE='42501';END IF;
  IF p_event_id IS NULL OR p_qr_token IS NULL OR length(p_qr_token) NOT BETWEEN 32 AND 256 THEN RAISE EXCEPTION 'Invalid event or QR credential';END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_event_id::text,1));
  SELECT * INTO v_existing FROM public.attendance_events WHERE id=p_event_id OR client_event_id=p_event_id LIMIT 1;
  IF FOUND THEN
    IF v_existing.event_type<>'EARLY_OUT' OR v_existing.person_type<>'student' OR v_existing.scanning_guard_id<>v_guard THEN RAISE EXCEPTION 'This event identifier was already used for another gate action';END IF;
    RETURN jsonb_build_object('event_id',v_existing.id,'person_id',v_existing.person_id,'person_type',v_existing.person_type,'full_name',(SELECT full_name FROM public.profiles p JOIN public.students s ON s.profile_id=p.id WHERE s.id=v_existing.person_id),'display_id',(SELECT student_id FROM public.students WHERE id=v_existing.person_id),'event_type',v_existing.event_type,'scanned_at',v_existing.actual_scan_time,'status',v_existing.sync_status,'duplicate',TRUE);
  END IF;
  SELECT s.id,p.full_name,s.student_id,s.grade_level,sec.name INTO v_student,v_name,v_number,v_grade,v_section
  FROM public.student_qr_codes q JOIN public.students s ON s.id=q.student_id JOIN public.profiles p ON p.id=s.profile_id LEFT JOIN public.sections sec ON sec.id=s.section_id
  WHERE q.token_hash=pg_catalog.encode(extensions.digest(p_qr_token,'sha256'),'hex') AND q.is_active AND s.status='active' AND p.is_active LIMIT 1;
  IF v_student IS NULL THEN RAISE EXCEPTION 'Active student QR credential was not verified' USING ERRCODE='22023';END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(v_student::text,2));
  PERFORM 1 FROM public.students WHERE id=v_student FOR UPDATE;
  v_now:=clock_timestamp();
  SELECT event_type INTO v_last FROM public.attendance_events WHERE person_type='student' AND person_id=v_student AND sync_status='SYNCED' ORDER BY actual_scan_time DESC,created_at DESC LIMIT 1;
  IF v_last IS NULL OR v_last NOT IN ('ENTRY','RETURN') THEN RAISE EXCEPTION 'Student is not currently recorded inside the school';END IF;
  SELECT id INTO v_req FROM public.early_out_requests WHERE student_id=v_student AND status='APPROVED' AND approved_departure_date=(v_now AT TIME ZONE 'Asia/Manila')::date
    AND (v_now AT TIME ZONE 'Asia/Manila')::time BETWEEN approved_departure_start AND approved_departure_end AND expires_at>=v_now
    ORDER BY approved_departure_start LIMIT 1 FOR UPDATE;
  IF v_req IS NULL THEN RAISE EXCEPTION 'No approved, unused early-out authorization is valid for this student and time';END IF;
  INSERT INTO public.attendance_events(id,client_event_id,person_type,person_id,event_type,actual_scan_time,scan_device_id,scanning_guard_id,verification_result,sync_status)
  VALUES(p_event_id,p_event_id,'student',v_student,'EARLY_OUT',v_now,p_device_id,v_guard,'VERIFIED','SYNCED');
  UPDATE public.early_out_requests SET status='USED',used_at=v_now,actual_departure_at=v_now,updated_at=v_now WHERE id=v_req AND status='APPROVED';
  IF NOT FOUND THEN RAISE EXCEPTION 'Early-out authorization was used by another transaction';END IF;
  INSERT INTO public.attendance_daily_summaries(student_id,summary_date,status,entry_time,exit_time)
  SELECT v_student,(v_now AT TIME ZONE 'Asia/Manila')::date,'early_departure',
    (SELECT actual_scan_time FROM public.attendance_events WHERE person_type='student' AND person_id=v_student AND event_type='ENTRY' AND (actual_scan_time AT TIME ZONE 'Asia/Manila')::date=(v_now AT TIME ZONE 'Asia/Manila')::date ORDER BY actual_scan_time LIMIT 1),v_now
  ON CONFLICT(student_id,summary_date) DO UPDATE SET status='early_departure',exit_time=EXCLUDED.exit_time,updated_at=v_now;
  INSERT INTO public.audit_logs(actor_id,entity_type,entity_id,action,details)
  VALUES(v_guard,'attendance_event',p_event_id,'early_out_recorded',jsonb_build_object('student_id',v_student,'request_id',v_req,'actual_departure_at',v_now));
  INSERT INTO public.notifications(recipient_id,actor_id,type,payload)
  SELECT pa.profile_id,v_guard,'attendance_early_out',jsonb_build_object('student_name',v_name,'student_id',v_number,'event_type','EARLY_OUT','actual_scan_time',v_now,'event_id',p_event_id,'request_id',v_req,'category','attendance','title','Your child has left school early.','message',v_name||' left school early at '||to_char(v_now AT TIME ZONE 'Asia/Manila','FMHH12:MI AM')||' on '||to_char(v_now AT TIME ZONE 'Asia/Manila','Mon DD, YYYY')||'.')
  FROM public.student_guardians sg JOIN public.parents pa ON pa.id=sg.parent_id JOIN public.profiles pp ON pp.id=pa.profile_id
  WHERE sg.student_id=v_student AND sg.is_authorized AND sg.verification_status='APPROVED' AND pp.is_active;
  INSERT INTO public.notifications(recipient_id,actor_id,type,payload)
  SELECT s.profile_id,v_guard,'student_early_out_recorded',jsonb_build_object('student_name',v_name,'student_id',v_number,'event_type','EARLY_OUT','actual_scan_time',v_now,'event_id',p_event_id,'request_id',v_req,'category','attendance','title','Early departure recorded','message','Your departure was recorded at '||to_char(v_now AT TIME ZONE 'Asia/Manila','FMHH12:MI AM')||' on '||to_char(v_now AT TIME ZONE 'Asia/Manila','Mon DD, YYYY')||'.')
  FROM public.students s WHERE s.id=v_student;
  INSERT INTO public.notifications(recipient_id,actor_id,type,payload)
  SELECT a.id,v_guard,'admin_early_out_recorded',jsonb_build_object('student_name',v_name,'student_id',v_number,'event_type','EARLY_OUT','actual_scan_time',v_now,'event_id',p_event_id,'category','attendance','title','Student early departure recorded','message',v_name||' was recorded leaving school early at '||to_char(v_now AT TIME ZONE 'Asia/Manila','FMHH12:MI AM')||'.')
  FROM public.profiles a WHERE a.role='administrator' AND a.is_active;
  RETURN jsonb_build_object('event_id',p_event_id,'person_id',v_student,'person_type','student','display_id',v_number,'full_name',v_name,'grade_level',v_grade,'section_name',v_section,'event_type','EARLY_OUT','scanned_at',v_now,'status','SYNCED','duplicate',FALSE);
END;$$;
REVOKE ALL ON FUNCTION public.record_early_out_scan(UUID,TEXT,UUID) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.record_early_out_scan(UUID,TEXT,UUID) TO authenticated;

-- Keep ordinary scan handling compatible with EARLY_OUT as a terminal campus state.
CREATE OR REPLACE FUNCTION public.record_attendance_scan(p_event_id UUID,p_qr_token TEXT,p_event_type TEXT,p_scanned_at TIMESTAMPTZ,p_device_id UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_guard UUID:=public.current_profile_id();v_id UUID;v_kind TEXT;v_name TEXT;v_number TEXT;v_grade TEXT;v_section TEXT;v_last TEXT;v_last_at TIMESTAMPTZ;v_status TEXT:='VERIFIED';v_hash TEXT;v_existing public.attendance_events%ROWTYPE;
BEGIN
 IF v_guard IS NULL OR NOT public.has_school_role('guard') OR NOT EXISTS(SELECT 1 FROM public.devices WHERE id=p_device_id AND user_id=v_guard AND NOT is_revoked) THEN RAISE EXCEPTION 'Active registered guard device required' USING ERRCODE='42501';END IF;
 IF p_event_id IS NULL OR p_qr_token IS NULL OR length(p_qr_token) NOT BETWEEN 32 AND 256 OR p_scanned_at IS NULL OR p_scanned_at>NOW()+INTERVAL '5 minutes' THEN RAISE EXCEPTION 'Invalid QR scan';END IF;
 IF p_event_type NOT IN ('ENTRY','EXIT','TEMPORARY_EXIT','RETURN') THEN RAISE EXCEPTION 'Use the dedicated EARLY_OUT transaction for approved early departure';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_event_id::text,1));SELECT * INTO v_existing FROM public.attendance_events WHERE id=p_event_id OR client_event_id=p_event_id LIMIT 1;
 IF FOUND THEN RETURN jsonb_build_object('event_id',v_existing.id,'person_id',v_existing.person_id,'person_type',v_existing.person_type,'event_type',v_existing.event_type,'full_name',CASE WHEN v_existing.person_type='student' THEN (SELECT p.full_name FROM public.students s JOIN public.profiles p ON p.id=s.profile_id WHERE s.id=v_existing.person_id) ELSE (SELECT p.full_name FROM public.teachers t JOIN public.profiles p ON p.id=t.profile_id WHERE t.id=v_existing.person_id) END,'display_id',CASE WHEN v_existing.person_type='student' THEN (SELECT student_id FROM public.students WHERE id=v_existing.person_id) ELSE (SELECT teacher_id FROM public.teachers WHERE id=v_existing.person_id) END,'grade_level',CASE WHEN v_existing.person_type='student' THEN (SELECT grade_level FROM public.students WHERE id=v_existing.person_id) ELSE (SELECT designation FROM public.teachers WHERE id=v_existing.person_id) END,'scanned_at',v_existing.actual_scan_time,'status',v_existing.sync_status,'duplicate',TRUE);END IF;
 v_hash:=pg_catalog.encode(extensions.digest(p_qr_token,'sha256'),'hex');
 SELECT s.id,'student',p.full_name,s.student_id,s.grade_level,sec.name INTO v_id,v_kind,v_name,v_number,v_grade,v_section FROM public.student_qr_codes q JOIN public.students s ON s.id=q.student_id JOIN public.profiles p ON p.id=s.profile_id LEFT JOIN public.sections sec ON sec.id=s.section_id WHERE q.token_hash=v_hash AND q.is_active AND s.status='active' AND p.is_active LIMIT 1;
 IF v_id IS NULL THEN SELECT t.id,'teacher',p.full_name,t.teacher_id,t.designation,NULL INTO v_id,v_kind,v_name,v_number,v_grade,v_section FROM public.teacher_qr_codes q JOIN public.teachers t ON t.id=q.teacher_id JOIN public.profiles p ON p.id=t.profile_id WHERE q.token_hash=v_hash AND q.is_active AND p.is_active LIMIT 1;END IF;
 IF v_id IS NULL THEN RAISE EXCEPTION 'QR credential is invalid, revoked, expired, or inactive' USING ERRCODE='22023';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(v_id::text,2));
 SELECT event_type,actual_scan_time INTO v_last,v_last_at FROM public.attendance_events WHERE person_type=v_kind AND person_id=v_id AND sync_status<>'NEEDS_REVIEW' ORDER BY actual_scan_time DESC,created_at DESC LIMIT 1;
 IF v_last_at IS NOT NULL AND p_scanned_at<v_last_at THEN v_status:='NEEDS_REVIEW';
 ELSIF (p_event_type='ENTRY' AND v_last IS NOT NULL AND (NOT COALESCE(v_last IN ('EXIT','EARLY_OUT'),FALSE) OR (v_last_at AT TIME ZONE 'Asia/Manila')::date=(p_scanned_at AT TIME ZONE 'Asia/Manila')::date)) OR (p_event_type IN ('EXIT','TEMPORARY_EXIT') AND NOT COALESCE(v_last IN ('ENTRY','RETURN'),FALSE)) OR (p_event_type='RETURN' AND v_last IS DISTINCT FROM 'TEMPORARY_EXIT') THEN RAISE EXCEPTION 'Invalid gate event sequence for this person' USING ERRCODE='22023';END IF;
 IF p_event_type='EXIT' AND v_kind='student' AND EXISTS(SELECT 1 FROM public.school_schedules sch WHERE sch.is_active AND (p_scanned_at AT TIME ZONE 'Asia/Manila')::time<sch.end_time) THEN RAISE EXCEPTION 'Use EARLY_OUT for an approved early departure';END IF;
 INSERT INTO public.attendance_events(id,client_event_id,person_type,person_id,event_type,actual_scan_time,scan_device_id,scanning_guard_id,verification_result,sync_status)
 VALUES(p_event_id,p_event_id,v_kind,v_id,p_event_type,p_scanned_at,p_device_id,v_guard,v_status,CASE WHEN v_status='NEEDS_REVIEW' THEN 'NEEDS_REVIEW' ELSE 'SYNCED' END);
 IF v_kind='student' AND v_status='VERIFIED' THEN INSERT INTO public.notifications(recipient_id,actor_id,type,payload) SELECT pa.profile_id,v_guard,'attendance_'||lower(p_event_type),jsonb_build_object('student_name',v_name,'student_id',v_number,'event_type',p_event_type,'actual_scan_time',p_scanned_at,'event_id',p_event_id) FROM public.student_guardians sg JOIN public.parents pa ON pa.id=sg.parent_id JOIN public.profiles pp ON pp.id=pa.profile_id WHERE sg.student_id=v_id AND sg.is_authorized AND sg.verification_status='APPROVED' AND pp.is_active;END IF;
 INSERT INTO public.audit_logs(actor_id,entity_type,entity_id,action,details) VALUES(v_guard,'attendance_event',p_event_id,'scan_recorded',jsonb_build_object('person_type',v_kind,'event_type',p_event_type,'verification_result',v_status));
 RETURN jsonb_build_object('event_id',p_event_id,'person_id',v_id,'person_type',v_kind,'full_name',v_name,'display_id',v_number,'grade_level',v_grade,'section_name',v_section,'event_type',p_event_type,'scanned_at',p_scanned_at,'status',v_status,'duplicate',FALSE);
END;$$;
REVOKE ALL ON FUNCTION public.record_attendance_scan(UUID,TEXT,TEXT,TIMESTAMPTZ,UUID) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.record_attendance_scan(UUID,TEXT,TEXT,TIMESTAMPTZ,UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.record_manual_attendance(p_event_id UUID,p_person_type TEXT,p_person_id UUID,p_event_type TEXT,p_scanned_at TIMESTAMPTZ,p_device_id UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_guard UUID:=public.current_profile_id();v_name TEXT;v_number TEXT;v_grade TEXT;v_section TEXT;v_last TEXT;v_last_at TIMESTAMPTZ;v_existing public.attendance_events%ROWTYPE;
BEGIN
 IF v_guard IS NULL OR NOT public.has_school_role('guard') OR NOT EXISTS(SELECT 1 FROM public.devices WHERE id=p_device_id AND user_id=v_guard AND NOT is_revoked) THEN RAISE EXCEPTION 'Active registered guard device required' USING ERRCODE='42501';END IF;
 IF p_event_id IS NULL OR p_person_id IS NULL OR p_scanned_at IS NULL OR p_scanned_at>NOW()+INTERVAL '5 minutes' OR p_person_type NOT IN ('student','teacher') OR p_event_type NOT IN ('ENTRY','EXIT','TEMPORARY_EXIT','RETURN') THEN RAISE EXCEPTION 'Invalid manual scan';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_event_id::text,1));SELECT * INTO v_existing FROM public.attendance_events WHERE id=p_event_id OR client_event_id=p_event_id LIMIT 1;
 IF FOUND THEN RETURN jsonb_build_object('event_id',v_existing.id,'person_id',v_existing.person_id,'person_type',v_existing.person_type,'event_type',v_existing.event_type,'scanned_at',v_existing.actual_scan_time,'status',v_existing.sync_status,'duplicate',TRUE);END IF;
 IF p_person_type='student' THEN SELECT p.full_name,s.student_id,s.grade_level,sec.name INTO v_name,v_number,v_grade,v_section FROM public.students s JOIN public.profiles p ON p.id=s.profile_id LEFT JOIN public.sections sec ON sec.id=s.section_id WHERE s.id=p_person_id AND s.status='active' AND p.is_active;
 ELSE SELECT p.full_name,t.teacher_id,t.designation,NULL INTO v_name,v_number,v_grade,v_section FROM public.teachers t JOIN public.profiles p ON p.id=t.profile_id WHERE t.id=p_person_id AND p.is_active;END IF;
 IF v_name IS NULL THEN RAISE EXCEPTION 'Person record is inactive or does not exist';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_person_id::text,2));SELECT event_type,actual_scan_time INTO v_last,v_last_at FROM public.attendance_events WHERE person_type=p_person_type AND person_id=p_person_id AND sync_status<>'NEEDS_REVIEW' ORDER BY actual_scan_time DESC,created_at DESC LIMIT 1;
 IF (p_event_type='ENTRY' AND v_last IS NOT NULL AND (NOT COALESCE(v_last IN ('EXIT','EARLY_OUT'),FALSE) OR (v_last_at AT TIME ZONE 'Asia/Manila')::date=(p_scanned_at AT TIME ZONE 'Asia/Manila')::date)) OR (p_event_type IN ('EXIT','TEMPORARY_EXIT') AND NOT COALESCE(v_last IN ('ENTRY','RETURN'),FALSE)) OR (p_event_type='RETURN' AND v_last IS DISTINCT FROM 'TEMPORARY_EXIT') THEN RAISE EXCEPTION 'Invalid gate event sequence for this person';END IF;
 IF p_event_type='EXIT' AND p_person_type='student' AND EXISTS(SELECT 1 FROM public.school_schedules sch WHERE sch.is_active AND (p_scanned_at AT TIME ZONE 'Asia/Manila')::time<sch.end_time) THEN RAISE EXCEPTION 'Use the QR scanner EARLY_OUT action for an approved early departure';END IF;
 INSERT INTO public.attendance_events(id,client_event_id,person_type,person_id,event_type,actual_scan_time,scan_device_id,scanning_guard_id,verification_result,sync_status) VALUES(p_event_id,p_event_id,p_person_type,p_person_id,p_event_type,p_scanned_at,p_device_id,v_guard,'MANUAL_VERIFIED','SYNCED');
 IF p_person_type='student' THEN INSERT INTO public.notifications(recipient_id,actor_id,type,payload) SELECT pa.profile_id,v_guard,'attendance_'||lower(p_event_type),jsonb_build_object('student_name',v_name,'student_id',v_number,'event_type',p_event_type,'actual_scan_time',p_scanned_at,'event_id',p_event_id) FROM public.student_guardians sg JOIN public.parents pa ON pa.id=sg.parent_id JOIN public.profiles pp ON pp.id=pa.profile_id WHERE sg.student_id=p_person_id AND sg.is_authorized AND sg.verification_status='APPROVED' AND pp.is_active;END IF;
 INSERT INTO public.audit_logs(actor_id,entity_type,entity_id,action,details) VALUES(v_guard,'attendance_event',p_event_id,'manual_scan_recorded',jsonb_build_object('person_type',p_person_type,'event_type',p_event_type));
 RETURN jsonb_build_object('event_id',p_event_id,'person_id',p_person_id,'person_type',p_person_type,'display_id',v_number,'full_name',v_name,'grade_level',v_grade,'section_name',v_section,'event_type',p_event_type,'scanned_at',p_scanned_at,'status','SYNCED','duplicate',FALSE);
END;$$;
REVOKE ALL ON FUNCTION public.record_manual_attendance(UUID,TEXT,UUID,TEXT,TIMESTAMPTZ,UUID) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.record_manual_attendance(UUID,TEXT,UUID,TEXT,TIMESTAMPTZ,UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_guard_student_snapshot(p_student_id UUID)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v JSONB;
BEGIN
 IF NOT public.has_school_role('guard') THEN RAISE EXCEPTION 'Guard access required' USING ERRCODE='42501';END IF;
 SELECT jsonb_build_object(
  'student_id',s.student_id,'full_name',p.full_name,'grade_level',s.grade_level,'section_name',sec.name,'enrollment_status',s.status,'contact_number',p.phone,
  'guardian_name',pd.guardian_full_name,'guardian_contact',pd.guardian_contact_number,
  'today_attendance',(SELECT jsonb_build_object('status',d.status,'entry_time',d.entry_time,'exit_time',d.exit_time) FROM public.attendance_daily_summaries d WHERE d.student_id=s.id AND d.summary_date=(NOW() AT TIME ZONE 'Asia/Manila')::date LIMIT 1),
  'inside_campus',(SELECT e.event_type IN ('ENTRY','RETURN') FROM public.attendance_events e WHERE e.person_type='student' AND e.person_id=s.id AND e.sync_status<>'NEEDS_REVIEW' ORDER BY e.actual_scan_time DESC,e.created_at DESC LIMIT 1),
  'recent_gate_activity',(SELECT COALESCE(jsonb_agg(jsonb_build_object('event_type',e.event_type,'actual_scan_time',e.actual_scan_time,'sync_status',e.sync_status) ORDER BY e.actual_scan_time DESC),'[]'::jsonb) FROM (SELECT * FROM public.attendance_events WHERE person_type='student' AND person_id=s.id ORDER BY actual_scan_time DESC LIMIT 8)e),
  'approved_early_outs',(SELECT COALESCE(jsonb_agg(jsonb_build_object('id',r.id,'requested_departure',r.requested_departure,'status',r.status,'reason',r.reason,'approved_departure_date',r.approved_departure_date,'approved_departure_start',r.approved_departure_start,'approved_departure_end',r.approved_departure_end,'expires_at',r.expires_at) ORDER BY r.approved_departure_start),'[]'::jsonb) FROM public.early_out_requests r WHERE r.student_id=s.id AND r.status='APPROVED' AND r.expires_at>=NOW())
 ) INTO v FROM public.students s JOIN public.profiles p ON p.id=s.profile_id LEFT JOIN public.sections sec ON sec.id=s.section_id LEFT JOIN public.student_private_details pd ON pd.student_id=s.id WHERE s.id=p_student_id AND p.is_active;
 RETURN v;
END;$$;
REVOKE ALL ON FUNCTION public.get_guard_student_snapshot(UUID) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.get_guard_student_snapshot(UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_guard_dashboard_metrics()
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v JSONB;
BEGIN
 IF NOT public.has_school_role('guard') THEN RAISE EXCEPTION 'Guard access required' USING ERRCODE='42501';END IF;
 SELECT jsonb_build_object(
  'entries_today',(SELECT count(*) FROM public.attendance_events WHERE actual_scan_time >= (NOW() AT TIME ZONE 'Asia/Manila')::date::timestamp AT TIME ZONE 'Asia/Manila' AND actual_scan_time < ((NOW() AT TIME ZONE 'Asia/Manila')::date+1)::timestamp AT TIME ZONE 'Asia/Manila' AND event_type='ENTRY' AND sync_status<>'NEEDS_REVIEW'),
  'exits_today',(SELECT count(*) FROM public.attendance_events WHERE actual_scan_time >= (NOW() AT TIME ZONE 'Asia/Manila')::date::timestamp AT TIME ZONE 'Asia/Manila' AND actual_scan_time < ((NOW() AT TIME ZONE 'Asia/Manila')::date+1)::timestamp AT TIME ZONE 'Asia/Manila' AND event_type IN ('EXIT','EARLY_OUT','TEMPORARY_EXIT') AND sync_status<>'NEEDS_REVIEW'),
  'early_outs_today',(SELECT count(*) FROM public.attendance_events WHERE actual_scan_time >= (NOW() AT TIME ZONE 'Asia/Manila')::date::timestamp AT TIME ZONE 'Asia/Manila' AND actual_scan_time < ((NOW() AT TIME ZONE 'Asia/Manila')::date+1)::timestamp AT TIME ZONE 'Asia/Manila' AND event_type='EARLY_OUT' AND sync_status='SYNCED'),
  'inside_count',(SELECT count(*) FROM (SELECT DISTINCT ON(person_id) person_id,event_type FROM public.attendance_events WHERE person_type='student' AND sync_status<>'NEEDS_REVIEW' ORDER BY person_id,actual_scan_time DESC) q WHERE event_type IN ('ENTRY','RETURN')),
  'visitors_inside',(SELECT count(*) FROM public.visitor_logs WHERE authorization_status='APPROVED' AND (actual_entry_time IS NOT NULL OR visitor_request_id IS NOT NULL) AND actual_departure_time IS NULL),
  'pending_visitors',(SELECT count(*) FROM public.visitor_logs WHERE authorization_status='PENDING' AND requester_guard_id IS NOT NULL)+(SELECT count(*) FROM public.visitor_requests WHERE status='PENDING' AND visit_date >= (NOW() AT TIME ZONE 'Asia/Manila')::date)
 ) INTO v;RETURN v;
END;$$;
REVOKE ALL ON FUNCTION public.get_guard_dashboard_metrics() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.get_guard_dashboard_metrics() TO authenticated;

DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_publication WHERE pubname='supabase_realtime') AND NOT EXISTS(SELECT 1 FROM pg_publication_tables WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='early_out_requests') THEN ALTER PUBLICATION supabase_realtime ADD TABLE public.early_out_requests;END IF;
END $$;

-- Old EXIT actions must not consume an early-out request. Require the distinct transaction type.
CREATE OR REPLACE FUNCTION public.prevent_early_out_as_regular_exit()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NEW.event_type='EXIT' AND NEW.person_type='student' AND EXISTS(SELECT 1 FROM public.school_schedules s WHERE s.is_active AND (NEW.actual_scan_time AT TIME ZONE 'Asia/Manila')::time<s.end_time) THEN
    RAISE EXCEPTION 'Use the EARLY_OUT gate action for an approved early departure';
  END IF;
  RETURN NEW;
END;$$;
REVOKE ALL ON FUNCTION public.prevent_early_out_as_regular_exit() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS prevent_early_out_as_regular_exit ON public.attendance_events;
CREATE TRIGGER prevent_early_out_as_regular_exit BEFORE INSERT ON public.attendance_events FOR EACH ROW EXECUTE FUNCTION public.prevent_early_out_as_regular_exit();

-- Parent notification validation also accepts the distinct EARLY_OUT event type.
CREATE OR REPLACE FUNCTION public.prepare_parent_attendance_notification()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_event UUID;v_student UUID;v_event_type TEXT;v_name TEXT;v_time TIMESTAMPTZ;v_allowed BOOLEAN;v_title TEXT;v_verb TEXT;
BEGIN
 IF NEW.type NOT IN ('attendance_entry','attendance_exit','attendance_temporary_exit','attendance_return','attendance_early_out') THEN RETURN NEW;END IF;
 v_event:=NULLIF(NEW.payload->>'event_id','')::UUID;v_event_type:=upper(NEW.payload->>'event_type');v_time:=NULLIF(NEW.payload->>'actual_scan_time','')::TIMESTAMPTZ;
 SELECT e.person_id,p.full_name INTO v_student,v_name FROM public.attendance_events e JOIN public.students s ON s.id=e.person_id JOIN public.profiles p ON p.id=s.profile_id
 WHERE e.id=v_event AND e.person_type='student' AND e.event_type=v_event_type AND e.sync_status='SYNCED' AND e.verification_result IN ('VERIFIED','MANUAL_VERIFIED');
 IF v_student IS NULL OR v_time IS NULL OR NOT EXISTS(SELECT 1 FROM public.student_guardians sg JOIN public.parents pa ON pa.id=sg.parent_id JOIN public.profiles pp ON pp.id=pa.profile_id JOIN auth.users u ON u.id=pp.auth_user_id WHERE sg.student_id=v_student AND pa.profile_id=NEW.recipient_id AND sg.is_authorized AND sg.verification_status='APPROVED' AND pp.is_active AND u.email_confirmed_at IS NOT NULL) THEN RETURN NULL;END IF;
 SELECT CASE v_event_type WHEN 'TEMPORARY_EXIT' THEN COALESCE(pref.temporary_exit_enabled,FALSE) WHEN 'RETURN' THEN COALESCE(pref.return_enabled,FALSE) ELSE TRUE END INTO v_allowed
 FROM public.parents pa LEFT JOIN public.parent_notification_preferences pref ON pref.parent_id=pa.id WHERE pa.profile_id=NEW.recipient_id;
 IF NOT COALESCE(v_allowed,FALSE) OR EXISTS(SELECT 1 FROM public.notifications n WHERE n.recipient_id=NEW.recipient_id AND n.type=NEW.type AND n.payload->>'event_id'=v_event::text) THEN RETURN NULL;END IF;
 v_title:=CASE v_event_type WHEN 'ENTRY' THEN 'Your child has arrived at school.' WHEN 'EXIT' THEN 'Your child has left the school.' WHEN 'EARLY_OUT' THEN 'Your child has left school early.' WHEN 'TEMPORARY_EXIT' THEN 'Your child has temporarily left school.' ELSE 'Your child has returned to school.' END;
 v_verb:=CASE v_event_type WHEN 'ENTRY' THEN 'entered' WHEN 'EXIT' THEN 'exited' WHEN 'EARLY_OUT' THEN 'left early' WHEN 'TEMPORARY_EXIT' THEN 'temporarily left' ELSE 'returned to' END;
 NEW.payload:=NEW.payload||jsonb_build_object('title',v_title,'message',v_name||' '||v_verb||' school at '||to_char(v_time AT TIME ZONE 'Asia/Manila','FMHH12:MI AM')||' on '||to_char(v_time AT TIME ZONE 'Asia/Manila','Mon DD, YYYY')||'.','category','attendance','student_name',v_name,'actual_scan_time',v_time,'event_id',v_event);
 RETURN NEW;
END;$$;

CREATE OR REPLACE FUNCTION public.notify_parent_request_update()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_parent RECORD;v_student_name TEXT;v_enabled BOOLEAN;v_type TEXT:=TG_ARGV[0];v_event_name TEXT;v_status TEXT:=to_jsonb(NEW)->>'status';v_old TEXT;
BEGIN
 IF TG_OP='UPDATE' THEN v_old:=to_jsonb(OLD)->>'status';IF v_old IS NOT DISTINCT FROM v_status THEN RETURN NEW;END IF;END IF;
 IF v_type='early_out' AND v_status IN ('USED','EXPIRED') THEN RETURN NEW;END IF;
 SELECT p.full_name INTO v_student_name FROM public.students s JOIN public.profiles p ON p.id=s.profile_id WHERE s.id=(to_jsonb(NEW)->>'student_id')::UUID;
 v_event_name:=CASE v_type WHEN 'early_out' THEN 'early-out request' ELSE 'visitor request' END;
 FOR v_parent IN SELECT pa.id AS parent_id,pa.profile_id FROM public.student_guardians sg JOIN public.parents pa ON pa.id=sg.parent_id JOIN public.profiles pr ON pr.id=pa.profile_id JOIN auth.users u ON u.id=pr.auth_user_id WHERE sg.student_id=(to_jsonb(NEW)->>'student_id')::UUID AND sg.is_authorized AND sg.verification_status='APPROVED' AND pr.is_active AND u.email_confirmed_at IS NOT NULL LOOP
   SELECT CASE WHEN v_type='early_out' THEN COALESCE(pref.early_out_enabled,TRUE) ELSE COALESCE(pref.visitor_enabled,TRUE) END INTO v_enabled FROM public.parent_notification_preferences pref WHERE pref.parent_id=v_parent.parent_id;
   IF COALESCE(v_enabled,TRUE) THEN INSERT INTO public.notifications(recipient_id,actor_id,type,payload) SELECT v_parent.profile_id,public.current_profile_id(),'parent_'||v_type||'_'||lower(v_status),jsonb_build_object('request_id',to_jsonb(NEW)->>'id','student_name',v_student_name,'status',v_status,'category','requests','title',initcap(v_event_name)||' update','message','Update: your child''s '||v_event_name||' is now '||lower(v_status)||'.') WHERE NOT EXISTS(SELECT 1 FROM public.notifications n WHERE n.recipient_id=v_parent.profile_id AND n.type='parent_'||v_type||'_'||lower(v_status) AND n.payload->>'request_id'=to_jsonb(NEW)->>'id');END IF;
 END LOOP;
 RETURN NEW;
END;$$;

-- The legacy status trigger notified parents without checking preferences. Keep the student
-- decision notice, while the preference-aware trigger above handles verified guardians.
DROP TRIGGER IF EXISTS early_out_request_status_notification ON public.early_out_requests;
CREATE OR REPLACE FUNCTION public.notify_student_early_out_decision()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_profile UUID;v_name TEXT;
BEGIN
 IF NEW.status NOT IN ('APPROVED','REJECTED') OR OLD.status IS NOT DISTINCT FROM NEW.status THEN RETURN NEW;END IF;
 SELECT s.profile_id,p.full_name INTO v_profile,v_name FROM public.students s JOIN public.profiles p ON p.id=s.profile_id WHERE s.id=NEW.student_id;
 INSERT INTO public.notifications(recipient_id,actor_id,type,payload)
 VALUES(v_profile,NEW.reviewed_by,'early_out_'||lower(NEW.status),jsonb_build_object('request_id',NEW.id,'status',NEW.status,'student_name',v_name,'approved_departure_date',NEW.approved_departure_date,'approved_departure_start',NEW.approved_departure_start,'approved_departure_end',NEW.approved_departure_end,'category','requests','title','Early-out request update','message','Your early-out request was '||lower(NEW.status)||'.'));
 RETURN NEW;
END;$$;
REVOKE ALL ON FUNCTION public.notify_student_early_out_decision() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER early_out_student_decision_notification AFTER UPDATE OF status ON public.early_out_requests FOR EACH ROW EXECUTE FUNCTION public.notify_student_early_out_decision();

DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_publication WHERE pubname='supabase_realtime') AND NOT EXISTS(SELECT 1 FROM pg_publication_tables WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='attendance_events') THEN ALTER PUBLICATION supabase_realtime ADD TABLE public.attendance_events;END IF;
END $$;
