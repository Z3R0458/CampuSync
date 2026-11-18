import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { QRCodeSVG } from 'qrcode.react'
import { Download, Printer, QrCode } from 'lucide-react'
import { AnnouncementFeed } from '../admin/AnnouncementManagement'
import { supabase } from '../lib/supabase'
import { friendlyError, useFeedback } from '../components/UserFeedback'
import { ProfileAvatar } from '../components/ProfilePhoto'

type Row = Record<string, unknown>
type Props = { profile: { id: string; full_name: string; email?: string; phone?: string | null; is_active?: boolean; profile_photo_path?: string | null } }
const localDay = (value: unknown) => value ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(String(value))) : ''
const localMonth = (value: unknown) => localDay(value).slice(0, 7)
const formatPhilippineDateTime = (value: string) => value && value !== 'undefined' ? new Intl.DateTimeFormat('en-PH', { timeZone: 'Asia/Manila', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : '—'
const titleCase = (value: unknown) => String(value ?? '—').replaceAll('_', ' ').replace(/\b\w/g, char => char.toUpperCase())
const record = (value: unknown): Row | null => Array.isArray(value) ? value[0] as Row ?? null : value && typeof value === 'object' ? value as Row : null

export function TeacherPortal({ profile }: Props) {
  const { confirmAction } = useFeedback()
  const location = useLocation()
  const navigate = useNavigate()
  const page = location.pathname.replace(/\/$/, '') || '/teacher'
  const [teacher, setTeacher] = useState<Row | null>(null)
  const [sections, setSections] = useState<Row[]>([])
  const [events, setEvents] = useState<Row[]>([])
  const [announcements, setAnnouncements] = useState<Row[]>([])
  const [reads, setReads] = useState<Set<string>>(new Set())
  const [notifications, setNotifications] = useState<Row[]>([])
  const [preferences, setPreferences] = useState({ attendance_enabled: true, announcement_enabled: true })
  const [profileEmail, setProfileEmail] = useState(profile.email ?? '')
  const [qrToken, setQrToken] = useState('')
  const [qrBusy, setQrBusy] = useState(false)
  const [phone, setPhone] = useState(profile.phone ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [isOnline, setIsOnline] = useState(() => navigator.onLine)
  const [range, setRange] = useState('daily')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const qrRef = useRef<SVGSVGElement | null>(null)

  const refresh = useCallback(async () => {
    if (!supabase) return
    setError('')
    const client = supabase
    const [{ data: teacherRow, error: teacherError }, { data: profileRow }, { data: preferenceRow }] = await Promise.all([
      client.from('teachers').select('id,teacher_id,designation').eq('profile_id', profile.id).maybeSingle(),
      client.from('profiles').select('email,phone').eq('id', profile.id).maybeSingle(),
      client.from('teacher_notification_preferences').select('attendance_enabled,announcement_enabled').eq('profile_id', profile.id).maybeSingle(),
    ])
    if (teacherError || !teacherRow) {
      setTeacher(null)
      setError(teacherError?.message ?? 'No teacher record is linked to this account. Contact the administrator.')
      return
    }
    setTeacher(teacherRow)
    if (profileRow?.phone !== undefined) setPhone(profileRow.phone ?? '')
    if (profileRow?.email) setProfileEmail(profileRow.email)
    if (preferenceRow) setPreferences({ attendance_enabled: preferenceRow.attendance_enabled, announcement_enabled: preferenceRow.announcement_enabled })
    const [sectionRows, eventRows, announcementRows, readRows, notificationRows] = await Promise.all([
      client.from('sections').select('id,name,grade_level,adviser_id').eq('adviser_id', teacherRow.id).order('grade_level').order('name'),
      client.from('attendance_events').select('id,event_type,actual_scan_time,verification_result,sync_status,scanning_guard_id').eq('person_type', 'teacher').eq('person_id', teacherRow.id).order('actual_scan_time', { ascending: false }).limit(1000),
      client.from('announcements').select('id,title,summary,body,audience,category,priority,status,content_format,published_at,expires_at,target_grade_level,target_section_id,attachments,created_at,updated_at').in('audience', ['all', 'teacher']).eq('status', 'published').order('published_at', { ascending: false }).limit(100),
      client.from('announcement_reads').select('announcement_id').eq('profile_id', profile.id),
      client.from('notifications').select('id,type,payload,is_read,created_at').eq('recipient_id', profile.id).order('created_at', { ascending: false }).limit(100),
    ])
    const failure = [sectionRows.error, eventRows.error, announcementRows.error, readRows.error, notificationRows.error].find(Boolean)
    if (failure) setError(friendlyError(failure))
    else {
      setSections(sectionRows.data ?? [])
      setEvents(eventRows.data ?? [])
      setAnnouncements(announcementRows.data ?? [])
      setReads(new Set((readRows.data ?? []).map(row => row.announcement_id)))
      setNotifications(notificationRows.data ?? [])
    }
  }, [profile.id])

  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => {
    const online = () => setIsOnline(true)
    const offline = () => setIsOnline(false)
    window.addEventListener('online', online); window.addEventListener('offline', offline)
    return () => { window.removeEventListener('online', online); window.removeEventListener('offline', offline) }
  }, [])
  useEffect(() => {
    if (!supabase) return
    const client = supabase
    const channel = client.channel(`teacher-portal-${profile.id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'notifications', filter: `recipient_id=eq.${profile.id}` }, () => void refresh())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'attendance_events' }, () => void refresh())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'announcements' }, () => void refresh())
      .subscribe()
    return () => { void client.removeChannel(channel) }
  }, [profile.id, refresh])

  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date())
  const month = today.slice(0, 7)
  const confirmed = events.filter(event => event.sync_status === 'SYNCED' && ['VERIFIED', 'MANUAL_VERIFIED'].includes(String(event.verification_result)))
  const todayEvents = confirmed.filter(event => localDay(event.actual_scan_time) === today).sort((a, b) => String(a.actual_scan_time).localeCompare(String(b.actual_scan_time)))
  const monthEvents = confirmed.filter(event => localMonth(event.actual_scan_time) === month)
  const firstIn = todayEvents.find(event => ['ENTRY', 'RETURN'].includes(String(event.event_type)))
  const lastOut = [...todayEvents].reverse().find(event => ['EXIT', 'EARLY_OUT', 'TEMPORARY_EXIT'].includes(String(event.event_type)))
  const lastAction = todayEvents.at(-1)
  const attendanceStatus = !todayEvents.length ? 'No recorded transaction' : ['EXIT', 'EARLY_OUT'].includes(String(lastAction?.event_type)) ? 'Checked out' : 'On campus'
  const unreadCount = notifications.filter(item => !item.is_read).length
  const visibleAnnouncements = announcements.filter(item => (!item.published_at || new Date(String(item.published_at)) <= new Date()) && (!item.expires_at || new Date(String(item.expires_at)) > new Date()))
  const filteredEvents = useMemo(() => {
    let start = from
    let end = to
    if (range === 'daily') start = end = today
    if (range === 'weekly' && !from && !to) { const d = new Date(`${today}T00:00:00+08:00`); d.setUTCDate(d.getUTCDate() - 6); start = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(d); end = today }
    if (range === 'monthly' && !from && !to) { start = `${month}-01`; end = today }
    return confirmed.filter(event => (!start || localDay(event.actual_scan_time) >= start) && (!end || localDay(event.actual_scan_time) <= end))
  }, [confirmed, from, to, range, today, month])
  const daySummaries = useMemo(() => {
    const groups = new Map<string, Row[]>()
    for (const event of filteredEvents) {
      const key = localDay(event.actual_scan_time)
      groups.set(key, [...(groups.get(key) ?? []), event])
    }
    return [...groups].sort(([a], [b]) => b.localeCompare(a)).map(([date, rows]) => {
      const inEvent = rows.find(event => ['ENTRY','RETURN'].includes(String(event.event_type)))
      const outEvent = [...rows].reverse().find(event => ['EXIT','EARLY_OUT','TEMPORARY_EXIT'].includes(String(event.event_type)))
      const last = rows.at(-1)
      return { date, inEvent, outEvent, late: rows.some(event => event.verification_result === 'LATE'), earlyOut: rows.some(event => event.event_type === 'EARLY_OUT'), status: last && ['EXIT','EARLY_OUT'].includes(String(last.event_type)) ? 'Checked out' : last ? 'On campus' : 'No record' }
    })
  }, [filteredEvents])

  const generateQr = async () => {
    if (!supabase || qrBusy || !navigator.onLine) { setError('Connect to the internet before generating or replacing your secure QR credential.'); return }
    if (qrToken) { await confirmAction({title:'Replace your QR credential?',description:'Your current QR will stop working immediately. Share the replacement securely.',confirmLabel:'Replace QR',tone:'danger',successMessage:'A replacement QR code was generated.',onConfirm:async()=>{const {data,error:qrError}=await supabase!.rpc('issue_self_qr_credential');if(qrError)throw qrError;if(typeof data!=='string'||data.length<32)throw new Error('The server did not return a valid QR credential.');setQrToken(data)}});return }
    setQrBusy(true); setError(''); setNotice('')
    const { data, error: qrError } = await supabase.rpc('issue_self_qr_credential')
    if (qrError) setError(friendlyError(qrError))
    else if (typeof data === 'string' && data.length >= 32) { setQrToken(data); setNotice('QR generated. Download or print it now; the secure credential is shown only during this session.') }
    else setError('The server did not return a valid QR credential.')
    setQrBusy(false)
  }
  const downloadQr = () => {
    const svg = qrRef.current
    if (!svg || !qrToken) return
    const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(svg)], { type: 'image/svg+xml;charset=utf-8' }))
    const image = new Image()
    image.onload = () => { const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth * 3; canvas.height = image.naturalHeight * 3; const context = canvas.getContext('2d'); if (!context) { URL.revokeObjectURL(url); setError('Could not prepare the QR image.'); return } context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height); context.drawImage(image, 0, 0, canvas.width, canvas.height); URL.revokeObjectURL(url); canvas.toBlob(blob => { if (!blob) { setError('Could not prepare the QR image.'); return } const link = document.createElement('a'); const blobUrl = URL.createObjectURL(blob); link.href = blobUrl; link.download = `teacher-qr-${teacher?.teacher_id ?? 'code'}.png`; link.click(); URL.revokeObjectURL(blobUrl) }, 'image/png') }
    image.onerror = () => { URL.revokeObjectURL(url); setError('Could not prepare the QR image.') }
    image.src = url
  }
  const markNotificationRead = async (id: string) => { if (!supabase) return; const { error: updateError } = await supabase.from('notifications').update({ is_read: true }).eq('id', id).eq('recipient_id', profile.id); if (updateError) setError(friendlyError(updateError)); else setNotifications(rows => rows.map(row => row.id === id ? { ...row, is_read: true } : row)) }
  const markAllRead = async () => { if (!supabase) return; const { error: updateError } = await supabase.from('notifications').update({ is_read: true }).eq('recipient_id', profile.id).eq('is_read', false); if (updateError) setError(friendlyError(updateError)); else setNotifications(rows => rows.map(row => ({ ...row, is_read: true }))) }
  const markAnnouncementRead = async (id: string) => { if (!supabase) return; const { error: updateError } = await supabase.from('announcement_reads').upsert({ profile_id: profile.id, announcement_id: id }, { onConflict: 'profile_id,announcement_id' }); if (updateError) setError(friendlyError(updateError)); else setReads(old => new Set(old).add(id)) }
  const savePreference = async (key: keyof typeof preferences, enabled: boolean) => {
    if (!supabase) return
    const next = { ...preferences, [key]: enabled }
    setPreferences(next)
    const { error: preferenceError } = await supabase.from('teacher_notification_preferences').upsert({ profile_id: profile.id, ...next }, { onConflict: 'profile_id' })
    if (preferenceError) { setPreferences(preferences); setError(friendlyError(preferenceError)) }
    else setNotice('Notification preferences saved.')
  }
  const saveProfile = async (event: React.FormEvent) => { event.preventDefault(); if (!supabase) return; setBusy(true); setError(''); const { error: updateError } = await supabase.from('profiles').update({ phone: phone.trim() || null }).eq('id', profile.id); setBusy(false); if (updateError) setError(friendlyError(updateError)); else setNotice('Contact number updated.') }
  const pageTitle = page === '/teacher/qr' ? 'My QR Code' : page === '/teacher/attendance' ? 'My Attendance' : page === '/teacher/profile' ? 'My Profile' : page === '/teacher/announcements' ? 'Announcements' : page === '/teacher/notifications' ? 'Notifications' : 'Teacher dashboard'
  const pageSubtitle = page === '/teacher' ? `Welcome, ${profile.full_name}` : 'Your personal CampuSync information'

  return <div className="space-y-5">
    <header className="rounded-[28px] border border-[var(--color-border)] bg-white p-5 shadow-sm"><p className="text-xs font-bold uppercase tracking-[.2em] text-emerald-800">Teacher Portal</p><h2 className="mt-1 text-2xl font-bold">{pageTitle}</h2><p className="mt-1 text-sm text-slate-500">{pageSubtitle}</p></header>
    {!isOnline&&<p role="status" className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">Offline. Attendance shown here is the last data loaded from Supabase; pending gate scans are not treated as confirmed or shown as synced.</p>}
    {error && <p role="alert" className="rounded-xl bg-rose-50 p-3 text-sm text-rose-800">{error}</p>}{notice && <p role="status" className="rounded-xl bg-emerald-50 p-3 text-sm text-emerald-900">{notice}</p>}
    {page === '/teacher' && <>
      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{([['Teacher ID',teacher?.teacher_id??'Loading…'],['Today',attendanceStatus],['Monthly transactions',String(monthEvents.length)],['Unread notifications',String(unreadCount)]] as [string,string][]).map(([label,value])=><article key={label} className="rounded-2xl border bg-white p-4 shadow-sm"><p className="text-xs text-slate-500">{label}</p><p className="mt-2 text-xl font-bold">{value}</p></article>)}</section>
      <div className="grid gap-5 lg:grid-cols-[.8fr_1.2fr]"><section className="rounded-[28px] border bg-white p-5 shadow-sm"><div className="flex items-center gap-3"><ProfileAvatar path={profile.profile_photo_path} name={profile.full_name} size={56}/><div><h3 className="font-bold">{profile.full_name}</h3><p className="text-sm text-slate-500">{String(teacher?.designation??'Teacher')}</p><p className="text-xs text-slate-500">{profileEmail}</p></div></div><p className="mt-4 rounded-xl bg-slate-50 p-3 text-xs text-slate-600">Employment status: <b>{profile.is_active===false?'Inactive':'Active'}</b>.</p></section>
        <section className="rounded-[28px] border bg-white p-5 shadow-sm"><div className="flex items-center justify-between"><h3 className="font-bold">Today’s attendance</h3><button onClick={()=>navigate('/teacher/attendance')} className="text-sm font-semibold text-emerald-800 underline">History</button></div><div className="mt-3 grid gap-3 sm:grid-cols-3"><div className="rounded-xl bg-emerald-50 p-3"><p className="text-xs text-emerald-800">Time in</p><p className="mt-1 text-sm font-bold">{firstIn?formatPhilippineDateTime(String(firstIn.actual_scan_time)):'—'}</p></div><div className="rounded-xl bg-sky-50 p-3"><p className="text-xs text-sky-800">Time out</p><p className="mt-1 text-sm font-bold">{lastOut?formatPhilippineDateTime(String(lastOut.actual_scan_time)):'—'}</p></div><div className="rounded-xl bg-slate-50 p-3"><p className="text-xs text-slate-600">Status</p><p className="mt-1 text-sm font-bold">{attendanceStatus}</p></div></div><p className="mt-3 text-xs text-slate-500">Monthly: {monthEvents.filter(event=>['ENTRY','RETURN'].includes(String(event.event_type))).length} arrivals · {monthEvents.filter(event=>['EXIT','EARLY_OUT','TEMPORARY_EXIT'].includes(String(event.event_type))).length} departures · {monthEvents.filter(event=>event.verification_result==='LATE').length} late-marked events</p></section></div>
      <section className="rounded-[28px] border bg-white p-5 shadow-sm"><div className="flex items-center justify-between"><h3 className="font-bold">My QR code</h3><button onClick={()=>navigate('/teacher/qr')} className="text-sm font-semibold text-emerald-800 underline">Open QR page</button></div>{qrToken?<div className="mt-3 flex flex-wrap items-center gap-4"><QRCodeSVG value={qrToken} size={120} level="H" includeMargin aria-label={`Teacher attendance QR ${String(teacher?.teacher_id??'')}`} /><div><p className="font-semibold">{profile.full_name} · {String(teacher?.teacher_id??'')}</p><p className="text-xs text-slate-500">Secure gate attendance credential</p><button onClick={downloadQr} className="mt-2 inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-xs font-semibold"><Download size={14}/>Download QR</button></div></div>:<div className="mt-3 rounded-xl bg-slate-50 p-4 text-sm text-slate-600">QR credentials are not loaded automatically. Open My QR Code to generate one explicitly; it will replace any previous credential.</div>}</section>
      <div className="grid gap-5 lg:grid-cols-2"><section className="rounded-[28px] border bg-white p-5 shadow-sm"><h3 className="font-bold">Assigned advisory sections</h3>{sections.length?sections.map(section=><p key={String(section.id)} className="mt-2 rounded-xl bg-slate-50 p-3 text-sm">Grade {String(section.grade_level)} · {String(section.name)}</p>):<p className="mt-2 text-sm text-slate-500">No adviser sections are assigned to this account.</p>}<p className="mt-3 text-xs text-slate-500">Subject assignments and class schedules are not available in the current database.</p></section><section className="rounded-[28px] border bg-white p-5 shadow-sm"><div className="flex items-center justify-between"><h3 className="font-bold">Latest announcements</h3><button onClick={()=>navigate('/teacher/announcements')} className="text-sm font-semibold text-emerald-800 underline">View all</button></div><AnnouncementFeed items={visibleAnnouncements.slice(0,3)}/></section></div>
      <section className="rounded-[28px] border bg-white p-5 shadow-sm"><div className="flex items-center justify-between"><h3 className="font-bold">Recent notifications</h3><button onClick={()=>navigate('/teacher/notifications')} className="text-sm font-semibold text-emerald-800 underline">Open center</button></div>{notifications.slice(0,4).map(item=><p key={String(item.id)} className="border-b py-2 text-sm">{String(record(item.payload)?.message??titleCase(item.type))}<time className="block text-xs text-slate-500">{formatPhilippineDateTime(String(item.created_at))}</time></p>)}{!notifications.length&&<p className="mt-2 text-sm text-slate-500">No notifications have been recorded.</p>}</section>
    </>}
    {page === '/teacher/qr' && <section className="rounded-[28px] border bg-white p-5 text-center shadow-sm"><div className="mx-auto max-w-md"><p className="text-sm text-slate-500">Personal teacher attendance credential</p>{qrToken?<><div className="mt-4 inline-block rounded-2xl bg-white p-3"><QRCodeSVG ref={qrRef} value={qrToken} size={260} level="H" includeMargin aria-label={`Teacher attendance QR ${String(teacher?.teacher_id??'')}`} /></div><h3 className="mt-3 text-xl font-bold">{profile.full_name}</h3><p className="text-sm text-slate-500">Teacher ID: {String(teacher?.teacher_id??'—')}</p><p className="text-xs text-slate-500">Scan this code with the existing Security Guard scanner.</p><div className="mt-4 flex flex-wrap justify-center gap-2"><button onClick={downloadQr} className="inline-flex items-center gap-2 rounded-xl border px-4 py-2 font-semibold"><Download size={16}/>Download PNG</button><button onClick={()=>window.print()} className="inline-flex items-center gap-2 rounded-xl border px-4 py-2 font-semibold"><Printer size={16}/>Print</button></div></>:<div className="mt-5 rounded-2xl bg-slate-50 p-6"><QrCode className="mx-auto h-10 w-10 text-emerald-800"/><p className="mt-3 text-sm text-slate-600">A new secure QR credential is issued by the server and associated with your teacher account.</p><button disabled={qrBusy||!teacher||!navigator.onLine} onClick={()=>void generateQr()} className="mt-4 rounded-xl bg-emerald-800 px-5 py-3 font-semibold text-white disabled:opacity-50">{qrBusy?'Generating…':'Generate my QR code'}</button></div>}<p className="mt-4 text-xs text-slate-500">The credential is stored as a server-side hash. Save or print it now. Generating a replacement revokes the previous QR immediately.</p>{qrToken&&<button onClick={()=>void generateQr()} disabled={qrBusy||!navigator.onLine} className="mt-4 block w-full text-xs font-semibold text-rose-700 underline disabled:opacity-50">Replace compromised QR credential</button>}</div></section>}
    {page === '/teacher/attendance' && <section className="rounded-[28px] border bg-white p-5 shadow-sm"><div className="flex flex-wrap items-end justify-between gap-3"><div><h3 className="font-bold">Attendance history</h3><p className="text-sm text-slate-500">Only synchronized, server-verified gate transactions count as confirmed.</p></div><div className="flex flex-wrap gap-2"><select aria-label="Attendance range" value={range} onChange={event=>setRange(event.target.value)} className="rounded-xl border bg-white px-3 py-2 text-sm"><option value="daily">Today</option><option value="weekly">Last 7 days</option><option value="monthly">This month</option><option value="custom">Custom dates</option></select>{range==='custom'&&<><input aria-label="From date" type="date" value={from} onChange={event=>setFrom(event.target.value)} className="rounded-xl border px-2 py-2 text-sm"/><input aria-label="To date" type="date" value={to} onChange={event=>setTo(event.target.value)} className="rounded-xl border px-2 py-2 text-sm"/></>}</div></div><div className="mt-4 grid gap-2 sm:grid-cols-3"><p className="rounded-xl bg-slate-50 p-3 text-sm">Transactions: <b>{filteredEvents.length}</b></p><p className="rounded-xl bg-amber-50 p-3 text-sm">Late-marked: <b>{filteredEvents.filter(event=>event.verification_result==='LATE').length}</b></p><p className="rounded-xl bg-sky-50 p-3 text-sm">Early departures: <b>{filteredEvents.filter(event=>event.event_type==='EARLY_OUT').length}</b></p></div><div className="mt-4 overflow-x-auto"><table className="min-w-full text-left text-sm"><thead className="bg-slate-50 text-xs uppercase text-slate-500"><tr>{['Date','Time IN','Time OUT','Status','Indicators'].map(item=><th key={item} className="px-3 py-3">{item}</th>)}</tr></thead><tbody>{daySummaries.map(day=><tr key={day.date} className="border-t"><td className="px-3 py-3">{new Intl.DateTimeFormat('en-PH',{timeZone:'Asia/Manila',dateStyle:'medium'}).format(new Date(`${day.date}T12:00:00+08:00`))}</td><td className="px-3 py-3">{day.inEvent?formatPhilippineDateTime(String(day.inEvent.actual_scan_time)):'—'}</td><td className="px-3 py-3">{day.outEvent?formatPhilippineDateTime(String(day.outEvent.actual_scan_time)):'—'}</td><td className="px-3 py-3">{day.status}</td><td className="px-3 py-3">{day.late?'Late arrival · ':''}{day.earlyOut?'Early departure':''}{!day.late&&!day.earlyOut?'—':''}</td></tr>)}{!daySummaries.length&&<tr><td colSpan={5} className="px-3 py-8 text-center text-slate-500">No confirmed gate transactions in this period.</td></tr>}</tbody></table></div><h4 className="mt-6 font-semibold">Gate event history</h4><div className="mt-2 overflow-x-auto"><table className="min-w-full text-left text-sm"><thead className="bg-slate-50 text-xs uppercase text-slate-500"><tr>{['Time','Transaction','Sync status','Verification'].map(item=><th key={item} className="px-3 py-3">{item}</th>)}</tr></thead><tbody>{filteredEvents.map(event=><tr key={String(event.id)} className="border-t"><td className="px-3 py-3">{formatPhilippineDateTime(String(event.actual_scan_time))}</td><td className="px-3 py-3 font-semibold">{titleCase(event.event_type)}</td><td className="px-3 py-3">{titleCase(event.sync_status)}</td><td className="px-3 py-3">{titleCase(event.verification_result)}</td></tr>)}{!filteredEvents.length&&<tr><td colSpan={4} className="px-3 py-4 text-center text-slate-500">No event details to display.</td></tr>}</tbody></table></div></section>}
    {page === '/teacher/profile' && <section className="rounded-[28px] border bg-white p-5 shadow-sm"><div className="flex items-center gap-3"><ProfileAvatar path={profile.profile_photo_path} name={profile.full_name} size={56}/><div><h3 className="font-bold">{profile.full_name}</h3><p className="text-xs text-slate-500">Profile photo can be changed from the account menu.</p></div></div><form onSubmit={event=>void saveProfile(event)} className="mt-5 grid gap-3 sm:grid-cols-2"><label className="text-sm font-semibold">Full name<input readOnly value={profile.full_name} className="mt-1 w-full rounded-xl border bg-slate-50 p-3"/></label><label className="text-sm font-semibold">Teacher ID<input readOnly value={String(teacher?.teacher_id??'')} className="mt-1 w-full rounded-xl border bg-slate-50 p-3"/></label><label className="text-sm font-semibold">Email<input readOnly value={profileEmail} className="mt-1 w-full rounded-xl border bg-slate-50 p-3"/></label><label className="text-sm font-semibold">Contact number<input type="tel" maxLength={40} value={phone} onChange={event=>setPhone(event.target.value)} className="mt-1 w-full rounded-xl border p-3"/></label><label className="text-sm font-semibold">Designation / specialization<input readOnly value={String(teacher?.designation??'Not recorded')} className="mt-1 w-full rounded-xl border bg-slate-50 p-3"/></label><label className="text-sm font-semibold">Employment status<input readOnly value={profile.is_active===false?'Inactive':'Active'} className="mt-1 w-full rounded-xl border bg-slate-50 p-3"/></label><div className="sm:col-span-2"><p className="text-xs text-slate-500">Assigned advisory sections: {sections.length?sections.map(section=>`Grade ${String(section.grade_level)} ${String(section.name)}`).join(', '):'None recorded'}. Department, photo, subject assignments, and schedules are not represented in the existing teacher schema.</p><button disabled={busy} className="mt-3 rounded-xl bg-emerald-800 px-4 py-2.5 font-semibold text-white disabled:opacity-50">{busy?'Saving…':'Save contact number'}</button></div></form></section>}
    {page === '/teacher/announcements' && <section className="rounded-[28px] border bg-white p-5 shadow-sm"><div className="mb-4 flex items-center justify-between"><div><h3 className="font-bold">School announcements</h3><p className="text-sm text-slate-500">Published announcements for teachers and the whole school</p></div><span className="rounded-full bg-slate-100 px-3 py-1 text-xs">{visibleAnnouncements.filter(item=>!reads.has(String(item.id))).length} unread</span></div><div className="space-y-4">{visibleAnnouncements.map(item=><article key={String(item.id)} className="rounded-2xl border p-4"><div className="flex flex-wrap items-center justify-between gap-2"><h4 className="font-bold">{String(item.title)}</h4><span className="rounded-full bg-amber-50 px-2 py-1 text-[10px] font-bold uppercase">{titleCase(item.priority)}</span></div><p className="mt-1 text-xs text-slate-500">{titleCase(item.category)} · Published {formatPhilippineDateTime(String(item.published_at))}</p><AnnouncementFeed items={[item]}/>{!reads.has(String(item.id))&&<button onClick={()=>void markAnnouncementRead(String(item.id))} className="mt-2 text-xs font-semibold text-emerald-800 underline">Mark as read</button>}</article>)}{!visibleAnnouncements.length&&<p className="rounded-xl bg-slate-50 p-6 text-center text-sm text-slate-500">No current teacher announcements.</p>}</div></section>}
    {page === '/teacher/notifications' && <><section className="rounded-[28px] border bg-white p-5 shadow-sm"><h3 className="font-bold">Notification preferences</h3><p className="mt-1 text-sm text-slate-500">These settings control in-app alerts. The global Enable push control manages this device’s browser notifications.</p><div className="mt-4 grid gap-3 sm:grid-cols-2">{([{key:'attendance_enabled',label:'Attendance recorded'},{key:'announcement_enabled',label:'School announcements'}] as const).map(({key,label})=><label key={key} className="flex items-center justify-between rounded-xl border p-3 text-sm"><span>{label}</span><input type="checkbox" checked={preferences[key]} onChange={event=>void savePreference(key,event.target.checked)} aria-label={`${label} notifications`} className="h-4 w-4 accent-emerald-700"/></label>)}</div></section><section className="rounded-[28px] border bg-white p-5 shadow-sm"><div className="mb-4 flex items-center justify-between"><div><h3 className="font-bold">Notification center</h3><p className="text-sm text-slate-500">Live attendance, announcement, and school updates</p></div><div className="flex items-center gap-2"><span className="rounded-full bg-emerald-100 px-3 py-1 text-xs font-bold">{unreadCount} unread</span>{unreadCount>0&&<button onClick={()=>void markAllRead()} className="text-xs font-semibold underline">Mark all read</button>}</div></div><div className="space-y-2">{notifications.map(item=><article key={String(item.id)} className={`rounded-xl border p-3 ${item.is_read?'':'border-emerald-200 bg-emerald-50'}`}><div className="flex items-start justify-between gap-3"><div><h4 className="font-semibold">{titleCase(item.type)}</h4><p className="mt-1 text-sm text-slate-600">{String(record(item.payload)?.message??'School account update')}</p><time className="mt-1 block text-xs text-slate-500">{formatPhilippineDateTime(String(item.created_at))}</time></div>{!item.is_read&&<button onClick={()=>void markNotificationRead(String(item.id))} className="text-xs font-semibold text-emerald-800 underline">Mark read</button>}</div></article>)}{!notifications.length&&<p className="rounded-xl bg-slate-50 p-6 text-center text-sm text-slate-500">No notifications recorded for this account.</p>}</div></section></>}
  </div>
}

