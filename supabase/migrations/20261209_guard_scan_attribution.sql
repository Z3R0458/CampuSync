-- Preserve guard attribution and distinguish the original scan from later sync.
ALTER TABLE public.attendance_events
  ADD COLUMN IF NOT EXISTS scanning_guard_name TEXT,
  ADD COLUMN IF NOT EXISTS scan_origin TEXT,
  ADD COLUMN IF NOT EXISTS synchronized_at TIMESTAMPTZ;

ALTER TABLE public.attendance_events DROP CONSTRAINT IF EXISTS attendance_events_scan_origin_check;
ALTER TABLE public.attendance_events ADD CONSTRAINT attendance_events_scan_origin_check
  CHECK (scan_origin IN ('ONLINE','OFFLINE'));

-- Existing rows retain their original guard ID. New events also snapshot the
-- guard's name; later edits cannot replace the responsible guard attribution.
CREATE OR REPLACE FUNCTION public.capture_attendance_guard_attribution()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.scan_origin := COALESCE(NEW.scan_origin, 'ONLINE');
    IF NEW.scanning_guard_id IS NOT NULL THEN
      SELECT p.full_name INTO NEW.scanning_guard_name
      FROM public.profiles p WHERE p.id = NEW.scanning_guard_id AND p.role = 'guard';
    END IF;
    NEW.synchronized_at := COALESCE(NEW.synchronized_at, clock_timestamp());
  ELSE
    NEW.scanning_guard_id := OLD.scanning_guard_id;
    NEW.scanning_guard_name := OLD.scanning_guard_name;
    NEW.scan_origin := OLD.scan_origin;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.capture_attendance_guard_attribution() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS attendance_guard_attribution ON public.attendance_events;
CREATE TRIGGER attendance_guard_attribution
  BEFORE INSERT OR UPDATE ON public.attendance_events
  FOR EACH ROW EXECUTE FUNCTION public.capture_attendance_guard_attribution();

CREATE OR REPLACE FUNCTION public.audit_attendance_event_correction()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_actor UUID:=public.current_profile_id();
BEGIN
  IF (to_jsonb(NEW)-'scanning_guard_id'-'scanning_guard_name'-'synchronized_at'-'created_at')
     IS DISTINCT FROM (to_jsonb(OLD)-'scanning_guard_id'-'scanning_guard_name'-'synchronized_at'-'created_at') THEN
    INSERT INTO public.audit_logs(actor_id,entity_type,entity_id,action,details)
    VALUES(v_actor,'attendance_event',NEW.id,'attendance_event_corrected',jsonb_build_object(
      'original_guard_id',OLD.scanning_guard_id,'event_id',NEW.id,
      'old_record',to_jsonb(OLD)-'scanning_guard_name','new_record',to_jsonb(NEW)-'scanning_guard_name'));
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.audit_attendance_event_correction() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS attendance_event_correction_audit ON public.attendance_events;
CREATE TRIGGER attendance_event_correction_audit
  AFTER UPDATE ON public.attendance_events
  FOR EACH ROW EXECUTE FUNCTION public.audit_attendance_event_correction();

CREATE INDEX IF NOT EXISTS attendance_events_guard_time_idx
  ON public.attendance_events(scanning_guard_id, actual_scan_time DESC);
CREATE INDEX IF NOT EXISTS attendance_events_origin_time_idx
  ON public.attendance_events(scan_origin, actual_scan_time DESC);

