-- Run after supabase/schema.sql. This migration adds guarded workflows while
-- keeping attendance and approval writes behind validated database functions.

ALTER TABLE public.attendance_events
  ADD COLUMN IF NOT EXISTS client_event_id UUID;
ALTER TABLE public.visitor_logs
  ADD COLUMN IF NOT EXISTS visitor_request_id UUID REFERENCES public.visitor_requests(id);

-- The older schema had a qr_token column. Preserve the column for compatibility,
-- but remove any stored bearer credentials; token_hash remains usable for scan verification.
UPDATE public.student_qr_codes SET qr_token = 'HASH_ONLY:' || id::text WHERE qr_token NOT LIKE 'HASH_ONLY:%';
UPDATE public.teacher_qr_codes SET qr_token = 'HASH_ONLY:' || id::text WHERE qr_token NOT LIKE 'HASH_ONLY:%';
COMMENT ON COLUMN public.student_qr_codes.qr_token IS 'Compatibility placeholder only; QR bearer tokens are never stored here.';
COMMENT ON COLUMN public.teacher_qr_codes.qr_token IS 'Compatibility placeholder only; QR bearer tokens are never stored here.';

CREATE UNIQUE INDEX IF NOT EXISTS idx_student_qr_token_hash ON public.student_qr_codes (token_hash);
CREATE UNIQUE INDEX IF NOT EXISTS idx_teacher_qr_token_hash ON public.teacher_qr_codes (token_hash);

