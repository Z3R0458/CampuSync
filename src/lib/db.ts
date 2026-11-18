import Dexie, { type Table } from 'dexie'

export type SyncStatus = 'PENDING' | 'SYNCING' | 'SYNCED' | 'FAILED' | 'NEEDS_REVIEW'
export type GateEventType = 'ENTRY' | 'EXIT' | 'EARLY_OUT' | 'TEMPORARY_EXIT' | 'RETURN'
export type PersonType = 'student' | 'teacher'

export interface PendingAttendanceEvent {
  id: string
  personId: string
  personType: PersonType
  displayId: string
  fullName: string
  gradeLevel: string | null
  sectionName: string | null
  eventType: GateEventType
  scanTimestamp: string
  deviceId: string
  guardId: string
  qrToken: string
  syncStatus: SyncStatus
  verificationResult: 'CACHED_CREDENTIAL' | 'MANUAL_VERIFIED' | 'VERIFIED' | 'NEEDS_REVIEW'
  attemptCount: number
  lastError?: string
}

export interface CachedQrCredential {
  tokenHash: string
  personId: string
  personType: PersonType
  displayId: string
  fullName: string
  gradeLevel: string | null
  sectionName: string | null
  lastEventType: GateEventType | null
  lastScanAt: string | null
  cachedAt: string
}

export interface PendingVisitorLog {
  id: string
  visitorRequestId: string | null
  visitorName: string
  contactNumber: string | null
  identificationDetails: string | null
  relationshipToStudent: string | null
  studentId: string | null
  purpose: string
  remarks?: string | null
  visitDate: string
  personContacted: string | null
  authorizationStatus: 'PENDING' | 'APPROVED' | 'DENIED'
  actualDepartureTime: string | null
  syncStatus: SyncStatus
  attemptCount: number
  lastError?: string
}

export interface CachedVisitorApproval {
  id: string
  visitorName: string
  contactNumber: string | null
  relationshipToStudent: string
  studentId: string | null
  studentName: string | null
  studentNumber: string | null
  gradeLevel: string | null
  sectionName: string | null
  purpose: string
  visitDate: string
  expectedArrivalTime: string
  cachedAt: string
}

class SchoolGuardDb extends Dexie {
  pendingSync!: Table<PendingAttendanceEvent, string>
  qrCache!: Table<CachedQrCredential, string>
  visitorQueue!: Table<PendingVisitorLog, string>
  visitorApprovals!: Table<CachedVisitorApproval, string>

  constructor() {
    super('SchoolGuardDB')
    this.version(1).stores({
      pendingSync: 'id, syncStatus, scanTimestamp, studentId',
    })
    this.version(2).stores({
      pendingSync: 'id, syncStatus, scanTimestamp, studentId, personId, personType, [personType+personId]',
      qrCache: 'tokenHash, personId, personType, cachedAt, [personType+personId]',
    }).upgrade(async (transaction) => {
      await transaction.table('pendingSync').toCollection().modify((event: Record<string, unknown>) => {
        if (event.studentId && !event.personId) event.personId = event.studentId
        if (!event.personType) event.personType = 'student'
        if (!event.qrToken) {
          event.syncStatus = 'NEEDS_REVIEW'
          event.lastError = 'This record predates secure QR verification and requires review.'
        }
      })
    })
    this.version(3).stores({
      pendingSync: 'id, syncStatus, scanTimestamp, studentId, personId, personType, [personType+personId]',
      qrCache: 'tokenHash, personId, personType, cachedAt, [personType+personId]',
      visitorQueue: 'id, syncStatus, visitDate',
    })
    this.version(4).stores({
      pendingSync: 'id, syncStatus, scanTimestamp, studentId, personId, personType, [personType+personId]',
      qrCache: 'tokenHash, personId, personType, displayId, cachedAt, [personType+personId]',
      visitorQueue: 'id, syncStatus, visitDate',
    })
    this.version(5).stores({
      pendingSync: 'id, syncStatus, scanTimestamp, studentId, personId, personType, [personType+personId]',
      qrCache: 'tokenHash, personId, personType, displayId, cachedAt, [personType+personId]',
      visitorQueue: 'id, syncStatus, visitDate, visitorRequestId',
      visitorApprovals: 'id, visitDate, cachedAt',
    })
  }
}

export const db = new SchoolGuardDb()

export async function addPendingSync(event: PendingAttendanceEvent) {
  await db.pendingSync.put(event)
}

