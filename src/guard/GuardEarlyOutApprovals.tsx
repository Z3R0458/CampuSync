import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { friendlyError } from '../components/UserFeedback'

type Row = Record<string, unknown>
const label = (value: unknown) => String(value ?? '—').replaceAll('_', ' ').replace(/\b\w/g, c => c.toUpperCase())
const time = (value: unknown) => value ? new Intl.DateTimeFormat('en-PH', { timeZone: 'Asia/Manila', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(String(value))) : '—'

export function GuardEarlyOutApprovals() {
  const [rows, setRows] = useState<Row[]>([])
  const [filter, setFilter] = useState('all')
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const refresh = useCallback(async () => {
    if (!supabase) return
    const client = supabase
    const { data, error: loadError } = await client.rpc('get_guard_early_out_approvals')
    setLoading(false)
    setError(loadError ? friendlyError(loadError) : '')
    setRows(data ?? [])
  }, [])

  useEffect(() => {
    void refresh()
    if (!supabase) return
    const client = supabase
    const channel = client.channel('guard-early-out-approvals')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'early_out_requests' }, () => void refresh())
      .subscribe()
    const timer = window.setInterval(() => void refresh(), 60_000)
    return () => { window.clearInterval(timer); void client.removeChannel(channel) }
  }, [refresh])

  const filtered = useMemo(() => rows.filter(row => {
    const matchesStatus = filter === 'all' || (filter === 'PENDING' ? ['PENDING', 'UNDER_REVIEW'].includes(String(row.status)) : row.status === filter)
    const matchesQuery = `${row.student_name ?? ''} ${row.student_number ?? ''} ${row.reason ?? ''}`.toLowerCase().includes(query.toLowerCase())
    return matchesStatus && matchesQuery
  }), [rows, filter, query])

  return <div className="space-y-5">
    <header><p className="text-xs font-bold uppercase tracking-[.2em] text-emerald-800">Gate Operations</p><h2 className="mt-1 text-2xl font-bold">Early-Out Approvals</h2><p className="mt-1 text-sm text-slate-500">Review school-approved departure windows and whether each permission was used. Final authorization is revalidated by Supabase during the scan.</p></header>
    {error && <p role="alert" className="rounded-xl bg-rose-50 p-3 text-sm text-rose-800">{error}</p>}
    <section className="rounded-2xl border bg-white p-4 shadow-sm">
      <div className="grid gap-2 sm:grid-cols-[1fr_14rem_auto]"><input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search student, ID, or reason" className="rounded-xl border px-3 py-2 text-sm"/><select aria-label="Filter early-out status" value={filter} onChange={e => setFilter(e.target.value)} className="rounded-xl border bg-white px-3 py-2 text-sm"><option value="all">All statuses</option>{['PENDING','APPROVED','USED','REJECTED','EXPIRED'].map(status => <option key={status}>{status}</option>)}</select><button onClick={() => void refresh()} className="rounded-xl border px-4 py-2 text-sm font-semibold">Refresh</button></div>
      <div className="mt-4 grid gap-3 xl:grid-cols-2">{filtered.map(row => {
        const name = String(row.student_name ?? 'Student')
        const initials = name.split(/\s+/).map(part => part[0]).join('').slice(0, 2)
        return <article key={String(row.request_id)} className="rounded-2xl border border-slate-200 p-4">
          <div className="flex items-start gap-3"><span aria-hidden="true" className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-emerald-100 font-bold text-emerald-900">{initials}</span><div className="min-w-0 flex-1"><div className="flex flex-wrap items-start justify-between gap-2"><div><h3 className="font-bold">{name}</h3><p className="text-xs text-slate-500">{String(row.student_number ?? '—')} · Grade {String(row.grade_level ?? '—')} · {String(row.section_name ?? 'Unassigned')}</p></div><span className={`rounded-full px-2.5 py-1 text-[10px] font-bold uppercase ${row.status === 'APPROVED' ? 'bg-emerald-100 text-emerald-900' : row.status === 'USED' ? 'bg-sky-100 text-sky-900' : row.status === 'REJECTED' ? 'bg-rose-100 text-rose-900' : 'bg-amber-100 text-amber-900'}`}>{label(row.status)}</span></div></div></div>
          <dl className="mt-4 grid gap-3 sm:grid-cols-2">{[
            ['Reason', row.reason], ['Requested departure', time(row.requested_departure)],
            ['Approved window', row.approved_departure_date ? `${String(row.approved_departure_date)} · ${String(row.approved_departure_start ?? '').slice(0, 5)}–${String(row.approved_departure_end ?? '').slice(0, 5)}` : 'Not approved'],
            ['Approved by', row.reviewed_by ? `${String(row.reviewed_by_name ?? 'Administrator')} · ${time(row.approved_at ?? row.reviewed_at)}` : '—'],
            ['Expires', time(row.expires_at)], ['Usage', row.status === 'USED' ? `Used · ${time(row.actual_departure_at ?? row.used_at)}` : row.status === 'EXPIRED' ? 'Expired' : row.status === 'APPROVED' ? 'Unused' : 'Not authorized'],
          ].map(([key, value]) => <div key={String(key)} className="rounded-xl bg-slate-50 p-3"><dt className="text-[11px] text-slate-500">{String(key)}</dt><dd className="mt-1 break-words text-sm font-semibold">{String(value ?? '—')}</dd></div>)}</dl>
          {Boolean(row.reviewer_remarks) && <p className="mt-3 rounded-xl bg-slate-50 p-3 text-sm"><b>Administrator note:</b> {String(row.reviewer_remarks)}</p>}
        </article>
      })}{!filtered.length && <p className="rounded-xl bg-slate-50 p-8 text-center text-sm text-slate-500 xl:col-span-2">{loading ? 'Loading approval records…' : 'No early-out requests match this filter.'}</p>}</div>
    </section>
  </div>
}
