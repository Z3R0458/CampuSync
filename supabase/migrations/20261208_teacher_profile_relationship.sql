-- Keep the teacher directory's PostgREST profile -> teacher embed discoverable.
-- Existing production rows were checked for orphaned or duplicate profile links.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.teachers'::regclass
      AND confrelid = 'public.profiles'::regclass
      AND contype = 'f'
      AND conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = 'public.teachers'::regclass AND attname = 'profile_id')]::smallint[]
  ) THEN
    ALTER TABLE public.teachers
      ADD CONSTRAINT teachers_profile_id_fkey
      FOREIGN KEY (profile_id) REFERENCES public.profiles(id) ON DELETE CASCADE;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS teachers_profile_id_unique_idx ON public.teachers(profile_id);
NOTIFY pgrst, 'reload schema';
