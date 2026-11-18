-- Extend the existing audit trail with durable, readable snapshots and safe diffs.
ALTER TABLE public.audit_logs
  ADD COLUMN IF NOT EXISTS actor_name_snapshot TEXT,
  ADD COLUMN IF NOT EXISTS actor_email_snapshot TEXT,
  ADD COLUMN IF NOT EXISTS actor_role_snapshot TEXT,
  ADD COLUMN IF NOT EXISTS module TEXT NOT NULL DEFAULT 'system',
  ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS entity_label TEXT,
  ADD COLUMN IF NOT EXISTS old_values JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS new_values JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS changed_fields TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'success';

UPDATE public.audit_logs l SET
  actor_name_snapshot = COALESCE(l.actor_name_snapshot,p.full_name,'System'),
  actor_email_snapshot = COALESCE(l.actor_email_snapshot,p.email),
  actor_role_snapshot = COALESCE(l.actor_role_snapshot,p.role),
  module = CASE
    WHEN l.entity_type IN ('student','students','student_private_details') THEN 'students'
    WHEN l.entity_type IN ('enrollment','enrollment_record','enrollment_records') THEN 'enrollment'
    WHEN l.entity_type IN ('profile','profiles','teacher','teachers') THEN 'accounts'
    WHEN l.entity_type IN ('announcement','announcements') THEN 'announcements'
    WHEN l.entity_type IN ('section','sections') THEN 'classes'
    WHEN l.entity_type IN ('attendance_event','attendance_events') THEN 'attendance'
    ELSE COALESCE(l.module,'system') END,
  description = COALESCE(NULLIF(l.description,''),replace(initcap(replace(l.action,'_',' ')),'  ',' ')),
  status = COALESCE(l.status,'success')
FROM public.profiles p WHERE p.id=l.actor_id;

CREATE INDEX IF NOT EXISTS audit_logs_created_at_idx ON public.audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS audit_logs_module_created_idx ON public.audit_logs(module,created_at DESC);
CREATE INDEX IF NOT EXISTS audit_logs_actor_created_idx ON public.audit_logs(actor_id,created_at DESC);
CREATE INDEX IF NOT EXISTS audit_logs_action_created_idx ON public.audit_logs(action,created_at DESC);

ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "audit_logs_admin_read" ON public.audit_logs;
CREATE POLICY "audit_logs_admin_read" ON public.audit_logs
  FOR SELECT TO authenticated USING (public.has_school_role('administrator'));

CREATE OR REPLACE FUNCTION public.audit_safe_values(p_table TEXT,p_row JSONB)
RETURNS JSONB LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE v_keys TEXT[];
BEGIN
  v_keys := CASE p_table
    WHEN 'student' THEN ARRAY['student_id','grade_level','section_id','status']
    WHEN 'students' THEN ARRAY['student_id','grade_level','section_id','status']
    WHEN 'enrollment_record' THEN ARRAY['school_year','grade_level','section_id','enrollment_type','status','student_id']
    WHEN 'enrollment_records' THEN ARRAY['school_year','grade_level','section_id','enrollment_type','status','student_id']
    WHEN 'profile' THEN ARRAY['full_name','email','role','is_active']
    WHEN 'profiles' THEN ARRAY['full_name','email','role','is_active']
    WHEN 'teacher' THEN ARRAY['teacher_id','designation']
    WHEN 'teachers' THEN ARRAY['teacher_id','designation']
    WHEN 'section' THEN ARRAY['name','grade_level']
    WHEN 'sections' THEN ARRAY['name','grade_level']
    WHEN 'announcement' THEN ARRAY['title','summary','audience','category','priority','status','published_at','expires_at']
    WHEN 'announcements' THEN ARRAY['title','summary','audience','category','priority','status','published_at','expires_at']
    ELSE ARRAY[]::TEXT[] END;
  RETURN COALESCE((SELECT jsonb_object_agg(fields.key,p_row->fields.key) FROM unnest(v_keys) AS fields(key) WHERE p_row ? fields.key), '{}'::jsonb);
END;
$$;
REVOKE ALL ON FUNCTION public.audit_safe_values(TEXT,JSONB) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.log_admin_record_change()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_row JSONB;
  v_old JSONB := '{}'::jsonb;
  v_new JSONB := '{}'::jsonb;
  v_id UUID;
  v_actor UUID := public.current_profile_id();
  v_name TEXT;
  v_email TEXT;
  v_role TEXT;
  v_module TEXT;
  v_action TEXT;
  v_description TEXT;
  v_label TEXT;
  v_fields TEXT[] := '{}';
