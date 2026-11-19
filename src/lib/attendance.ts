import {
  addPendingVisitor,
  consumeCachedVisitorApproval,
  addPendingSync,
  db,
  getPendingVisitors,
  getCachedCredential,
  findCachedPerson,
  getCachedVisitorApprovals,
  getLocalLastEvent,
  getPendingSyncQueue,
  markFailed,
  markNeedsReview,
  markSynced,
  markSyncing,
  markVisitorStatus,
  replaceQrCache,
  replaceVisitorApprovals,
  updateCachedPersonState,
  type CachedQrCredential,
  type CachedVisitorApproval,
  type GateEventType,
  type PendingAttendanceEvent,
  type PersonType,
} from './db'
import { supabase } from './supabase'

export interface AttendanceScanResult {
  eventId: string
  personId: string
  personType: PersonType
  displayId: string
  fullName: string
  gradeLevel: string | null
  sectionName: string | null
  eventType: GateEventType
  scannedAt: string
  syncStatus: 'SYNCED' | 'PENDING' | 'NEEDS_REVIEW'
  guardId?: string
  guardName?: string
  scanOrigin?: 'ONLINE' | 'OFFLINE'
  synchronizedAt?: string
  message: string
}

const deviceStorageKey = (profileId: string) => `schoolguard:device:${profileId}`
let attendanceSyncRunning = false
let visitorSyncRunning = false

function dispatchPush(body: { event_id?: string; request_id?: string }) {
  if (supabase) void supabase.functions.invoke('dispatch-push', { body }).then(({ error }) => {
    if (error) console.warn('Push delivery is not available:', error.message)
  })
}

export async function registerGuardDevice(profileId: string) {
  if (!supabase) throw new Error('Supabase is not configured.')
  let existingId: string | null = null
  try { existingId = localStorage.getItem(deviceStorageKey(profileId)) } catch { /* Storage can be disabled. */ }

  if (!navigator.onLine) {
    if (existingId) return existingId
    throw new Error('This device must be registered online before it can record offline attendance.')
  }

  const { data, error } = await supabase.rpc('register_guard_device', {
    p_device_id: existingId,
    p_device_name: `${navigator.userAgent.includes('Mobile') ? 'Mobile' : 'Desktop'} gate device`,
  })
  if (error) {
    if (!navigator.onLine && existingId) return existingId
    throw new Error(error.message)
  }
  if (typeof data !== 'string') throw new Error('Server returned an invalid device identifier.')
  try { localStorage.setItem(deviceStorageKey(profileId), data) } catch { /* The current session can still use this ID. */ }
  return data
}

export async function refreshOfflineQrCache() {
  if (!supabase || !navigator.onLine) return 0
  const { data, error } = await supabase.rpc('get_offline_qr_cache')
  if (error) throw new Error(error.message)
  const rows = Array.isArray(data) ? data : []
  const cachedAt = new Date().toISOString()
  const credentials: CachedQrCredential[] = rows.map((row: Record<string, unknown>) => ({
    tokenHash: String(row.token_hash),
    personId: String(row.person_id),
    personType: row.person_type === 'teacher' ? 'teacher' : 'student',
    displayId: String(row.display_id ?? ''),
    fullName: String(row.full_name ?? ''),
    gradeLevel: typeof row.grade_level === 'string' ? row.grade_level : null,
    sectionName: typeof row.section_name === 'string' ? row.section_name : null,
    lastEventType: isGateEvent(row.last_event_type) ? row.last_event_type : null,
    lastScanAt: typeof row.last_scan_at === 'string' ? row.last_scan_at : null,
    cachedAt,
  }))
  await replaceQrCache(credentials)
  return credentials.length
}

