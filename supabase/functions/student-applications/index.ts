import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { escapeEmailHtml, getPublicAppUrl, sendSchoolEmail } from '../_shared/email.ts'

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' }
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })
const hash = async (value: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), byte => byte.toString(16).padStart(2, '0')).join('')
const clean = (value: unknown, max = 180) => typeof value === 'string' ? value.trim().slice(0, max) : ''
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, char => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[char] ?? char))
async function hmac(secret: string, value: string) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name:'HMAC', hash:'SHA-256' }, false, ['sign'])
  return Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value))), byte=>byte.toString(16).padStart(2,'0')).join('')
}
async function sendStudentSetupEmail(_admin: ReturnType<typeof createClient>, email: string, fullName: string, studentNumber: string) {
  const publicUrl = getPublicAppUrl()
  const setupUrl = `${publicUrl}/set-password?email=${encodeURIComponent(email)}`
  const safeLink = escapeEmailHtml(setupUrl)
  await sendSchoolEmail({
    to: email,
    subject: 'Your CampuSync student account is ready',
    preheader: 'Verify your email to set the password for your new student account.',
    text: `Hello ${fullName},\n\nYour student application has been approved. Open the CampuSync password setup page and request a six-digit code sent to this email. After the code is verified, you can choose your password:\n${setupUrl}\n\nStudent number: ${studentNumber}\nThe code expires in five minutes. Never share it.`,
    html: `<h1 style="margin:4px 0 12px;color:#16332a;font-size:24px;line-height:1.3">Your CampuSync student account is ready</h1><p style="margin:0 0 14px;color:#334155;font-size:15px;line-height:1.7">Hello ${escapeHtml(fullName)},</p><p style="margin:0 0 22px;color:#475569;font-size:15px;line-height:1.7">Your student application has been approved. Open the secure password setup page and request a six-digit code sent to this email. After verifying the code, you can choose your password.</p><p style="margin:0 0 22px"><a href="${safeLink}" style="display:inline-block;padding:13px 22px;border-radius:10px;background:#11865d;color:#fff;text-decoration:none;font-size:15px;font-weight:700">Verify and set my password</a></p><div style="padding:14px 16px;border:1px solid #e2ebe6;border-radius:12px;background:#f8fbf9;color:#475569;font-size:14px;line-height:1.7"><b style="color:#16332a">Student number:</b> ${escapeHtml(studentNumber)}</div><p style="margin:18px 0 0;color:#64756e;font-size:13px;line-height:1.6">The code expires in five minutes. If you did not request a school account, contact Valencia National High School.</p>`,
  })
}