CREATE UNIQUE INDEX IF NOT EXISTS idx_attendance_events_client_event
  ON public.attendance_events (client_event_id)
  WHERE client_event_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_attendance_events_guard_recent
  ON public.attendance_events (actual_scan_time DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_visitor_logs_request_unique
  ON public.visitor_logs (visitor_request_id) WHERE visitor_request_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.register_guard_device(p_device_id UUID, p_device_name TEXT)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_profile_id UUID := public.current_profile_id();
  v_device_id UUID := COALESCE(p_device_id, gen_random_uuid());
BEGIN
  IF v_profile_id IS NULL OR NOT public.has_school_role('guard') THEN
    RAISE EXCEPTION 'Only active guard accounts may register a scanning device' USING ERRCODE = '42501';
  END IF;
  IF p_device_name IS NULL OR length(trim(p_device_name)) < 2 OR length(p_device_name) > 100 THEN
    RAISE EXCEPTION 'Device name must be between 2 and 100 characters';
  END IF;

  INSERT INTO public.devices AS current_device (id, user_id, device_name, platform, is_online, is_revoked)
  VALUES (v_device_id, v_profile_id, trim(p_device_name), 'web', TRUE, FALSE)
  ON CONFLICT (id) DO UPDATE SET updated_at = NOW(), is_online = TRUE
    WHERE current_device.user_id = v_profile_id AND NOT current_device.is_revoked;

  IF NOT EXISTS (SELECT 1 FROM public.devices d WHERE d.id = v_device_id AND d.user_id = v_profile_id AND NOT d.is_revoked) THEN
    RAISE EXCEPTION 'Device is not registered to this guard or has been revoked' USING ERRCODE = '42501';
  END IF;
  RETURN v_device_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_offline_qr_cache()
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE v_cache JSONB;
BEGIN
  IF NOT public.has_school_role('guard') THEN
    RAISE EXCEPTION 'Only active guards may download the verification cache' USING ERRCODE = '42501';
  END IF;
  SELECT COALESCE(jsonb_agg(entry), '[]'::jsonb) INTO v_cache
  FROM (
    SELECT jsonb_build_object('token_hash', q.token_hash, 'person_type', 'student', 'person_id', s.id,
      'display_id', s.student_id, 'full_name', p.full_name, 'grade_level', s.grade_level,
      'section_name', sec.name,
      'last_event_type', (SELECT e.event_type FROM public.attendance_events e WHERE e.person_type = 'student'
        AND e.person_id = s.id AND e.sync_status <> 'NEEDS_REVIEW' ORDER BY e.actual_scan_time DESC LIMIT 1),
      'last_scan_at', (SELECT e.actual_scan_time FROM public.attendance_events e WHERE e.person_type = 'student'
        AND e.person_id = s.id AND e.sync_status <> 'NEEDS_REVIEW' ORDER BY e.actual_scan_time DESC LIMIT 1)) AS entry
    FROM public.student_qr_codes q
    JOIN public.students s ON s.id = q.student_id
    JOIN public.profiles p ON p.id = s.profile_id
    LEFT JOIN public.sections sec ON sec.id = s.section_id
    WHERE q.is_active AND s.status = 'active' AND p.is_active AND q.token_hash IS NOT NULL
    UNION ALL
    SELECT jsonb_build_object('token_hash', q.token_hash, 'person_type', 'teacher', 'person_id', t.id,
      'display_id', t.teacher_id, 'full_name', p.full_name, 'grade_level', t.designation,
      'section_name', NULL,
      'last_event_type', (SELECT e.event_type FROM public.attendance_events e WHERE e.person_type = 'teacher'
        AND e.person_id = t.id AND e.sync_status <> 'NEEDS_REVIEW' ORDER BY e.actual_scan_time DESC LIMIT 1),
      'last_scan_at', (SELECT e.actual_scan_time FROM public.attendance_events e WHERE e.person_type = 'teacher'
        AND e.person_id = t.id AND e.sync_status <> 'NEEDS_REVIEW' ORDER BY e.actual_scan_time DESC LIMIT 1)) AS entry
    FROM public.teacher_qr_codes q
    JOIN public.teachers t ON t.id = q.teacher_id
    JOIN public.profiles p ON p.id = t.profile_id
    WHERE q.is_active AND p.is_active AND q.token_hash IS NOT NULL
  ) cache_rows;
  RETURN v_cache;
END;
$$;

CREATE OR REPLACE FUNCTION public.lookup_guard_person(p_display_id TEXT)
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE v_person JSONB;
BEGIN
  IF NOT public.has_school_role('guard') THEN
    RAISE EXCEPTION 'Only active guards may look up gate identities' USING ERRCODE = '42501';
  END IF;
  SELECT jsonb_build_object('person_id', s.id, 'person_type', 'student', 'display_id', s.student_id,
    'full_name', p.full_name, 'grade_level', s.grade_level, 'section_name', sec.name)
  INTO v_person FROM public.students s JOIN public.profiles p ON p.id = s.profile_id
  LEFT JOIN public.sections sec ON sec.id = s.section_id
  WHERE lower(s.student_id) = lower(trim(p_display_id)) AND s.status = 'active' AND p.is_active LIMIT 1;
  IF v_person IS NULL THEN
    SELECT jsonb_build_object('person_id', t.id, 'person_type', 'teacher', 'display_id', t.teacher_id,
      'full_name', p.full_name, 'grade_level', t.designation, 'section_name', NULL)
    INTO v_person FROM public.teachers t JOIN public.profiles p ON p.id = t.profile_id
    WHERE lower(t.teacher_id) = lower(trim(p_display_id)) AND p.is_active LIMIT 1;
  END IF;
  RETURN v_person;
END;
$$;

CREATE OR REPLACE FUNCTION public.record_manual_attendance(
  p_event_id UUID,
  p_person_type TEXT,
  p_person_id UUID,
  p_event_type TEXT,
  p_scanned_at TIMESTAMPTZ,
  p_device_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_guard_id UUID := public.current_profile_id();
  v_last_type TEXT;
  v_last_time TIMESTAMPTZ;
  v_name TEXT;
  v_display_id TEXT;
  v_grade TEXT;
  v_section TEXT;
  v_early_out_id UUID;
  v_existing public.attendance_events%ROWTYPE;
BEGIN
  IF v_guard_id IS NULL OR NOT public.has_school_role('guard') THEN
    RAISE EXCEPTION 'Only active guards may record manual gate scans' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.devices d WHERE d.id = p_device_id AND d.user_id = v_guard_id AND NOT d.is_revoked) THEN
    RAISE EXCEPTION 'Scanning device is not registered to this guard' USING ERRCODE = '42501';
  END IF;
  IF p_event_id IS NULL OR p_person_id IS NULL OR p_scanned_at IS NULL OR p_scanned_at > NOW() + INTERVAL '5 minutes' THEN
    RAISE EXCEPTION 'Manual scan timestamp or identity is invalid';
  END IF;
  IF p_person_type IS NULL OR p_person_type NOT IN ('student', 'teacher') OR p_event_type IS NULL OR p_event_type NOT IN ('ENTRY', 'EXIT', 'TEMPORARY_EXIT', 'RETURN') THEN
    RAISE EXCEPTION 'Manual scan details are invalid';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_event_id::text, 1));
  SELECT e.* INTO v_existing FROM public.attendance_events e WHERE e.id = p_event_id OR e.client_event_id = p_event_id LIMIT 1;
  IF FOUND THEN
    RETURN jsonb_build_object('event_id', v_existing.id, 'person_id', v_existing.person_id,
      'person_type', v_existing.person_type, 'event_type', v_existing.event_type,
      'scanned_at', v_existing.actual_scan_time, 'status', v_existing.sync_status, 'duplicate', TRUE);
  END IF;

  IF p_person_type = 'student' THEN
    SELECT p.full_name, s.student_id, s.grade_level, sec.name INTO v_name, v_display_id, v_grade, v_section
    FROM public.students s JOIN public.profiles p ON p.id = s.profile_id
    LEFT JOIN public.sections sec ON sec.id = s.section_id
    WHERE s.id = p_person_id AND s.status = 'active' AND p.is_active;
  ELSE
    SELECT p.full_name, t.teacher_id, t.designation, NULL INTO v_name, v_display_id, v_grade, v_section
    FROM public.teachers t JOIN public.profiles p ON p.id = t.profile_id
    WHERE t.id = p_person_id AND p.is_active;
  END IF;
  IF v_name IS NULL THEN RAISE EXCEPTION 'Person record is inactive or does not exist' USING ERRCODE = '22023'; END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_person_id::text, 2));
  SELECT e.event_type, e.actual_scan_time INTO v_last_type, v_last_time FROM public.attendance_events e
    WHERE e.person_type = p_person_type AND e.person_id = p_person_id AND e.sync_status <> 'NEEDS_REVIEW'
    ORDER BY e.actual_scan_time DESC, e.created_at DESC LIMIT 1;
  IF (p_event_type = 'ENTRY' AND v_last_type IS NOT NULL AND
      (v_last_type <> 'EXIT' OR (v_last_time AT TIME ZONE 'Asia/Manila')::date = (p_scanned_at AT TIME ZONE 'Asia/Manila')::date))
    OR (p_event_type IN ('EXIT', 'TEMPORARY_EXIT') AND NOT COALESCE(v_last_type IN ('ENTRY', 'RETURN'), FALSE))
    OR (p_event_type = 'RETURN' AND v_last_type IS DISTINCT FROM 'TEMPORARY_EXIT') THEN
    RAISE EXCEPTION 'Invalid gate event sequence for this person' USING ERRCODE = '22023';
  END IF;
  IF p_event_type = 'EXIT' AND p_person_type = 'student' AND EXISTS (
    SELECT 1 FROM public.school_schedules sch WHERE sch.is_active
      AND (p_scanned_at AT TIME ZONE 'Asia/Manila')::time < sch.end_time
  ) THEN
    SELECT r.id INTO v_early_out_id FROM public.early_out_requests r WHERE r.student_id = p_person_id
      AND r.status = 'APPROVED' AND (r.requested_departure AT TIME ZONE 'Asia/Manila')::date = (p_scanned_at AT TIME ZONE 'Asia/Manila')::date
      AND r.requested_departure BETWEEN p_scanned_at - INTERVAL '3 hours' AND p_scanned_at + INTERVAL '30 minutes'
      ORDER BY r.requested_departure LIMIT 1 FOR UPDATE;
    IF v_early_out_id IS NULL THEN RAISE EXCEPTION 'Approved early-out authorization is required' USING ERRCODE = '42501'; END IF;
  END IF;

  INSERT INTO public.attendance_events (id, client_event_id, person_type, person_id, event_type,
    actual_scan_time, scan_device_id, scanning_guard_id, verification_result, sync_status)
  VALUES (p_event_id, p_event_id, p_person_type, p_person_id, p_event_type, p_scanned_at,
    p_device_id, v_guard_id, 'MANUAL_VERIFIED', 'SYNCED');
  IF v_early_out_id IS NOT NULL THEN UPDATE public.early_out_requests SET status = 'USED', updated_at = NOW() WHERE id = v_early_out_id; END IF;
  INSERT INTO public.audit_logs (actor_id, entity_type, entity_id, action, details)
    VALUES (v_guard_id, 'attendance_event', p_event_id, 'manual_scan_recorded',
      jsonb_build_object('person_type', p_person_type, 'event_type', p_event_type));
  IF p_person_type = 'student' THEN
    INSERT INTO public.notifications (recipient_id, actor_id, type, payload)
    SELECT pa.profile_id, v_guard_id, 'attendance_' || lower(p_event_type),
      jsonb_build_object('student_name', v_name, 'student_id', v_display_id, 'event_type', p_event_type, 'actual_scan_time', p_scanned_at, 'event_id', p_event_id)
    FROM public.student_guardians sg JOIN public.parents pa ON pa.id = sg.parent_id
      JOIN public.profiles pp ON pp.id = pa.profile_id
    WHERE sg.student_id = p_person_id AND sg.is_authorized AND pp.is_active;
  END IF;
  RETURN jsonb_build_object('event_id', p_event_id, 'person_id', p_person_id, 'person_type', p_person_type,
    'display_id', v_display_id, 'full_name', v_name, 'grade_level', v_grade, 'section_name', v_section,
    'event_type', p_event_type, 'scanned_at', p_scanned_at, 'status', 'SYNCED', 'duplicate', FALSE);