export async function refreshApprovedVisitorCache() {
  if (!supabase || !navigator.onLine) return getCachedVisitorApprovals()
  const { data, error } = await supabase.rpc('list_guard_expected_visitors')
  if (error) throw new Error(error.message)
  const cachedAt = new Date().toISOString()
  const approvals: CachedVisitorApproval[] = (data ?? []).map((row: Record<string,unknown>) => ({
    id: String(row.request_id), visitorName: String(row.visitor_name), contactNumber: row.contact_number ? String(row.contact_number) : null,
    relationshipToStudent: String(row.visitor_relationship), studentId: row.student_id ? String(row.student_id) : null,
    studentName: row.student_name ? String(row.student_name) : null,studentNumber:row.school_student_id ? String(row.school_student_id) : null,gradeLevel:row.grade_level ? String(row.grade_level) : null,sectionName:row.section_name ? String(row.section_name) : null,
    purpose: String(row.purpose), visitDate: String(row.visit_date),
    expectedArrivalTime: String(row.expected_arrival_time), cachedAt,
  }))
  await replaceVisitorApprovals(approvals)
  return approvals
}

export async function queueApprovedVisitorCheckIn(approval: CachedVisitorApproval) {
  if (Date.now() - Date.parse(approval.cachedAt) > 24 * 60 * 60 * 1000) throw new Error('The visitor approval cache has expired.')
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date())
  if (approval.visitDate !== today) throw new Error('This visitor approval is not for today.')
  const arrival = new Date(`${approval.visitDate}T${approval.expectedArrivalTime}+08:00`).getTime()
  const now = Date.now()
  if (now < arrival - 2 * 60 * 60 * 1000 || now > arrival + 4 * 60 * 60 * 1000) throw new Error('This visitor approval is outside its valid arrival window.')
  await addPendingVisitor({
    id: crypto.randomUUID(), visitorRequestId: approval.id,
    visitorName: approval.visitorName, contactNumber: approval.contactNumber,
    identificationDetails: null, relationshipToStudent: approval.relationshipToStudent,
    studentId: approval.studentId, purpose: approval.purpose, visitDate: new Date().toISOString(),
    personContacted: null, authorizationStatus: 'APPROVED', actualDepartureTime: null,
    syncStatus: 'PENDING', attemptCount: 0,
  })
  await consumeCachedVisitorApproval(approval.id)
}

function isGateEvent(value: unknown): value is GateEventType {
  return value === 'ENTRY' || value === 'EXIT' || value === 'EARLY_OUT' || value === 'TEMPORARY_EXIT' || value === 'RETURN'
}