BEGIN
  v_row := CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  -- Service-role provisioning is logged explicitly by its trusted Edge Function,
  -- which knows the administrator who initiated the multi-table operation.
  IF v_actor IS NULL THEN IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF; END IF;
  v_id := NULLIF(v_row->>'id','')::UUID;
  IF TG_OP <> 'INSERT' THEN v_old := public.audit_safe_values(TG_TABLE_NAME,to_jsonb(OLD)); END IF;
  IF TG_OP <> 'DELETE' THEN v_new := public.audit_safe_values(TG_TABLE_NAME,to_jsonb(NEW)); END IF;
  IF TG_OP='UPDATE' THEN
    SELECT COALESCE(array_agg(keys.key ORDER BY keys.key),'{}'::TEXT[]) INTO v_fields
    FROM jsonb_object_keys(v_old || v_new) AS keys(key)
    WHERE v_old->keys.key IS DISTINCT FROM v_new->keys.key;
    IF cardinality(v_fields)=0 THEN RETURN NEW; END IF;
  ELSIF TG_OP='INSERT' THEN SELECT COALESCE(array_agg(keys.key ORDER BY keys.key),'{}'::TEXT[]) INTO v_fields FROM jsonb_object_keys(v_new) AS keys(key);
  ELSE SELECT COALESCE(array_agg(keys.key ORDER BY keys.key),'{}'::TEXT[]) INTO v_fields FROM jsonb_object_keys(v_old) AS keys(key);
  END IF;

  SELECT p.full_name,p.email,p.role INTO v_name,v_email,v_role FROM public.profiles p WHERE p.id=v_actor;
  v_module := CASE TG_TABLE_NAME WHEN 'students' THEN 'students' WHEN 'enrollment_records' THEN 'enrollment'
    WHEN 'profiles' THEN 'accounts' WHEN 'teachers' THEN 'accounts' WHEN 'sections' THEN 'classes'
    WHEN 'announcements' THEN 'announcements' ELSE 'system' END;
  v_action := CASE
    WHEN TG_TABLE_NAME='announcements' AND TG_OP='INSERT' THEN 'announcement_created'
    WHEN TG_TABLE_NAME='announcements' AND TG_OP='DELETE' THEN 'announcement_deleted'
    WHEN TG_TABLE_NAME='announcements' AND v_old->>'status' IS DISTINCT FROM v_new->>'status' AND v_new->>'status'='published' THEN 'announcement_published'
    WHEN TG_TABLE_NAME='announcements' AND v_old->>'status' IS DISTINCT FROM v_new->>'status' AND v_new->>'status'='scheduled' THEN 'announcement_scheduled'
    WHEN TG_TABLE_NAME='announcements' AND v_old->>'status' IS DISTINCT FROM v_new->>'status' AND v_new->>'status'='unpublished' THEN 'announcement_unpublished'
    WHEN TG_TABLE_NAME='announcements' AND v_old->>'status' IS DISTINCT FROM v_new->>'status' AND v_new->>'status'='archived' THEN 'announcement_archived'
    WHEN TG_TABLE_NAME='announcements' AND v_old->>'status'='archived' AND v_new->>'status' IN ('published','scheduled') THEN 'announcement_restored'
    WHEN TG_TABLE_NAME='announcements' THEN 'announcement_edited'
    WHEN TG_TABLE_NAME='enrollment_records' AND TG_OP='INSERT' THEN 'enrollment_created'
    WHEN TG_TABLE_NAME='enrollment_records' AND v_old->>'status' IS DISTINCT FROM v_new->>'status' AND v_new->>'status'='APPROVED' THEN 'enrollment_approved'
    WHEN TG_TABLE_NAME='enrollment_records' AND v_old->>'status' IS DISTINCT FROM v_new->>'status' AND v_new->>'status'='REJECTED' THEN 'enrollment_rejected'
    WHEN TG_TABLE_NAME='enrollment_records' AND v_old->>'status' IS DISTINCT FROM v_new->>'status' THEN 'enrollment_status_changed'
    WHEN TG_TABLE_NAME='enrollment_records' THEN 'enrollment_updated'
    WHEN TG_TABLE_NAME='students' AND TG_OP='INSERT' THEN 'student_registered'
    WHEN TG_TABLE_NAME='students' AND TG_OP='DELETE' THEN 'student_deleted'
    WHEN TG_TABLE_NAME='students' AND v_old->>'status' IS DISTINCT FROM v_new->>'status' AND v_new->>'status'='archived' THEN 'student_archived'
    WHEN TG_TABLE_NAME='students' AND v_old->>'status'='archived' AND v_new->>'status' IS DISTINCT FROM 'archived' THEN 'student_restored'
    WHEN TG_TABLE_NAME='students' AND v_old->>'section_id' IS DISTINCT FROM v_new->>'section_id' THEN 'student_section_transferred'
    WHEN TG_TABLE_NAME='students' THEN 'student_updated'
    WHEN TG_TABLE_NAME='profiles' AND v_old->>'is_active' IS DISTINCT FROM v_new->>'is_active' AND v_new->>'is_active'='false' THEN 'account_deactivated'
    WHEN TG_TABLE_NAME='profiles' AND v_old->>'is_active' IS DISTINCT FROM v_new->>'is_active' AND v_new->>'is_active'='true' THEN 'account_activated'
    WHEN TG_TABLE_NAME='profiles' AND v_old->>'role' IS DISTINCT FROM v_new->>'role' THEN 'account_role_changed'
    WHEN TG_TABLE_NAME='profiles' THEN 'account_updated'
    WHEN TG_TABLE_NAME='teachers' AND TG_OP='INSERT' THEN 'teacher_record_created'
    WHEN TG_TABLE_NAME='teachers' AND TG_OP='DELETE' THEN 'teacher_record_deleted'
    WHEN TG_TABLE_NAME='teachers' THEN 'teacher_record_updated'
    WHEN TG_TABLE_NAME='sections' AND TG_OP='INSERT' THEN 'section_created'
    WHEN TG_TABLE_NAME='sections' AND TG_OP='DELETE' THEN 'section_deleted'
    WHEN TG_TABLE_NAME='sections' THEN 'section_updated'
    ELSE lower(TG_OP) END;
  v_description := replace(initcap(replace(v_action,'_',' ')),'  ',' ');
  v_label := COALESCE(v_row->>'student_id',v_row->>'teacher_id',v_row->>'full_name',v_row->>'title',
    CASE WHEN v_row ? 'name' THEN concat_ws(' · ',v_row->>'name',v_row->>'grade_level') END,v_id::TEXT);
  IF TG_TABLE_NAME='enrollment_records' THEN
    SELECT s.student_id INTO v_label FROM public.students s WHERE s.id=NULLIF(v_row->>'student_id','')::UUID;
  END IF;

  INSERT INTO public.audit_logs(actor_id,actor_name_snapshot,actor_email_snapshot,actor_role_snapshot,
    entity_type,entity_id,entity_label,action,module,description,old_values,new_values,changed_fields,status,details)
  VALUES(v_actor,COALESCE(v_name,'System'),v_email,v_role,TG_TABLE_NAME,v_id,v_label,v_action,v_module,
    v_description,v_old,v_new,v_fields,'success',jsonb_build_object('changed_fields',v_fields,'old_values',v_old,'new_values',v_new));
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.log_admin_record_change() FROM PUBLIC;