END;
$$;

CREATE OR REPLACE FUNCTION public.record_attendance_scan(
  p_event_id UUID,
  p_qr_token TEXT,
  p_event_type TEXT,
  p_scanned_at TIMESTAMPTZ,
  p_device_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_guard_id UUID := public.current_profile_id();
  v_person_id UUID;
  v_person_type TEXT;
  v_name TEXT;
  v_display_id TEXT;
  v_grade TEXT;
  v_section TEXT;
  v_last_type TEXT;
  v_last_time TIMESTAMPTZ;
  v_existing public.attendance_events%ROWTYPE;
  v_hash TEXT;
  v_status TEXT := 'VERIFIED';
  v_early_out_id UUID;
BEGIN
  IF v_guard_id IS NULL OR NOT public.has_school_role('guard') THEN
    RAISE EXCEPTION 'Only active guards may record gate scans' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.devices d WHERE d.id = p_device_id AND d.user_id = v_guard_id AND NOT d.is_revoked) THEN
    RAISE EXCEPTION 'Scanning device is not registered to this guard' USING ERRCODE = '42501';
  END IF;
  IF p_event_id IS NULL OR p_qr_token IS NULL OR length(p_qr_token) < 32 OR length(p_qr_token) > 256 THEN
    RAISE EXCEPTION 'Invalid event or QR credential';
  END IF;
  IF p_event_type IS NULL OR p_event_type NOT IN ('ENTRY', 'EXIT', 'TEMPORARY_EXIT', 'RETURN') THEN
    RAISE EXCEPTION 'Unsupported attendance event type';
  END IF;
  IF p_scanned_at IS NULL OR p_scanned_at > NOW() + INTERVAL '5 minutes' THEN
    RAISE EXCEPTION 'Scan timestamp is invalid or in the future';
  END IF;

  -- Serialize duplicate events and each person's gate state transitions.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_event_id::text, 1));

  SELECT e.* INTO v_existing FROM public.attendance_events e
  WHERE e.id = p_event_id OR e.client_event_id = p_event_id LIMIT 1;
  IF FOUND THEN
    RETURN jsonb_build_object('event_id', v_existing.id, 'person_type', v_existing.person_type,
      'person_id', v_existing.person_id, 'event_type', v_existing.event_type,
      'full_name', CASE WHEN v_existing.person_type = 'student' THEN
        (SELECT p.full_name FROM public.students s JOIN public.profiles p ON p.id = s.profile_id WHERE s.id = v_existing.person_id)
        ELSE (SELECT p.full_name FROM public.teachers t JOIN public.profiles p ON p.id = t.profile_id WHERE t.id = v_existing.person_id) END,
      'display_id', CASE WHEN v_existing.person_type = 'student' THEN
        (SELECT s.student_id FROM public.students s WHERE s.id = v_existing.person_id)
        ELSE (SELECT t.teacher_id FROM public.teachers t WHERE t.id = v_existing.person_id) END,
      'grade_level', CASE WHEN v_existing.person_type = 'student' THEN
        (SELECT s.grade_level FROM public.students s WHERE s.id = v_existing.person_id)
        ELSE (SELECT t.designation FROM public.teachers t WHERE t.id = v_existing.person_id) END,
      'scanned_at', v_existing.actual_scan_time, 'status', v_existing.sync_status, 'duplicate', TRUE);
  END IF;

  v_hash := pg_catalog.encode(extensions.digest(p_qr_token, 'sha256'), 'hex');
  SELECT s.id, 'student', p.full_name, s.student_id, s.grade_level, sec.name
    INTO v_person_id, v_person_type, v_name, v_display_id, v_grade, v_section
  FROM public.student_qr_codes q
  JOIN public.students s ON s.id = q.student_id
  JOIN public.profiles p ON p.id = s.profile_id
  LEFT JOIN public.sections sec ON sec.id = s.section_id
  WHERE q.token_hash = v_hash AND q.is_active AND s.status = 'active' AND p.is_active
  LIMIT 1;

  IF v_person_id IS NULL THEN
    SELECT t.id, 'teacher', p.full_name, t.teacher_id, t.designation, NULL
      INTO v_person_id, v_person_type, v_name, v_display_id, v_grade, v_section
    FROM public.teacher_qr_codes q
    JOIN public.teachers t ON t.id = q.teacher_id
    JOIN public.profiles p ON p.id = t.profile_id
    WHERE q.token_hash = v_hash AND q.is_active AND p.is_active
    LIMIT 1;
  END IF;
  IF v_person_id IS NULL THEN
    RAISE EXCEPTION 'QR credential is invalid, revoked, or belongs to an inactive account' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(v_person_id::text, 2));

  SELECT e.event_type, e.actual_scan_time INTO v_last_type, v_last_time
  FROM public.attendance_events e
  WHERE e.person_type = v_person_type AND e.person_id = v_person_id
    AND e.sync_status <> 'NEEDS_REVIEW'
  ORDER BY e.actual_scan_time DESC, e.created_at DESC LIMIT 1;

  IF v_last_time IS NOT NULL AND p_scanned_at < v_last_time THEN
    v_status := 'NEEDS_REVIEW';
  ELSIF (p_event_type = 'ENTRY' AND v_last_type IS NOT NULL AND
      (v_last_type <> 'EXIT' OR (v_last_time AT TIME ZONE 'Asia/Manila')::date = (p_scanned_at AT TIME ZONE 'Asia/Manila')::date))
    OR (p_event_type IN ('EXIT', 'TEMPORARY_EXIT') AND NOT COALESCE(v_last_type IN ('ENTRY', 'RETURN'), FALSE))
    OR (p_event_type = 'RETURN' AND v_last_type IS DISTINCT FROM 'TEMPORARY_EXIT') THEN
    RAISE EXCEPTION 'Invalid gate event sequence for this person' USING ERRCODE = '22023';
  END IF;

  IF p_event_type = 'EXIT' AND v_person_type = 'student' AND EXISTS (
    SELECT 1 FROM public.school_schedules sch WHERE sch.is_active
      AND (p_scanned_at AT TIME ZONE 'Asia/Manila')::time < sch.end_time
  ) THEN
    SELECT r.id INTO v_early_out_id FROM public.early_out_requests r
    WHERE r.student_id = v_person_id AND r.status = 'APPROVED'
      AND (r.requested_departure AT TIME ZONE 'Asia/Manila')::date = (p_scanned_at AT TIME ZONE 'Asia/Manila')::date
      AND r.requested_departure BETWEEN p_scanned_at - INTERVAL '3 hours' AND p_scanned_at + INTERVAL '30 minutes'
    ORDER BY r.requested_departure LIMIT 1 FOR UPDATE;
    IF v_early_out_id IS NULL THEN
      RAISE EXCEPTION 'An approved early-out request is required before this student may exit' USING ERRCODE = '42501';
    END IF;
  END IF;

  INSERT INTO public.attendance_events
    (id, client_event_id, person_type, person_id, event_type, actual_scan_time,
     scan_device_id, scanning_guard_id, verification_result, sync_status)
  VALUES
    (p_event_id, p_event_id, v_person_type, v_person_id, p_event_type, p_scanned_at,
     p_device_id, v_guard_id, v_status, CASE WHEN v_status = 'NEEDS_REVIEW' THEN 'NEEDS_REVIEW' ELSE 'SYNCED' END);

  IF v_early_out_id IS NOT NULL THEN
    UPDATE public.early_out_requests SET status = 'USED', updated_at = NOW() WHERE id = v_early_out_id;
  END IF;

  IF v_status = 'VERIFIED' AND v_person_type = 'student' AND p_event_type IN ('ENTRY', 'EXIT', 'TEMPORARY_EXIT', 'RETURN') THEN
    INSERT INTO public.notifications (recipient_id, actor_id, type, payload)
    SELECT parent_profile.id, v_guard_id, 'attendance_' || lower(p_event_type),
      jsonb_build_object('student_name', v_name, 'student_id', v_display_id, 'event_type', p_event_type,
        'actual_scan_time', p_scanned_at, 'event_id', p_event_id)
    FROM public.student_guardians sg
    JOIN public.parents pa ON pa.id = sg.parent_id
    JOIN public.profiles parent_profile ON parent_profile.id = pa.profile_id
    WHERE sg.student_id = v_person_id AND sg.is_authorized AND parent_profile.is_active;
  END IF;

  INSERT INTO public.audit_logs (actor_id, entity_type, entity_id, action, details)
  VALUES (v_guard_id, 'attendance_event', p_event_id, 'scan_recorded',
    jsonb_build_object('person_type', v_person_type, 'event_type', p_event_type, 'verification_result', v_status));

  RETURN jsonb_build_object('event_id', p_event_id, 'person_type', v_person_type, 'person_id', v_person_id,
    'full_name', v_name, 'display_id', v_display_id, 'grade_level', v_grade, 'section_name', v_section,
    'event_type', p_event_type, 'scanned_at', p_scanned_at, 'status', v_status, 'duplicate', FALSE);