-- Replace the QR RPC signature so offline origin and the locally authorized
-- guard identity are validated in the same transaction as event creation.
DROP FUNCTION IF EXISTS public.record_attendance_scan(UUID,TEXT,TEXT,TIMESTAMPTZ,UUID);
CREATE FUNCTION public.record_attendance_scan(
  p_event_id UUID,p_qr_token TEXT,p_event_type TEXT,p_scanned_at TIMESTAMPTZ,
  p_device_id UUID,p_expected_guard_id UUID,p_offline_origin BOOLEAN
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_guard UUID:=public.current_profile_id(); v_id UUID; v_kind TEXT; v_name TEXT;
  v_number TEXT; v_grade TEXT; v_section TEXT; v_last TEXT; v_last_at TIMESTAMPTZ; v_guard_name TEXT;
  v_status TEXT:='VERIFIED'; v_hash TEXT; v_existing public.attendance_events%ROWTYPE;
  v_sync_time TIMESTAMPTZ:=clock_timestamp();
BEGIN
  IF v_guard IS NULL OR NOT public.has_school_role('guard') OR p_expected_guard_id IS DISTINCT FROM v_guard
    OR NOT EXISTS(SELECT 1 FROM public.devices WHERE id=p_device_id AND user_id=v_guard AND NOT is_revoked)
  THEN RAISE EXCEPTION 'Active registered guard device and matching guard session required' USING ERRCODE='42501'; END IF;
  SELECT full_name INTO v_guard_name FROM public.profiles WHERE id=v_guard AND role='guard';
  IF p_event_id IS NULL OR p_qr_token IS NULL OR length(p_qr_token) NOT BETWEEN 32 AND 256 OR p_scanned_at IS NULL OR p_scanned_at>NOW()+INTERVAL '5 minutes'
  THEN RAISE EXCEPTION 'Invalid QR scan'; END IF;
  IF p_event_type NOT IN ('ENTRY','EXIT','TEMPORARY_EXIT','RETURN') THEN RAISE EXCEPTION 'Use the dedicated EARLY_OUT transaction for approved early departure'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_event_id::text,1));
  SELECT * INTO v_existing FROM public.attendance_events WHERE id=p_event_id OR client_event_id=p_event_id LIMIT 1;
  IF FOUND THEN
    IF v_existing.scanning_guard_id IS DISTINCT FROM v_guard THEN RAISE EXCEPTION 'Event identifier belongs to another guard'; END IF;
    RETURN jsonb_build_object('event_id',v_existing.id,'person_id',v_existing.person_id,'person_type',v_existing.person_type,'event_type',v_existing.event_type,
      'full_name',CASE WHEN v_existing.person_type='student' THEN (SELECT p.full_name FROM public.students s JOIN public.profiles p ON p.id=s.profile_id WHERE s.id=v_existing.person_id) ELSE (SELECT p.full_name FROM public.teachers t JOIN public.profiles p ON p.id=t.profile_id WHERE t.id=v_existing.person_id) END,
      'display_id',CASE WHEN v_existing.person_type='student' THEN (SELECT student_id FROM public.students WHERE id=v_existing.person_id) ELSE (SELECT teacher_id FROM public.teachers WHERE id=v_existing.person_id) END,
      'scanned_at',v_existing.actual_scan_time,'status',v_existing.sync_status,'duplicate',TRUE,'scanning_guard_id',v_existing.scanning_guard_id,
      'scanning_guard_name',v_existing.scanning_guard_name,'scan_origin',v_existing.scan_origin,'synchronized_at',v_existing.synchronized_at);
  END IF;
  v_hash:=pg_catalog.encode(extensions.digest(p_qr_token,'sha256'),'hex');
  SELECT s.id,'student',p.full_name,s.student_id,s.grade_level,sec.name INTO v_id,v_kind,v_name,v_number,v_grade,v_section
    FROM public.student_qr_codes q JOIN public.students s ON s.id=q.student_id JOIN public.profiles p ON p.id=s.profile_id
    LEFT JOIN public.sections sec ON sec.id=s.section_id WHERE q.token_hash=v_hash AND q.is_active AND s.status='active' AND p.is_active LIMIT 1;
  IF v_id IS NULL THEN
    SELECT t.id,'teacher',p.full_name,t.teacher_id,t.designation,NULL INTO v_id,v_kind,v_name,v_number,v_grade,v_section
      FROM public.teacher_qr_codes q JOIN public.teachers t ON t.id=q.teacher_id JOIN public.profiles p ON p.id=t.profile_id
      WHERE q.token_hash=v_hash AND q.is_active AND p.is_active LIMIT 1;
  END IF;
  IF v_id IS NULL THEN RAISE EXCEPTION 'QR credential is invalid, revoked, expired, or inactive' USING ERRCODE='22023'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(v_id::text,2));
  SELECT event_type,actual_scan_time INTO v_last,v_last_at FROM public.attendance_events
    WHERE person_type=v_kind AND person_id=v_id AND sync_status<>'NEEDS_REVIEW' ORDER BY actual_scan_time DESC,created_at DESC LIMIT 1;
  IF v_last_at IS NOT NULL AND p_scanned_at<v_last_at THEN v_status:='NEEDS_REVIEW';
  ELSIF (p_event_type='ENTRY' AND v_last IS NOT NULL AND (NOT COALESCE(v_last IN ('EXIT','EARLY_OUT'),FALSE) OR (v_last_at AT TIME ZONE 'Asia/Manila')::date=(p_scanned_at AT TIME ZONE 'Asia/Manila')::date))
    OR (p_event_type IN ('EXIT','TEMPORARY_EXIT') AND NOT COALESCE(v_last IN ('ENTRY','RETURN'),FALSE)) OR (p_event_type='RETURN' AND v_last IS DISTINCT FROM 'TEMPORARY_EXIT')
  THEN RAISE EXCEPTION 'Invalid gate event sequence for this person' USING ERRCODE='22023'; END IF;
  IF p_event_type='EXIT' AND v_kind='student' AND EXISTS(SELECT 1 FROM public.school_schedules sch WHERE sch.is_active AND (p_scanned_at AT TIME ZONE 'Asia/Manila')::time<sch.end_time)
    THEN RAISE EXCEPTION 'Use EARLY_OUT for an approved early departure'; END IF;
  INSERT INTO public.attendance_events(id,client_event_id,person_type,person_id,event_type,actual_scan_time,scan_device_id,scanning_guard_id,verification_result,sync_status,scan_origin,synchronized_at)
    VALUES(p_event_id,p_event_id,v_kind,v_id,p_event_type,p_scanned_at,p_device_id,v_guard,v_status,CASE WHEN v_status='NEEDS_REVIEW' THEN 'NEEDS_REVIEW' ELSE 'SYNCED' END,
      CASE WHEN p_offline_origin THEN 'OFFLINE' ELSE 'ONLINE' END,v_sync_time);
  IF v_kind='student' AND v_status='VERIFIED' THEN
    INSERT INTO public.notifications(recipient_id,actor_id,type,payload)
    SELECT pa.profile_id,v_guard,'attendance_'||lower(p_event_type),jsonb_build_object('student_name',v_name,'student_id',v_number,'event_type',p_event_type,'actual_scan_time',p_scanned_at,'event_id',p_event_id)
    FROM public.student_guardians sg JOIN public.parents pa ON pa.id=sg.parent_id JOIN public.profiles pp ON pp.id=pa.profile_id
    WHERE sg.student_id=v_id AND sg.is_authorized AND sg.verification_status='APPROVED' AND pp.is_active;
  END IF;
  INSERT INTO public.audit_logs(actor_id,entity_type,entity_id,action,details) VALUES(v_guard,'attendance_event',p_event_id,'scan_recorded',
    jsonb_build_object('person_type',v_kind,'event_type',p_event_type,'verification_result',v_status,'scan_origin',CASE WHEN p_offline_origin THEN 'OFFLINE' ELSE 'ONLINE' END));
  RETURN jsonb_build_object('event_id',p_event_id,'person_id',v_id,'person_type',v_kind,'full_name',v_name,'display_id',v_number,'grade_level',v_grade,'section_name',v_section,
    'event_type',p_event_type,'scanned_at',p_scanned_at,'status',v_status,'duplicate',FALSE,'scanning_guard_id',v_guard,'scanning_guard_name',v_guard_name,
    'scan_origin',CASE WHEN p_offline_origin THEN 'OFFLINE' ELSE 'ONLINE' END,'synchronized_at',v_sync_time);
