import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { escapeEmailHtml, sendSchoolEmail } from '../_shared/email.ts'

const origins = (Deno.env.get('SCHOOLGUARD_ALLOWED_ORIGINS') ?? '').split(',').map(value => value.trim()).filter(Boolean)
const genericFailure = 'Sign-in could not be completed. Check your credentials and try again.'

function headers(origin: string | null) {
  const allowed = origin && origins.includes(origin) ? origin : 'null'
  return { 'Access-Control-Allow-Origin': allowed, 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Vary': 'Origin' }
}
function respond(origin: string | null, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...headers(origin), 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })
}
function b64(bytes: Uint8Array) { return btoa(String.fromCharCode(...bytes)) }
function unb64(value: string) { return Uint8Array.from(atob(value), c => c.charCodeAt(0)) }
function jwtClaims(token: string): Record<string, unknown> {
  const part = token.split('.')[1]
  if (!part) throw new Error('Invalid authentication response')
  return JSON.parse(atob(part.replaceAll('-', '+').replaceAll('_', '/'))) as Record<string, unknown>
}
async function hmac(secret: string, value: string) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value))), byte => byte.toString(16).padStart(2, '0')).join('')
}
async function encrypt(keyValue: string, value: unknown) {
  const key = await crypto.subtle.importKey('raw', unb64(keyValue), 'AES-GCM', false, ['encrypt'])
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(value)))
  return `${b64(iv)}.${b64(new Uint8Array(encrypted))}`
}
async function decrypt(keyValue: string, value: string) {
  const [ivPart, dataPart] = value.split('.')
  const key = await crypto.subtle.importKey('raw', unb64(keyValue), 'AES-GCM', false, ['decrypt'])
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(ivPart) }, key, unb64(dataPart))
  return JSON.parse(new TextDecoder().decode(decrypted)) as { access_token: string; refresh_token: string }
}
function maskEmail(email: string) {
  const [name, domain] = email.split('@')
  return `${name.slice(0, 1)}${'*'.repeat(Math.max(2, Math.min(8, name.length - 1)))}@${domain}`
}
async function makeCode() {
  const range = Math.floor(0x1_0000_0000 / 1_000_000) * 1_000_000
  while (true) {
    const bytes = crypto.getRandomValues(new Uint8Array(4))
    const integer = new DataView(bytes.buffer).getUint32(0)
    if (integer < range) return String(integer % 1_000_000).padStart(6, '0')
  }
}
function parseDevice(userAgent: string) {
  const deviceType = /ipad|tablet|playbook|silk/i.test(userAgent) ? 'Tablet' : /mobile|iphone|ipod|android.*mobile/i.test(userAgent) ? 'Mobile' : 'Desktop'
  const operatingSystem = /Windows NT/i.test(userAgent) ? 'Windows'
    : /Android/i.test(userAgent) ? 'Android'
    : /iPhone|iPad|iPod/i.test(userAgent) ? 'iOS'
    : /Mac OS X/i.test(userAgent) ? 'macOS'
    : /Linux/i.test(userAgent) ? 'Linux' : 'Unknown'
  const browserMatch = userAgent.match(/Edg\/([\d.]+)/) ? ['Edge', userAgent.match(/Edg\/([\d.]+)/)![1]]
    : userAgent.match(/OPR\/([\d.]+)/) ? ['Opera', userAgent.match(/OPR\/([\d.]+)/)![1]]
    : userAgent.match(/Firefox\/([\d.]+)/) ? ['Firefox', userAgent.match(/Firefox\/([\d.]+)/)![1]]
    : userAgent.match(/Chrome\/([\d.]+)/) ? ['Chrome', userAgent.match(/Chrome\/([\d.]+)/)![1]]
    : userAgent.match(/Version\/([\d.]+).*Safari/) ? ['Safari', userAgent.match(/Version\/([\d.]+).*Safari/)![1]]
    : ['Unknown', '']
  return { deviceType, operatingSystem, browser: browserMatch[0], browserVersion: browserMatch[1] }
}
function safeDeviceIdentifier(value: unknown) {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f-]{27,40}$/i.test(value) ? value : crypto.randomUUID()
}

