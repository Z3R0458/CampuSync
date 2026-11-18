ALTER TABLE public.student_applications
  ADD COLUMN IF NOT EXISTS activation_email_status text NOT NULL DEFAULT 'PENDING',
  ADD COLUMN IF NOT EXISTS activation_email_sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS activation_email_last_attempt_at timestamptz;

ALTER TABLE public.student_applications
  DROP CONSTRAINT IF EXISTS student_applications_activation_email_status_check;
ALTER TABLE public.student_applications
  ADD CONSTRAINT student_applications_activation_email_status_check
  CHECK (activation_email_status IN ('PENDING','SENDING','SENT','FAILED'));

NOTIFY pgrst, 'reload schema';
