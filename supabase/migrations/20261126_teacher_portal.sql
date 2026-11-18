-- Teacher portal support: scoped preferences and notifications for validated events.
CREATE TABLE IF NOT EXISTS public.teacher_notification_preferences (
  profile_id UUID PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  attendance_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  announcement_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.teacher_notification_preferences ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS teacher_notification_preferences_self ON public.teacher_notification_preferences;
CREATE POLICY teacher_notification_preferences_self ON public.teacher_notification_preferences
  FOR ALL TO authenticated
  USING (profile_id = (SELECT public.current_profile_id()) AND public.has_school_role('teacher'))
  WITH CHECK (profile_id = (SELECT public.current_profile_id()) AND public.has_school_role('teacher'));
GRANT SELECT, INSERT, UPDATE ON public.teacher_notification_preferences TO authenticated;

-- Teachers may read announcements targeted to sections they advise.
CREATE OR REPLACE FUNCTION public.can_read_school_announcement(p_announcement_id UUID)
RETURNS BOOLEAN LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_role TEXT; v_profile UUID;
BEGIN
  SELECT p.role,p.id INTO v_role,v_profile FROM public.profiles p
  WHERE p.auth_user_id = (SELECT auth.uid()) AND p.is_active;
  IF v_profile IS NULL THEN RETURN FALSE; END IF;
  IF v_role = 'administrator' THEN RETURN TRUE; END IF;
  RETURN EXISTS (
    SELECT 1 FROM public.announcements a
    WHERE a.id = p_announcement_id
      AND a.status IN ('published','scheduled')
      AND a.published_at IS NOT NULL AND a.published_at <= NOW()
      AND (a.expires_at IS NULL OR a.expires_at > NOW())
      AND (a.audience = 'all' OR a.audience = v_role)
      AND (
        (v_role = 'teacher' AND (a.target_grade_level IS NULL OR EXISTS (
          SELECT 1 FROM public.teachers t JOIN public.sections s ON s.adviser_id=t.id
          WHERE t.profile_id=v_profile AND s.grade_level=a.target_grade_level
        )) AND (a.target_section_id IS NULL OR EXISTS (
          SELECT 1 FROM public.teachers t JOIN public.sections s ON s.adviser_id=t.id
          WHERE t.profile_id=v_profile AND s.id=a.target_section_id
        )))
        OR (v_role = 'student' AND (a.target_grade_level IS NULL OR EXISTS (
          SELECT 1 FROM public.students s WHERE s.profile_id=v_profile AND s.grade_level=a.target_grade_level
        )) AND (a.target_section_id IS NULL OR EXISTS (
          SELECT 1 FROM public.students s WHERE s.profile_id=v_profile AND s.section_id=a.target_section_id
        )))
        OR (v_role NOT IN ('teacher','student') AND a.target_grade_level IS NULL AND a.target_section_id IS NULL)
      )
  );
END;
$$;
REVOKE ALL ON FUNCTION public.can_read_school_announcement(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.can_read_school_announcement(UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.notify_teacher_attendance_event()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_profile UUID; v_name TEXT; v_enabled BOOLEAN;
BEGIN
  IF NEW.person_type <> 'teacher' OR NEW.sync_status <> 'SYNCED'
     OR NEW.verification_result NOT IN ('VERIFIED','MANUAL_VERIFIED','LATE') THEN RETURN NEW; END IF;
  SELECT t.profile_id,p.full_name INTO v_profile,v_name
  FROM public.teachers t JOIN public.profiles p ON p.id=t.profile_id
  WHERE t.id=NEW.person_id AND p.is_active AND p.role='teacher';
  IF v_profile IS NULL THEN RETURN NEW; END IF;
  SELECT attendance_enabled INTO v_enabled FROM public.teacher_notification_preferences WHERE profile_id=v_profile;
  IF COALESCE(v_enabled,TRUE) AND NOT EXISTS (
    SELECT 1 FROM public.notifications n WHERE n.recipient_id=v_profile
      AND n.type='teacher_attendance_recorded' AND n.payload->>'event_id'=NEW.id::text
  ) THEN
    INSERT INTO public.notifications(recipient_id,actor_id,type,payload)
    VALUES(v_profile,NEW.scanning_guard_id,'teacher_attendance_recorded',jsonb_build_object(
      'event_id',NEW.id,'event_type',NEW.event_type,'actual_scan_time',NEW.actual_scan_time,
      'category','attendance','title','Teacher attendance recorded',
      'message',v_name||' attendance was recorded as '||replace(lower(NEW.event_type),'_',' ')||' at '||
        to_char(NEW.actual_scan_time AT TIME ZONE 'Asia/Manila','FMHH12:MI AM')||' on '||
        to_char(NEW.actual_scan_time AT TIME ZONE 'Asia/Manila','Mon DD, YYYY')||'.'
    ));
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.notify_teacher_attendance_event() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS teacher_attendance_notification ON public.attendance_events;
CREATE TRIGGER teacher_attendance_notification AFTER INSERT ON public.attendance_events
  FOR EACH ROW EXECUTE FUNCTION public.notify_teacher_attendance_event();

CREATE OR REPLACE FUNCTION public.notify_teacher_announcement()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NEW.status <> 'published' OR NEW.published_at IS NULL OR NEW.published_at > NOW()
     OR (NEW.expires_at IS NOT NULL AND NEW.expires_at <= NOW())
     OR NEW.audience NOT IN ('all','teacher')
     OR (TG_OP='UPDATE' AND OLD.status='published' AND OLD.title=NEW.title AND OLD.body=NEW.body
         AND OLD.audience=NEW.audience AND OLD.published_at IS NOT DISTINCT FROM NEW.published_at) THEN
    RETURN NEW;
  END IF;
  INSERT INTO public.notifications(recipient_id,actor_id,type,payload)
  SELECT p.id,NEW.created_by,'announcement_published',jsonb_build_object(
    'announcement_id',NEW.id,'title',NEW.title,'message',COALESCE(NEW.summary,NEW.title),
    'category','announcements'
  )
  FROM public.profiles p
  LEFT JOIN public.teacher_notification_preferences pref ON pref.profile_id=p.id
  WHERE p.role='teacher' AND p.is_active AND COALESCE(pref.announcement_enabled,TRUE)
    AND (NEW.target_grade_level IS NULL OR EXISTS (
      SELECT 1 FROM public.teachers t JOIN public.sections s ON s.adviser_id=t.id
      WHERE t.profile_id=p.id AND s.grade_level=NEW.target_grade_level
    ))
    AND (NEW.target_section_id IS NULL OR EXISTS (
      SELECT 1 FROM public.teachers t JOIN public.sections s ON s.adviser_id=t.id
      WHERE t.profile_id=p.id AND s.id=NEW.target_section_id
    ))
    AND NOT EXISTS (SELECT 1 FROM public.notifications n WHERE n.recipient_id=p.id
      AND n.type='announcement_published' AND n.payload->>'announcement_id'=NEW.id::text);
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.notify_teacher_announcement() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS teacher_announcement_notification ON public.announcements;
CREATE TRIGGER teacher_announcement_notification AFTER INSERT OR UPDATE OF status,title,body,audience,published_at,target_grade_level,target_section_id
  ON public.announcements FOR EACH ROW EXECUTE FUNCTION public.notify_teacher_announcement();

-- Administrator-controlled revocation for a lost or compromised teacher QR.
CREATE OR REPLACE FUNCTION public.revoke_teacher_qr_credential(p_teacher_id UUID)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_count INTEGER;
BEGIN
  IF NOT public.has_school_role('administrator') THEN
    RAISE EXCEPTION 'Only administrators may revoke teacher QR credentials' USING ERRCODE='42501';
  END IF;
  UPDATE public.teacher_qr_codes SET is_active=FALSE,revoked_at=NOW(),updated_at=NOW()
  WHERE teacher_id=p_teacher_id AND is_active;
  GET DIAGNOSTICS v_count=ROW_COUNT;
  RETURN v_count > 0;
END;
$$;
REVOKE ALL ON FUNCTION public.revoke_teacher_qr_credential(UUID) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.revoke_teacher_qr_credential(UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.audit_teacher_qr_credential_change()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_actor UUID:=public.current_profile_id(); v_teacher_id UUID; v_action TEXT;
BEGIN
  v_teacher_id:=NEW.teacher_id;
  IF TG_OP='UPDATE' AND OLD.is_active IS DISTINCT FROM NEW.is_active AND NEW.is_active=FALSE THEN
    v_action:='teacher_qr_revoked';
  ELSIF TG_OP='INSERT' AND NEW.is_active THEN
    v_action:='teacher_qr_issued';
  ELSE
    RETURN NEW;
  END IF;
  INSERT INTO public.audit_logs(actor_id,entity_type,entity_id,action,details)
  VALUES(v_actor,'teacher_qr_credential',v_teacher_id,v_action,
    jsonb_build_object('credential_id',NEW.id,'active',NEW.is_active));
  INSERT INTO public.notifications(recipient_id,actor_id,type,payload)
  SELECT t.profile_id,v_actor,v_action,jsonb_build_object(
    'credential_id',NEW.id,'title',CASE WHEN NEW.is_active THEN 'Teacher QR credential replaced' ELSE 'Teacher QR credential deactivated' END,
    'message',CASE WHEN NEW.is_active THEN 'A new attendance QR credential was issued for your teacher account. Save the new code before using it at the gate.' ELSE 'Your attendance QR credential was deactivated by an administrator. Contact the school to receive a replacement.' END,
    'category','account'
  ) FROM public.teachers t WHERE t.id=v_teacher_id AND v_actor IS DISTINCT FROM t.profile_id;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.audit_teacher_qr_credential_change() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS teacher_qr_credential_audit ON public.teacher_qr_codes;
CREATE TRIGGER teacher_qr_credential_audit AFTER INSERT OR UPDATE OF is_active ON public.teacher_qr_codes
  FOR EACH ROW EXECUTE FUNCTION public.audit_teacher_qr_credential_change();