Deno.serve(async request => {
  const origin = request.headers.get('Origin')
  if (request.method === 'OPTIONS') return new Response('ok', { headers: headers(origin) })
  if (request.method !== 'POST' || !origin || !origins.includes(origin)) return respond(origin, { error: genericFailure }, 403)
  const url = Deno.env.get('SUPABASE_URL')
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  const hmacSecret = Deno.env.get('OTP_HMAC_SECRET')
  const encryptionKey = Deno.env.get('OTP_SESSION_ENCRYPTION_KEY')
  let encryptionKeyBytes: Uint8Array
  try { encryptionKeyBytes = encryptionKey ? unb64(encryptionKey) : new Uint8Array() } catch { return respond(origin, { error: 'Login verification is not configured.' }, 503) }
  if (!url || !anonKey || !serviceKey || !hmacSecret || new TextEncoder().encode(hmacSecret).length < 32 || !encryptionKey || encryptionKeyBytes.length !== 32) return respond(origin, { error: 'Login verification is not configured.' }, 503)

  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })
  const db = admin.schema('public')
  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown-ip'
  const rate = async (key: string, seconds: number, max: number) => {
    const keyHash = await hmac(hmacSecret, `${key}|${ip}`)
    const { data, error } = await db.rpc('login_otp_allow_request', { p_key: keyHash, p_window_seconds: seconds, p_max_requests: max })
    return !error && data === true
  }
  const logEvent = async (event_type: string, auth_user_id: string | null = null, email = '', details: Record<string, unknown> = {}) => {
    try {
      await admin.from('login_auth_events').insert({
        event_type, auth_user_id: auth_user_id || null,
        email_hmac: email ? await hmac(hmacSecret, `audit-email:${email.toLowerCase()}`) : null,
        ip_hmac: await hmac(hmacSecret, `audit-ip:${ip}`), details,
      })
    } catch { /* Audit insertion is best-effort and never changes authentication results. */ }
  }
  const recordSuccessfulLogin = async (authUserId: string, email: string, sessionId: string, deviceIdentifier: string) => {
    const ua = request.headers.get('user-agent') ?? ''
    const device = parseDevice(ua)
    const trustedIp = request.headers.get('cf-connecting-ip')?.trim() ?? ''
    const ipAddress = /^[0-9a-f:.]+$/i.test(trustedIp) ? trustedIp : ''
    const { data: activityRows, error: activityError } = await db.rpc('record_login_activity', {
      p_auth_user_id: authUserId, p_session_id: sessionId, p_device_identifier: deviceIdentifier,
      p_device_type: device.deviceType, p_operating_system: device.operatingSystem,
      p_browser: device.browser, p_browser_version: device.browserVersion, p_ip_address: ipAddress,
    })
    const activity = Array.isArray(activityRows) ? activityRows[0] : null
    if (activityError || !activity?.activity_id) return { error: activityError ?? new Error('Login activity was not recorded.') }

    if (activity.is_new_device === true) {
      const title = 'New device signed in to CampuSync'
      const description = `A new ${device.deviceType.toLowerCase()} using ${device.operatingSystem} and ${device.browser}${device.browserVersion ? ` ${device.browserVersion}` : ''} signed in to your account.`
      const { data: existingNotice } = await admin.from('notifications').select('id').eq('recipient_id', activity.profile_id)
        .eq('type', 'security_new_device').contains('payload', { activity_id: activity.activity_id }).maybeSingle()
      if (!existingNotice) {
        await admin.from('notifications').insert({
          recipient_id: activity.profile_id, actor_id: activity.profile_id, type: 'security_new_device',
          payload: { title, message: description, category: 'security', activity_id: activity.activity_id, device_type: device.deviceType, operating_system: device.operatingSystem, browser: device.browser, browser_version: device.browserVersion || null, ip_address: ipAddress || null, login_at: new Date().toISOString(), security_path: `/${activity.user_role}/security` },
        })
      }
      if (activity.email_delivery_status !== 'SENT') {
        let delivered = false
        for (let attempt = 0; attempt < 2 && !delivered; attempt++) {
          try {
            const appUrl = (Deno.env.get('APP_PUBLIC_URL') ?? '').replace(/\/$/, '')
            const link = `${appUrl}/${activity.user_role}/security`
            const ipLine = ipAddress ? `IP address: ${ipAddress}` : 'IP address: not available'
            await sendSchoolEmail({
              to: email, subject: title, preheader: 'A new device accessed your CampuSync account.',
              text: `${description}\nLocation: not available\n${ipLine}\nTime: ${new Date().toISOString()} (UTC)\n\nIf you do not recognize this activity, change your password and review Security & Login Activity: ${link}`,
              html: `<h1 style="margin:4px 0 12px;color:#16332a;font-size:24px">New device sign-in</h1><p style="margin:0 0 18px;color:#475569;font-size:15px;line-height:1.7">We noticed a new device accessing your CampuSync account.</p><div style="padding:16px;border:1px solid #dce9e1;border-radius:12px;background:#f6faf8;color:#334155;font-size:14px;line-height:1.8"><b>Device:</b> ${escapeEmailHtml(device.deviceType)}<br><b>System:</b> ${escapeEmailHtml(device.operatingSystem)}<br><b>Browser:</b> ${escapeEmailHtml(device.browser)} ${escapeEmailHtml(device.browserVersion)}<br><b>Location:</b> Not available<br><b>IP address:</b> ${escapeEmailHtml(ipAddress || 'Not available')}<br><b>Time:</b> ${escapeEmailHtml(new Date().toISOString())} UTC</div><p style="margin:18px 0;color:#475569;font-size:14px;line-height:1.7">If you do not recognize this sign-in, change your password and review your recent activity.</p><p><a href="${escapeEmailHtml(link)}" style="display:inline-block;padding:12px 20px;border-radius:10px;background:#11865d;color:#fff;text-decoration:none;font-weight:700">Review login activity</a></p>`,
            })
            delivered = true
          } catch { /* A security alert failure must not invalidate a real login. */ }
        }
        await admin.from('login_activity').update({ email_delivery_status: delivered ? 'SENT' : 'FAILED', email_delivery_attempts: delivered ? 1 : 2, email_last_error: delivered ? null : 'SMTP delivery failed after retry.' }).eq('id', activity.activity_id)
      }
    }
    await logEvent('successful_login', authUserId, email, { activity_id: activity.activity_id, new_device: activity.is_new_device === true })
    return { activity, error: null }
  }
  let input: Record<string, unknown>
  try { input = await request.json() as Record<string, unknown> } catch { return respond(origin, { error: genericFailure }, 400) }
  const action = input.action

  if (action === 'start') {
    const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : ''
    const password = typeof input.password === 'string' ? input.password : ''
    if (!email || !password) return respond(origin, { error: genericFailure }, 401)
    await logEvent('login_attempt', null, email)
    if (!(await rate(`start:${email}`, 900, 5)) || !(await rate('start-ip', 900, 20))) { await logEvent('rate_limit_triggered', null, email, { action: 'start' }); return respond(origin, { error: 'Too many sign-in attempts. Please wait a few minutes and try again.' }, 429) }
    const auth = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } })
    const { data, error: signInError } = await auth.auth.signInWithPassword({ email, password })
    const firstTime = signInError?.code === 'email_not_confirmed'
    if (signInError?.code === 'user_banned') {
      await logEvent('account_access_denied', null, email, { reason: 'suspended' })
      return respond(origin, { error: 'This account is suspended. Please contact your school administrator.' }, 403)
    }
    if (signInError && !firstTime) { await logEvent('failed_login', null, email, { reason: 'invalid_credentials' }); return respond(origin, { error: genericFailure }, 401) }
    let authUserId = data.user?.id ?? ''
    let registeredEmail = data.user?.email ?? ''
    let authEmailVerifiedAt = data.user?.email_confirmed_at ?? null
    let session = data.session
    if (firstTime) {
      // Supabase returns email_not_confirmed only after it validates the password.
      // Resolve that account through its school profile and verify it is still unconfirmed.
      const { data: candidate, error: candidateError } = await admin.from('profiles').select('auth_user_id').eq('email', email).maybeSingle()
      if (candidateError || !candidate?.auth_user_id) { await logEvent('account_access_denied', null, email, { reason: 'profile_not_found' }); return respond(origin, { error: genericFailure }, 401) }
      const { data: authRecord, error: authRecordError } = await admin.auth.admin.getUserById(candidate.auth_user_id)
      if (authRecordError || !authRecord.user || authRecord.user.email?.toLowerCase() !== email || authRecord.user.email_confirmed_at) { await logEvent('failed_login', candidate.auth_user_id, email, { reason: 'unconfirmed_account_lookup_failed' }); return respond(origin, { error: genericFailure }, 401) }
      authUserId = authRecord.user.id
      registeredEmail = authRecord.user.email
      authEmailVerifiedAt = null
      session = null
    }
    if (!authUserId || !registeredEmail || (!firstTime && !session)) { await logEvent('failed_login', authUserId || null, email); return respond(origin, { error: genericFailure }, 401) }
    await logEvent('password_validated', authUserId, registeredEmail, { verification_kind: firstTime ? 'FIRST_TIME' : 'LOGIN' })
    const { data: profile, error: profileError } = await admin.from('profiles').select('id,role,is_active,email').eq('auth_user_id', authUserId).maybeSingle()
    if (profileError) return respond(origin, { error: 'Login verification is not configured. Please contact your school administrator.' }, 503)
    if (!profile?.is_active || !['administrator', 'guard', 'student', 'teacher', 'parent'].includes(profile.role)) { await logEvent('account_access_denied', authUserId, registeredEmail, { reason: 'inactive_or_unsupported_role' }); return respond(origin, { error: 'This account is inactive. Please contact your school administrator.' }, 403) }
    const { data: verification, error: verificationError } = await admin.from('school_email_verifications').select('verified_at').eq('auth_user_id', authUserId).maybeSingle()
    if (verificationError) return respond(origin, { error: 'Login verification is not configured. Please contact your school administrator.' }, 503)
    const verificationKind = firstTime || (!verification?.verified_at && !authEmailVerifiedAt) ? 'FIRST_TIME' : 'LOGIN'
    const sessionId = session ? String(jwtClaims(session.access_token).session_id ?? '') : crypto.randomUUID()
    if (!sessionId) return respond(origin, { error: genericFailure }, 401)

    // Email verification is a one-time gate. Existing accounts whose email is
    // already confirmed receive a normal session without another OTP.
    if (verificationKind === 'LOGIN' && session) {
      if (authEmailVerifiedAt && !verification?.verified_at) {
        await admin.from('school_email_verifications').upsert({ auth_user_id: authUserId, verified_at: authEmailVerifiedAt }, { onConflict: 'auth_user_id' })
      }
      await db.from('login_otp_challenges').update({ consumed_at: new Date().toISOString(), encrypted_session: '' }).eq('auth_user_id', authUserId).is('consumed_at', null)
      const { error: sessionWriteError } = await admin.from('login_otp_verified_sessions').upsert({
        session_id: sessionId, auth_user_id: authUserId,
        expires_at: new Date(Date.now() + 30 * 24 * 60 * 60_000).toISOString(), revoked_at: null,
      }, { onConflict: 'session_id' })
      if (sessionWriteError) return respond(origin, { error: 'Your verified session could not be prepared. Please try again.' }, 503)
      const deviceIdentifier = safeDeviceIdentifier(input.deviceIdentifier)
      const tracked = await recordSuccessfulLogin(authUserId, registeredEmail, sessionId, deviceIdentifier)
      if (tracked.error) {
        await admin.from('login_otp_verified_sessions').update({ revoked_at: new Date().toISOString() }).eq('session_id', sessionId)
        console.error('Successful login activity could not be recorded', { code: (tracked.error as { code?: string }).code ?? 'unknown' })
        return respond(origin, { error: 'Sign-in could not be completed because security activity could not be recorded. Please try again.' }, 503)
      }
      const refreshed = await fetch(`${url}/auth/v1/token?grant_type=refresh_token`, { method: 'POST', headers: { apikey: anonKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ refresh_token: session.refresh_token }) })
      if (!refreshed.ok) {
        await admin.from('login_otp_verified_sessions').update({ revoked_at: new Date().toISOString() }).eq('session_id', sessionId)
        return respond(origin, { error: 'Your sign-in expired. Please enter your credentials again.' }, 401)
      }
      const issued = await refreshed.json()
      return respond(origin, { access_token: issued.access_token, refresh_token: issued.refresh_token, token_type: issued.token_type, expires_in: issued.expires_in, verified: true })
    }

    await db.from('login_otp_challenges').delete().lt('expires_at', new Date().toISOString())
    const { error: invalidateError } = await db.from('login_otp_challenges').update({ consumed_at: new Date().toISOString(), encrypted_session: '' }).eq('auth_user_id', authUserId).is('consumed_at', null)
    if (invalidateError) return respond(origin, { error: genericFailure }, 503)
    const challengeId = crypto.randomUUID()
    const code = await makeCode()
    const { error: insertError } = await db.from('login_otp_challenges').insert({
      id: challengeId, auth_user_id: authUserId, session_id: sessionId, email: registeredEmail,
      otp_hmac: await hmac(hmacSecret, `${challengeId}:${code}`),
      verification_kind: verificationKind,
      encrypted_session: await encrypt(encryptionKey, session ? { access_token: session.access_token, refresh_token: session.refresh_token } : { first_time_verification: true }),
      expires_at: new Date(Date.now() + 5 * 60_000).toISOString(), resend_after: new Date(Date.now() + 60_000).toISOString(),
    })
    if (insertError) return respond(origin, { error: genericFailure }, 500)
    if (verificationKind === 'FIRST_TIME') await logEvent('first_time_verification_started', authUserId, registeredEmail)
    const emailSubject = verificationKind === 'FIRST_TIME' ? 'Verify your CampuSync email' : 'Your CampuSync sign-in code'
    const emailMessage = verificationKind === 'FIRST_TIME' ? 'Use this code to verify your email and finish setting up access to CampuSync.' : 'Use this code to finish signing in to CampuSync.'
    const emailBody = `${emailMessage}\n\nYour code: ${code}\n\nThis code expires in 5 minutes. Never share this code with anyone. If you did not try to sign in, you can ignore this email.`
    try {
      await sendSchoolEmail({ to: registeredEmail, subject: emailSubject, preheader: 'Your secure CampuSync verification code is inside.', text: emailBody, html: `<h1 style="margin:4px 0 12px;color:#16332a;font-size:24px;line-height:1.3">${emailSubject}</h1><p style="margin:0 0 20px;color:#475569;font-size:15px;line-height:1.7">${emailMessage}</p><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 18px;background:#f0f8f4;border:1px solid #d8ede1;border-radius:14px"><tr><td align="center" style="padding:22px 12px"><div style="margin-bottom:8px;color:#557064;font-size:11px;font-weight:700;letter-spacing:1.6px;text-transform:uppercase">Your one-time code</div><div style="color:#087a53;font-size:34px;font-weight:700;letter-spacing:9px">${code}</div></td></tr></table><p style="margin:0 0 10px;color:#475569;font-size:14px;line-height:1.7">This code expires in <b>5 minutes</b>. Enter it in the CampuSync sign-in screen.</p><p style="margin:0;color:#64756e;font-size:13px;line-height:1.6">Never share this code. If you did not request it, you can ignore this email.</p>` })
    } catch {
      await db.from('login_otp_challenges').delete().eq('id', challengeId)
      await logEvent('otp_delivery_failed', authUserId, registeredEmail, { verification_kind: verificationKind })
      return respond(origin, { error: genericFailure }, 503)
    }
    await logEvent('otp_sent', authUserId, registeredEmail, { verification_kind: verificationKind })
    return respond(origin, { challengeId, verificationKind, maskedEmail: maskEmail(registeredEmail), expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(), resendAt: new Date(Date.now() + 60_000).toISOString() })
  }

  if (action === 'resend') {
    const challengeId = typeof input.challengeId === 'string' ? input.challengeId : ''
    if (!challengeId || !(await rate(`resend:${challengeId}`, 3600, 5)) || !(await rate('resend-ip', 3600, 30))) { await logEvent('rate_limit_triggered', null, '', { action: 'resend' }); return respond(origin, { error: 'Please wait before requesting another code.' }, 429) }
    const code = await makeCode()
    const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString()
    const resendAt = new Date(Date.now() + 60_000).toISOString()
    const { data: resendRows, error } = await db.rpc('login_otp_resend_challenge', { p_challenge_id: challengeId, p_new_hmac: await hmac(hmacSecret, `${challengeId}:${code}`), p_expires_at: expiresAt, p_resend_after: resendAt })
    const resendChallenge = Array.isArray(resendRows) ? resendRows[0] : null
    if (error) return respond(origin, { error: genericFailure }, 500)
    if (!resendChallenge?.email) return respond(origin, { error: 'Please wait before requesting another code.' }, 429)
    const email = String(resendChallenge.email)
    const kind = resendChallenge.verification_kind === 'FIRST_TIME' ? 'FIRST_TIME' : 'LOGIN'
    // Legacy LOGIN challenges from before one-time verification may still be
    // present after deployment. Consume them instead of sending another OTP.
    if (kind !== 'FIRST_TIME') {
      await db.from('login_otp_challenges').update({ consumed_at: new Date().toISOString(), encrypted_session: '' }).eq('id', challengeId)
      return respond(origin, { error: 'Email verification is complete for this account. Return to sign in with your email and password.' }, 409)
    }
    const subject = kind === 'FIRST_TIME' ? 'Verify your CampuSync email' : 'Your CampuSync sign-in code'
    const purpose = kind === 'FIRST_TIME' ? 'verify your email and finish setting up access' : 'finish signing in'
    const body = `Use this code to ${purpose}: ${code}. It expires in 5 minutes. Never share this code. The previous code is no longer valid.`
    const html = `<h1 style="margin:4px 0 12px;color:#16332a;font-size:24px;line-height:1.3">${subject}</h1><p style="margin:0 0 20px;color:#475569;font-size:15px;line-height:1.7">Use this code to ${purpose}:</p><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 18px;background:#f0f8f4;border:1px solid #d8ede1;border-radius:14px"><tr><td align="center" style="padding:22px 12px"><div style="margin-bottom:8px;color:#557064;font-size:11px;font-weight:700;letter-spacing:1.6px;text-transform:uppercase">Your one-time code</div><div style="color:#087a53;font-size:34px;font-weight:700;letter-spacing:9px">${code}</div></td></tr></table><p style="margin:0;color:#64756e;font-size:13px;line-height:1.6">This code expires in 5 minutes. Never share it. Your previous code is no longer valid.</p>`
    try { await sendSchoolEmail({ to: email, subject, preheader: 'Your new secure CampuSync code is inside.', text: body, html }) }
    catch { await logEvent('otp_delivery_failed', null, email, { action: 'resend' }); return respond(origin, { error: genericFailure }, 503) }
    await logEvent('otp_resend', null, email, { verification_kind: kind })
    await logEvent('otp_sent', null, email, { verification_kind: kind, resend: true })
    return respond(origin, { challengeId, verificationKind: kind, maskedEmail: maskEmail(email), expiresAt, resendAt })
  }

  if (action === 'verify') {
    const challengeId = typeof input.challengeId === 'string' ? input.challengeId : ''
    const code = typeof input.code === 'string' ? input.code : ''
    if (!/^[0-9a-f-]{36}$/i.test(challengeId) || !/^\d{6}$/.test(code)) return respond(origin, { error: 'Invalid or expired verification code.' }, 400)
    if (!(await rate(`verify:${challengeId}`, 900, 10)) || !(await rate('verify-ip', 900, 60))) {
      const { data: challengeOwner } = await db.from('login_otp_challenges').select('auth_user_id,email').eq('id', challengeId).maybeSingle()
      await logEvent('rate_limit_triggered', challengeOwner?.auth_user_id ?? null, challengeOwner?.email ?? '', { action: 'verify' })
      return respond(origin, { error: 'Too many code attempts. Wait a little while, then sign in again for a new code.' }, 429)
    }
    const { data: resultRows, error } = await db.rpc('login_otp_verify_challenge', { p_challenge_id: challengeId, p_candidate_hmac: await hmac(hmacSecret, `${challengeId}:${code}`) })
    const result = Array.isArray(resultRows) ? resultRows[0] : null
    if (error) {
      // Keep infrastructure/schema failures distinct from a rejected OTP. The
      // previous generic response made database RPC errors look like bad codes.
      await logEvent('otp_verification_failure', null, '', { result: 'rpc_error', database_code: error.code ?? 'unknown' })
      console.error('OTP challenge verification RPC failed', { code: error.code ?? 'unknown' })
      return respond(origin, { error: 'The verification service is temporarily unavailable. Please return to login and try again.' }, 503)
    }
    if (result?.result !== 'verified') {
      const message = result?.result === 'incorrect' ? 'Incorrect code. Try again.' : result?.result === 'locked' ? 'Too many incorrect attempts. Return to sign in to request a new code.' : result?.result === 'expired' ? 'This code has expired. Return to sign in to request a new code.' : result?.result === 'invalid' ? 'This code was replaced or already used. Return to login and request a fresh code.' : 'The verification challenge could not be found. Return to login and request a fresh code.'
      const { data: challengeOwner } = await db.from('login_otp_challenges').select('auth_user_id,email').eq('id', challengeId).maybeSingle()
      await logEvent(result?.result === 'expired' ? 'otp_expiration' : 'otp_verification_failure', challengeOwner?.auth_user_id ?? null, challengeOwner?.email ?? '', { result: result?.result ?? 'invalid' })
      await logEvent('failed_login', challengeOwner?.auth_user_id ?? null, challengeOwner?.email ?? '', { reason: 'otp_verification_failed' })
      return respond(origin, { error: message }, 400)
    }
    await logEvent('otp_verification_success', result.auth_user_id, result.email, { verification_kind: result.verification_kind })
    let tokens: { access_token: string; refresh_token: string }
    let issuedSessionId = result.session_id
    if (result.verification_kind === 'FIRST_TIME') {
      const { error: confirmError } = await admin.auth.admin.updateUserById(result.auth_user_id, { email_confirm: true })
      if (confirmError) {
        await db.from('login_otp_verified_sessions').update({ revoked_at: new Date().toISOString() }).eq('session_id', result.session_id)
        return respond(origin, { error: 'Your email code was accepted, but verification could not be completed. Please try again.' }, 503)
      }
      const { error: verificationWriteError } = await admin.from('school_email_verifications').upsert({ auth_user_id: result.auth_user_id, verified_at: new Date().toISOString() }, { onConflict: 'auth_user_id' })
      if (verificationWriteError) {
        await db.from('login_otp_verified_sessions').update({ revoked_at: new Date().toISOString() }).eq('session_id', result.session_id)
        return respond(origin, { error: 'Your email code was accepted, but verification could not be completed. Please try again.' }, 503)
      }
      const { data: magicLink, error: linkError } = await admin.auth.admin.generateLink({ type: 'magiclink', email: result.email })
      const tokenHash = magicLink?.properties?.hashed_token
      if (linkError || !tokenHash) {
        await db.from('login_otp_verified_sessions').update({ revoked_at: new Date().toISOString() }).eq('session_id', result.session_id)
        return respond(origin, { error: 'Email verified, but a sign-in session could not be created. Please sign in again.' }, 503)
      }
      const sessionClient = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } })
      const { data: authResult, error: verifyLinkError } = await sessionClient.auth.verifyOtp({ token_hash: tokenHash, type: 'magiclink' })
      if (verifyLinkError || !authResult.session) {
        await db.from('login_otp_verified_sessions').update({ revoked_at: new Date().toISOString() }).eq('session_id', result.session_id)
        return respond(origin, { error: 'Email verified, but a sign-in session could not be created. Please sign in again.' }, 503)
      }
      tokens = { access_token: authResult.session.access_token, refresh_token: authResult.session.refresh_token }
      const actualSessionId = String(jwtClaims(tokens.access_token).session_id ?? '')
      if (!actualSessionId) {
        await db.from('login_otp_verified_sessions').update({ revoked_at: new Date().toISOString() }).eq('session_id', result.session_id)
        return respond(origin, { error: genericFailure }, 503)
      }
      issuedSessionId = actualSessionId
      const { error: sessionWriteError } = await db.from('login_otp_verified_sessions').upsert({ session_id: actualSessionId, auth_user_id: result.auth_user_id, expires_at: new Date(Date.now() + 30 * 24 * 60 * 60_000).toISOString(), revoked_at: null }, { onConflict: 'session_id' })
      if (sessionWriteError) {
        await db.from('login_otp_verified_sessions').update({ revoked_at: new Date().toISOString() }).eq('session_id', result.session_id)
        return respond(origin, { error: genericFailure }, 503)
      }
      if (actualSessionId !== result.session_id) await db.from('login_otp_verified_sessions').update({ revoked_at: new Date().toISOString() }).eq('session_id', result.session_id)
    } else {
      const { error: verificationWriteError } = await admin.from('school_email_verifications').upsert({ auth_user_id: result.auth_user_id, verified_at: new Date().toISOString() }, { onConflict: 'auth_user_id' })
      if (verificationWriteError) return respond(origin, { error: genericFailure }, 503)
      try { tokens = await decrypt(encryptionKey, result.encrypted_session) } catch { return respond(origin, { error: genericFailure }, 500) }
    }
    const refreshed = await fetch(`${url}/auth/v1/token?grant_type=refresh_token`, { method: 'POST', headers: { apikey: anonKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ refresh_token: tokens.refresh_token }) })
    if (!refreshed.ok) {
      await db.from('login_otp_verified_sessions').update({ revoked_at: new Date().toISOString() }).eq('session_id', issuedSessionId)
      return respond(origin, { error: 'Your sign-in expired. Please enter your credentials again.' }, 401)
    }
    const session = await refreshed.json()
    const deviceIdentifier = safeDeviceIdentifier(input.deviceIdentifier)
    const tracked = await recordSuccessfulLogin(result.auth_user_id, result.email, issuedSessionId, deviceIdentifier)
    if (tracked.error) {
      await admin.from('login_otp_verified_sessions').update({ revoked_at: new Date().toISOString() }).eq('session_id', issuedSessionId)
      console.error('Verified login activity could not be recorded', { code: (tracked.error as { code?: string }).code ?? 'unknown' })
      return respond(origin, { error: 'Email verified, but security activity could not be recorded. Please sign in again.' }, 503)
    }
    return respond(origin, { access_token: session.access_token, refresh_token: session.refresh_token, token_type: session.token_type, expires_in: session.expires_in })
  }
  return respond(origin, { error: genericFailure }, 400)
})
