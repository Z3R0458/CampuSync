import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { friendlyError } from '../components/UserFeedback'

type Row = Record<string, unknown>
const types = [
  { key: 'early_out', label: 'Early out', table: 'early_out_requests', date: 'requested_departure', detail: 'reason' },
  { key: 'visitor', label: 'Visitor', table: 'visitor_requests', date: 'visit_date', detail: 'purpose' },
  { key: 'absence', label: 'Absence', table: 'absence_notices', date: 'absence_date', detail: 'reason' },
  { key: 'attendance_correction', label: 'Attendance correction', table: 'attendance_correction_requests', date: 'attendance_date', detail: 'reason' },
  { key: 'walkin_visitor', label: 'Walk-in visitor', table: 'visitor_logs', date: 'requested_at', detail: 'purpose' },
] as const
type Request = Row & { request_type: string; student_name: string; student_number: string; grade_level: string; section_name: string }
const label = (v: unknown) => String(v ?? '—').replaceAll('_', ' ').replace(/\b\w/g, c => c.toUpperCase())
const date = (v: unknown) => v ? new Intl.DateTimeFormat('en-PH', { timeZone: 'Asia/Manila', dateStyle: 'medium' }).format(new Date(String(v))) : '—'
const time = (v: unknown) => v ? new Intl.DateTimeFormat('en-PH', { timeZone: 'Asia/Manila', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(String(v))) : '—'
const studentJoin = 'students(student_id,grade_level,profiles(full_name),sections(name))'
const defaultEarlyOutWindow = (row: Request) => {
  const requested = new Date(String(row.requested_departure))
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit' }).format(requested)
  const start = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Manila', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(requested)
  const [hour, minute] = start.split(':').map(Number)
  const endMinutes = Math.min(23 * 60 + 59, hour * 60 + minute + 30)
  return { date, start, end: `${String(Math.floor(endMinutes / 60)).padStart(2, '0')}:${String(endMinutes % 60).padStart(2, '0')}` }
}

export function StudentRequestReview({ role, profileId }: { role: 'administrator' | 'teacher'; profileId?: string }) {
  const [rows, setRows] = useState<Request[]>([])
  const [history, setHistory] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [status, setStatus] = useState('PENDING')
  const [type, setType] = useState('all')
  const [query, setQuery] = useState('')
  const [remarks, setRemarks] = useState<Record<string, string>>({})
  const [earlyOutWindows, setEarlyOutWindows] = useState<Record<string, { date: string; start: string; end: string }>>({})
  const [selected, setSelected] = useState<Request | null>(null)
  const [notifications,setNotifications]=useState<Row[]>([])

  const refresh = useCallback(async () => {
    if (!supabase) return
    const client = supabase
    setLoading(true); setError('')
    const results = await Promise.all(types.filter(t => role === 'administrator' || t.key !== 'walkin_visitor').map(async t => {
      const result = await client.from(t.table).select(`*,${studentJoin}`).order(t.key === 'walkin_visitor' ? 'requested_at' : 'created_at', { ascending: false }).limit(500)
      return { key: t.key, result }
    }))
    const failed = results.find(x => x.result.error)
    if (failed?.result.error) setError(friendlyError(failed.result.error))
    const next: Request[] = results.flatMap(({ key, result }) => (result.data ?? []).filter((r: Row) => key !== 'walkin_visitor' || Boolean(r.requester_guard_id)).map((r: Row) => {
      const student = Array.isArray(r.students) ? r.students[0] : r.students
      const p = student && typeof student === 'object' ? (student as Row).profiles : null
      const profile = Array.isArray(p) ? p[0] : p
      const section = student && typeof student === 'object' ? (student as Row).sections : null
      const sec = Array.isArray(section) ? section[0] : section
      return { ...r, created_at: r.created_at ?? r.requested_at, status: key === 'walkin_visitor' ? (r.authorization_status === 'DENIED' ? 'REJECTED' : r.authorization_status) : r.status, request_type: key, student_name: String((profile as Row | null)?.full_name ?? (key === 'walkin_visitor' ? 'Walk-in visitor' : 'Student')), student_number: String((student as Row | null)?.student_id ?? '—'), grade_level: String((student as Row | null)?.grade_level ?? '—'), section_name: String((sec as Row | null)?.name ?? 'Unassigned') }
    }))
    next.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    setRows(next)
    setLoading(false)
  }, [role])

  useEffect(() => {
    void refresh()
    if(role!=='administrator'||!profileId||!supabase)return
    const client=supabase
    const loadNotifications=()=>void client.from('notifications').select('id,type,payload,is_read,created_at').eq('recipient_id',profileId).order('created_at',{ascending:false}).limit(10).then(({data})=>setNotifications(data??[]))
    loadNotifications()
    const channel=client.channel(`admin-student-requests-${profileId}`).on('postgres_changes',{event:'*',schema:'public',table:'notifications',filter:`recipient_id=eq.${profileId}`},loadNotifications).on('postgres_changes',{event:'*',schema:'public',table:'visitor_logs'},()=>void refresh()).subscribe()
    return()=>{void client.removeChannel(channel)}
  }, [refresh,role,profileId])
  useEffect(() => {
    if (!supabase || !selected) { setHistory([]); return }
    if (selected.request_type === 'walkin_visitor') {
      const timeline: Row[] = [{ id: `${selected.id}-submitted`, old_status: null, new_status: 'PENDING', remarks: null, changed_at: selected.requested_at ?? selected.created_at, changed_by: selected.requester_guard_id }]
      if (selected.decision_at) timeline.push({ id: `${selected.id}-decision`, old_status: 'PENDING', new_status: selected.authorization_status === 'DENIED' ? 'REJECTED' : selected.authorization_status, remarks: selected.decision_remarks, changed_at: selected.decision_at, changed_by: selected.decision_by })
      setHistory(timeline); return
    }
    const client = supabase
    let live = true
    void client.from('student_request_history').select('id,old_status,new_status,remarks,changed_at,changed_by')
      .eq('request_id', String(selected.id)).eq('request_type', selected.request_type).order('changed_at')
      .then(({ data, error: historyError }) => { if (!live) return; setHistory(data ?? []); if (historyError) setError(friendlyError(historyError)) })
    return () => { live = false }
  }, [selected])

  const filtered = useMemo(() => rows.filter(r => (status === 'all' || r.status === status) && (type === 'all' || r.request_type === type) && `${r.student_name} ${r.student_number} ${r.reason ?? ''} ${r.purpose ?? ''} ${r.visitor_name ?? ''}`.toLowerCase().includes(query.toLowerCase())), [rows, status, type, query])
  const review = async (row: Request, next: string) => {
    if (!supabase) return
    const key = `${row.request_type}:${row.id}`
    setBusy(key); setError(''); setNotice('')
    if (row.request_type === 'early_out' && role !== 'administrator') { setError('Only an administrator may decide early-out requests.'); setBusy(''); return }
    if (row.request_type === 'early_out' && next === 'UNDER_REVIEW' && !remarks[key]?.trim()) { setError('Enter the additional information needed before requesting it.'); setBusy(''); return }
    const window = earlyOutWindows[key] ?? defaultEarlyOutWindow(row)
    const { error: reviewError } = row.request_type === 'walkin_visitor'
      ? await supabase.rpc('review_walkin_visitor', { p_log_id: row.id, p_status: next === 'REJECTED' ? 'DENIED' : next, p_remarks: remarks[key] || null })
      : row.request_type === 'early_out'
        ? await supabase.rpc('review_early_out_request', { p_request_id: row.id, p_status: next, p_remarks: remarks[key] || null, p_approved_date: next === 'APPROVED' ? window.date : null, p_approved_start: next === 'APPROVED' ? window.start : null, p_approved_end: next === 'APPROVED' ? window.end : null })
        : await supabase.rpc('review_student_request', { p_request_type: row.request_type, p_request_id: row.id, p_status: next, p_remarks: remarks[key] || null })
    if (reviewError) setError(friendlyError(reviewError))
    else { setNotice(`Request ${next.toLowerCase().replace('_', ' ')}.`); void supabase.functions.invoke('dispatch-push', { body: { request_id: row.id } }); await refresh(); if (selected?.id === row.id) setSelected({ ...row, status: next, reviewer_remarks: remarks[key] || null }) }
    setBusy('')
  }
  const markNotificationRead=async(id:string)=>{if(!supabase||!profileId)return;const {error:markError}=await supabase.from('notifications').update({is_read:true}).eq('id',id).eq('recipient_id',profileId);if(markError)setError(friendlyError(markError));else setNotifications(current=>current.map(n=>n.id===id?{...n,is_read:true}:n))}

  return <div className="space-y-5">
    <header><p className="text-xs font-bold uppercase tracking-[.2em] text-emerald-800">Student Services</p><h1 className="mt-1 text-2xl font-bold">Student request review</h1><p className="mt-1 text-sm text-slate-500">{role === 'teacher' ? 'Requests for students assigned to your advisory section.' : 'Review student service requests and see their status history.'}</p></header>
    {error && <p role="alert" className="rounded-xl bg-rose-50 p-3 text-sm text-rose-800">{error}</p>}{notice && <p role="status" className="rounded-xl bg-emerald-50 p-3 text-sm text-emerald-900">{notice}</p>}
    {role==='administrator'&&<section className="rounded-2xl border bg-white p-4 shadow-sm"><div className="mb-3 flex items-center justify-between"><h2 className="font-bold">Live notifications</h2><span className="rounded-full bg-emerald-100 px-2 py-1 text-xs font-bold">{notifications.filter(n=>!n.is_read).length} unread</span></div><div className="space-y-2">{notifications.slice(0,4).map(n=><div key={String(n.id)} className={`flex items-center justify-between gap-3 rounded-xl border p-3 ${n.is_read?'':'bg-emerald-50'}`}><span><b className="text-sm">{label(n.type)}</b><span className="block text-xs text-slate-500">{String((n.payload as Row)?.message??(n.payload as Row)?.visitor_name??'School operations update')} · {date(n.created_at)}</span></span>{!n.is_read&&<button onClick={()=>void markNotificationRead(String(n.id))} className="text-xs font-semibold text-emerald-900 underline">Mark read</button>}</div>)}{!notifications.length&&<p className="text-sm text-slate-500">No notifications yet.</p>}</div></section>}
    <section className="rounded-2xl border bg-white p-4 shadow-sm"><div className="grid gap-2 md:grid-cols-[1fr_12rem_14rem_auto]"><input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search student or request" className="rounded-xl border px-3 py-2 text-sm"/><select value={type} onChange={e => setType(e.target.value)} className="rounded-xl border px-3 py-2 text-sm"><option value="all">All request types</option>{types.map(t => <option key={t.key} value={t.key}>{t.label}</option>)}</select><select value={status} onChange={e => setStatus(e.target.value)} className="rounded-xl border px-3 py-2 text-sm"><option value="all">All statuses</option>{['PENDING','UNDER_REVIEW','APPROVED','ACCEPTED','REJECTED','CANCELLED','EXPIRED','COMPLETED','USED'].map(s => <option key={s}>{s}</option>)}</select><button onClick={() => void refresh()} className="rounded-xl border px-4 py-2 text-sm font-semibold">Refresh</button></div>
      <div className="mt-4 overflow-x-auto"><table className="min-w-full text-left text-sm"><thead className="bg-slate-50 text-xs uppercase text-slate-500"><tr>{['Student / visitor','Request','Requested date','Submitted','Status','Review'].map(x => <th key={x} className="whitespace-nowrap px-3 py-3">{x}</th>)}</tr></thead><tbody>{filtered.map(r => { const t = types.find(x => x.key === r.request_type)!; const key = `${r.request_type}:${r.id}`; const actionable = ['PENDING','UNDER_REVIEW'].includes(String(r.status)); const window = earlyOutWindows[key] ?? defaultEarlyOutWindow(r); const approvals = r.request_type === 'absence' ? [['ACCEPTED','Accept']] : [['APPROVED','Approve'],['REJECTED','Reject']]; return <tr key={key} className="border-t align-top"><td className="whitespace-nowrap px-3 py-3"><button onClick={() => setSelected(r)} className="text-left font-semibold text-emerald-900 hover:underline">{r.request_type === 'walkin_visitor' ? String(r.visitor_name) : r.student_name}</button><span className="block text-xs text-slate-500">{r.request_type === 'walkin_visitor' ? `Walk-in · Guard ${String(r.requester_guard_id).slice(0,8)}` : `${r.student_number} · Grade ${r.grade_level}, ${r.section_name}`}</span></td><td className="min-w-40 px-3 py-3"><span className="font-semibold">{t.label}</span><span className="block max-w-56 truncate text-xs text-slate-500">{String(r[t.detail] ?? r.visitor_name ?? '—')}</span></td><td className="whitespace-nowrap px-3 py-3">{date(r[t.date])}</td><td className="whitespace-nowrap px-3 py-3">{date(r.created_at)}</td><td className="px-3 py-3"><span className="rounded-full bg-slate-100 px-2.5 py-1 text-[10px] font-bold uppercase">{label(r.status)}</span></td><td className="min-w-56 px-3 py-3">{actionable ? r.request_type === 'early_out' && role !== 'administrator' ? <span className="text-xs text-slate-500">Administrator review only</span> : <><textarea value={remarks[key] ?? ''} onChange={e => setRemarks(old => ({ ...old, [key]: e.target.value }))} maxLength={1000} rows={2} placeholder={r.request_type === 'early_out' ? 'Review note (required for more information)' : 'Optional review remarks'} className="w-full rounded-lg border p-2 text-xs"/>{r.request_type === 'early_out' && role === 'administrator' && <div className="mt-2 grid grid-cols-3 gap-1"><label className="text-[10px]">Approved date<input type="date" value={window.date} onChange={e => setEarlyOutWindows(old => ({ ...old, [key]: { ...window, date: e.target.value } }))} className="mt-1 w-full rounded border p-1.5 text-xs"/></label><label className="text-[10px]">From<input type="time" value={window.start} onChange={e => setEarlyOutWindows(old => ({ ...old, [key]: { ...window, start: e.target.value } }))} className="mt-1 w-full rounded border p-1.5 text-xs"/></label><label className="text-[10px]">Until<input type="time" value={window.end} onChange={e => setEarlyOutWindows(old => ({ ...old, [key]: { ...window, end: e.target.value } }))} className="mt-1 w-full rounded border p-1.5 text-xs"/></label></div>}<div className="mt-1 flex flex-wrap gap-2">{r.request_type === 'early_out' && role === 'administrator' && <button disabled={busy === key || !remarks[key]?.trim()} onClick={() => void review(r, 'UNDER_REVIEW')} className="rounded-lg border px-2 py-1 text-xs">Request info</button>}{r.request_type !== 'walkin_visitor'&&r.request_type!=='early_out'&&<button disabled={busy === key} onClick={() => void review(r, 'UNDER_REVIEW')} className="rounded-lg border px-2 py-1 text-xs">Under review</button>}{r.request_type === 'walkin_visitor'&&<button disabled={busy === key} onClick={() => void review(r, 'REQUEST_INFO')} className="rounded-lg border px-2 py-1 text-xs">Request info</button>}{approvals.map(([s, text]) => <button key={s} disabled={busy === key} onClick={() => void review(r, s)} className={`rounded-lg px-2 py-1 text-xs font-semibold ${s === 'REJECTED' ? 'bg-rose-50 text-rose-800' : 'bg-emerald-800 text-white'}`}>{busy === key ? 'Saving…' : text}</button>)}</div></> : <button onClick={() => setSelected(r)} className="font-semibold text-emerald-800">View details</button>}</td></tr> })}{!filtered.length && <tr><td colSpan={6} className="px-3 py-10 text-center text-slate-500">{loading ? 'Loading requests…' : 'No requests match these filters.'}</td></tr>}</tbody></table></div>
    </section>
    {selected && <div className="fixed inset-0 z-[80] flex items-center justify-center bg-slate-950/50 p-4" onClick={() => setSelected(null)}><section role="dialog" aria-modal="true" aria-label="Student request details" onClick={e => e.stopPropagation()} className="max-h-[90vh] w-full max-w-2xl overflow-auto rounded-3xl bg-white p-6"><div className="flex justify-between"><div><p className="text-xs font-bold uppercase tracking-widest text-emerald-800">{label(selected.request_type)}</p><h2 className="mt-1 text-xl font-bold">{selected.request_type==='walkin_visitor'?String(selected.visitor_name):selected.student_name}</h2></div><button onClick={() => setSelected(null)} className="rounded-lg border px-3 py-1">Close</button></div><div className="mt-4 grid gap-3 sm:grid-cols-2">{[['Student number',selected.student_number],['Grade and section',`Grade ${selected.grade_level} · ${selected.section_name}`],['Status',label(selected.status)],['Submitted',time(selected.created_at)],['Requested date',date(selected[types.find(t=>t.key===selected.request_type)?.date ?? ''])],['Request details',selected.reason ?? selected.purpose ?? selected.visitor_name ?? selected.requested_status],['Visitor contact',selected.contact_number],['Visitor ID',selected.identification_details],['Person to visit',selected.person_contacted],['Additional remarks',selected.visitor_remarks],['Reviewer remarks',selected.reviewer_remarks ?? selected.decision_remarks ?? 'No remarks']].filter(([,v])=>v!==null&&v!==undefined&&v!=='').map(([k,v])=><div key={String(k)} className="rounded-xl bg-slate-50 p-3"><p className="text-xs text-slate-500">{String(k)}</p><p className="mt-1 break-words text-sm font-semibold">{String(v ?? '—')}</p></div>)}</div><h3 className="mt-6 font-bold">Request history</h3><ol className="mt-3 space-y-3 border-l-2 border-emerald-100 pl-4">{history.map(h=><li key={String(h.id)}><p className="font-semibold">{h.old_status ? `${label(h.old_status)} → ` : ''}{label(h.new_status)}</p><p className="text-xs text-slate-500">{time(h.changed_at)}{h.changed_by ? ` · Actor ${String(h.changed_by)}` : ''}</p>{Boolean(h.remarks) && <p className="mt-1 text-sm">{String(h.remarks)}</p>}</li>)}{!history.length && <li className="text-sm text-slate-500">No recorded status changes yet.</li>}</ol></section></div>}
  </div>
}
