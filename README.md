# CampuSync

CampuSync is a React + Vite school attendance and gate management application for Philippine schools.

## CampuSync PWA branding

The existing PWA keeps its `/` start URL, scope, and effective install ID. Its
manifest remains at `/manifest.webmanifest`; the app shell cache was versioned
to `campusync-shell-v3` so an updated service worker refreshes the manifest and
CampuSync icon assets without clearing authentication, local storage, or the
offline attendance database. Deploy the normal production build, including the
files in `dist/`; the service worker installs the new asset shell on a user's
next online visit and activates it without requiring a manual cache clear.

Most installed PWAs update their name and icon from the refreshed manifest. If
a platform keeps showing the old launcher icon, open CampuSync online and
reload it first. If it remains stale, reinstall CampuSync from the updated site
using that platform's normal install flow. Reinstalling can clear device-local
data on some platforms, so guards should sync pending offline scans and users
should confirm they can sign in again before removing the installed app. The
branding deployment itself does not remove app data or revoke sessions.

## Current functionality

- Supabase Auth login and database-backed, profile-based role routing.
- Guard QR scanning, manual ID lookup, device registration, online event recording, and offline IndexedDB queueing.
- Server-side QR validation, gate-event sequence checks, early-out authorization, parent in-app notifications, and retry synchronization.
- Student early-out and visitor authorization requests with administrator review.
- Guard walk-in visitor registration, approved visitor check-in, and check-out.
- Parent-linked child attendance and request updates.
- Administrator dashboard, role-separated account directories, enrollment registration and review, announcement management, audit history, and configurable report exports.
- Responsive dashboards and an installable PWA shell.

## Quick start

```bash
npm install
npm run dev -- --host 0.0.0.0
```

Set `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` in
`.env.local`. Copy `.env.example` to create the file on another checkout.
Restart Vite after changing environment variables. The `.env.local` file is
ignored by Git. Camera scanning requires HTTPS or localhost.

## Supabase setup

The base schema is in `supabase/schema.sql`. Apply the follow-up migration
`supabase/migrations/20261112_schoolguard_core.sql` in the Supabase SQL Editor.
It adds scoped policies, guarded QR/manual attendance RPCs, guard-device
registration, request notifications, visitor check-in, and offline QR-cache
support. Then apply `supabase/migrations/20261113_fix_qr_credential_generation.sql`
to fix schema-qualified cryptographic calls in QR issuance. Student QR codes
are generated from the student dashboard when requested; teacher QR codes are
generated from the teacher dashboard. The client does not insert attendance
events directly.

Create the first administrator under Supabase **Authentication → Users**, then
link that Auth user ID in SQL Editor:

```sql
insert into public.profiles (auth_user_id, full_name, email, role)
values ('AUTH_USER_UUID', 'School Administrator', 'admin@example.edu', 'administrator');
```

Sign in with that administrator account to manage portal records. Student
registration uses the `admin-create-user` Edge Function. Before using the admin
enrollment, account, and audit modules, apply `supabase/migrations/20261116_admin_modules.sql`
and then `supabase/migrations/20261117_enrollment_records.sql`. The latter adds
student personal and guardian fields, school-year enrollment records, status
history, administrator-only policies, and protection against deactivating the
last active administrator. Apply `supabase/migrations/20261118_admin_account_edit.sql`
to enable atomic edits to linked student and teacher account records. Deploy the
updated Edge Function from the project root with:

```bash
supabase functions deploy admin-create-user
```

For public student self-registration, apply
`supabase/migrations/20261131_student_applications.sql` and deploy
`supabase functions deploy student-applications`. Set the existing
`SCHOOLGUARD_ALLOWED_ORIGINS` and `OTP_HMAC_SECRET` function secrets; set
`APP_PUBLIC_URL`, `RESEND_API_KEY`, and `SCHOOL_EMAIL_FROM` so approved students
receive a password setup link. If email delivery is not configured, the account
is still provisioned and administrators can send its password reset link from
User Accounts. Public applicants receive a private tracking code on submission;
the school cannot recover that code for them.

Students can apply at `/student-registration`. Applications are separate from
the Student Directory until an administrator approves them in the new Student
Applications sidebar module. Approval creates the Auth account, student record,
private student details, enrolled school-year record, and QR credential in one
database transaction; if the database step fails, the staged Auth user is
removed. Teacher accounts can be created from the Teachers tab in User Accounts
and appear in the existing teacher directory.