END;
$$;

-- Generate a random one-time credential. Only its SHA-256 digest is retained;
-- the plaintext QR credential is returned to the administrator once.
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
      VALUES (p_person_id, 'HASH_ONLY:' || pg_catalog.gen_random_uuid()::text, pg_catalog.encode(extensions.digest(v_token, 'sha256'), 'hex'), TRUE);
  ELSIF p_person_type = 'teacher' THEN
    UPDATE public.teacher_qr_codes SET is_active = FALSE, revoked_at = NOW(), updated_at = NOW()
      WHERE teacher_id = p_person_id AND is_active;
    INSERT INTO public.teacher_qr_codes (teacher_id, qr_token, token_hash, is_active)
      VALUES (p_person_id, 'HASH_ONLY:' || pg_catalog.gen_random_uuid()::text, pg_catalog.encode(extensions.digest(v_token, 'sha256'), 'hex'), TRUE);
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
    SELECT id INTO v_person_id FROM public.students WHERE profile_id = v_profile_id AND status = 'active' LIMIT 1;
    IF v_person_id IS NULL THEN RAISE EXCEPTION 'No active student record is linked to this profile'; END IF;
    UPDATE public.student_qr_codes SET is_active = FALSE, revoked_at = NOW(), updated_at = NOW()
      WHERE student_id = v_person_id AND is_active;
    INSERT INTO public.student_qr_codes (student_id, qr_token, token_hash, is_active)
      VALUES (v_person_id, 'HASH_ONLY:' || pg_catalog.gen_random_uuid()::text, pg_catalog.encode(extensions.digest(v_token, 'sha256'), 'hex'), TRUE);
  ELSIF public.has_school_role('teacher') THEN
    SELECT id INTO v_person_id FROM public.teachers WHERE profile_id = v_profile_id LIMIT 1;
    IF v_person_id IS NULL THEN RAISE EXCEPTION 'No teacher record is linked to this profile'; END IF;
    UPDATE public.teacher_qr_codes SET is_active = FALSE, revoked_at = NOW(), updated_at = NOW()
      WHERE teacher_id = v_person_id AND is_active;
    INSERT INTO public.teacher_qr_codes (teacher_id, qr_token, token_hash, is_active)
      VALUES (v_person_id, 'HASH_ONLY:' || pg_catalog.gen_random_uuid()::text, pg_catalog.encode(extensions.digest(v_token, 'sha256'), 'hex'), TRUE);
  ELSE
    RAISE EXCEPTION 'Only students and teachers may issue their own QR credential' USING ERRCODE = '42501';
  END IF;
  RETURN v_token;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_guard_dashboard_snapshot()
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE v_snapshot JSONB;
BEGIN
  IF NOT public.has_school_role('guard') AND NOT public.has_school_role('administrator') THEN
    RAISE EXCEPTION 'Only guards and administrators may view gate operations' USING ERRCODE = '42501';
  END IF;

  SELECT jsonb_build_object(
    'inside_count', (SELECT count(*) FROM (
      SELECT DISTINCT ON (e.person_type, e.person_id) e.person_type, e.person_id, e.event_type
      FROM public.attendance_events e WHERE e.sync_status <> 'NEEDS_REVIEW'
      ORDER BY e.person_type, e.person_id, e.actual_scan_time DESC, e.created_at DESC
    ) latest WHERE latest.event_type IN ('ENTRY', 'RETURN')),
    'visitors_inside', (SELECT count(*) FROM public.visitor_logs v WHERE v.actual_departure_time IS NULL
      AND v.authorization_status = 'APPROVED'),
    'recent_events', COALESCE((SELECT jsonb_agg(row_data ORDER BY scan_time DESC) FROM (
      SELECT jsonb_build_object(
        'id', e.id, 'person_type', e.person_type, 'person_id', e.person_id,
        'full_name', CASE WHEN e.person_type = 'student' THEN ps.full_name ELSE pt.full_name END,
        'display_id', CASE WHEN e.person_type = 'student' THEN s.student_id ELSE t.teacher_id END,
        'event_type', e.event_type, 'actual_scan_time', e.actual_scan_time,
        'sync_status', e.sync_status, 'verification_result', e.verification_result
      ) AS row_data, e.actual_scan_time AS scan_time
      FROM public.attendance_events e
      LEFT JOIN public.students s ON e.person_type = 'student' AND s.id = e.person_id
      LEFT JOIN public.profiles ps ON ps.id = s.profile_id
      LEFT JOIN public.teachers t ON e.person_type = 'teacher' AND t.id = e.person_id
      LEFT JOIN public.profiles pt ON pt.id = t.profile_id
      ORDER BY e.actual_scan_time DESC LIMIT 20
    ) recent), '[]'::jsonb)
  ) INTO v_snapshot;
  RETURN v_snapshot;
