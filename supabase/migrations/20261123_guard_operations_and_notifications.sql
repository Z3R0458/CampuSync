-- Complete the guard workflow while keeping walk-in approvals administrator-only.
ALTER TABLE public.visitor_logs
  ADD COLUMN IF NOT EXISTS requester_guard_id UUID REFERENCES public.profiles(id),
  ADD COLUMN IF NOT EXISTS decision_by UUID REFERENCES public.profiles(id),
  ADD COLUMN IF NOT EXISTS decision_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS decision_remarks TEXT,
  ADD COLUMN IF NOT EXISTS requested_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS actual_entry_time TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS visitor_remarks TEXT;

DROP POLICY IF EXISTS visitor_logs_insert_guard ON public.visitor_logs;
CREATE POLICY visitor_logs_insert_guard ON public.visitor_logs FOR INSERT TO authenticated
  WITH CHECK (false); -- walk-ins must use register_walkin_visitor()
DROP POLICY IF EXISTS visitor_logs_update_guard_staff_admin ON public.visitor_logs;
DROP POLICY IF EXISTS visitor_logs_read_staff_guard_admin ON public.visitor_logs;
DROP POLICY IF EXISTS "visitor_logs_read_staff_guard_admin" ON public.visitor_logs;
DROP POLICY IF EXISTS visitor_logs_read_admin_guard_student ON public.visitor_logs;
CREATE POLICY visitor_logs_read_admin_guard_student ON public.visitor_logs FOR SELECT TO authenticated
  USING (public.has_school_role('administrator') OR public.has_school_role('guard') OR
    student_id IN (SELECT id FROM public.students WHERE profile_id=public.current_profile_id()));

CREATE OR REPLACE FUNCTION public.register_walkin_visitor(
  p_visitor_name TEXT,p_contact_number TEXT,p_identification_details TEXT,p_relationship TEXT,
  p_student_id UUID,p_purpose TEXT,p_person_contacted TEXT DEFAULT NULL,p_remarks TEXT DEFAULT NULL,p_request_id UUID DEFAULT NULL
) RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_guard UUID:=public.current_profile_id();v_id UUID:=COALESCE(p_request_id,pg_catalog.gen_random_uuid());v_student_name TEXT;
BEGIN
  IF v_guard IS NULL OR NOT public.has_school_role('guard') THEN RAISE EXCEPTION 'Guard access required' USING ERRCODE='42501';END IF;
  IF EXISTS(SELECT 1 FROM public.visitor_logs WHERE id=v_id AND requester_guard_id=v_guard) THEN RETURN v_id;END IF;
  IF length(trim(COALESCE(p_visitor_name,''))) NOT BETWEEN 2 AND 120 OR length(trim(COALESCE(p_purpose,''))) NOT BETWEEN 2 AND 500 THEN RAISE EXCEPTION 'Visitor name and purpose are required';END IF;
  IF p_student_id IS NOT NULL THEN SELECT p.full_name INTO v_student_name FROM public.students s JOIN public.profiles p ON p.id=s.profile_id WHERE s.id=p_student_id AND s.status='active';IF v_student_name IS NULL THEN RAISE EXCEPTION 'Student not found or inactive';END IF;END IF;
  INSERT INTO public.visitor_logs(id,visitor_name,contact_number,identification_details,relationship_to_student,student_id,purpose,visit_date,authorization_status,actual_departure_time,requester_guard_id,requested_at,person_contacted,visitor_remarks)
  VALUES(v_id,trim(p_visitor_name),NULLIF(trim(p_contact_number),''),NULLIF(trim(p_identification_details),''),NULLIF(trim(p_relationship),''),p_student_id,trim(p_purpose),NOW(),'PENDING',NULL,v_guard,NOW(),COALESCE(v_student_name,NULLIF(trim(p_person_contacted),'')),NULLIF(trim(p_remarks),''));
  INSERT INTO public.audit_logs(actor_id,entity_type,entity_id,entity_label,action,module,description,new_values,status)
  VALUES(v_guard,'walkin_visitor',v_id,trim(p_visitor_name),'walkin_visitor_submitted','gate','Guard submitted a walk-in visitor for administrator review',jsonb_build_object('student_id',p_student_id,'purpose',trim(p_purpose),'status','PENDING'),'success');
  INSERT INTO public.notifications(recipient_id,actor_id,type,payload)
  SELECT id,v_guard,'walkin_visitor_pending',jsonb_build_object('request_id',v_id,'visitor_name',trim(p_visitor_name),'student_name',v_student_name,'message','A walk-in visitor is awaiting authorization.') FROM public.profiles WHERE role='administrator' AND is_active
  AND NOT EXISTS(SELECT 1 FROM public.notifications n WHERE n.recipient_id=profiles.id AND n.type='walkin_visitor_pending' AND n.payload->>'request_id'=v_id::text);
  RETURN v_id;
