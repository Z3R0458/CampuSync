import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function respond(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (request.method !== 'POST') return respond({ error: 'Method not allowed' }, 405)

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  const publishableKey = Deno.env.get('SUPABASE_ANON_KEY')
  if (!supabaseUrl || !serviceRoleKey || !publishableKey) return respond({ error: 'Function secrets are not configured.' }, 500)

  const authHeader = request.headers.get('Authorization')
  if (!authHeader?.startsWith('Bearer ')) return respond({ error: 'Sign in as an administrator.' }, 401)
  const token = authHeader.slice('Bearer '.length)
  const authClient = createClient(supabaseUrl, publishableKey, { auth: { persistSession: false }, global: { headers: { Authorization: authHeader } } })
  const { data: authData, error: authError } = await authClient.auth.getUser(token)
  if (authError || !authData.user) return respond({ error: 'Session is invalid or expired.' }, 401)

  const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } })
  let claims: Record<string, unknown>
  try { claims = JSON.parse(atob(token.split('.')[1].replaceAll('-', '+').replaceAll('_', '/'))) as Record<string, unknown> } catch { return respond({ error: 'Email verification is required.' }, 403) }
  const sessionId = typeof claims.session_id === 'string' ? claims.session_id : ''
  const { data: verifiedSession } = await admin.from('login_otp_verified_sessions').select('session_id')
    .eq('session_id', sessionId).eq('auth_user_id', authData.user.id).is('revoked_at', null).gt('expires_at', new Date().toISOString()).maybeSingle()
  if (!verifiedSession) return respond({ error: 'Email verification is required.' }, 403)
  const { data: caller, error: callerError } = await admin.from('profiles')
    .select('id,full_name,email,role,is_active').eq('auth_user_id', authData.user.id).maybeSingle()
  if (callerError || caller?.role !== 'administrator' || !caller.is_active) return respond({ error: 'Administrator permission is required.' }, 403)

  let input: Record<string, unknown>
  try { input = await request.json() } catch { return respond({ error: 'Invalid JSON body.' }, 400) }
  const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : ''
  const fullName = typeof input.full_name === 'string' ? input.full_name.trim() : ''
  const password = typeof input.password === 'string' ? input.password : ''
  const role = input.role
  const validRoles = ['administrator', 'guard', 'student', 'teacher', 'parent']
  if (!validRoles.includes(String(role))) return respond({ error: 'Unsupported role.' }, 400)
  if (role === 'student' && input.enrollment_type === 'RETURNING' && typeof input.existing_student_id === 'string') {
    const schoolYear = typeof input.school_year === 'string' ? input.school_year.trim() : ''
    const gradeLevel = typeof input.grade_level === 'string' ? input.grade_level.trim() : ''
    if (!schoolYear || !gradeLevel) return respond({ error: 'A school year and grade level are required.' }, 400)
    const { data: existing, error: existingError } = await admin.from('students')
      .select('id,student_id,profile_id').eq('id', input.existing_student_id).maybeSingle()
    if (existingError || !existing) return respond({ error: 'Select an existing student account.' }, 404)
    const { data: existingProfile } = await admin.from('profiles').select('role').eq('id', existing.profile_id).maybeSingle()
    if (existingProfile?.role !== 'student') return respond({ error: 'The selected record is not linked to a student account.' }, 400)
    if (input.section_id) {
      const { data: section, error: sectionError } = await admin.from('sections').select('grade_level').eq('id', String(input.section_id)).maybeSingle()
      if (sectionError || !section || section.grade_level !== gradeLevel) return respond({ error: 'Select a section belonging to the chosen grade level.' }, 400)
    }
    const { data: enrollment, error: enrollmentError } = await admin.from('enrollment_records').insert({
      student_id: existing.id, school_year: schoolYear, grade_level: gradeLevel,
      section_id: typeof input.section_id === 'string' && input.section_id ? input.section_id : null,
      enrollment_type: 'RETURNING', status: 'PENDING',
    }).select('id').single()
    if (enrollmentError) return respond({ error: enrollmentError.code === '23505' ? `Student ${existing.student_id} already has an enrollment record for ${schoolYear}.` : enrollmentError.message }, enrollmentError.code === '23505' ? 409 : 400)
    await admin.from('audit_logs').insert({
      actor_id: caller.id, actor_name_snapshot: caller.full_name, actor_email_snapshot: caller.email, actor_role_snapshot: caller.role,
      entity_type: 'enrollment_records', entity_id: enrollment.id, entity_label: existing.student_id,
      action: 'enrollment_created', module: 'enrollment', description: 'Returning enrollment application created',
      new_values: { school_year: schoolYear, grade_level: gradeLevel, section_id: input.section_id ?? null, enrollment_type: 'RETURNING', status: 'PENDING' },
      changed_fields: ['school_year', 'grade_level', 'section_id', 'enrollment_type', 'status'], status: 'success', details: {},
    })
    return respond({ profile_id: existing.profile_id, student_id: existing.id, role: 'student', enrollment_type: 'RETURNING' }, 201)
  }
  if (!email.includes('@') || fullName.length < 2 || fullName.length > 120 || password.length < 12 || !validRoles.includes(String(role))) {
    return respond({ error: 'Provide a valid email, full name, supported role, and password with at least 12 characters.' }, 400)
  }
  if (role === 'student' && (typeof input.student_id !== 'string' || typeof input.grade_level !== 'string')) {
    return respond({ error: 'Student accounts require a student ID and grade level.' }, 400)
  }
  if (role === 'student') {
    const studentId = String(input.student_id).trim()
    const gradeLevel = String(input.grade_level).trim()
    const schoolYear = typeof input.school_year === 'string' ? input.school_year.trim() : ''
    if (!studentId || !gradeLevel || !schoolYear || typeof input.birth_date !== 'string' || typeof input.gender !== 'string' || typeof input.address !== 'string' || typeof input.guardian_full_name !== 'string' || typeof input.guardian_relationship !== 'string' || typeof input.guardian_contact_number !== 'string') {
      return respond({ error: 'Student enrollment requires personal, guardian, academic, and school-year information.' }, 400)
    }
    const { data: duplicateStudent } = await admin.from('students').select('id').eq('student_id', studentId).maybeSingle()
    if (duplicateStudent) return respond({ error: 'That student number is already registered.' }, 409)
    if (input.section_id) {
      const { data: section, error: sectionError } = await admin.from('sections').select('grade_level').eq('id', String(input.section_id)).maybeSingle()
      if (sectionError || !section || section.grade_level !== gradeLevel) return respond({ error: 'Select a section belonging to the chosen grade level.' }, 400)
    }
  }
  if (role === 'teacher' && typeof input.teacher_id !== 'string') return respond({ error: 'Teacher accounts require a teacher ID.' }, 400)

  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email, password, email_confirm: true, user_metadata: { full_name: fullName },
  })
  if (createError || !created.user) return respond({ error: createError?.message ?? 'Could not create auth account.' }, 400)

  const { data: profile, error: profileError } = await admin.from('profiles').insert({
    auth_user_id: created.user.id, full_name: fullName, email, role,
    phone: typeof input.phone === 'string' ? input.phone.trim() || null : null,
  }).select('id').single()
  if (profileError || !profile) {
    await admin.auth.admin.deleteUser(created.user.id)
    return respond({ error: profileError?.message ?? 'Could not create CampuSync profile.' }, 400)
  }

  let roleError: string | null = null
  if (role === 'student') {
    const { data: student, error } = await admin.from('students').insert({
      profile_id: profile.id,
      student_id: String(input.student_id).trim(),
      grade_level: String(input.grade_level).trim(),
      section_id: typeof input.section_id === 'string' && input.section_id ? input.section_id : null,
      status: 'pending',
      first_name: typeof input.first_name === 'string' ? input.first_name.trim() : null,
      middle_name: typeof input.middle_name === 'string' ? input.middle_name.trim() || null : null,
      last_name: typeof input.last_name === 'string' ? input.last_name.trim() : null,
      suffix: typeof input.suffix === 'string' ? input.suffix.trim() || null : null,
    }).select('id').single()
    roleError = error?.message ?? null
    if (!roleError && student) {
      const { error: detailsError } = await admin.from('student_private_details').insert({
        student_id: student.id,
        birth_date: input.birth_date,
        gender: input.gender,
        address: input.address,
        guardian_full_name: input.guardian_full_name,
        guardian_relationship: input.guardian_relationship,
        guardian_contact_number: input.guardian_contact_number,
        guardian_address: typeof input.guardian_address === 'string' ? input.guardian_address.trim() || null : null,
      })
      roleError = detailsError?.message ?? null
    }
    if (!roleError && student) {
      const { error: enrollmentError } = await admin.from('enrollment_records').insert({
        student_id: student.id,
        school_year: String(input.school_year).trim(),
        grade_level: String(input.grade_level).trim(),
        section_id: typeof input.section_id === 'string' && input.section_id ? input.section_id : null,
        enrollment_type: input.enrollment_type === 'RETURNING' ? 'RETURNING' : 'NEW',
        status: 'PENDING',
      })
      roleError = enrollmentError?.message ?? null
    }
  } else if (role === 'teacher') {
    const { error } = await admin.from('teachers').insert({ profile_id: profile.id, teacher_id: input.teacher_id, designation: input.designation ?? null })
    roleError = error?.message ?? null
  } else if (role === 'parent') {
    const { data: parent, error } = await admin.from('parents').insert({ profile_id: profile.id, relationship: input.relationship ?? null }).select('id').single()
    roleError = error?.message ?? (!parent ? 'Could not create parent record.' : null)
  }

  if (roleError) {
    await admin.from('profiles').delete().eq('id', profile.id)
    await admin.auth.admin.deleteUser(created.user.id)
    return respond({ error: roleError }, 400)
  }

  const auditEvents = [{
    actor_id: caller.id, actor_name_snapshot: caller.full_name, actor_email_snapshot: caller.email,
    actor_role_snapshot: caller.role, entity_type: 'profiles', entity_id: profile.id,
    entity_label: fullName, action: 'account_created', module: 'accounts',
    description: 'Account created', new_values: { full_name: fullName, email, role },
    changed_fields: ['full_name', 'email', 'role'], status: 'success', details: { role },
  }]
  if (role === 'student') {
    const { data: studentRow } = await admin.from('students').select('id').eq('student_id', String(input.student_id)).maybeSingle()
    auditEvents.push({
    actor_id: caller.id, actor_name_snapshot: caller.full_name, actor_email_snapshot: caller.email,
    actor_role_snapshot: caller.role, entity_type: 'students', entity_id: studentRow?.id ?? profile.id,
    entity_label: String(input.student_id), action: 'student_registered', module: 'students',
    description: 'Student registered', new_values: { student_id: input.student_id, grade_level: input.grade_level, section_id: input.section_id ?? null },
    changed_fields: ['student_id', 'grade_level', 'section_id'], status: 'success', details: {},
  })
    if (studentRow) {
      const { data: enrollmentRow } = await admin.from('enrollment_records').select('id')
        .eq('student_id', studentRow.id).eq('school_year', String(input.school_year)).maybeSingle()
      if (enrollmentRow) auditEvents.push({
        actor_id: caller.id, actor_name_snapshot: caller.full_name, actor_email_snapshot: caller.email,
        actor_role_snapshot: caller.role, entity_type: 'enrollment_records', entity_id: enrollmentRow.id,
        entity_label: String(input.student_id), action: 'enrollment_created', module: 'enrollment',
        description: 'Enrollment application created', new_values: { school_year: input.school_year, grade_level: input.grade_level, section_id: input.section_id ?? null, status: 'PENDING' },
        changed_fields: ['school_year', 'grade_level', 'section_id', 'status'], status: 'success', details: {},
      })
    }
  }
  const { error: auditError } = await admin.from('audit_logs').insert(auditEvents)
  if (auditError) console.error('Could not record account provisioning audit event:', auditError.message)
  return respond({ profile_id: profile.id, auth_user_id: created.user.id, role })
})