END;
$$;

CREATE OR REPLACE FUNCTION public.check_in_authorized_visitor(p_request_id UUID, p_event_id UUID)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_guard_id UUID := public.current_profile_id();
  v_request public.visitor_requests%ROWTYPE;
  v_arrival_at TIMESTAMPTZ;
BEGIN
  IF v_guard_id IS NULL OR NOT public.has_school_role('guard') THEN
    RAISE EXCEPTION 'Only guards may check in authorized visitors' USING ERRCODE = '42501';
  END IF;
  IF p_event_id IS NULL THEN RAISE EXCEPTION 'Visitor check-in event ID is required'; END IF;
  IF EXISTS (SELECT 1 FROM public.visitor_logs v WHERE v.id = p_event_id AND v.visitor_request_id = p_request_id) THEN
    RETURN p_event_id;
  END IF;
  SELECT * INTO v_request FROM public.visitor_requests r WHERE r.id = p_request_id FOR UPDATE;
  IF NOT FOUND OR v_request.status <> 'APPROVED' THEN
    RAISE EXCEPTION 'Visitor request is not approved or has already been used' USING ERRCODE = '22023';
  END IF;
  IF v_request.visit_date <> (NOW() AT TIME ZONE 'Asia/Manila')::date THEN
    RAISE EXCEPTION 'This visitor approval is not valid for today' USING ERRCODE = '22023';
  END IF;
  v_arrival_at := (v_request.visit_date + v_request.expected_arrival_time) AT TIME ZONE 'Asia/Manila';
  IF NOW() < v_arrival_at - INTERVAL '2 hours' OR NOW() > v_arrival_at + INTERVAL '4 hours' THEN
    RAISE EXCEPTION 'Visitor approval is outside its valid arrival window' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM public.visitor_logs v WHERE v.visitor_request_id = p_request_id) THEN
    RAISE EXCEPTION 'Visitor approval has already been used' USING ERRCODE = '23505';
  END IF;

  UPDATE public.visitor_requests SET status = 'USED', updated_at = NOW() WHERE id = p_request_id;
  INSERT INTO public.visitor_logs
    (id, visitor_request_id, visitor_name, contact_number, relationship_to_student, student_id,
     purpose, visit_date, authorization_status, person_contacted)
  VALUES
    (p_event_id, p_request_id, v_request.visitor_name, v_request.contact_number,
     v_request.visitor_relationship, v_request.student_id, v_request.purpose,
     NOW(), 'APPROVED', v_request.student_id::text);
  INSERT INTO public.notifications (recipient_id, actor_id, type, payload)
  SELECT recipients.profile_id, v_guard_id, 'visitor_checked_in',
    jsonb_build_object('visitor_request_id', p_request_id, 'visitor_name', v_request.visitor_name,
      'student_id', v_request.student_id, 'visit_time', NOW())
  FROM (
    SELECT s.profile_id FROM public.students s WHERE s.id = v_request.student_id
    UNION
    SELECT pa.profile_id FROM public.student_guardians sg JOIN public.parents pa ON pa.id = sg.parent_id
      WHERE sg.student_id = v_request.student_id AND sg.is_authorized
  ) recipients;
  RETURN p_event_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.notify_request_status_change()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor UUID;
  v_kind TEXT := TG_ARGV[0];
  v_type TEXT;
  v_payload JSONB;
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status OR NEW.status NOT IN ('APPROVED', 'REJECTED') THEN RETURN NEW; END IF;
  v_actor := COALESCE(NULLIF(to_jsonb(NEW)->>'reviewed_by', '')::UUID,
                      NULLIF(to_jsonb(NEW)->>'approved_by', '')::UUID);
  v_type := v_kind || '_' || lower(NEW.status);
  v_payload := jsonb_build_object('request_id', NEW.id, 'status', NEW.status, 'student_id', NEW.student_id);
  INSERT INTO public.notifications (recipient_id, actor_id, type, payload)
  SELECT recipients.profile_id, v_actor, v_type, v_payload
  FROM (
    SELECT s.profile_id FROM public.students s WHERE s.id = NEW.student_id
    UNION
    SELECT pa.profile_id FROM public.student_guardians sg
      JOIN public.parents pa ON pa.id = sg.parent_id
      WHERE sg.student_id = NEW.student_id AND sg.is_authorized
  ) recipients;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS early_out_request_status_notification ON public.early_out_requests;