-- Profile creation is already audited by the trusted account provisioning Edge Function.
DROP TRIGGER IF EXISTS admin_profiles_audit ON public.profiles;
CREATE TRIGGER admin_profiles_audit AFTER UPDATE OR DELETE ON public.profiles
FOR EACH ROW EXECUTE FUNCTION public.log_admin_record_change();
DROP TRIGGER IF EXISTS admin_students_audit ON public.students;
CREATE TRIGGER admin_students_audit AFTER INSERT OR UPDATE OR DELETE ON public.students
FOR EACH ROW EXECUTE FUNCTION public.log_admin_record_change();
DROP TRIGGER IF EXISTS enrollment_records_audit ON public.enrollment_records;
CREATE TRIGGER enrollment_records_audit AFTER INSERT OR UPDATE OR DELETE ON public.enrollment_records
FOR EACH ROW EXECUTE FUNCTION public.log_admin_record_change();
DROP TRIGGER IF EXISTS admin_teachers_audit ON public.teachers;
CREATE TRIGGER admin_teachers_audit AFTER INSERT OR UPDATE OR DELETE ON public.teachers
FOR EACH ROW EXECUTE FUNCTION public.log_admin_record_change();
DROP TRIGGER IF EXISTS admin_sections_audit ON public.sections;
CREATE TRIGGER admin_sections_audit AFTER INSERT OR UPDATE OR DELETE ON public.sections
FOR EACH ROW EXECUTE FUNCTION public.log_admin_record_change();
DROP TRIGGER IF EXISTS admin_announcements_audit ON public.announcements;
CREATE TRIGGER admin_announcements_audit AFTER INSERT OR UPDATE OR DELETE ON public.announcements
FOR EACH ROW EXECUTE FUNCTION public.log_admin_record_change();