END;
$$;
REVOKE ALL ON FUNCTION public.record_attendance_scan(UUID,TEXT,TEXT,TIMESTAMPTZ,UUID,UUID,BOOLEAN) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.record_attendance_scan(UUID,TEXT,TEXT,TIMESTAMPTZ,UUID,UUID,BOOLEAN) TO authenticated;

-- Keep the prior RPC arity working for already-open clients during rollout.
CREATE OR REPLACE FUNCTION public.record_attendance_scan(
  p_event_id UUID,p_qr_token TEXT,p_event_type TEXT,p_scanned_at TIMESTAMPTZ,p_device_id UUID
) RETURNS JSONB LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  SELECT public.record_attendance_scan(p_event_id,p_qr_token,p_event_type,p_scanned_at,p_device_id,
    public.current_profile_id(),COALESCE(p_scanned_at < clock_timestamp()-INTERVAL '30 seconds',FALSE));
$$;
REVOKE ALL ON FUNCTION public.record_attendance_scan(UUID,TEXT,TEXT,TIMESTAMPTZ,UUID) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.record_attendance_scan(UUID,TEXT,TEXT,TIMESTAMPTZ,UUID) TO authenticated;

DROP FUNCTION IF EXISTS public.record_manual_attendance(UUID,TEXT,UUID,TEXT,TIMESTAMPTZ,UUID);
CREATE FUNCTION public.record_manual_attendance(
  p_event_id UUID,p_person_type TEXT,p_person_id UUID,p_event_type TEXT,p_scanned_at TIMESTAMPTZ,
  p_device_id UUID,p_expected_guard_id UUID,p_offline_origin BOOLEAN
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_guard UUID:=public.current_profile_id(); v_name TEXT; v_number TEXT; v_grade TEXT; v_section TEXT;
  v_last TEXT; v_last_at TIMESTAMPTZ; v_existing public.attendance_events%ROWTYPE; v_sync_time TIMESTAMPTZ:=clock_timestamp(); v_guard_name TEXT;
BEGIN
  IF v_guard IS NULL OR NOT public.has_school_role('guard') OR p_expected_guard_id IS DISTINCT FROM v_guard
    OR NOT EXISTS(SELECT 1 FROM public.devices WHERE id=p_device_id AND user_id=v_guard AND NOT is_revoked)
  THEN RAISE EXCEPTION 'Active registered guard device and matching guard session required' USING ERRCODE='42501'; END IF;
  SELECT full_name INTO v_guard_name FROM public.profiles WHERE id=v_guard AND role='guard';
  IF p_event_id IS NULL OR p_person_id IS NULL OR p_scanned_at IS NULL OR p_scanned_at>NOW()+INTERVAL '5 minutes'
    OR p_person_type NOT IN ('student','teacher') OR p_event_type NOT IN ('ENTRY','EXIT','TEMPORARY_EXIT','RETURN') THEN RAISE EXCEPTION 'Invalid manual scan'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_event_id::text,1));
  SELECT * INTO v_existing FROM public.attendance_events WHERE id=p_event_id OR client_event_id=p_event_id LIMIT 1;
  IF FOUND THEN
    IF v_existing.scanning_guard_id IS DISTINCT FROM v_guard THEN RAISE EXCEPTION 'Event identifier belongs to another guard'; END IF;
    RETURN jsonb_build_object('event_id',v_existing.id,'person_id',v_existing.person_id,'person_type',v_existing.person_type,'event_type',v_existing.event_type,
      'scanned_at',v_existing.actual_scan_time,'status',v_existing.sync_status,'duplicate',TRUE,'scanning_guard_id',v_existing.scanning_guard_id,
      'scanning_guard_name',v_existing.scanning_guard_name,'scan_origin',v_existing.scan_origin,'synchronized_at',v_existing.synchronized_at);
  END IF;
  IF p_person_type='student' THEN
    SELECT p.full_name,s.student_id,s.grade_level,sec.name INTO v_name,v_number,v_grade,v_section FROM public.students s JOIN public.profiles p ON p.id=s.profile_id
      LEFT JOIN public.sections sec ON sec.id=s.section_id WHERE s.id=p_person_id AND s.status='active' AND p.is_active;
  ELSE
    SELECT p.full_name,t.teacher_id,t.designation,NULL INTO v_name,v_number,v_grade,v_section FROM public.teachers t JOIN public.profiles p ON p.id=t.profile_id WHERE t.id=p_person_id AND p.is_active;
  END IF;
  IF v_name IS NULL THEN RAISE EXCEPTION 'Person record is inactive or does not exist'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_person_id::text,2));
  SELECT event_type,actual_scan_time INTO v_last,v_last_at FROM public.attendance_events WHERE person_type=p_person_type AND person_id=p_person_id AND sync_status<>'NEEDS_REVIEW' ORDER BY actual_scan_time DESC,created_at DESC LIMIT 1;
  IF (p_event_type='ENTRY' AND v_last IS NOT NULL AND (NOT COALESCE(v_last IN ('EXIT','EARLY_OUT'),FALSE) OR (v_last_at AT TIME ZONE 'Asia/Manila')::date=(p_scanned_at AT TIME ZONE 'Asia/Manila')::date))
    OR (p_event_type IN ('EXIT','TEMPORARY_EXIT') AND NOT COALESCE(v_last IN ('ENTRY','RETURN'),FALSE)) OR (p_event_type='RETURN' AND v_last IS DISTINCT FROM 'TEMPORARY_EXIT')
    THEN RAISE EXCEPTION 'Invalid gate event sequence for this person'; END IF;
  IF p_event_type='EXIT' AND p_person_type='student' AND EXISTS(SELECT 1 FROM public.school_schedules sch WHERE sch.is_active AND (p_scanned_at AT TIME ZONE 'Asia/Manila')::time<sch.end_time)
    THEN RAISE EXCEPTION 'Use the QR scanner EARLY_OUT action for an approved early departure'; END IF;
  INSERT INTO public.attendance_events(id,client_event_id,person_type,person_id,event_type,actual_scan_time,scan_device_id,scanning_guard_id,verification_result,sync_status,scan_origin,synchronized_at)
    VALUES(p_event_id,p_event_id,p_person_type,p_person_id,p_event_type,p_scanned_at,p_device_id,v_guard,'MANUAL_VERIFIED','SYNCED',CASE WHEN p_offline_origin THEN 'OFFLINE' ELSE 'ONLINE' END,v_sync_time);
  IF p_person_type='student' THEN
    INSERT INTO public.notifications(recipient_id,actor_id,type,payload)
    SELECT pa.profile_id,v_guard,'attendance_'||lower(p_event_type),jsonb_build_object('student_name',v_name,'student_id',v_number,'event_type',p_event_type,'actual_scan_time',p_scanned_at,'event_id',p_event_id)
    FROM public.student_guardians sg JOIN public.parents pa ON pa.id=sg.parent_id JOIN public.profiles pp ON pp.id=pa.profile_id
    WHERE sg.student_id=p_person_id AND sg.is_authorized AND sg.verification_status='APPROVED' AND pp.is_active;
  END IF;
  INSERT INTO public.audit_logs(actor_id,entity_type,entity_id,action,details) VALUES(v_guard,'attendance_event',p_event_id,'manual_scan_recorded',
    jsonb_build_object('person_type',p_person_type,'event_type',p_event_type,'scan_origin',CASE WHEN p_offline_origin THEN 'OFFLINE' ELSE 'ONLINE' END));
  RETURN jsonb_build_object('event_id',p_event_id,'person_id',p_person_id,'person_type',p_person_type,'display_id',v_number,'full_name',v_name,'grade_level',v_grade,
    'section_name',v_section,'event_type',p_event_type,'scanned_at',p_scanned_at,'status','SYNCED','duplicate',FALSE,'scanning_guard_id',v_guard,
    'scanning_guard_name',v_guard_name,'scan_origin',CASE WHEN p_offline_origin THEN 'OFFLINE' ELSE 'ONLINE' END,'synchronized_at',v_sync_time);
END;
$$;
REVOKE ALL ON FUNCTION public.record_manual_attendance(UUID,TEXT,UUID,TEXT,TIMESTAMPTZ,UUID,UUID,BOOLEAN) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.record_manual_attendance(UUID,TEXT,UUID,TEXT,TIMESTAMPTZ,UUID,UUID,BOOLEAN) TO authenticated;

CREATE OR REPLACE FUNCTION public.record_manual_attendance(
  p_event_id UUID,p_person_type TEXT,p_person_id UUID,p_event_type TEXT,p_scanned_at TIMESTAMPTZ,p_device_id UUID
) RETURNS JSONB LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  SELECT public.record_manual_attendance(p_event_id,p_person_type,p_person_id,p_event_type,p_scanned_at,p_device_id,
    public.current_profile_id(),COALESCE(p_scanned_at < clock_timestamp()-INTERVAL '30 seconds',FALSE));
$$;
REVOKE ALL ON FUNCTION public.record_manual_attendance(UUID,TEXT,UUID,TEXT,TIMESTAMPTZ,UUID) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.record_manual_attendance(UUID,TEXT,UUID,TEXT,TIMESTAMPTZ,UUID) TO authenticated;