CREATE TRIGGER early_out_request_status_notification
AFTER UPDATE OF status ON public.early_out_requests
FOR EACH ROW EXECUTE FUNCTION public.notify_request_status_change('early_out');

DROP TRIGGER IF EXISTS visitor_request_status_notification ON public.visitor_requests;
CREATE TRIGGER visitor_request_status_notification
AFTER UPDATE OF status ON public.visitor_requests
FOR EACH ROW EXECUTE FUNCTION public.notify_request_status_change('visitor_request');

REVOKE ALL ON FUNCTION public.register_guard_device(UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_offline_qr_cache() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.lookup_guard_person(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_manual_attendance(UUID, TEXT, UUID, TEXT, TIMESTAMPTZ, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_attendance_scan(UUID, TEXT, TEXT, TIMESTAMPTZ, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.issue_qr_credential(TEXT, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.issue_self_qr_credential() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_guard_dashboard_snapshot() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.check_in_authorized_visitor(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.notify_request_status_change() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.register_guard_device(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_offline_qr_cache() TO authenticated;
GRANT EXECUTE ON FUNCTION public.lookup_guard_person(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_manual_attendance(UUID, TEXT, UUID, TEXT, TIMESTAMPTZ, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_attendance_scan(UUID, TEXT, TEXT, TIMESTAMPTZ, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.issue_qr_credential(TEXT, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.issue_self_qr_credential() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_guard_dashboard_snapshot() TO authenticated;
GRANT EXECUTE ON FUNCTION public.check_in_authorized_visitor(UUID, UUID) TO authenticated;

-- Attendance is read-only to clients; validated inserts go through the RPC.
DO $$ BEGIN
  CREATE POLICY "attendance_read_authorized" ON public.attendance_events FOR SELECT TO authenticated
  USING (
    public.has_school_role('administrator') OR public.has_school_role('guard')
    OR (person_type = 'student' AND person_id IN (
      SELECT s.id FROM public.students s WHERE s.profile_id = (SELECT public.current_profile_id())
      OR s.id IN (SELECT sg.student_id FROM public.student_guardians sg JOIN public.parents pa ON pa.id = sg.parent_id
        WHERE pa.profile_id = (SELECT public.current_profile_id()) AND sg.is_authorized)
    ))
    OR (person_type = 'teacher' AND person_id IN (
      SELECT t.id FROM public.teachers t WHERE t.profile_id = (SELECT public.current_profile_id())
    ))
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "students_read_linked_guardians" ON public.students FOR SELECT TO authenticated
  USING (id IN (
    SELECT sg.student_id FROM public.student_guardians sg
    JOIN public.parents pa ON pa.id = sg.parent_id
    WHERE pa.profile_id = (SELECT public.current_profile_id()) AND sg.is_authorized
  ));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "attendance_summary_read_authorized" ON public.attendance_daily_summaries FOR SELECT TO authenticated
  USING (
    public.has_school_role('administrator') OR public.has_school_role('guard')
    OR student_id IN (SELECT s.id FROM public.students s WHERE s.profile_id = (SELECT public.current_profile_id())
      OR s.id IN (SELECT sg.student_id FROM public.student_guardians sg JOIN public.parents pa ON pa.id = sg.parent_id
        WHERE pa.profile_id = (SELECT public.current_profile_id()) AND sg.is_authorized))
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "early_out_read_authorized" ON public.early_out_requests FOR SELECT TO authenticated
  USING (public.has_school_role('administrator') OR public.has_school_role('staff') OR
    student_id IN (SELECT s.id FROM public.students s WHERE s.profile_id = (SELECT public.current_profile_id())
      OR s.id IN (SELECT sg.student_id FROM public.student_guardians sg JOIN public.parents pa ON pa.id = sg.parent_id
        WHERE pa.profile_id = (SELECT public.current_profile_id()) AND sg.is_authorized)));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "early_out_submit_self" ON public.early_out_requests FOR INSERT TO authenticated
  WITH CHECK (status = 'PENDING' AND reviewed_by IS NULL AND student_id IN
    (SELECT s.id FROM public.students s WHERE s.profile_id = (SELECT public.current_profile_id())));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "early_out_review_staff_admin" ON public.early_out_requests FOR UPDATE TO authenticated
  USING (public.has_school_role('administrator') OR public.has_school_role('staff'))
  WITH CHECK (public.has_school_role('administrator') OR public.has_school_role('staff'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "visitor_request_read_authorized" ON public.visitor_requests FOR SELECT TO authenticated
  USING (public.has_school_role('administrator') OR public.has_school_role('staff') OR
    student_id IN (SELECT s.id FROM public.students s WHERE s.profile_id = (SELECT public.current_profile_id())
      OR s.id IN (SELECT sg.student_id FROM public.student_guardians sg JOIN public.parents pa ON pa.id = sg.parent_id
        WHERE pa.profile_id = (SELECT public.current_profile_id()) AND sg.is_authorized)));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "visitor_request_guard_today" ON public.visitor_requests FOR SELECT TO authenticated
  USING (public.has_school_role('guard') AND visit_date = (NOW() AT TIME ZONE 'Asia/Manila')::date
    AND status = 'APPROVED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "visitor_request_submit_self" ON public.visitor_requests FOR INSERT TO authenticated
  WITH CHECK (status = 'PENDING' AND approved_by IS NULL AND student_id IN
    (SELECT s.id FROM public.students s WHERE s.profile_id = (SELECT public.current_profile_id())));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "visitor_request_review_staff_admin" ON public.visitor_requests FOR UPDATE TO authenticated
  USING (public.has_school_role('administrator') OR public.has_school_role('staff'))
  WITH CHECK (public.has_school_role('administrator') OR public.has_school_role('staff'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "visitor_logs_read_staff_guard_admin" ON public.visitor_logs FOR SELECT TO authenticated
  USING (public.has_school_role('administrator') OR public.has_school_role('guard') OR public.has_school_role('staff'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DROP POLICY IF EXISTS "visitor_logs_insert_guard" ON public.visitor_logs;
DO $$ BEGIN
  CREATE POLICY "visitor_logs_insert_guard" ON public.visitor_logs FOR INSERT TO authenticated
  WITH CHECK (public.has_school_role('guard') AND authorization_status = 'PENDING' AND actual_departure_time IS NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "visitor_logs_update_guard_staff_admin" ON public.visitor_logs FOR UPDATE TO authenticated
  USING (public.has_school_role('administrator') OR public.has_school_role('guard') OR public.has_school_role('staff'))
  WITH CHECK (public.has_school_role('administrator') OR public.has_school_role('guard') OR public.has_school_role('staff'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "notifications_read_self" ON public.notifications FOR SELECT TO authenticated
  USING (recipient_id = (SELECT public.current_profile_id()) OR public.has_school_role('administrator'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "notifications_update_self" ON public.notifications FOR UPDATE TO authenticated
  USING (recipient_id = (SELECT public.current_profile_id()))
  WITH CHECK (recipient_id = (SELECT public.current_profile_id()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "push_subscriptions_read_self" ON public.push_subscriptions FOR SELECT TO authenticated
  USING (user_id = (SELECT public.current_profile_id()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "push_subscriptions_insert_self" ON public.push_subscriptions FOR INSERT TO authenticated
  WITH CHECK (user_id = (SELECT public.current_profile_id()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "push_subscriptions_update_self" ON public.push_subscriptions FOR UPDATE TO authenticated
  USING (user_id = (SELECT public.current_profile_id()))
  WITH CHECK (user_id = (SELECT public.current_profile_id()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "push_subscriptions_delete_self" ON public.push_subscriptions FOR DELETE TO authenticated
  USING (user_id = (SELECT public.current_profile_id()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "announcements_read_active_users" ON public.announcements FOR SELECT TO authenticated
  USING ((SELECT public.current_profile_id()) IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "announcements_manage_admin" ON public.announcements FOR ALL TO authenticated
  USING (public.has_school_role('administrator')) WITH CHECK (public.has_school_role('administrator'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "devices_read_self_admin" ON public.devices FOR SELECT TO authenticated
  USING (user_id = (SELECT public.current_profile_id()) OR public.has_school_role('administrator'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "qr_codes_admin_only" ON public.student_qr_codes FOR SELECT TO authenticated
  USING (public.has_school_role('administrator'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "teacher_qr_codes_admin_only" ON public.teacher_qr_codes FOR SELECT TO authenticated
  USING (public.has_school_role('administrator'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "sections_read_authenticated" ON public.sections FOR SELECT TO authenticated
  USING ((SELECT public.current_profile_id()) IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "schedules_read_authenticated" ON public.school_schedules FOR SELECT TO authenticated
  USING ((SELECT public.current_profile_id()) IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Grant only the table operations explicitly covered by RLS.
GRANT SELECT ON public.attendance_events, public.attendance_daily_summaries,
  public.early_out_requests, public.visitor_requests, public.visitor_logs,
  public.notifications, public.announcements, public.devices, public.sections,
  public.school_schedules, public.student_qr_codes, public.teacher_qr_codes,
  public.profiles, public.students, public.teachers, public.parents,
  public.student_guardians TO authenticated;
GRANT INSERT ON public.early_out_requests, public.visitor_requests, public.visitor_logs TO authenticated;
GRANT UPDATE ON public.early_out_requests, public.visitor_requests, public.visitor_logs, public.notifications TO authenticated;
GRANT INSERT, UPDATE, DELETE ON public.announcements TO authenticated;
REVOKE UPDATE ON public.notifications FROM authenticated;
GRANT UPDATE (is_read) ON public.notifications TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.push_subscriptions TO authenticated;