-- Remove legacy full-row payloads (which may contain unnecessary personal data)
-- while keeping event history and retaining only the field allow-list.
UPDATE public.audit_logs l SET
  old_values=CASE WHEN l.action='delete' THEN public.audit_safe_values(l.entity_type,COALESCE(l.details->'record','{}'::jsonb)) ELSE '{}'::jsonb END,
  new_values=CASE WHEN l.action IN ('insert','update') THEN public.audit_safe_values(l.entity_type,COALESCE(l.details->'record','{}'::jsonb)) ELSE '{}'::jsonb END,
  entity_label=COALESCE(l.entity_label,l.details->'record'->>'student_id',l.details->'record'->>'teacher_id',l.details->'record'->>'full_name',l.details->'record'->>'title',l.entity_id::text),
  changed_fields=CASE WHEN l.action IN ('insert','delete') THEN ARRAY(SELECT jsonb_object_keys(public.audit_safe_values(l.entity_type,COALESCE(l.details->'record','{}'::jsonb)))) ELSE '{}'::TEXT[] END,
  details=jsonb_build_object('legacy_record_redacted',true,'changed_fields',CASE WHEN l.action IN ('insert','delete') THEN to_jsonb(ARRAY(SELECT jsonb_object_keys(public.audit_safe_values(l.entity_type,COALESCE(l.details->'record','{}'::jsonb))))) ELSE '[]'::jsonb END)
WHERE l.details ? 'record';
UPDATE public.audit_logs SET actor_name_snapshot='System' WHERE actor_name_snapshot IS NULL;
UPDATE public.audit_logs SET description=replace(initcap(replace(action,'_',' ')),'  ',' ') WHERE description='';

CREATE OR REPLACE FUNCTION public.prevent_audit_log_mutation()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN RAISE EXCEPTION 'Audit log records are append-only' USING ERRCODE='42501'; END;
$$;
REVOKE ALL ON FUNCTION public.prevent_audit_log_mutation() FROM PUBLIC;
CREATE OR REPLACE FUNCTION public.fill_audit_log_metadata()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_profile public.profiles%ROWTYPE;
BEGIN
  IF NEW.actor_id IS NOT NULL AND NEW.actor_name_snapshot IS NULL THEN
    SELECT * INTO v_profile FROM public.profiles WHERE id=NEW.actor_id;
    NEW.actor_name_snapshot:=COALESCE(v_profile.full_name,'System');
    NEW.actor_email_snapshot:=v_profile.email;
    NEW.actor_role_snapshot:=v_profile.role;
  END IF;
  NEW.actor_name_snapshot:=COALESCE(NEW.actor_name_snapshot,'System');
  IF NEW.module='system' THEN NEW.module:=CASE
    WHEN NEW.entity_type IN ('student','students','student_private_details') THEN 'students'
    WHEN NEW.entity_type IN ('enrollment','enrollment_record','enrollment_records') THEN 'enrollment'
    WHEN NEW.entity_type IN ('profile','profiles','teacher','teachers') THEN 'accounts'
    WHEN NEW.entity_type IN ('announcement','announcements') THEN 'announcements'
    WHEN NEW.entity_type IN ('section','sections') THEN 'classes'
    WHEN NEW.entity_type IN ('attendance_event','attendance_events') THEN 'attendance'
    ELSE 'system' END; END IF;
  IF NEW.description='' THEN NEW.description:=replace(initcap(replace(NEW.action,'_',' ')),'  ',' '); END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.fill_audit_log_metadata() FROM PUBLIC;
DROP TRIGGER IF EXISTS audit_logs_fill_metadata ON public.audit_logs;
CREATE TRIGGER audit_logs_fill_metadata BEFORE INSERT ON public.audit_logs
FOR EACH ROW EXECUTE FUNCTION public.fill_audit_log_metadata();
DROP TRIGGER IF EXISTS audit_logs_append_only ON public.audit_logs;
CREATE TRIGGER audit_logs_append_only BEFORE UPDATE OR DELETE ON public.audit_logs
FOR EACH ROW EXECUTE FUNCTION public.prevent_audit_log_mutation();
REVOKE INSERT,UPDATE,DELETE,TRUNCATE ON public.audit_logs FROM anon,authenticated;
GRANT SELECT ON public.audit_logs TO authenticated;