Deno.serve(async request => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (request.method !== 'POST') return reply({ error: 'Method not allowed.' }, 405)
  // CORS is not an authorization boundary. Vercel preview and installed PWA
  // hosts vary; authenticated actions below validate the Supabase Auth token
  // and active administrator role on every request.
  const url = Deno.env.get('SUPABASE_URL'), anon = Deno.env.get('SUPABASE_ANON_KEY'), key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  const hmacSecret = Deno.env.get('OTP_HMAC_SECRET')
  if (!url || !anon || !key || !hmacSecret) return reply({ error: 'Application service is not configured.' }, 503)
  let input: Record<string, unknown>
  try { input = await request.json() } catch { return reply({ error: 'Invalid request.' }, 400) }
  const admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
  if (input.action === 'submit' || input.action === 'track' || input.action === 'correct') {
    const ip = request.headers.get('cf-connecting-ip') ?? 'unknown-ip'
    const max = input.action === 'track' ? 10 : 8
    const { data: allowed, error } = await admin.rpc('login_otp_allow_request', { p_key: await hmac(hmacSecret, `student-application:${input.action}:${ip}`), p_window_seconds: 900, p_max_requests: max })
    if (error || allowed !== true) return reply({ error:'Too many requests. Please wait before trying again.' },429)
  }

  if (input.action === 'submit') {
    const fields = ['first_name','last_name','birth_date','gender','address','guardian_full_name','guardian_relationship','guardian_contact_number','grade_level','school_year','email']
    if (fields.some(field => !clean(input[field], field === 'address' ? 500 : 180)) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean(input.email, 254))) return reply({ error: 'Complete all required fields with valid information.' }, 400)
    if (clean(input.middle_name, 120).length > 120 || clean(input.phone, 40).length > 40) return reply({ error: 'Some fields exceed the allowed length.' }, 400)
    const email = clean(input.email, 254).toLowerCase()
    const { data: existingProfile } = await admin.from('profiles').select('id').eq('email', email).maybeSingle()
    if (existingProfile) return reply({ error: 'An account already exists for this email. Contact the school office if you need help.' }, 409)
    const { data: duplicateApplicant } = await admin.from('student_applications').select('id').eq('first_name',clean(input.first_name,120)).eq('last_name',clean(input.last_name,120)).eq('birth_date',clean(input.birth_date,10)).in('application_status',['PENDING','CORRECTION_REQUESTED','APPROVED']).limit(1).maybeSingle()
    if (duplicateApplicant) return reply({ error:'An application already exists for a student with this name and birth date. Use its tracking details or contact the school.' },409)
    const { data: existingStudent } = await admin.from('students').select('id,student_private_details!inner(birth_date)').eq('first_name',clean(input.first_name,120)).eq('last_name',clean(input.last_name,120)).eq('student_private_details.birth_date',clean(input.birth_date,10)).limit(1).maybeSingle()
    if (existingStudent) return reply({ error:'A student record already matches this name and birth date. Contact the school office instead of creating another application.' },409)
    const tracking = Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('')
    const reference = `CS-${crypto.randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()}`
    const record = {
      reference_code: reference, tracking_token_hash: await hash(tracking), email,
      first_name: clean(input.first_name, 120), middle_name: clean(input.middle_name, 120) || null, last_name: clean(input.last_name, 120), suffix: clean(input.suffix, 20) || null,
      birth_date: clean(input.birth_date, 10), gender: clean(input.gender, 40), address: clean(input.address, 500), phone: clean(input.phone, 40) || null,
      guardian_full_name: clean(input.guardian_full_name, 180), guardian_relationship: clean(input.guardian_relationship, 60), guardian_contact_number: clean(input.guardian_contact_number, 40), guardian_address: clean(input.guardian_address, 500) || null,
      grade_level: clean(input.grade_level, 80), requested_section: clean(input.requested_section, 120) || null, school_year: clean(input.school_year, 20),
    }
    const { error } = await admin.from('student_applications').insert(record)
    if (error) return reply({ error: error.code === '23505' ? 'An open application already exists for this email.' : 'The application could not be submitted. Please try again.' }, error.code === '23505' ? 409 : 400)
    const { data: appRow } = await admin.from('student_applications').select('id').eq('reference_code', reference).single()
    if (appRow) await admin.from('audit_logs').insert({ entity_type:'student_applications',entity_id:appRow.id,entity_label:reference,action:'student_application_submitted',module:'enrollment',description:'Public student application submitted',new_values:{application_status:'PENDING'},changed_fields:['application_status'],status:'success',details:{} })
    return reply({ reference, trackingToken: tracking }, 201)
  }

  if (input.action === 'track') {
    const reference = clean(input.reference, 24).toUpperCase(), token = clean(input.tracking_token, 100)
    if (!reference || token.length < 32) return reply({ error: 'Enter the application reference and tracking code.' }, 400)
    const { data, error } = await admin.from('student_applications').select('id,reference_code,application_status,decision_note,created_at,updated_at,reviewed_at,first_name,middle_name,last_name,suffix,birth_date,gender,address,phone,guardian_full_name,guardian_relationship,guardian_contact_number,guardian_address,email,grade_level,requested_section,school_year,approved_profile_id,activation_email_status,activation_email_last_attempt_at').eq('reference_code', reference).eq('tracking_token_hash', await hash(token)).maybeSingle()
    if (error || !data) return reply({ error: 'We could not find an application using those details.' }, 404)
    let activationEmailStatus = data.activation_email_status ?? 'PENDING'
    let activationEmailNotice = ''
    if (data.application_status === 'APPROVED' && data.approved_profile_id) {
      const attemptedAt = data.activation_email_last_attempt_at ? Date.parse(data.activation_email_last_attempt_at) : 0
      // Recovery links are single-use and can expire. Permit a controlled
      // resend after five minutes even if the previous email was delivered.
      const canRetry = activationEmailStatus === 'PENDING' || ((activationEmailStatus === 'FAILED' || activationEmailStatus === 'SENT') && Date.now() - attemptedAt >= 5 * 60_000)
      const staleSend = activationEmailStatus === 'SENDING' && Date.now() - attemptedAt >= 5 * 60_000
      if (canRetry || staleSend) {
        let claim = admin.from('student_applications').update({ activation_email_status: 'SENDING', activation_email_last_attempt_at: new Date().toISOString() }).eq('id', data.id).eq('activation_email_status', activationEmailStatus)
        if (staleSend) claim = claim.eq('activation_email_last_attempt_at', data.activation_email_last_attempt_at)
        const { data: claimed } = await claim.select('id').maybeSingle()
        if (claimed) {
          const { data: student } = await admin.from('students').select('student_id').eq('profile_id', data.approved_profile_id).maybeSingle()
          try {
            if (!student?.student_id) throw new Error('Student account record is unavailable.')
            await sendStudentSetupEmail(admin, data.email, [data.first_name, data.middle_name, data.last_name, data.suffix].filter(Boolean).join(' '), student.student_id)
            const { error: sentUpdateError } = await admin.from('student_applications').update({ activation_email_status: 'SENT', activation_email_sent_at: new Date().toISOString() }).eq('id', data.id).eq('activation_email_status', 'SENDING')
            if (sentUpdateError) throw sentUpdateError
            activationEmailStatus = 'SENT'
          } catch (sendError) {
            console.error('Student setup email resend failed', { code: (sendError as { code?: string }).code ?? 'delivery_error' })
            await admin.from('student_applications').update({ activation_email_status: 'FAILED' }).eq('id', data.id).eq('activation_email_status', 'SENDING')
            activationEmailStatus = 'FAILED'
            activationEmailNotice = 'The secure setup email could not be sent. Please check again in a minute or contact the school office.'
          }
        } else activationEmailStatus = 'SENDING'
      } else if (activationEmailStatus === 'FAILED') activationEmailNotice = 'The secure setup email could not be sent yet. Please check again in a minute or contact the school office.'
      else if (activationEmailStatus === 'SENT' && Date.now() - attemptedAt < 5 * 60_000) activationEmailNotice = 'A setup email was sent recently. If its link has expired, check the application status again after five minutes to receive a fresh link.'
      else activationEmailNotice = 'Your approved account setup email is being prepared. Check your registered email shortly.'
    }
    const application = { ...data, activation_email_status: activationEmailStatus, activation_email_notice: activationEmailNotice }
    delete (application as Partial<typeof application>).approved_profile_id
    delete (application as Partial<typeof application>).activation_email_last_attempt_at
    delete (application as Partial<typeof application>).id
    return reply({ application })
  }

  if (input.action === 'correct') {
    const reference = clean(input.reference, 24).toUpperCase(), token = clean(input.tracking_token, 100)
    if (!reference || token.length < 32) return reply({ error: 'Application tracking details are required.' }, 400)
    const { data: application } = await admin.from('student_applications').select('id,application_status').eq('reference_code', reference).eq('tracking_token_hash', await hash(token)).maybeSingle()
    if (!application || application.application_status !== 'CORRECTION_REQUESTED') return reply({ error: 'This application is not awaiting corrections.' }, 409)
    const required = ['first_name','last_name','birth_date','gender','address','guardian_full_name','guardian_relationship','guardian_contact_number','grade_level','school_year']
    if (required.some(field => !clean(input[field], field === 'address' ? 500 : 180))) return reply({ error: 'Complete all required fields.' }, 400)
    const { error } = await admin.from('student_applications').update({
      first_name:clean(input.first_name,120),middle_name:clean(input.middle_name,120)||null,last_name:clean(input.last_name,120),suffix:clean(input.suffix,20)||null,
      birth_date:clean(input.birth_date,10),gender:clean(input.gender,40),address:clean(input.address,500),phone:clean(input.phone,40)||null,
      guardian_full_name:clean(input.guardian_full_name,180),guardian_relationship:clean(input.guardian_relationship,60),guardian_contact_number:clean(input.guardian_contact_number,40),guardian_address:clean(input.guardian_address,500)||null,
      grade_level:clean(input.grade_level,80),requested_section:clean(input.requested_section,120)||null,school_year:clean(input.school_year,20),
      application_status:'PENDING',decision_note:null,reviewed_by:null,reviewed_at:null,updated_at:new Date().toISOString(),
    }).eq('id',application.id).eq('application_status','CORRECTION_REQUESTED')
    if (error) return reply({ error: 'Corrections could not be saved.' },400)
    await admin.from('audit_logs').insert({ entity_type:'student_applications',entity_id:application.id,entity_label:reference,action:'student_application_corrected',module:'enrollment',description:'Applicant submitted requested corrections',new_values:{application_status:'PENDING'},changed_fields:['application_status','application_details'],status:'success',details:{} })
    return reply({ success:true })
  }

  const authorization = request.headers.get('Authorization') ?? ''
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : ''
  if (!token) return reply({ error: 'Sign in as an administrator.' }, 401)
  const authClient = createClient(url, anon, { auth: { persistSession: false }, global: { headers: { Authorization: authorization } } })
  const { data: authData, error: authError } = await authClient.auth.getUser(token)
  if (authError || !authData.user) return reply({ error: 'Session is invalid or expired.' }, 401)
  const { data: actor } = await admin.from('profiles').select('id,full_name,email,role,is_active').eq('auth_user_id', authData.user.id).maybeSingle()
  if (actor?.role !== 'administrator' || !actor.is_active) return reply({ error: 'Administrator permission is required.' }, 403)

  const appId = clean(input.application_id, 50), action = clean(input.action, 40)
  const { data: application, error: appError } = await admin.from('student_applications').select('*').eq('id', appId).maybeSingle()
  if (appError || !application) return reply({ error: 'Application not found.' }, 404)
  if (action === 'review') {
    const status = clean(input.status, 40)
    if (!['CORRECTION_REQUESTED','REJECTED'].includes(status)) return reply({ error: 'Unsupported review status.' }, 400)
    const note = clean(input.note, 1000)
    if (!note) return reply({ error: 'Add a note explaining the decision.' }, 400)
    if (!['PENDING','CORRECTION_REQUESTED'].includes(application.application_status)) return reply({ error: 'This application has already been decided.' }, 409)
    const { error } = await admin.from('student_applications').update({ application_status: status, decision_note: note, reviewed_by: actor.id, reviewed_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', appId).in('application_status', ['PENDING','CORRECTION_REQUESTED'])
    if (error) return reply({ error: 'The application could not be updated.' }, 400)
    await admin.from('audit_logs').insert({ actor_id:actor.id,actor_name_snapshot:actor.full_name,actor_email_snapshot:actor.email,actor_role_snapshot:'administrator',entity_type:'student_applications',entity_id:appId,entity_label:application.reference_code,action:status==='REJECTED'?'student_application_rejected':'student_application_correction_requested',module:'enrollment',description:status==='REJECTED'?'Student application rejected':'Applicant asked to provide corrections',new_values:{application_status:status,decision_note:note},changed_fields:['application_status','decision_note'],status:'success',details:{} })
    return reply({ success: true })
  }
  if (action !== 'approve') return reply({ error: 'Unsupported action.' }, 400)
  if (application.application_status === 'APPROVED' && application.approved_profile_id) return reply({ success: true, alreadyApproved: true })
  if (!['PENDING','CORRECTION_REQUESTED'].includes(application.application_status)) return reply({ error: 'Only pending applications can be approved.' }, 409)
  const studentNumber = clean(input.student_number, 40), gradeLevel = clean(input.grade_level, 80), sectionId = clean(input.section_id, 60) || null
  if (!studentNumber || !gradeLevel) return reply({ error: 'Enter the school-issued student number and grade level.' }, 400)
  if (sectionId) {
    const { data: section } = await admin.from('sections').select('grade_level').eq('id', sectionId).maybeSingle()
    if (!section || section.grade_level !== gradeLevel) return reply({ error: 'The chosen section does not match the grade level.' }, 400)
  }
  const { data: dupeStudent } = await admin.from('students').select('id').eq('student_id', studentNumber).maybeSingle()
  if (dupeStudent) return reply({ error: 'That student number is already assigned.' }, 409)
  const { data: dupeEmail } = await admin.from('profiles').select('id').eq('email', application.email).maybeSingle()
  if (dupeEmail) return reply({ error: 'An account already exists for this email.' }, 409)
  // Supabase Auth uses bcrypt, which only accepts passwords up to 72 bytes.
  // A 32-byte random value encoded as hex is 64 ASCII characters.
  const secret = Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('')
  const fullName = [application.first_name, application.middle_name, application.last_name, application.suffix].filter(Boolean).join(' ')
  const { data: created, error: createError } = await admin.auth.admin.createUser({ email: application.email, password: secret, email_confirm: true, user_metadata: { full_name: fullName } })
  if (createError || !created.user) return reply({ error: createError?.message ?? 'Could not create the account.' }, 400)
  const { data: approved, error: approveError } = await admin.rpc('complete_student_application_approval', {
    p_application_id: appId, p_auth_user_id: created.user.id, p_student_number: studentNumber,
    p_grade_level: gradeLevel, p_section_id: sectionId, p_actor_id: actor.id,
    p_actor_name: actor.full_name, p_actor_email: actor.email,
  })
  if (approveError) {
    await admin.auth.admin.deleteUser(created.user.id)
    console.error('Student application approval transaction failed', { code: approveError.code ?? 'unknown', message: approveError.message })
    if (/student number or email is already assigned/i.test(approveError.message)) return reply({ error: 'That student number or email is already assigned to an existing account.' }, 409)
    if (/section does not match grade level/i.test(approveError.message)) return reply({ error: 'The selected section does not match the approved grade level.' }, 400)
    if (/application is no longer pending/i.test(approveError.message)) return reply({ error: 'This application has already been decided. Refresh the application list.' }, 409)
    if (/student number and grade level are required/i.test(approveError.message)) return reply({ error: 'Enter the school-issued student number and approved grade level.' }, 400)
    return reply({ error: `Student records could not be created (database error ${approveError.code ?? 'unknown'}). Please contact support.` }, 500)
  }
  if (approved?.already_approved) {
    await admin.auth.admin.deleteUser(created.user.id)
    return reply({ success:true, alreadyApproved:true, emailSent:false, emailNotice:'This application was already approved. The existing student account was preserved.' })
  }
  const attemptAt = new Date().toISOString()
  const { error: sendingStateError } = await admin.from('student_applications').update({ activation_email_status: 'SENDING', activation_email_last_attempt_at: attemptAt }).eq('id', appId).eq('application_status', 'APPROVED')
  let emailSent = false
  if (!sendingStateError) {
    try { await sendStudentSetupEmail(admin, application.email, fullName, studentNumber); emailSent = true }
    catch (sendError) { console.error('Student setup email delivery failed', { code: (sendError as { code?: string }).code ?? 'delivery_error' }) }
  } else console.error('Could not set student setup email state', { code: sendingStateError.code ?? 'unknown' })
  const { error: emailStateError } = await admin.from('student_applications').update({ activation_email_status: emailSent ? 'SENT' : 'FAILED', activation_email_sent_at: emailSent ? new Date().toISOString() : null }).eq('id', appId).eq('application_status', 'APPROVED')
  if (emailStateError) { emailSent = false; console.error('Could not save student setup email status', { code: emailStateError.code ?? 'unknown' }) }
  await admin.from('audit_logs').insert({ actor_id: actor.id, actor_name_snapshot: actor.full_name, actor_email_snapshot: actor.email, actor_role_snapshot: 'administrator', entity_type: 'student_applications', entity_id: appId, entity_label: application.reference_code, action: 'student_activation_email_delivery', module: 'enrollment', description: emailSent ? 'Student activation email sent' : 'Student activation email delivery failed or is not configured', new_values: { email_sent: emailSent }, changed_fields: ['email_sent'], status: emailSent ? 'success' : 'failed', details: {} })
  return reply({ success: true, student: approved, emailSent, emailNotice: emailSent ? null : 'Account was created, but the secure password setup email could not be confirmed. The student can check application status to retry delivery.' }, 201)
})
