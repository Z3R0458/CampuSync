-- Store the browser details supplied during the authenticated login flow.
-- Existing user_devices.device_type/device_name fields remain the canonical
-- device category and display label. User-agent strings are stored per login
-- because they can change when the browser is upgraded.
ALTER TABLE public.login_activity
  ADD COLUMN IF NOT EXISTS user_agent text;

COMMENT ON COLUMN public.login_activity.user_agent IS
  'Browser-reported user-agent captured by the login Edge Function; visible only through existing own-record/admin RLS policies.';

NOTIFY pgrst, 'reload schema';