CREATE OR REPLACE FUNCTION public.record_auth_activity(p_action TEXT)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_actor UUID:=public.current_profile_id(); v_id UUID;
BEGIN
  IF v_actor IS NULL OR p_action IS NULL OR p_action NOT IN ('login','logout') THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE='42501'; END IF;
  INSERT INTO public.audit_logs(actor_id,actor_name_snapshot,actor_email_snapshot,actor_role_snapshot,entity_type,entity_id,action,module,description,status)
  SELECT p.id,p.full_name,p.email,p.role,'profile',p.id,'auth_'||p_action,'authentication',initcap(p_action),'success'
  FROM public.profiles p WHERE p.id=v_actor RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION public.record_auth_activity(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_auth_activity(TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION public.record_export_activity(p_report TEXT,p_category TEXT,p_format TEXT,p_record_count INTEGER,p_filters JSONB DEFAULT '{}'::jsonb)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_actor UUID:=public.current_profile_id(); v_id UUID;
BEGIN
  IF v_actor IS NULL OR NOT public.has_school_role('administrator') THEN RAISE EXCEPTION 'Administrator access required' USING ERRCODE='42501'; END IF;
  IF p_format IS NULL OR p_format NOT IN ('csv','xlsx','pdf') OR p_record_count IS NULL OR p_record_count<0 OR p_record_count>1000000 THEN RAISE EXCEPTION 'Invalid export metadata' USING ERRCODE='22023'; END IF;
  INSERT INTO public.audit_logs(actor_id,actor_name_snapshot,actor_email_snapshot,actor_role_snapshot,entity_type,action,module,description,new_values,status)
  SELECT p.id,p.full_name,p.email,p.role,'report_export','report_exported','exports',
    initcap(p_format)||' report generated: '||left(COALESCE(p_report,'School report'),120),
    jsonb_build_object('report',left(COALESCE(p_report,'School report'),120),'category',left(COALESCE(p_category,'other'),60),
      'format',p_format,'record_count',p_record_count,'filters',COALESCE(p_filters,'{}'::jsonb)), 'success'
  FROM public.profiles p WHERE p.id=v_actor RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION public.record_export_activity(TEXT,TEXT,TEXT,INTEGER,JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_export_activity(TEXT,TEXT,TEXT,INTEGER,JSONB) TO authenticated;

CREATE OR REPLACE FUNCTION public.record_password_reset_request(p_target_profile UUID)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_actor UUID:=public.current_profile_id(); v_target public.profiles%ROWTYPE; v_id UUID;
BEGIN
  IF v_actor IS NULL OR NOT public.has_school_role('administrator') THEN RAISE EXCEPTION 'Administrator access required' USING ERRCODE='42501'; END IF;
  SELECT * INTO v_target FROM public.profiles WHERE id=p_target_profile;
  IF NOT FOUND THEN RAISE EXCEPTION 'Account not found' USING ERRCODE='P0002'; END IF;
  INSERT INTO public.audit_logs(actor_id,actor_name_snapshot,actor_email_snapshot,actor_role_snapshot,entity_type,entity_id,entity_label,action,module,description,status)
  SELECT p.id,p.full_name,p.email,p.role,'profile',v_target.id,v_target.full_name,'password_reset_requested','accounts','Password reset email requested','success'
  FROM public.profiles p WHERE p.id=v_actor RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION public.record_password_reset_request(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_password_reset_request(UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.record_announcement_attachment_activity(p_announcement_id UUID,p_action TEXT,p_file_count INTEGER)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_actor UUID:=public.current_profile_id(); v_announcement public.announcements%ROWTYPE; v_id UUID;
BEGIN
  IF v_actor IS NULL OR NOT public.has_school_role('administrator') THEN RAISE EXCEPTION 'Administrator access required' USING ERRCODE='42501'; END IF;
  IF p_action IS NULL OR p_action NOT IN ('uploaded','removed') OR p_file_count IS NULL OR p_file_count<1 OR p_file_count>100 THEN RAISE EXCEPTION 'Invalid attachment activity' USING ERRCODE='22023'; END IF;
  SELECT * INTO v_announcement FROM public.announcements WHERE id=p_announcement_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Announcement not found' USING ERRCODE='P0002'; END IF;
  INSERT INTO public.audit_logs(actor_id,entity_type,entity_id,entity_label,action,module,description,new_values,status)
  VALUES(v_actor,'announcements',v_announcement.id,v_announcement.title,'announcement_attachment_'||p_action,'announcements',
    'Announcement attachment '||p_action,jsonb_build_object('file_count',p_file_count),'success') RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION public.record_announcement_attachment_activity(UUID,TEXT,INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_announcement_attachment_activity(UUID,TEXT,INTEGER) TO authenticated;
