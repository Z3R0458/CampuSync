import { useCallback, useEffect, useMemo, useState } from 'react'
import { Monitor, Smartphone, Tablet, Shield, ShieldAlert, RefreshCw, LogOut, MapPin, Laptop } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { friendlyError } from '../components/UserFeedback'

type Profile = { id: string; full_name: string; role: string }
type Device = {
  id: string; device_identifier: string; device_name: string; device_type: string; operating_system: string
  browser: string; browser_version: string | null; first_seen_at: string; last_seen_at: string; is_recognized: boolean
}
type Login = {
  id: string; profile_id: string; device_id: string | null; session_id: string; ip_address: string | null
  approximate_location: string | null; login_at: string; logout_at: string | null; last_activity_at: string
  login_status: string; is_new_device: boolean; email_delivery_status: string | null
  email_delivery_attempts: number
}
type SessionRow = { session_id: string; verified_at: string; expires_at: string; revoked_at: string | null }
type AuthEvent = { id: string; event_type: string; auth_user_id: string | null; details: Record<string, unknown>; created_at: string }

const dateTime = (value: string | null | undefined) => value
  ? new Intl.DateTimeFormat('en-PH', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Manila' }).format(new Date(value)) + ' PHT'
  : 'Not available'
const shortIp = (value: string | null) => value || 'Not available'

function DeviceIcon({ type }: { type: string }) {
  const Icon = type === 'Mobile' ? Smartphone : type === 'Tablet' ? Tablet : type === 'Laptop' ? Laptop : Monitor
  return <Icon className="h-5 w-5" aria-hidden="true" />
}

export function SecurityLoginActivity({ profile }: { profile: Profile }) {
  const [devices, setDevices] = useState<Device[]>([])
  const [logins, setLogins] = useState<Login[]>([])
  const [sessions, setSessions] = useState<SessionRow[]>([])
  const [alerts, setAlerts] = useState<Array<{ id: string; payload: Record<string, unknown>; created_at: string; is_read: boolean }>>([])
  const [currentSessionId, setCurrentSessionId] = useState('')
  const [currentDeviceIdentifier, setCurrentDeviceIdentifier] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')

  const refresh = useCallback(async () => {
    if (!supabase) return
    setLoading(true)
    setError('')
    const [{ data: auth }, devicesResult, loginResult, sessionsResult, alertsResult] = await Promise.all([
      supabase.auth.getSession(),
      supabase.from('user_devices').select('id,device_identifier,device_name,device_type,operating_system,browser,browser_version,first_seen_at,last_seen_at,is_recognized').order('last_seen_at', { ascending: false }).limit(100),
      supabase.from('login_activity').select('id,profile_id,device_id,session_id,ip_address,approximate_location,login_at,logout_at,last_activity_at,login_status,is_new_device,email_delivery_status,email_delivery_attempts').order('login_at', { ascending: false }).limit(100),
      supabase.from('login_otp_verified_sessions').select('session_id,verified_at,expires_at,revoked_at').order('verified_at', { ascending: false }).limit(100),
      supabase.from('notifications').select('id,payload,created_at,is_read').eq('type', 'security_new_device').order('created_at', { ascending: false }).limit(20),
    ])
    const userId = auth.session?.user.id
    const tokenPart = auth.session?.access_token.split('.')[1]
    try {
      const claims = tokenPart ? JSON.parse(atob(tokenPart.replaceAll('-', '+').replaceAll('_', '/'))) as { session_id?: string } : {}
      setCurrentSessionId(claims.session_id ?? '')
    } catch { setCurrentSessionId('') }
    try { setCurrentDeviceIdentifier(localStorage.getItem('campusync:device-id') ?? '') } catch { setCurrentDeviceIdentifier('') }
    const errors = [devicesResult.error, loginResult.error, sessionsResult.error, alertsResult.error].filter(Boolean)
    if (errors.length) setError(friendlyError(errors[0]))
    setDevices(devicesResult.data ?? [])
    setLogins(loginResult.data ?? [])
    setSessions(sessionsResult.data ?? [])
    setAlerts((alertsResult.data ?? []) as typeof alerts)
    if (!userId) setError('Your login session is unavailable. Sign in again to manage account security.')
    setLoading(false)
  }, [])

  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => {
    const client = supabase
    if (!client) return
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void client.rpc('touch_my_login_activity')
    }, 5 * 60_000)
    return () => window.clearInterval(timer)
  }, [])

  const deviceById = useMemo(() => new Map(devices.map(device => [device.id, device])), [devices])
  const currentDevice = devices.find(device => device.device_identifier === currentDeviceIdentifier)
  const activeSessions = sessions.filter(session => !session.revoked_at && Date.parse(session.expires_at) > Date.now())

  const revoke = async (sessionId: string) => {
    if (!supabase || !window.confirm('Sign out this other session? It will lose access to CampuSync data.')) return
    setBusy(sessionId); setError(''); setMessage('')
    const { data, error: revokeError } = await supabase.rpc('revoke_login_session', { p_session_id: sessionId })
    if (revokeError) setError(friendlyError(revokeError))
    else if (!data) setError('That session could not be revoked. Refresh the list and try again.')
    else { setMessage('The session was revoked.'); await refresh() }
    setBusy('')
  }
  const revokeOthers = async () => {
    if (!supabase || !window.confirm('Sign out all other devices? Your current device will stay signed in.')) return
    setBusy('all'); setError(''); setMessage('')
    const { data, error: revokeError } = await supabase.rpc('revoke_other_login_sessions')
    if (revokeError) setError(friendlyError(revokeError))
    else {
      // The registry blocks application access immediately; Supabase also
      // removes this browser's cached refresh sessions where supported.
      await supabase.auth.signOut({ scope: 'others' })
      setMessage(`${Number(data ?? 0)} other session(s) were revoked.`)
      await refresh()
    }
    setBusy('')
  }
  const setRecognized = async (device: Device) => {
    if (!supabase) return
    const value = !device.is_recognized
    if (!window.confirm(value ? 'Recognize this device for future sign-ins?' : 'Forget this device? Its next sign-in will be treated as new.')) return
    setBusy(device.id); setError(''); setMessage('')
    const { error: updateError } = await supabase.from('user_devices').update({ is_recognized: value }).eq('id', device.id)
    if (updateError) setError(friendlyError(updateError))
    else { setMessage(value ? 'Device recognized.' : 'Device forgotten.'); await refresh() }
    setBusy('')
  }

  return <div className="space-y-5">
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-emerald-100 bg-emerald-50 p-4 text-sm text-emerald-950">
      <p><b>Privacy-minded device recognition.</b> CampuSync stores a random browser ID; it does not fingerprint hardware. Location is shown only when a trusted location source is configured.</p>
      <button onClick={() => void refresh()} disabled={loading} className="inline-flex items-center gap-2 rounded-xl border border-emerald-200 bg-white px-3 py-2 font-semibold disabled:opacity-50"><RefreshCw className="h-4 w-4"/> Refresh</button>
    </div>
    {error && <p role="alert" className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</p>}
    {message && <p role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">{message}</p>}
    <section className="rounded-2xl border bg-white p-5 shadow-sm">
      <div className="flex items-center gap-3"><span className="rounded-xl bg-emerald-50 p-2 text-emerald-800"><Shield className="h-5 w-5"/></span><div><h2 className="font-bold">Current device</h2><p className="text-sm text-slate-500">{profile.full_name} · {profile.role}</p></div></div>
      {loading ? <p className="mt-4 text-sm text-slate-500">Loading device information…</p> : currentDevice ? <div className="mt-4 grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
        <p className="flex items-center gap-2"><DeviceIcon type={currentDevice.device_type}/><b>{currentDevice.device_name}</b><span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs text-emerald-800">Current</span></p>
        <p>First seen: {dateTime(currentDevice.first_seen_at)}</p><p>Last seen: {dateTime(currentDevice.last_seen_at)}</p>
        <p>Location: not available</p><p>Browser ID: {currentDevice.is_recognized ? 'Recognized' : 'Not recognized'}</p><p>Session: {activeSessions.some(session => session.session_id === currentSessionId) ? 'Active' : 'Not listed'}</p>
      </div> : <p className="mt-4 text-sm text-slate-500">This device has not been recorded yet. It will appear after your next successful sign-in.</p>}
    </section>
    <section className="rounded-2xl border bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="font-bold">Active sessions</h2><p className="text-sm text-slate-500">Revoking a session blocks it from accessing CampuSync data.</p></div><button onClick={() => void revokeOthers()} disabled={busy !== '' || activeSessions.length < 2} className="rounded-xl border px-3 py-2 text-sm font-semibold disabled:opacity-50">{busy === 'all' ? 'Signing out…' : 'Sign out all other sessions'}</button></div>
      {loading ? <p className="mt-4 text-sm text-slate-500">Loading sessions…</p> : activeSessions.length ? <div className="mt-4 space-y-3">{activeSessions.map(session => {
        const row = logins.find(login => login.session_id === session.session_id)
        const device = row?.device_id ? deviceById.get(row.device_id) : undefined
        const current = session.session_id === currentSessionId
        return <article key={session.session_id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border p-4">
          <div className="min-w-0"><p className="flex items-center gap-2 font-semibold"><DeviceIcon type={device?.device_type ?? 'Unknown'}/>{device?.device_name ?? 'Device details not recorded'}{current && <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs text-emerald-800">This device</span>}</p><p className="mt-1 text-sm text-slate-500">Signed in {dateTime(row?.login_at ?? session.verified_at)} · Last activity {dateTime(row?.last_activity_at ?? session.verified_at)}</p><p className="mt-1 text-xs text-slate-500">IP: {shortIp(row?.ip_address ?? null)} · Location: {row?.approximate_location ?? 'Not available'}</p></div>
          {!current && <button onClick={() => void revoke(session.session_id)} disabled={busy !== ''} className="inline-flex items-center gap-2 rounded-xl border border-red-200 px-3 py-2 text-sm font-semibold text-red-800 disabled:opacity-50"><LogOut className="h-4 w-4"/>{busy === session.session_id ? 'Revoking…' : 'Sign out'}</button>}
        </article>
      })}</div> : <p className="mt-4 text-sm text-slate-500">No active sessions were returned.</p>}
    </section>
    <section className="rounded-2xl border bg-white p-5 shadow-sm"><div className="flex items-center gap-2"><ShieldAlert className="h-5 w-5 text-emerald-800"/><div><h2 className="font-bold">Recent login activity</h2><p className="text-sm text-slate-500">Times are shown in Asia/Manila.</p></div></div>
      {loading ? <p className="mt-4 text-sm text-slate-500">Loading activity…</p> : logins.length ? <div className="mt-4 divide-y">{logins.map(login => { const device = login.device_id ? deviceById.get(login.device_id) : undefined; return <article key={login.id} className="grid gap-2 py-4 text-sm md:grid-cols-[1fr_auto]"><div><p className="flex items-center gap-2 font-semibold"><DeviceIcon type={device?.device_type ?? 'Unknown'}/>{device?.device_name ?? 'Unknown device'}{login.is_new_device && <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-900">New device</span>}</p><p className="mt-1 text-slate-600">{device?.browser ?? 'Browser unavailable'} {device?.browser_version ?? ''} · {device?.operating_system ?? 'System unavailable'}</p><p className="mt-1 flex items-center gap-1 text-xs text-slate-500"><MapPin className="h-3.5 w-3.5"/>{login.approximate_location ?? 'Location not available'} · IP {shortIp(login.ip_address)}</p></div><div className="text-xs text-slate-600 md:text-right"><p>{dateTime(login.login_at)}</p><p className="mt-1">{login.session_id === currentSessionId ? 'Current session' : login.login_status.replaceAll('_',' ')}</p>{login.is_new_device && <p className="mt-1">Email alert: {login.email_delivery_status ?? 'Pending'}</p>}</div></article> })}</div> : <p className="mt-4 text-sm text-slate-500">No login records are available yet.</p>}
    </section>
    <section className="rounded-2xl border bg-white p-5 shadow-sm"><h2 className="font-bold">Recognized devices</h2><p className="mt-1 text-sm text-slate-500">Forget a device to make its next sign-in count as a new device.</p>
      {devices.length ? <div className="mt-3 divide-y">{devices.map(device => <div key={device.id} className="flex flex-wrap items-center justify-between gap-3 py-3"><div><p className="flex items-center gap-2 text-sm font-semibold"><DeviceIcon type={device.device_type}/>{device.device_name}{device.device_identifier === currentDeviceIdentifier && <span className="text-xs text-emerald-800">This browser</span>}</p><p className="mt-1 text-xs text-slate-500">First seen {dateTime(device.first_seen_at)} · Last seen {dateTime(device.last_seen_at)}</p></div><button onClick={() => void setRecognized(device)} disabled={busy !== ''} className="rounded-lg border px-3 py-1.5 text-xs font-semibold disabled:opacity-50">{device.is_recognized ? 'Forget device' : 'Recognize device'}</button></div>)}</div> : <p className="mt-3 text-sm text-slate-500">No recognized devices yet.</p>}
    </section>
    <section className="rounded-2xl border bg-white p-5 shadow-sm"><h2 className="font-bold">Security alerts</h2>{alerts.length ? <div className="mt-3 divide-y">{alerts.map(alert => <div key={alert.id} className="py-3"><p className="font-semibold">{String(alert.payload.title ?? 'Account security alert')}</p><p className="mt-1 text-sm text-slate-600">{String(alert.payload.message ?? 'Review recent account activity.')}</p><p className="mt-1 text-xs text-slate-500">{dateTime(alert.created_at)}</p></div>)}</div> : <p className="mt-2 text-sm text-slate-500">No security alerts are available.</p>}</section>
  </div>
}

export function AdminLoginMonitoring() {
  const [rows, setRows] = useState<Login[]>([])
  const [profiles, setProfiles] = useState<Map<string, { full_name: string; email: string; role: string }>>(new Map())
  const [devices, setDevices] = useState<Map<string, Device>>(new Map())
  const [events, setEvents] = useState<AuthEvent[]>([])
  const [search, setSearch] = useState('')
  const [roleFilter, setRoleFilter] = useState('all')
  const [deviceFilter, setDeviceFilter] = useState('all')
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const refresh = useCallback(async () => {
    if (!supabase) return
    setLoading(true); setError('')
    const [loginResult, eventResult] = await Promise.all([
      supabase.from('login_activity').select('id,profile_id,device_id,session_id,ip_address,approximate_location,login_at,logout_at,last_activity_at,login_status,is_new_device,email_delivery_status,email_delivery_attempts').order('login_at', { ascending: false }).limit(500),
      supabase.from('login_auth_events').select('id,event_type,auth_user_id,details,created_at').in('event_type', ['failed_login','account_access_denied','otp_verification_failure','otp_expiration']).order('created_at', { ascending: false }).limit(100),
    ])
    const activityRows = loginResult.data ?? []
    const profileIds = [...new Set(activityRows.map(row => row.profile_id))]
    const deviceIds = [...new Set(activityRows.map(row => row.device_id).filter(Boolean))] as string[]
    const [profileResult, deviceResult] = await Promise.all([
      profileIds.length ? supabase.from('profiles').select('id,auth_user_id,full_name,email,role').in('id', profileIds) : Promise.resolve({ data: [], error: null }),
      deviceIds.length ? supabase.from('user_devices').select('id,device_identifier,device_name,device_type,operating_system,browser,browser_version,first_seen_at,last_seen_at,is_recognized').in('id', deviceIds) : Promise.resolve({ data: [], error: null }),
    ])
    if (loginResult.error || eventResult.error || profileResult.error || deviceResult.error) setError(friendlyError(loginResult.error ?? eventResult.error ?? profileResult.error ?? deviceResult.error))
    setRows(activityRows)
    setProfiles(new Map((profileResult.data ?? []).flatMap(item => [[item.id, item], [item.auth_user_id, item]])))
    setDevices(new Map((deviceResult.data ?? []).map(item => [item.id, item])))
    setEvents((eventResult.data ?? []) as AuthEvent[])
    setLoading(false)
  }, [])

  useEffect(() => { void refresh() }, [refresh])
  const filtered = useMemo(() => rows.filter(row => {
    const profile = profiles.get(row.profile_id)
    const device = row.device_id ? devices.get(row.device_id) : undefined
    const query = search.trim().toLowerCase()
    if (query && !`${profile?.full_name ?? ''} ${profile?.email ?? ''} ${profile?.role ?? ''}`.toLowerCase().includes(query)) return false
    if (roleFilter !== 'all' && profile?.role !== roleFilter) return false
    if (deviceFilter !== 'all' && device?.device_type !== deviceFilter) return false
    if (fromDate && row.login_at.slice(0,10) < fromDate) return false
    if (toDate && row.login_at.slice(0,10) > toDate) return false
    return true
  }), [rows,profiles,devices,search,roleFilter,deviceFilter,fromDate,toDate])

  return <div className="space-y-5">
    <div className="flex flex-wrap items-center justify-between gap-3"><p className="text-sm text-slate-600">Successful logins and available failed-authentication events. Location is shown only when collected from a trusted source.</p><button onClick={() => void refresh()} disabled={loading} className="inline-flex items-center gap-2 rounded-xl border bg-white px-3 py-2 text-sm font-semibold disabled:opacity-50"><RefreshCw className="h-4 w-4"/>Refresh</button></div>
    {error && <p role="alert" className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</p>}
    <section className="grid gap-3 rounded-2xl border bg-white p-4 sm:grid-cols-2 lg:grid-cols-3"><input value={search} onChange={event=>setSearch(event.target.value)} placeholder="Search name, email, role" className="rounded-xl border px-3 py-2 text-sm"/><select value={roleFilter} onChange={event=>setRoleFilter(event.target.value)} className="rounded-xl border bg-white px-3 py-2 text-sm"><option value="all">All roles</option>{['administrator','guard','student','teacher','parent'].map(role=><option key={role} value={role}>{role}</option>)}</select><select value={deviceFilter} onChange={event=>setDeviceFilter(event.target.value)} className="rounded-xl border bg-white px-3 py-2 text-sm"><option value="all">All device types</option>{['Desktop','Laptop','Tablet','Mobile','Unknown'].map(type=><option key={type}>{type}</option>)}</select><label className="text-xs text-slate-500">From<input type="date" value={fromDate} onChange={event=>setFromDate(event.target.value)} className="mt-1 block w-full rounded-xl border px-3 py-2 text-sm text-slate-800"/></label><label className="text-xs text-slate-500">To<input type="date" value={toDate} onChange={event=>setToDate(event.target.value)} className="mt-1 block w-full rounded-xl border px-3 py-2 text-sm text-slate-800"/></label><p className="self-end pb-2 text-sm text-slate-600">{filtered.length} login records</p></section>
    <section className="overflow-hidden rounded-2xl border bg-white shadow-sm"><div className="border-b p-4"><h2 className="font-bold">Login activity</h2></div>{loading ? <p className="p-5 text-sm text-slate-500">Loading activity…</p> : filtered.length ? <div className="divide-y">{filtered.map(row=>{const profile=profiles.get(row.profile_id);const device=row.device_id?devices.get(row.device_id):undefined;return <article key={row.id} className="grid gap-2 p-4 md:grid-cols-[minmax(12rem,1fr)_minmax(13rem,1.1fr)_minmax(12rem,1fr)]"><div><p className="font-semibold">{profile?.full_name??'Profile unavailable'}</p><p className="text-sm text-slate-600">{profile?.email??'Email unavailable'} · {profile?.role??'Role unavailable'}</p></div><div className="text-sm"><p className="font-semibold">{device?.device_name??'Device details unavailable'}</p><p className="text-slate-600">{device?.browser??'Unknown browser'} {device?.browser_version??''} · {device?.operating_system??'Unknown system'}</p><p className="text-xs text-slate-500">{device?.device_type??'Unknown device type'}</p></div><div className="text-sm md:text-right"><p>{dateTime(row.login_at)}</p><p className="text-xs text-slate-600">{row.login_status.replaceAll('_',' ')}{row.is_new_device?' · New device':''}</p><p className="text-xs text-slate-500">IP {shortIp(row.ip_address)} · {row.approximate_location??'Location not available'}</p></div></article>})}</div>:<p className="p-5 text-sm text-slate-500">No login records match those filters.</p>}</section>
    <section className="rounded-2xl border bg-white p-5 shadow-sm"><h2 className="font-bold">Failed sign-in and verification events</h2><p className="mt-1 text-sm text-slate-500">Failed events are shown with available account references; CampuSync never stores passwords or email codes in this history.</p>{events.length?<div className="mt-3 divide-y">{events.map(event=>{const profile=[...profiles.entries()].find(([id])=>id===event.auth_user_id)?.[1];return <div key={event.id} className="flex flex-wrap justify-between gap-2 py-3 text-sm"><span><b>{event.event_type.replaceAll('_',' ')}</b>{profile?` · ${profile.full_name} (${profile.role})`:''}</span><span className="text-slate-500">{dateTime(event.created_at)}</span></div>})}</div>:<p className="mt-3 text-sm text-slate-500">No failed sign-in events are available.</p>}</section>
  </div>
}
