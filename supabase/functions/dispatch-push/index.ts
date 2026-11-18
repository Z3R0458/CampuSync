import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import webpush from 'npm:web-push@3.6.7'
import { escapeEmailHtml, sendSchoolEmail } from '../_shared/email.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function respond(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (request.method !== 'POST') return respond({ error: 'Method not allowed' }, 405)

  const url = Deno.env.get('SUPABASE_URL')
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
  const vapidPublicKey = Deno.env.get('VAPID_PUBLIC_KEY')
  const vapidPrivateKey = Deno.env.get('VAPID_PRIVATE_KEY')
  const vapidSubject = Deno.env.get('VAPID_SUBJECT') ?? 'mailto:school-admin@example.edu'
  if (!url || !serviceKey || !anonKey || !vapidPublicKey || !vapidPrivateKey) return respond({ error: 'Push function secrets are not configured.' }, 500)

  const authHeader = request.headers.get('Authorization')
  if (!authHeader?.startsWith('Bearer ')) return respond({ error: 'Sign in is required.' }, 401)
  const authClient = createClient(url, anonKey, { global: { headers: { Authorization: authHeader } }, auth: { persistSession: false } })
  const { data: authData, error: authError } = await authClient.auth.getUser(authHeader.slice(7))
  if (authError || !authData.user) return respond({ error: 'Session is invalid or expired.' }, 401)

  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })
  let claims: Record<string, unknown>
  try { claims = JSON.parse(atob(authHeader.slice(7).split('.')[1].replaceAll('-', '+').replaceAll('_', '/'))) as Record<string, unknown> } catch { return respond({ error: 'Email verification is required.' }, 403) }
  const sessionId = typeof claims.session_id === 'string' ? claims.session_id : ''
  const { data: verifiedSession } = await admin.from('login_otp_verified_sessions').select('session_id')
    .eq('session_id', sessionId).eq('auth_user_id', authData.user.id).is('revoked_at', null).gt('expires_at', new Date().toISOString()).maybeSingle()
  if (claims.schoolguard_otp_verified !== true || !verifiedSession) return respond({ error: 'Email verification is required.' }, 403)
  const { data: actor } = await admin.from('profiles').select('id,role,is_active').eq('auth_user_id', authData.user.id).maybeSingle()
  if (!actor?.is_active) return respond({ error: 'Active profile is required.' }, 403)

  let input: { event_id?: string; request_id?: string; announcement_id?: string }
  try { input = await request.json() } catch { return respond({ error: 'Invalid JSON body.' }, 400) }
  let notificationsQuery = admin.from('notifications').select('id,recipient_id,type,payload').limit(100)

  if (input.event_id) {
    const { data: gateEvent } = await admin.from('attendance_events').select('id,scanning_guard_id').eq('id', input.event_id).maybeSingle()
    if (!gateEvent || (gateEvent.scanning_guard_id !== actor.id && actor.role !== 'administrator')) return respond({ error: 'You cannot dispatch this gate event.' }, 403)
    notificationsQuery = notificationsQuery.contains('payload', { event_id: input.event_id })
  } else if (input.request_id) {
    const [early, visitor, walkin, visitorLog, approvedVisitorLog, parentLink] = await Promise.all([
      admin.from('early_out_requests').select('id,student_id,reviewed_by').eq('id', input.request_id).maybeSingle(),
      admin.from('visitor_requests').select('id,student_id,approved_by').eq('id', input.request_id).maybeSingle(),
      admin.from('visitor_logs').select('id,requester_guard_id,decision_by').eq('id', input.request_id).not('requester_guard_id','is',null).maybeSingle(),
      admin.from('visitor_logs').select('id,visitor_request_id,requester_guard_id').eq('id',input.request_id).maybeSingle(),
      admin.from('visitor_logs').select('id,visitor_request_id,requester_guard_id').eq('visitor_request_id',input.request_id).maybeSingle(),
      admin.from('parent_linking_requests').select('id,parent_id,parents(profile_id)').eq('id',input.request_id).maybeSingle(),
    ])
    const linkParent = Array.isArray(parentLink.data?.parents) ? parentLink.data.parents[0] : parentLink.data?.parents
    const parentOwnsRequest = actor.role==='parent' && linkParent?.profile_id===actor.id
    const studentId=early.data?.student_id??visitor.data?.student_id
    const {data: studentOwner}=studentId?await admin.from('students').select('profile_id').eq('id',studentId).maybeSingle():{data:null}
    const studentOwnsRequest=actor.role==='student'&&studentOwner?.profile_id===actor.id
    const requestActor = early.data?.reviewed_by ?? visitor.data?.approved_by ?? (walkin.data?.decision_by === actor.id ? walkin.data.decision_by : walkin.data?.requester_guard_id)
    const guardGateActor = actor.role === 'guard' && (visitorLog.data?.requester_guard_id === actor.id || Boolean(visitorLog.data?.visitor_request_id) || Boolean(approvedVisitorLog.data?.id))
    if (requestActor !== actor.id && actor.role !== 'administrator' && !guardGateActor && !parentOwnsRequest && !studentOwnsRequest) return respond({ error: 'You cannot dispatch this request update.' }, 403)
    notificationsQuery = notificationsQuery.or(`payload->>request_id.eq.${input.request_id},payload->>visitor_request_id.eq.${input.request_id}`)
  } else if (input.announcement_id) {
    if (actor.role !== 'administrator') return respond({ error: 'Administrator permission is required.' }, 403)
    const { data: announcement } = await admin.from('announcements').select('id').eq('id', input.announcement_id).maybeSingle()
    if (!announcement) return respond({ error: 'Announcement not found.' }, 404)
    notificationsQuery = notificationsQuery.contains('payload', { announcement_id: input.announcement_id })
  } else return respond({ error: 'Provide an event_id, request_id, or announcement_id.' }, 400)

  const { data: notices, error: noticeError } = await notificationsQuery
  if (noticeError) return respond({ error: noticeError.message }, 500)
  webpush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey)
  let delivered = 0
  for (const notice of notices ?? []) {
    const noticePayload = (notice.payload ?? {}) as Record<string, unknown>
    const { data: subscriptions } = await admin.from('push_subscriptions')
      .select('id,endpoint,auth_key,p256dh').eq('user_id', notice.recipient_id)
    const payload = JSON.stringify({ title: String(noticePayload.title ?? 'CampuSync update'), body: String(noticePayload.message ?? String(notice.type).replaceAll('_', ' ')), url: String(noticePayload.category) === 'attendance' ? '/parent/attendance' : '/' })
    for (const subscription of subscriptions ?? []) {
      const deliveryKey=String(subscription.id)
      const { data: prior } = await admin.from('parent_notification_delivery_attempts').select('id,status,attempts').eq('notification_id',notice.id).eq('recipient_id',notice.recipient_id).eq('channel','web_push').eq('delivery_key',deliveryKey).maybeSingle()
      if (prior?.status === 'SENT') continue
      const attempts = (prior?.attempts ?? 0) + 1
      const { data: delivery } = await admin.from('parent_notification_delivery_attempts').upsert({ notification_id:notice.id,recipient_id:notice.recipient_id,channel:'web_push',delivery_key:deliveryKey,status:'PENDING',attempts,last_error:null,updated_at:new Date().toISOString() },{ onConflict:'notification_id,recipient_id,channel,delivery_key' }).select('id').single()
      try {
        await webpush.sendNotification({ endpoint: subscription.endpoint, keys: { auth: subscription.auth_key, p256dh: subscription.p256dh } }, payload)
        delivered += 1
        if(delivery?.id)await admin.from('parent_notification_delivery_attempts').update({status:'SENT',sent_at:new Date().toISOString(),last_error:null,updated_at:new Date().toISOString()}).eq('id',delivery.id)
      } catch (error) {
        const statusCode = (error as { statusCode?: number }).statusCode
        if (statusCode === 404 || statusCode === 410) await admin.from('push_subscriptions').delete().eq('id', subscription.id)
        if(delivery?.id)await admin.from('parent_notification_delivery_attempts').update({status:'FAILED',last_error:String(error),updated_at:new Date().toISOString()}).eq('id',delivery.id)
      }
    }
    if (noticePayload.category && actor.is_active) {
      const { data: recipient } = await admin.from('profiles').select('email,role').eq('id',notice.recipient_id).maybeSingle()
      if(recipient?.role==='parent'&&recipient.email){
        const { data: parent } = await admin.from('parents').select('id,parent_notification_preferences(email_enabled)').eq('profile_id',notice.recipient_id).maybeSingle()
        const pref = Array.isArray(parent?.parent_notification_preferences) ? parent.parent_notification_preferences[0] : parent?.parent_notification_preferences
        if(pref?.email_enabled){
          const { data: prior } = await admin.from('parent_notification_delivery_attempts').select('id,status,attempts').eq('notification_id',notice.id).eq('recipient_id',notice.recipient_id).eq('channel','email').eq('delivery_key','account').maybeSingle()
          if(prior?.status!=='SENT'){
            const attempts=(prior?.attempts??0)+1
            const { data: delivery }=await admin.from('parent_notification_delivery_attempts').upsert({notification_id:notice.id,recipient_id:notice.recipient_id,channel:'email',delivery_key:'account',status:'PENDING',attempts,last_error:null,updated_at:new Date().toISOString()},{onConflict:'notification_id,recipient_id,channel,delivery_key'}).select('id').single()
            try{
              const title=String(noticePayload.title??'CampuSync update')
              const message=String(noticePayload.message??notice.type)
              await sendSchoolEmail({to:recipient.email,subject:title,preheader:title,text:message,html:`<h1 style="margin:4px 0 12px;color:#16332a;font-size:23px;line-height:1.35">${escapeEmailHtml(title)}</h1><p style="margin:0;color:#475569;font-size:15px;line-height:1.75;white-space:pre-line">${escapeEmailHtml(message)}</p>`})
              if(delivery?.id)await admin.from('parent_notification_delivery_attempts').update({status:'SENT',sent_at:new Date().toISOString(),last_error:null,updated_at:new Date().toISOString()}).eq('id',delivery.id)
            }catch(error){if(delivery?.id)await admin.from('parent_notification_delivery_attempts').update({status:'FAILED',last_error:String(error),updated_at:new Date().toISOString()}).eq('id',delivery.id)}
          }
        }
      }
    }
  }
  return respond({ delivered })
})