async function hashToken(token: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function validateLocalSequence(lastType: GateEventType | null, nextType: GateEventType, lastAt: string | null, scannedAt: string) {
  let valid = false
  if (nextType === 'ENTRY') {
    valid = lastType === null || ((lastType === 'EXIT' || lastType === 'EARLY_OUT') && Boolean(lastAt) &&
      new Date(lastAt!).toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' }) !==
      new Date(scannedAt).toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' }))
  } else if (nextType === 'EXIT' || nextType === 'EARLY_OUT' || nextType === 'TEMPORARY_EXIT') {
    valid = lastType === 'ENTRY' || lastType === 'RETURN'
  } else if (nextType === 'RETURN') {
    valid = lastType === 'TEMPORARY_EXIT'
  }
  if (!valid) throw new Error(`The ${nextType} scan is not valid after ${lastType ?? 'no recorded entry'}.`)
}

function mapServerResult(result: Record<string, unknown>, eventType: GateEventType): AttendanceScanResult {
  const status: AttendanceScanResult['syncStatus'] = result.status === 'NEEDS_REVIEW' ? 'NEEDS_REVIEW' : 'SYNCED'
  return {
    eventId: String(result.event_id),
    personId: String(result.person_id),
    personType: result.person_type === 'teacher' ? 'teacher' : 'student',
    displayId: String(result.display_id ?? ''),
    fullName: String(result.full_name ?? 'School member'),
    gradeLevel: typeof result.grade_level === 'string' ? result.grade_level : null,
    sectionName: typeof result.section_name === 'string' ? result.section_name : null,
    eventType: eventType,
    scannedAt: typeof result.scanned_at === 'string' ? result.scanned_at : new Date().toISOString(),
    syncStatus: status,
    guardId: typeof result.scanning_guard_id === 'string' ? result.scanning_guard_id : undefined,
    guardName: typeof result.scanning_guard_name === 'string' ? result.scanning_guard_name : undefined,
    scanOrigin: result.scan_origin === 'OFFLINE' ? 'OFFLINE' : 'ONLINE',
    synchronizedAt: typeof result.synchronized_at === 'string' ? result.synchronized_at : undefined,
    message: status === 'SYNCED' ? 'Credential verified and attendance recorded.' : 'Saved for manual review because the event time is out of sequence.',
  }
}

export async function recordQrScan(qrToken: string, eventType: GateEventType, deviceId: string, guardId: string): Promise<AttendanceScanResult> {
  if (!qrToken || qrToken.length < 32 || qrToken.length > 256) throw new Error('QR code does not contain a valid school credential.')
  if (eventType === 'EARLY_OUT' && !navigator.onLine) throw new Error('Early-out authorization must be checked online. Reconnect before recording an early departure.')
  const eventId = crypto.randomUUID()
  const scannedAt = new Date().toISOString()

  if (navigator.onLine && supabase) {
    const { data, error } = eventType === 'EARLY_OUT'
      ? await supabase.rpc('record_early_out_scan', { p_event_id: eventId, p_qr_token: qrToken, p_device_id: deviceId })
      : await supabase.rpc('record_attendance_scan', {
        p_event_id: eventId,
        p_qr_token: qrToken,
        p_event_type: eventType,
        p_scanned_at: scannedAt,
        p_device_id: deviceId,
        p_expected_guard_id: guardId,
        p_offline_origin: false,
      })
    if (error) throw new Error(error.message)
    const result = mapServerResult(data as Record<string, unknown>, eventType)
    if (result.syncStatus === 'SYNCED') await updateCachedPersonState(result.personType, result.personId, eventType, result.scannedAt)
    if (result.syncStatus === 'SYNCED') dispatchPush({ event_id: result.eventId })
    return result
  }

  const tokenHash = await hashToken(qrToken)
  const credential = await getCachedCredential(tokenHash)
  if (!credential) throw new Error('This credential is not in the offline cache. Connect to the internet to verify it.')
  return queueOfflineAttendance(credential, eventType, deviceId, guardId, qrToken, 'CACHED_CREDENTIAL', eventId, scannedAt)
}

async function queueOfflineAttendance(
  credential: CachedQrCredential,
  eventType: GateEventType,
  deviceId: string,
  guardId: string,
  qrToken: string,
  verificationResult: PendingAttendanceEvent['verificationResult'],
  eventId = crypto.randomUUID(),
  scannedAt = new Date().toISOString(),
): Promise<AttendanceScanResult> {
  if (Date.now() - Date.parse(credential.cachedAt) > 24 * 60 * 60 * 1000) {
    throw new Error('The offline QR cache is older than 24 hours. Connect and refresh it before scanning.')
  }
  const previous = await getLocalLastEvent(credential.personType, credential.personId)
  validateLocalSequence(previous.eventType, eventType, previous.scanAt, scannedAt)

  const localEvent: PendingAttendanceEvent = {
    id: eventId,
    personId: credential.personId,
    personType: credential.personType,
    displayId: credential.displayId,
    fullName: credential.fullName,
    gradeLevel: credential.gradeLevel,
    sectionName: credential.sectionName,
    eventType,
    scanTimestamp: scannedAt,
    deviceId,
    guardId,
    qrToken,
    syncStatus: 'PENDING' as const,
    verificationResult,
    attemptCount: 0,
  }
  await addPendingSync(localEvent)
  return {
    eventId,
    personId: credential.personId,
    personType: credential.personType,
    displayId: credential.displayId,
    fullName: credential.fullName,
    gradeLevel: credential.gradeLevel,
    sectionName: credential.sectionName,
    eventType,
    scannedAt,
    syncStatus: 'PENDING',
    message: 'Credential matched against this device’s cached data. Event saved locally and waiting to sync.',
  }
}

export async function lookupGuardPerson(displayId: string) {
  if (navigator.onLine && supabase) {
    const { data, error } = await supabase.rpc('lookup_guard_person', { p_display_id: displayId.trim() })
    if (error) throw new Error(error.message)
    if (!data) throw new Error('No active student or teacher matches that school ID.')
    return {
      personId: String(data.person_id), personType: data.person_type === 'teacher' ? 'teacher' as const : 'student' as const,
      displayId: String(data.display_id), fullName: String(data.full_name),
      gradeLevel: typeof data.grade_level === 'string' ? data.grade_level : null,
      sectionName: typeof data.section_name === 'string' ? data.section_name : null,
    }
  }
  const cached = await findCachedPerson(displayId)
  if (!cached) throw new Error('No matching active person is in the offline cache.')
  if (Date.now() - Date.parse(cached.cachedAt) > 24 * 60 * 60 * 1000) throw new Error('Offline data is older than 24 hours. Connect and refresh it.')
  return { personId: cached.personId, personType: cached.personType, displayId: cached.displayId,
    fullName: cached.fullName, gradeLevel: cached.gradeLevel, sectionName: cached.sectionName }
}

export async function searchGuardStudents(query: string) {
  if (!navigator.onLine || !supabase) return []
  const { data, error } = await supabase.rpc('search_guard_students', { p_query: query.trim() })
  if (error) throw new Error(error.message)
  return Array.isArray(data) ? data as { student_id: string; school_student_id: string; full_name: string; grade_level: string; section_name: string | null; enrollment_status: string }[] : []
}

export async function getGuardStudentSnapshot(studentId: string) {
  if (!navigator.onLine || !supabase) throw new Error('Student details need an online connection.')
  const { data, error } = await supabase.rpc('get_guard_student_snapshot', { p_student_id: studentId })
  if (error) throw new Error(error.message)
  if (!data) throw new Error('Student details were not found.')
  return data as Record<string, unknown>
}

export async function previewGuardQr(qrToken: string) {
  if (!supabase || !navigator.onLine) throw new Error('QR identity checks require a live connection. Offline scans use the limited device cache.')
  const { data, error } = await supabase.rpc('preview_guard_qr', { p_qr_token: qrToken })
  if (error) {
    const message = error.message.toLowerCase()
    if (error.code === 'PGRST202' || message.includes('preview_guard_qr') && message.includes('schema cache')) {
      throw new Error('QR verification is not set up on this Supabase project yet. Apply the profile photo and QR preview migrations, then refresh the app.')
    }
    if (error.code === '42501') throw new Error('Only an active Security Guard account can verify student QR codes. Sign in again if your guard account was just updated.')
    if (error.code === '22023' || message.includes('invalid, revoked, expired')) {
      throw new Error('This QR is invalid, was replaced, or belongs to an inactive account. Ask the student to open their dashboard and show their current QR code.')
    }
    if (message.includes('gen_random_bytes') || message.includes('digest') || message.includes('function') && message.includes('does not exist')) {
      throw new Error('The Supabase QR functions are out of date. Apply the QR credential and profile photo migrations, then try again.')
    }
    throw new Error(`QR verification failed: ${error.message}`)
  }
  if (!data) throw new Error('This QR is invalid, was replaced, or belongs to an inactive account. Ask the student to show their current QR code.')
  return data as Record<string, unknown>
}

export async function recordManualScan(
  person: { personId: string; personType: PersonType; displayId: string; fullName: string; gradeLevel: string | null; sectionName: string | null },
  eventType: GateEventType,
  deviceId: string,
  guardId: string,
) {
  const eventId = crypto.randomUUID()
  const scannedAt = new Date().toISOString()
  if (navigator.onLine && supabase) {
    const { data, error } = await supabase.rpc('record_manual_attendance', {
      p_event_id: eventId, p_person_type: person.personType, p_person_id: person.personId,
      p_event_type: eventType, p_scanned_at: scannedAt, p_device_id: deviceId,
      p_expected_guard_id: guardId, p_offline_origin: false,
    })
    if (error) throw new Error(error.message)
    const result = mapServerResult(data as Record<string, unknown>, eventType)
    if (result.syncStatus === 'SYNCED') await updateCachedPersonState(result.personType, result.personId, eventType, result.scannedAt)
    if (result.syncStatus === 'SYNCED') dispatchPush({ event_id: result.eventId })
    return result
  }
  const cached = await findCachedPerson(person.displayId)
  if (!cached || cached.personId !== person.personId || Date.now() - Date.parse(cached.cachedAt) > 24 * 60 * 60 * 1000) {
    throw new Error('This person is not available in the current offline verification cache.')
  }
  return queueOfflineAttendance(cached, eventType, deviceId, guardId, '', 'MANUAL_VERIFIED', eventId, scannedAt)
}

export async function syncPendingAttendance() {
  if (!navigator.onLine || !supabase || attendanceSyncRunning) return
  attendanceSyncRunning = true
  try {
    const queue = await getPendingSyncQueue()
    for (const event of queue) {
      await markSyncing(event.id)
      const { data, error } = event.verificationResult === 'MANUAL_VERIFIED'
        ? await supabase.rpc('record_manual_attendance', {
          p_event_id: event.id, p_person_type: event.personType, p_person_id: event.personId,
          p_event_type: event.eventType, p_scanned_at: event.scanTimestamp, p_device_id: event.deviceId,
          p_expected_guard_id: event.guardId, p_offline_origin: true,
        })
        : await supabase.rpc('record_attendance_scan', {
          p_event_id: event.id, p_qr_token: event.qrToken, p_event_type: event.eventType,
          p_scanned_at: event.scanTimestamp, p_device_id: event.deviceId,
          p_expected_guard_id: event.guardId, p_offline_origin: true,
        })
      if (error) {
        if (error.code === '22023' || error.code === '42501') await markNeedsReview(event.id, error.message)
        else await markFailed(event.id, error.message)
        continue
      }
      const result = data as Record<string, unknown>
      if (result.status === 'NEEDS_REVIEW') await markNeedsReview(event.id, 'Server placed this scan in the manual review queue.')
      else { await markSynced(event.id); dispatchPush({ event_id: event.id }) }
    }
  } finally {
    attendanceSyncRunning = false
  }
}

export async function recoverSyncingEvents() {
  await Promise.all([
    db.pendingSync.where('syncStatus').equals('SYNCING').modify({ syncStatus: 'PENDING' }),
    db.visitorQueue.where('syncStatus').equals('SYNCING').modify({ syncStatus: 'PENDING' }),
  ])
}

export async function syncPendingVisitors() {
  if (!navigator.onLine || !supabase || visitorSyncRunning) return
  visitorSyncRunning = true
  try {
    for (const visitor of await getPendingVisitors()) {
      await markVisitorStatus(visitor.id, 'SYNCING')
      if (visitor.visitorRequestId) {
        const { error } = await supabase.rpc('check_in_authorized_visitor', {
          p_request_id: visitor.visitorRequestId, p_event_id: visitor.id,
        })
        if (error) {
          await markVisitorStatus(visitor.id, error.code === '42501' || error.code === '22023' ? 'NEEDS_REVIEW' : 'FAILED', error.message)
        } else {
          await markVisitorStatus(visitor.id, 'SYNCED')
        }
        continue
      }

      const { error } = await supabase.rpc('register_walkin_visitor', {
        p_visitor_name: visitor.visitorName, p_contact_number: visitor.contactNumber,
        p_identification_details: visitor.identificationDetails, p_relationship: visitor.relationshipToStudent,
        p_student_id: visitor.studentId, p_purpose: visitor.purpose, p_person_contacted: visitor.personContacted, p_remarks: visitor.remarks ?? null,
        p_request_id: visitor.id,
      })
      if (error) await markVisitorStatus(visitor.id, error.code === '42501' || error.code === '22023' ? 'NEEDS_REVIEW' : 'FAILED', error.message)
      else {
        await markVisitorStatus(visitor.id, 'SYNCED')
        void supabase.functions.invoke('dispatch-push', { body: { request_id: visitor.id } })
      }
    }
  } finally {
    visitorSyncRunning = false
  }
}
