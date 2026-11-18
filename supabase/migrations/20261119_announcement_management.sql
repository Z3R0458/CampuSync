-- Extend existing announcements without replacing or deleting published rows.
ALTER TABLE public.announcements
  ADD COLUMN IF NOT EXISTS summary TEXT,
  ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT 'general',
  ADD COLUMN IF NOT EXISTS priority TEXT NOT NULL DEFAULT 'normal',
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'published',
  ADD COLUMN IF NOT EXISTS content_format TEXT NOT NULL DEFAULT 'text',
  ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_modified_by UUID REFERENCES public.profiles(id),
  ADD COLUMN IF NOT EXISTS target_grade_level TEXT,
  ADD COLUMN IF NOT EXISTS target_section_id UUID REFERENCES public.sections(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS attachments JSONB NOT NULL DEFAULT '[]'::jsonb;

UPDATE public.announcements
SET published_at = COALESCE(published_at, created_at), status = 'published', content_format = 'text'
WHERE published_at IS NULL;

ALTER TABLE public.announcements
  ADD CONSTRAINT announcements_category_check CHECK (category IN ('general','academic','enrollment','events','examination','schedule_changes','emergency','other')),
  ADD CONSTRAINT announcements_priority_check CHECK (priority IN ('normal','important','urgent','emergency')),
  ADD CONSTRAINT announcements_status_check CHECK (status IN ('draft','scheduled','published','unpublished','archived')),
  ADD CONSTRAINT announcements_content_format_check CHECK (content_format IN ('text','html')),
  ADD CONSTRAINT announcements_audience_check CHECK (audience IN ('all','student','teacher','guard')),
  ADD CONSTRAINT announcements_publish_expiry_check CHECK (expires_at IS NULL OR published_at IS NULL OR expires_at > published_at),
  ADD CONSTRAINT announcements_attachments_array_check CHECK (jsonb_typeof(attachments) = 'array');

CREATE INDEX IF NOT EXISTS announcements_status_publish_idx ON public.announcements(status,published_at DESC);
CREATE INDEX IF NOT EXISTS announcements_audience_idx ON public.announcements(audience,target_grade_level,target_section_id);

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
      AND (a.target_grade_level IS NULL OR EXISTS (
        SELECT 1 FROM public.students s WHERE s.profile_id = v_profile AND s.grade_level = a.target_grade_level
      ))
      AND (a.target_section_id IS NULL OR EXISTS (
        SELECT 1 FROM public.students s WHERE s.profile_id = v_profile AND s.section_id = a.target_section_id
      ))
  );
END;
$$;
REVOKE ALL ON FUNCTION public.can_read_school_announcement(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.can_read_school_announcement(UUID) TO authenticated;

DROP POLICY IF EXISTS "announcements_read_active_users" ON public.announcements;
DROP POLICY IF EXISTS "announcements_manage_admin" ON public.announcements;
CREATE POLICY "announcements_read_by_audience" ON public.announcements
  FOR SELECT TO authenticated USING (public.can_read_school_announcement(id));
CREATE POLICY "announcements_manage_admin" ON public.announcements
  FOR ALL TO authenticated USING (public.has_school_role('administrator'))
  WITH CHECK (public.has_school_role('administrator'));

INSERT INTO storage.buckets (id,name,public,file_size_limit,allowed_mime_types)
VALUES ('school-announcements','school-announcements',FALSE,10485760,
  ARRAY['image/jpeg','image/png','application/pdf','application/vnd.openxmlformats-officedocument.wordprocessingml.document'])
ON CONFLICT (id) DO UPDATE SET public = FALSE, file_size_limit = 10485760,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

CREATE OR REPLACE FUNCTION public.can_read_school_announcement_file(p_name TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  RETURN public.can_read_school_announcement(split_part(p_name,'/',1)::UUID);
EXCEPTION WHEN invalid_text_representation THEN RETURN FALSE;
END;
$$;
REVOKE ALL ON FUNCTION public.can_read_school_announcement_file(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.can_read_school_announcement_file(TEXT) TO authenticated;

DROP POLICY IF EXISTS "school_announcement_files_admin_insert" ON storage.objects;
DROP POLICY IF EXISTS "school_announcement_files_admin_update" ON storage.objects;
DROP POLICY IF EXISTS "school_announcement_files_admin_delete" ON storage.objects;
DROP POLICY IF EXISTS "school_announcement_files_audience_read" ON storage.objects;
CREATE POLICY "school_announcement_files_admin_insert" ON storage.objects
  FOR INSERT TO authenticated WITH CHECK (
    bucket_id = 'school-announcements' AND public.has_school_role('administrator')
  );
CREATE POLICY "school_announcement_files_admin_update" ON storage.objects
  FOR UPDATE TO authenticated USING (
    bucket_id = 'school-announcements' AND public.has_school_role('administrator')
  ) WITH CHECK (bucket_id = 'school-announcements' AND public.has_school_role('administrator'));
CREATE POLICY "school_announcement_files_admin_delete" ON storage.objects
  FOR DELETE TO authenticated USING (
    bucket_id = 'school-announcements' AND public.has_school_role('administrator')
  );
CREATE POLICY "school_announcement_files_audience_read" ON storage.objects
  FOR SELECT TO authenticated USING (
    bucket_id = 'school-announcements' AND public.can_read_school_announcement_file(name)
  );