END;$$;
REVOKE ALL ON FUNCTION public.register_walkin_visitor(TEXT,TEXT,TEXT,TEXT,UUID,TEXT,TEXT,TEXT,UUID) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.register_walkin_visitor(TEXT,TEXT,TEXT,TEXT,UUID,TEXT,TEXT,TEXT,UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.review_walkin_visitor(p_log_id UUID,p_status TEXT,p_remarks TEXT DEFAULT NULL)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_admin UUID:=public.current_profile_id();v_guard UUID;v_name TEXT;v_student UUID;v_old TEXT;
BEGIN
  IF v_admin IS NULL OR NOT public.has_school_role('administrator') THEN RAISE EXCEPTION 'Administrator access required' USING ERRCODE='42501';END IF;
  IF p_status NOT IN ('APPROVED','DENIED','REQUEST_INFO') THEN RAISE EXCEPTION 'Decision must be APPROVED, DENIED, or REQUEST_INFO';END IF;
  UPDATE public.visitor_logs SET authorization_status=CASE WHEN p_status='REQUEST_INFO' THEN 'PENDING' ELSE p_status END,decision_by=v_admin,decision_at=NOW(),decision_remarks=NULLIF(trim(p_remarks),''),updated_at=NOW()
  WHERE id=p_log_id AND requester_guard_id IS NOT NULL AND authorization_status='PENDING'
  RETURNING requester_guard_id,visitor_name,student_id INTO v_guard,v_name,v_student;
  IF NOT FOUND THEN RAISE EXCEPTION 'Pending walk-in request not found' USING ERRCODE='P0002';END IF;
  INSERT INTO public.audit_logs(actor_id,entity_type,entity_id,entity_label,action,module,description,new_values,status)
  VALUES(v_admin,'walkin_visitor',p_log_id,v_name,'walkin_visitor_'||lower(p_status),'gate','Administrator decided a walk-in visitor request',jsonb_build_object('status',p_status,'remarks',p_remarks,'student_id',v_student),'success');
  INSERT INTO public.notifications(recipient_id,actor_id,type,payload) VALUES(v_guard,v_admin,'walkin_visitor_decision',jsonb_build_object('request_id',p_log_id,'status',p_status,'remarks',p_remarks,'visitor_name',v_name,'message',CASE WHEN p_status='REQUEST_INFO' THEN 'Administrator requested more information about this walk-in visitor.' ELSE 'Walk-in visitor request was '||lower(p_status)||'.' END));
  RETURN p_log_id;
END;$$;
REVOKE ALL ON FUNCTION public.review_walkin_visitor(UUID,TEXT,TEXT) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.review_walkin_visitor(UUID,TEXT,TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION public.guard_checkin_walkin(p_log_id UUID)
RETURNS TIMESTAMPTZ LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_now TIMESTAMPTZ:=NOW();v_name TEXT;v_student UUID;v_guard UUID:=public.current_profile_id();
BEGIN
  IF v_guard IS NULL OR NOT public.has_school_role('guard') THEN RAISE EXCEPTION 'Guard access required' USING ERRCODE='42501';END IF;
  UPDATE public.visitor_logs SET actual_entry_time=v_now,visit_date=v_now,updated_at=v_now
  WHERE id=p_log_id AND requester_guard_id=v_guard AND authorization_status='APPROVED' AND actual_entry_time IS NULL AND actual_departure_time IS NULL
  RETURNING visitor_name,student_id INTO v_name,v_student;
  IF NOT FOUND THEN RAISE EXCEPTION 'Visitor is not approved for entry or already checked in' USING ERRCODE='P0002';END IF;
  INSERT INTO public.audit_logs(actor_id,entity_type,entity_id,entity_label,action,module,description,new_values,status)
  VALUES(v_guard,'walkin_visitor',p_log_id,v_name,'walkin_visitor_checkin','gate','Guard recorded walk-in visitor arrival',jsonb_build_object('student_id',v_student,'entry_time',v_now),'success');
  INSERT INTO public.notifications(recipient_id,actor_id,type,payload)
  SELECT recipients.profile_id,v_guard,'visitor_arrived',jsonb_build_object('visitor_name',v_name,'request_id',p_log_id,'message','A walk-in visitor has checked in.') FROM (
    SELECT s.profile_id FROM public.students s WHERE s.id=v_student
    UNION SELECT pa.profile_id FROM public.student_guardians sg JOIN public.parents pa ON pa.id=sg.parent_id WHERE sg.student_id=v_student AND sg.is_authorized
  ) recipients WHERE recipients.profile_id IS NOT NULL;
  RETURN v_now;
END;$$;
REVOKE ALL ON FUNCTION public.guard_checkin_walkin(UUID) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.guard_checkin_walkin(UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.guard_record_visitor_exit(p_log_id UUID)
RETURNS TIMESTAMPTZ LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_departure TIMESTAMPTZ:=NOW();v_visitor TEXT;v_student UUID;v_guard UUID:=public.current_profile_id();
BEGIN
 IF v_guard IS NULL OR NOT public.has_school_role('guard') THEN RAISE EXCEPTION 'Guard access required' USING ERRCODE='42501';END IF;
 UPDATE public.visitor_logs SET actual_departure_time=v_departure,updated_at=v_departure
 WHERE id=p_log_id AND authorization_status='APPROVED' AND actual_departure_time IS NULL AND (actual_entry_time IS NOT NULL OR visitor_request_id IS NOT NULL)
 RETURNING visitor_name,student_id INTO v_visitor,v_student;
 IF NOT FOUND THEN RAISE EXCEPTION 'Visitor is not checked in or has already exited' USING ERRCODE='P0002';END IF;
 INSERT INTO public.audit_logs(actor_id,entity_type,entity_id,entity_label,action,module,description,new_values,status)
 VALUES(v_guard,'visitor_log',p_log_id,v_visitor,'visitor_exit_recorded','gate','Guard recorded visitor departure',jsonb_build_object('student_id',v_student,'actual_departure_time',v_departure),'success');
 INSERT INTO public.notifications(recipient_id,actor_id,type,payload)
 SELECT recipients.profile_id,v_guard,'visitor_departed',jsonb_build_object('visitor_name',v_visitor,'request_id',p_log_id,'message','A visitor has checked out.') FROM (
   SELECT s.profile_id FROM public.students s WHERE s.id=v_student
   UNION SELECT pa.profile_id FROM public.student_guardians sg JOIN public.parents pa ON pa.id=sg.parent_id WHERE sg.student_id=v_student AND sg.is_authorized
 ) recipients WHERE recipients.profile_id IS NOT NULL;
 RETURN v_departure;
END;$$;
REVOKE ALL ON FUNCTION public.guard_record_visitor_exit(UUID) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.guard_record_visitor_exit(UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.search_guard_students(p_query TEXT)
RETURNS TABLE(student_id UUID,school_student_id TEXT,full_name TEXT,grade_level TEXT,section_name TEXT,enrollment_status TEXT)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT public.has_school_role('guard') THEN RAISE EXCEPTION 'Guard access required' USING ERRCODE='42501';END IF;
  RETURN QUERY SELECT s.id,s.student_id,p.full_name,s.grade_level,sec.name,s.status FROM public.students s JOIN public.profiles p ON p.id=s.profile_id LEFT JOIN public.sections sec ON sec.id=s.section_id
  WHERE p.is_active AND s.status='active' AND (p_query IS NULL OR trim(p_query)='' OR s.student_id ILIKE '%'||trim(p_query)||'%' OR p.full_name ILIKE '%'||trim(p_query)||'%')
  ORDER BY p.full_name LIMIT 30;
END;$$;
REVOKE ALL ON FUNCTION public.search_guard_students(TEXT) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.search_guard_students(TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION public.list_guard_expected_visitors()
RETURNS TABLE(request_id UUID,visitor_name TEXT,visitor_relationship TEXT,contact_number TEXT,student_id UUID,school_student_id TEXT,student_name TEXT,grade_level TEXT,section_name TEXT,visit_date DATE,expected_arrival_time TIME,expected_departure_time TIME,purpose TEXT,visitor_id_type TEXT)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
 IF NOT public.has_school_role('guard') THEN RAISE EXCEPTION 'Guard access required' USING ERRCODE='42501';END IF;
 RETURN QUERY SELECT r.id,r.visitor_name,r.visitor_relationship,r.contact_number,r.student_id,s.student_id,p.full_name,s.grade_level,sec.name,r.visit_date,r.expected_arrival_time,r.expected_departure_time,r.purpose,r.visitor_id_type
 FROM public.visitor_requests r JOIN public.students s ON s.id=r.student_id JOIN public.profiles p ON p.id=s.profile_id LEFT JOIN public.sections sec ON sec.id=s.section_id
 WHERE r.status='APPROVED' AND r.visit_date=(NOW() AT TIME ZONE 'Asia/Manila')::date ORDER BY r.expected_arrival_time;
END;$$;
REVOKE ALL ON FUNCTION public.list_guard_expected_visitors() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.list_guard_expected_visitors() TO authenticated;

CREATE OR REPLACE FUNCTION public.get_guard_student_snapshot(p_student_id UUID)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v JSONB;
BEGIN
  IF NOT public.has_school_role('guard') THEN RAISE EXCEPTION 'Guard access required' USING ERRCODE='42501';END IF;
  SELECT jsonb_build_object(
    'student_id',s.id,'school_student_id',s.student_id,'full_name',p.full_name,'grade_level',s.grade_level,'section_name',sec.name,'enrollment_status',s.status,'contact_number',p.phone,
    'guardian_name',pd.guardian_full_name,'guardian_contact',pd.guardian_contact_number,
    'today_attendance', (SELECT jsonb_build_object('status',d.status,'entry_time',d.entry_time,'exit_time',d.exit_time) FROM public.attendance_daily_summaries d WHERE d.student_id=s.id AND d.summary_date=(NOW() AT TIME ZONE 'Asia/Manila')::date LIMIT 1),
    'inside_campus',(SELECT e.event_type IN ('ENTRY','RETURN') FROM public.attendance_events e WHERE e.person_type='student' AND e.person_id=s.id AND e.sync_status<>'NEEDS_REVIEW' ORDER BY e.actual_scan_time DESC LIMIT 1),
    'recent_gate_activity',(SELECT COALESCE(jsonb_agg(jsonb_build_object('event_type',e.event_type,'actual_scan_time',e.actual_scan_time,'sync_status',e.sync_status) ORDER BY e.actual_scan_time DESC),'[]'::jsonb) FROM (SELECT * FROM public.attendance_events WHERE person_type='student' AND person_id=s.id ORDER BY actual_scan_time DESC LIMIT 8)e),
    'approved_early_outs',(SELECT COALESCE(jsonb_agg(jsonb_build_object('id',r.id,'requested_departure',r.requested_departure,'status',r.status,'reason',r.reason) ORDER BY r.requested_departure),'[]'::jsonb) FROM public.early_out_requests r WHERE r.student_id=s.id AND r.status='APPROVED' AND (r.requested_departure AT TIME ZONE 'Asia/Manila')::date>=(NOW() AT TIME ZONE 'Asia/Manila')::date)
  ) INTO v FROM public.students s JOIN public.profiles p ON p.id=s.profile_id LEFT JOIN public.sections sec ON sec.id=s.section_id LEFT JOIN public.student_private_details pd ON pd.student_id=s.id WHERE s.id=p_student_id AND p.is_active;
  RETURN v;
END;$$;
REVOKE ALL ON FUNCTION public.get_guard_student_snapshot(UUID) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.get_guard_student_snapshot(UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.preview_guard_qr(p_qr_token TEXT)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_person JSONB;v_id UUID;v_type TEXT;
BEGIN
 IF NOT public.has_school_role('guard') THEN RAISE EXCEPTION 'Guard access required' USING ERRCODE='42501';END IF;
 IF p_qr_token IS NULL OR length(p_qr_token)<32 OR length(p_qr_token)>256 THEN RAISE EXCEPTION 'Invalid QR code' USING ERRCODE='22023';END IF;
 SELECT q.student_id,'student' INTO v_id,v_type FROM public.student_qr_codes q JOIN public.students s ON s.id=q.student_id JOIN public.profiles p ON p.id=s.profile_id WHERE q.token_hash=pg_catalog.encode(extensions.digest(p_qr_token,'sha256'),'hex') AND q.is_active AND s.status='active' AND p.is_active LIMIT 1;
 IF v_id IS NULL THEN SELECT q.teacher_id,'teacher' INTO v_id,v_type FROM public.teacher_qr_codes q JOIN public.teachers t ON t.id=q.teacher_id JOIN public.profiles p ON p.id=t.profile_id WHERE q.token_hash=pg_catalog.encode(extensions.digest(p_qr_token,'sha256'),'hex') AND q.is_active AND p.is_active LIMIT 1;END IF;
 IF v_id IS NULL THEN RAISE EXCEPTION 'QR code is invalid, revoked, expired, or the account is inactive' USING ERRCODE='22023';END IF;
 IF v_type='student' THEN
   SELECT jsonb_build_object('person_id',s.id,'person_type','student','display_id',s.student_id,'full_name',p.full_name,'grade_level',s.grade_level,'section_name',sec.name,'student_details',public.get_guard_student_snapshot(s.id)) INTO v_person FROM public.students s JOIN public.profiles p ON p.id=s.profile_id LEFT JOIN public.sections sec ON sec.id=s.section_id WHERE s.id=v_id;
 ELSE SELECT jsonb_build_object('person_id',t.id,'person_type','teacher','display_id',t.teacher_id,'full_name',p.full_name,'grade_level',t.designation) INTO v_person FROM public.teachers t JOIN public.profiles p ON p.id=t.profile_id WHERE t.id=v_id;END IF;
 RETURN v_person;
END;$$;
REVOKE ALL ON FUNCTION public.preview_guard_qr(TEXT) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.preview_guard_qr(TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_guard_dashboard_metrics()
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v JSONB;
BEGIN
 IF NOT public.has_school_role('guard') THEN RAISE EXCEPTION 'Guard access required' USING ERRCODE='42501';END IF;
 SELECT jsonb_build_object(
  'entries_today',(SELECT count(*) FROM public.attendance_events WHERE actual_scan_time >= (NOW() AT TIME ZONE 'Asia/Manila')::date::timestamp AT TIME ZONE 'Asia/Manila' AND actual_scan_time < ((NOW() AT TIME ZONE 'Asia/Manila')::date+1)::timestamp AT TIME ZONE 'Asia/Manila' AND event_type='ENTRY' AND sync_status<>'NEEDS_REVIEW'),
  'exits_today',(SELECT count(*) FROM public.attendance_events WHERE actual_scan_time >= (NOW() AT TIME ZONE 'Asia/Manila')::date::timestamp AT TIME ZONE 'Asia/Manila' AND actual_scan_time < ((NOW() AT TIME ZONE 'Asia/Manila')::date+1)::timestamp AT TIME ZONE 'Asia/Manila' AND event_type IN ('EXIT','TEMPORARY_EXIT') AND sync_status<>'NEEDS_REVIEW'),
  'inside_count',(SELECT count(*) FROM (SELECT DISTINCT ON(person_id) person_id,event_type FROM public.attendance_events WHERE person_type='student' AND sync_status<>'NEEDS_REVIEW' ORDER BY person_id,actual_scan_time DESC) q WHERE event_type IN ('ENTRY','RETURN')),
  'visitors_inside',(SELECT count(*) FROM public.visitor_logs WHERE authorization_status='APPROVED' AND (actual_entry_time IS NOT NULL OR visitor_request_id IS NOT NULL) AND actual_departure_time IS NULL),
  'pending_visitors',(SELECT count(*) FROM public.visitor_logs WHERE authorization_status='PENDING' AND requester_guard_id IS NOT NULL)+(SELECT count(*) FROM public.visitor_requests WHERE status='PENDING' AND visit_date >= (NOW() AT TIME ZONE 'Asia/Manila')::date)
 ) INTO v;RETURN v;
END;$$;
REVOKE ALL ON FUNCTION public.get_guard_dashboard_metrics() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.get_guard_dashboard_metrics() TO authenticated;

-- Approved student permissions are operationally relevant to guards.
CREATE OR REPLACE FUNCTION public.notify_guard_request_approval()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_name TEXT;v_type TEXT:=TG_ARGV[0];v_actor UUID;
BEGIN
  IF NEW.status='APPROVED' AND OLD.status IS DISTINCT FROM NEW.status THEN
    SELECT p.full_name INTO v_name FROM public.students s JOIN public.profiles p ON p.id=s.profile_id WHERE s.id=NEW.student_id;
    v_actor:=COALESCE(NULLIF(to_jsonb(NEW)->>'reviewed_by','')::UUID,NULLIF(to_jsonb(NEW)->>'approved_by','')::UUID);
    INSERT INTO public.notifications(recipient_id,actor_id,type,payload)
    SELECT g.id,v_actor,'gate_permission_approved',jsonb_build_object('request_type',v_type,'request_id',NEW.id,'student_name',v_name,'student_id',NEW.student_id,'message','An approved student gate permission is available.')
    FROM public.profiles g WHERE g.role='guard' AND g.is_active
    AND NOT EXISTS(SELECT 1 FROM public.notifications n WHERE n.recipient_id=g.id AND n.type='gate_permission_approved' AND n.payload->>'request_id'=NEW.id::text);
  END IF;RETURN NEW;
END;$$;
REVOKE ALL ON FUNCTION public.notify_guard_request_approval() FROM PUBLIC;
DROP TRIGGER IF EXISTS notify_guard_early_out_approved ON public.early_out_requests;
CREATE TRIGGER notify_guard_early_out_approved AFTER UPDATE OF status ON public.early_out_requests FOR EACH ROW EXECUTE FUNCTION public.notify_guard_request_approval('early_out');
DROP TRIGGER IF EXISTS notify_guard_visitor_approved ON public.visitor_requests;
CREATE TRIGGER notify_guard_visitor_approved AFTER UPDATE OF status ON public.visitor_requests FOR EACH ROW EXECUTE FUNCTION public.notify_guard_request_approval('visitor');

CREATE OR REPLACE FUNCTION public.notify_guard_announcement()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
 IF NEW.status='published' AND (TG_OP='INSERT' OR OLD.status IS DISTINCT FROM NEW.status) AND NEW.audience IN ('all','guard') THEN
   INSERT INTO public.notifications(recipient_id,actor_id,type,payload)
   SELECT g.id,NEW.created_by,'announcement_published',jsonb_build_object('announcement_id',NEW.id,'title',NEW.title,'message','A new school announcement is available.') FROM public.profiles g WHERE g.role='guard' AND g.is_active
   AND NOT EXISTS(SELECT 1 FROM public.notifications n WHERE n.recipient_id=g.id AND n.type='announcement_published' AND n.payload->>'announcement_id'=NEW.id::text);
 END IF;RETURN NEW;
END;$$;
REVOKE ALL ON FUNCTION public.notify_guard_announcement() FROM PUBLIC;
DROP TRIGGER IF EXISTS announcement_guard_notification ON public.announcements;
CREATE TRIGGER announcement_guard_notification AFTER INSERT OR UPDATE OF status ON public.announcements FOR EACH ROW EXECUTE FUNCTION public.notify_guard_announcement();

DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_publication WHERE pubname='supabase_realtime') THEN
   IF NOT EXISTS(SELECT 1 FROM pg_publication_tables WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='notifications') THEN ALTER PUBLICATION supabase_realtime ADD TABLE public.notifications;END IF;
   IF NOT EXISTS(SELECT 1 FROM pg_publication_tables WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='visitor_logs') THEN ALTER PUBLICATION supabase_realtime ADD TABLE public.visitor_logs;END IF;
 END IF;
END $$;
