-- Admin module access for the existing school records.
-- Apply after schema.sql and the SchoolGuard core migration.

DO $$ BEGIN
  CREATE POLICY "students_admin_update" ON public.students
    FOR UPDATE TO authenticated
    USING (public.has_school_role('administrator'))
    WITH CHECK (public.has_school_role('administrator'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

GRANT UPDATE (status, grade_level, section_id, updated_at) ON public.students TO authenticated;

DO $$ BEGIN
  CREATE POLICY "sections_admin_insert" ON public.sections
    FOR INSERT TO authenticated
    WITH CHECK (public.has_school_role('administrator'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "sections_admin_update" ON public.sections
    FOR UPDATE TO authenticated
    USING (public.has_school_role('administrator'))
    WITH CHECK (public.has_school_role('administrator'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "sections_admin_delete" ON public.sections
    FOR DELETE TO authenticated
    USING (public.has_school_role('administrator'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

GRANT INSERT, UPDATE, DELETE ON public.sections TO authenticated;

DO $$ BEGIN
  CREATE POLICY "audit_logs_admin_read" ON public.audit_logs
    FOR SELECT TO authenticated
    USING (public.has_school_role('administrator'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

GRANT SELECT ON public.audit_logs TO authenticated;

DO $$ BEGIN
  CREATE POLICY "profiles_admin_update" ON public.profiles
    FOR UPDATE TO authenticated
    USING (public.has_school_role('administrator'))
    WITH CHECK (public.has_school_role('administrator'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

GRANT UPDATE (role, is_active, updated_at) ON public.profiles TO authenticated;

-- Record changes performed through administrator CRUD pages. The trigger
-- writes with its table owner's privileges; authenticated clients receive
-- read access only through the administrator policy above.
CREATE OR REPLACE FUNCTION public.log_admin_record_change()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_record JSONB;
  v_id UUID;
BEGIN
  v_record := CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  v_id := NULLIF(v_record->>'id', '')::UUID;
  INSERT INTO public.audit_logs (actor_id, entity_type, entity_id, action, details)
  VALUES (public.current_profile_id(), TG_TABLE_NAME, v_id, lower(TG_OP),
    jsonb_build_object('record', v_record));
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.log_admin_record_change() FROM PUBLIC;

DROP TRIGGER IF EXISTS admin_students_audit ON public.students;
CREATE TRIGGER admin_students_audit AFTER INSERT OR UPDATE OR DELETE ON public.students
FOR EACH ROW EXECUTE FUNCTION public.log_admin_record_change();

DROP TRIGGER IF EXISTS admin_sections_audit ON public.sections;
CREATE TRIGGER admin_sections_audit AFTER INSERT OR UPDATE OR DELETE ON public.sections
FOR EACH ROW EXECUTE FUNCTION public.log_admin_record_change();

DROP TRIGGER IF EXISTS admin_profiles_audit ON public.profiles;
CREATE TRIGGER admin_profiles_audit AFTER INSERT OR UPDATE OR DELETE ON public.profiles
FOR EACH ROW EXECUTE FUNCTION public.log_admin_record_change();

DROP TRIGGER IF EXISTS admin_announcements_audit ON public.announcements;
CREATE TRIGGER admin_announcements_audit AFTER INSERT OR UPDATE OR DELETE ON public.announcements
FOR EACH ROW EXECUTE FUNCTION public.log_admin_record_change();