Apply `supabase/migrations/20261119_announcement_management.sql` to enable the
announcement editor, scheduling, audience targeting, and private attachments.
The migration adds fields to existing announcement rows without deleting or
replacing them. Existing notices are retained as published plain text. Attachments
use the private `school-announcements` Storage bucket. Scheduled publication and
expiration are enforced in database read policies, so portal visibility does not
depend on an administrator's browser remaining open.

Apply `supabase/migrations/20261120_activity_audit_trail.sql` after the
announcement migration to extend the existing append-only audit log. It adds
administrator-only directory access, safe field-level change snapshots,
authentication and export events, and activity filtering metadata. Historical
full-record payloads are redacted to the audit field allow-list while their
event rows remain. Successful logins and logouts are recorded; failed login
attempts are not captured because authentication failures are handled by Supabase
Auth and are not available to the application as trusted audit events.

Student registration is performed in **Enrollment Management**. It creates a
student Auth user, profile, student record, and pending school-year enrollment;
the generated temporary password is shown once to the administrator. User
Management only administers existing accounts. Enrollment admission and history
records require the migration above.

The function uses Supabase’s server-side service-role secret. Never put that
secret in `.env.local` or frontend code. Public account self-registration is
limited to parent and guardian accounts and requires email confirmation.

For web push, set `NEXT_PUBLIC_VAPID_PUBLIC_KEY` in `.env.local`; set
`VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, and `VAPID_SUBJECT` as Supabase Edge
Function secrets. Deploy `dispatch-push` as well. Users can then enable push
subscriptions from the dashboard header. In-app notifications do not depend on
push permission.

## Verification and limits

Run `npm run build` and `npm run lint` to check the frontend. The guard retries
queued attendance and walk-in visitor records while the app is open and online.
Offline scans require a guard device and QR cache refreshed within the last 24
hours. Scans that fail server validation remain failed or need manual review;
the client does not claim they were synchronized.

Push delivery requires the VAPID setup above. Supporting-document uploads and
full attendance classification (late/absent/incomplete summaries) still need
implementation. Parent notifications are also available in the in-app list.

The guard QR and manual lookup panels show identity, enrollment, current
attendance/campus state, guardian contact, recent gate events, and approved
early-out permissions when those records are present. Walk-in visitor
supporting-document uploads are not implemented; ID details can be recorded as
text. Live end-to-end workflows require applying the migrations below and
configuring the connected Supabase project and Edge Function secrets.

For the Student Self-Service Portal and gate workflows, apply these migrations
in order after the activity audit migration:

1. `supabase/migrations/20261121_student_self_service.sql`
2. `supabase/migrations/20261122_fix_pgcrypto_qr_functions.sql`
3. `supabase/migrations/20261123_guard_operations_and_notifications.sql`
4. `supabase/migrations/20261124_parent_guardian_portal.sql`
5. `supabase/migrations/20261125_early_out_gate_transactions.sql`
6. `supabase/migrations/20261126_teacher_portal.sql`
7. `supabase/migrations/20261127_profile_photo_storage.sql`
8. `supabase/migrations/20261128_login_email_otp.sql`

The guard migration adds secure QR identity preview and student lookup RPCs,
admin-only authorization for walk-in visitors, guard entry/exit actions,
dashboard counts, and role-scoped real-time notifications. It also routes
walk-in submissions into the administrator Student Requests page. Browser push
requires the VAPID secrets and deployed `dispatch-push` function described
above; in-app notifications use Supabase Realtime.

Early-out approvals include an administrator-approved Manila date and time
window. Guards can review request status in **Early-Out Approvals** and record
the departure from the existing QR scanner as a distinct `EARLY_OUT` event.
The database checks the student QR, current inside-campus state, approved
window, expiry, and one-time usage in a single transaction. Ordinary early
`EXIT` transactions cannot consume these permissions. Attendance history exports
include the separate event type and can be filtered by date, grade, and section.

Parent and guardian accounts register from the sign-in screen. Supabase Auth
email confirmation must be enabled, and the deployed Auth redirect allow-list
must include the portal URL. The parent signup trigger creates a parent profile
only; it never links a student. A parent must submit a request and an
administrator must approve it before student data is visible. Parents can link
multiple students, and a student can have multiple approved guardians. Link
approval checks the submitted student ID, name, grade, and section; a supplied
school-issued linking code is checked when one exists on the student record.

Parent entry and exit notices are created only for validated, synchronized
attendance events and approved guardian relationships. Entry and exit are on by
default; temporary exit and return are off by default. The existing push system
uses standards-based Web Push with VAPID, not Firebase Cloud Messaging. Optional
email delivery uses Resend when `RESEND_API_KEY` and `SCHOOL_EMAIL_FROM` are set
as Edge Function secrets; a parent must also enable email notifications.
Without these secrets, email preferences are saved but email is not delivered.
Push and email attempts are recorded per notification and delivery target.

The parent portal does not display student photos because the current project
has no photo field or configured profile-photo storage. The school must set its
own relationship-verification, consent, retention, and privacy procedures.
Configure the Auth email confirmation and redirect settings before enabling
public parent registration.

The Teacher portal enhancement uses the existing `teachers`, `teacher_qr_codes`,
`attendance_events`, `announcements`, and `notifications` tables. Apply
`supabase/migrations/20261126_teacher_portal.sql` after the migrations above.
It adds teacher-owned attendance and announcement notification preferences,
verified attendance and announcement notification triggers, adviser-targeted
announcement access, and an administrator-only QR revocation RPC. The existing
administrator QR issuance RPC now also has an audit trail through a trigger.

Teacher QR credentials are generated only when a teacher requests one or an
administrator replaces it; the raw credential is returned once and is never
read back from the hashed database record. Teachers can download or print the
QR. Administrators can replace or revoke it from User Accounts. Replacing a QR
immediately disables the previous credential. Existing guard scans continue to
use the same attendance scanner and server validation path. Confirmed teacher
attendance records create deduplicated in-app notifications after a successful
database insert; the existing guard scan flow dispatches those notifications
through VAPID Web Push when configured.

The current teacher schema contains only teacher ID, designation, and profile
link, with adviser sections available through `sections.adviser_id`. It has no
teacher photo, department, subject assignment, or class schedule records, so
the portal shows actual adviser sections and states when other information is
not configured. Teacher attendance history is server-loaded and filters out
pending or review-only scans; offline scans are never shown as confirmed.

Profile images use the private `profile-photos` bucket and the shared
`profiles.profile_photo_path` field. Apply
`supabase/migrations/20261127_profile_photo_storage.sql` after the migrations
above. Uploads are center-cropped and converted to WebP in the browser before
they reach Storage. The database stores only the unique object path. Signed
image URLs are generated for authorized views; students and teachers can
upload, replace, and remove photos only inside their own auth-user folder.
Administrators and guards can view images needed for school operations, and
parents can view only approved linked students. Replacements delete the prior
owned object only after the profile path update succeeds. Deactivation does not remove a photo. There is no
permanent account-deletion workflow or school retention policy configured, so
the application does not automatically remove photos during account cleanup.

Email verification and a fresh email OTP on every login are enabled by
`supabase/migrations/20261130_restore_first_time_email_otp.sql` and the
`supabase/functions/login-otp` Edge Function. Apply migrations through
`20261130_restore_first_time_email_otp.sql`, then deploy `login-otp`,
`admin-create-user`, and `dispatch-push` using the Supabase CLI and repository
configuration. Keep the Resend sender domain verified for `SCHOOL_EMAIL_FROM`.
Deploy with `supabase functions deploy login-otp`,
`supabase functions deploy admin-create-user`, and
`supabase functions deploy dispatch-push`.
The function needs `OTP_HMAC_SECRET`, `OTP_SESSION_ENCRYPTION_KEY` (base64 for
exactly 32 random bytes), `SCHOOLGUARD_ALLOWED_ORIGINS` (comma-separated exact
portal origins), `RESEND_API_KEY`, and `SCHOOL_EMAIL_FROM`. Supabase supplies
`SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY`.

Keep Supabase email confirmations enabled. Supabase rejects password sign-in
for an unconfirmed email with `email_not_confirmed` after validating the
credentials; the Edge Function uses that specific response to start first-time
verification without issuing a browser session. After the code is verified, it
marks the Auth email confirmed, records the app verification timestamp, and
creates a session. Confirmed accounts receive a fresh OTP on each new login.
The custom access-token hook must be enabled and point to
`public.schoolguard_custom_access_token_hook`; RLS and backend endpoints require
its OTP-verified claim. Existing Auth-confirmed users must still pass a fresh
login OTP; unconfirmed users enter the first-time verification flow. No account
is marked as app-verified by the migration. The previous
`20261129_disable_email_otp_login.sql` migration is superseded by the restore
migration.

The OTP expires after five minutes, permits five incorrect attempts, enforces
a 60-second resend cooldown, and uses per-email, per-IP, and per-challenge rate
limits. Session tokens are encrypted while waiting for verification and are
not returned to the browser before a successful code check. The project build
does not validate deployed Auth-hook settings, SQL migration execution, Resend
delivery, or live login behavior; test those against a non-production account.
#   C a m p u S y n c  
 