export async function getPendingSyncCount() {
  const [attendanceCount, visitorCount] = await Promise.all([
    db.pendingSync.where('syncStatus').notEqual('SYNCED').count(),
    db.visitorQueue.where('syncStatus').notEqual('SYNCED').count(),
  ])
  return attendanceCount + visitorCount
}

export async function getPendingSyncQueue() {
  return db.pendingSync
    .where('syncStatus')
    .anyOf('PENDING', 'SYNCING', 'FAILED')
    .sortBy('scanTimestamp')
}

export async function markSyncing(id: string) {
  await db.pendingSync.update(id, { syncStatus: 'SYNCING' })
}

export async function markSynced(id: string) {
  await db.pendingSync.update(id, { syncStatus: 'SYNCED', verificationResult: 'VERIFIED', lastError: undefined })
}

export async function markFailed(id: string, message: string) {
  const event = await db.pendingSync.get(id)
  if (!event) return
  await db.pendingSync.update(id, { syncStatus: 'FAILED', attemptCount: (event.attemptCount ?? 0) + 1, lastError: message })
}

export async function markNeedsReview(id: string, message: string) {
  await db.pendingSync.update(id, { syncStatus: 'NEEDS_REVIEW', verificationResult: 'NEEDS_REVIEW', lastError: message })
}

export async function replaceQrCache(credentials: CachedQrCredential[]) {
  await db.transaction('rw', db.qrCache, async () => {
    await db.qrCache.clear()
    await db.qrCache.bulkPut(credentials)
  })
}

export async function getCachedCredential(tokenHash: string) {
  return db.qrCache.get(tokenHash)
}

export async function findCachedPerson(displayId: string) {
  return db.qrCache.where('displayId').equalsIgnoreCase(displayId.trim()).first()
}

export async function updateCachedPersonState(personType: PersonType, personId: string, eventType: GateEventType, scanAt: string) {
  await db.qrCache.where('[personType+personId]').equals([personType, personId]).modify({
    lastEventType: eventType,
    lastScanAt: scanAt,
  })
}

export async function getLocalLastEvent(personType: PersonType, personId: string) {
  const [credential, events] = await Promise.all([
    db.qrCache.where('[personType+personId]').equals([personType, personId]).first(),
    db.pendingSync.where('[personType+personId]').equals([personType, personId]).toArray(),
  ])
  const latestLocal = events
    .filter((event) => event.syncStatus !== 'NEEDS_REVIEW')
    .sort((a, b) => b.scanTimestamp.localeCompare(a.scanTimestamp))[0]
  if (latestLocal && (!credential?.lastScanAt || latestLocal.scanTimestamp > credential.lastScanAt)) {
    return { eventType: latestLocal.eventType, scanAt: latestLocal.scanTimestamp }
  }
  return { eventType: credential?.lastEventType ?? null, scanAt: credential?.lastScanAt ?? null }
}

export async function getPendingSyncQueueCount() {
  return getPendingSyncCount()
}

export async function getRecentQueuedAttendance() {
  const events = await db.pendingSync
    .where('syncStatus')
    .anyOf('PENDING', 'SYNCING', 'FAILED', 'NEEDS_REVIEW')
    .toArray()
  return events.sort((a, b) => b.scanTimestamp.localeCompare(a.scanTimestamp)).slice(0, 10)
}

export async function addPendingVisitor(log: PendingVisitorLog) {
  await db.visitorQueue.put(log)
}

export async function getPendingVisitors() {
  return db.visitorQueue.where('syncStatus').anyOf('PENDING', 'SYNCING', 'FAILED').sortBy('visitDate')
}

export async function getRecentVisitors() {
  return db.visitorQueue.orderBy('visitDate').reverse().limit(10).toArray()
}

export async function replaceVisitorApprovals(approvals: CachedVisitorApproval[]) {
  await db.transaction('rw', db.visitorApprovals, async () => {
    await db.visitorApprovals.clear()
    await db.visitorApprovals.bulkPut(approvals)
  })
}

export async function getCachedVisitorApprovals() {
  return db.visitorApprovals.toArray()
}

export async function consumeCachedVisitorApproval(id: string) {
  await db.visitorApprovals.delete(id)
}

export async function markVisitorStatus(id: string, syncStatus: SyncStatus, lastError?: string) {
  const log = await db.visitorQueue.get(id)
  if (!log) return
  await db.visitorQueue.update(id, {
    syncStatus,
    attemptCount: syncStatus === 'FAILED' ? (log.attemptCount ?? 0) + 1 : log.attemptCount,
    lastError,
  })
}
