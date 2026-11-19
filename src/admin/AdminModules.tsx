import { type FormEvent, type MouseEvent, type ReactNode, useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { downloadBlob } from '../lib/adminExports'
import { QRCodeSVG } from 'qrcode.react'
import { ProfileAvatar } from '../components/ProfilePhoto'
import { friendlyError, useFeedback } from '../components/UserFeedback'

const roles = [
  { id: 'administrator', label: 'Administrators' },
  { id: 'teacher', label: 'Teachers' },
  { id: 'guard', label: 'Guards' },
  { id: 'student', label: 'Students' },
  { id: 'parent', label: 'Parents / Guardians' },
] as const
type ManagedRole = (typeof roles)[number]['id']
type Props = { profile: { id: string; full_name: string } }
type Account = {
  id: string; full_name: string; email: string; phone?: string | null; role: ManagedRole; is_active: boolean; created_at: string; profile_photo_path?: string | null
  students?: { student_id: string; grade_level: string; status: string; section_id: string | null; sections?: { name: string } | null } | null
  teachers?: { id: string; teacher_id: string; designation: string | null } | null
}
type Enrollment = {
  id: string; student_id: string; school_year: string; grade_level: string; section_id: string | null
  enrollment_type: 'NEW' | 'RETURNING'; status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'ENROLLED'
  date_registered: string; remarks: string | null; sections?: { name: string } | null
  students?: { student_id: string; profiles?: { full_name: string; email: string } | null } | null
}

function Frame({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) {
  return <div className="space-y-5"><div><p className="text-[11px] font-bold uppercase tracking-[.18em] text-[var(--color-brand-dark)]">School operations</p><h2 className="mt-1 text-2xl font-bold">{title}</h2><p className="mt-1 text-sm text-slate-500">{subtitle}</p></div>{children}</div>
}
function Tag({ value }: { value: string }) {
  const color = ['active', 'APPROVED', 'ENROLLED'].includes(value) ? 'bg-emerald-100 text-emerald-800' : ['PENDING', 'pending'].includes(value) ? 'bg-amber-100 text-amber-800' : ['REJECTED', 'inactive', 'archived'].includes(value) ? 'bg-rose-100 text-rose-800' : 'bg-slate-100 text-slate-700'
  return <span className={`rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide ${color}`}>{value}</span>
}
const dateLabel = (value: string) => value ? new Intl.DateTimeFormat('en-PH', { timeZone: 'Asia/Manila', dateStyle: 'medium' }).format(new Date(value)) : '—'

const normalizeGradeLevel = (value: string) => value.trim().toLocaleLowerCase().replace(/^grade\s*/, '')

async function accountProvisioningError(error: unknown, data: unknown) {
  const payload = data && typeof data === 'object' ? data as { error?: unknown } : null
  if (typeof payload?.error === 'string' && payload.error) return payload.error
  const context = error && typeof error === 'object' ? (error as { context?: unknown }).context : null
  if (context instanceof Response) {
    try {
      const body = await context.clone().json() as { error?: unknown; message?: unknown }
      if (typeof body.error === 'string' && body.error) return body.error
      if (typeof body.message === 'string' && body.message) return body.message
    } catch { /* Fall back to the standard network error message. */ }
  }
  return friendlyError(error)
}

export function UserManagement({ profile }: Props) {
  const { confirmAction } = useFeedback()
  const [role, setRole] = useState<ManagedRole>('administrator')
  const [accounts, setAccounts] = useState<Account[]>([])
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('all')
  const [grade, setGrade] = useState('all')
  const [section, setSection] = useState('all')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [sort, setSort] = useState('name')
  const [pageSize, setPageSize] = useState(25)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [message, setMessage] = useState('')
  const [detail, setDetail] = useState<Account | null>(null)
  const [editing, setEditing] = useState<Account | null>(null)
  const [editName, setEditName] = useState('')
  const [editPhone, setEditPhone] = useState('')
  const [editStudentNumber, setEditStudentNumber] = useState('')
  const [editGradeLevel, setEditGradeLevel] = useState('')
  const [editSectionId, setEditSectionId] = useState('')
  const [editTeacherNumber, setEditTeacherNumber] = useState('')
  const [editDesignation, setEditDesignation] = useState('')
  const [allSections, setAllSections] = useState<{id:string;name:string;grade_level:string}[]>([])
  const [teacherQr, setTeacherQr] = useState<{ token: string; teacherId: string; name: string; isNew?: boolean } | null>(null)
  const [teacherRegistration, setTeacherRegistration] = useState({ full_name:'', email:'', phone:'', teacher_id:'', designation:'' })
  const [guardRegistration, setGuardRegistration] = useState({ full_name:'', email:'', phone:'' })
  const [creatingTeacher, setCreatingTeacher] = useState(false)
  const [creatingGuard, setCreatingGuard] = useState(false)
  const [guardActivityRows,setGuardActivityRows]=useState<Record<string,unknown>[]>([])
  const [guardActivityLoading,setGuardActivityLoading]=useState(false)
  const [guardActivityFrom,setGuardActivityFrom]=useState('')
  const [guardActivityTo,setGuardActivityTo]=useState('')

  const loadSections = async () => {
    if (!supabase) return
    const { data, error } = await supabase.from('sections').select('id,name,grade_level').order('grade_level').order('name').limit(10000)
    if (error) { setMessage(friendlyError(error)); return }
    setAllSections(data ?? [])
  }

  const refresh = async () => {
    if (!supabase) return
    setLoading(true); setMessage('')
    const select = role === 'student'
      ? 'id,full_name,email,phone,role,is_active,created_at,profile_photo_path,students(student_id,grade_level,status,section_id,sections(name))'
      : role === 'teacher'
        ? 'id,full_name,email,phone,role,is_active,created_at,profile_photo_path,teachers(id,teacher_id,designation)'
        : 'id,full_name,email,phone,role,is_active,created_at,profile_photo_path'
    const { data, error } = await supabase.from('profiles').select(select).eq('role', role).order('created_at', { ascending: false }).limit(10000)
    if (error) setMessage(friendlyError(error))
    else setAccounts((data ?? []).map((row:any)=>({...row,students:Array.isArray(row.students)?row.students[0]??null:row.students,teachers:Array.isArray(row.teachers)?row.teachers[0]??null:row.teachers})) as Account[])
    if (role === 'student') await loadSections()
    setLoading(false)
  }
  useEffect(() => { setPage(1); void refresh() }, [role])

  const grades = [...new Set(accounts.map((a) => a.students?.grade_level).filter((v): v is string => Boolean(v)))].sort()
  const editableGrades = [...new Set([...allSections.map((s) => s.grade_level), ...grades])].sort((a,b)=>a.localeCompare(b,undefined,{numeric:true}))
  const sections = [...new Set(accounts.map((a) => a.students?.sections?.name).filter((v): v is string => Boolean(v)))].sort()
  const filtered = useMemo(() => accounts.filter((a) => {
    const matches = `${a.full_name} ${a.email} ${a.students?.student_id ?? ''}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())
    const matchesStatus = status === 'all' || (status === 'active' ? a.is_active : !a.is_active)
    const created = a.created_at.slice(0, 10)
    return matches && matchesStatus && (role !== 'student' || (grade === 'all' || a.students?.grade_level === grade) && (section === 'all' || a.students?.sections?.name === section)) && (!from || created >= from) && (!to || created <= to)
  }).sort((a, b) => sort === 'name' ? a.full_name.localeCompare(b.full_name) : sort === 'oldest' ? a.created_at.localeCompare(b.created_at) : b.created_at.localeCompare(a.created_at)), [accounts, search, status, grade, section, from, to, sort, role])
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize))
  const displayed = filtered.slice((page - 1) * pageSize, page * pageSize)
  const clear = () => { setSearch(''); setStatus('all'); setGrade('all'); setSection('all'); setFrom(''); setTo(''); setSort('name'); setPage(1) }

  const toggleAccount = async (account: Account) => {
    if (!supabase) return
    if (account.is_active && account.role === 'administrator') {
      if (account.id === profile.id) { setMessage('You cannot deactivate your own administrator account.'); return }
      const { count, error } = await supabase.from('profiles').select('id', { count: 'exact', head: true }).eq('role', 'administrator').eq('is_active', true)
      if (error) { setMessage(friendlyError(error)); return }
      if ((count ?? 0) <= 1) { setMessage('The last active administrator cannot be deactivated.'); return }
    }
    const action = account.is_active ? 'deactivate' : 'reactivate'
    await confirmAction({
      title: account.is_active ? 'Deactivate this account?' : 'Reactivate this account?',
      description: account.is_active ? 'This user will no longer be able to access CampuSync until the account is reactivated.' : 'This user will be able to sign in to CampuSync again.',
      itemName: account.full_name, confirmLabel: account.is_active ? 'Deactivate Account' : 'Reactivate Account',
      tone: account.is_active ? 'danger' : 'primary', successMessage: `${account.full_name}'s account was ${action}d.`,
      onConfirm: async () => { const { error } = await supabase!.from('profiles').update({ is_active: !account.is_active }).eq('id', account.id); if (error) throw error; await refresh() },
    })
  }
  const sendReset = async (account: Account) => {
    if (!supabase) return
    await confirmAction({ title: 'Send a password reset code?', description: 'A six-digit verification code will be sent to this account. The user must verify the code before setting a new password.', itemName: account.email, confirmLabel: 'Send verification code', tone: 'primary', successMessage: `Password reset verification code sent to ${account.email}.`, onConfirm: async () => {
      const { data, error } = await supabase!.functions.invoke('login-otp', { body: { action: 'password-reset-start', email: account.email } })
      if (error || data?.error) throw new Error(data?.error ?? error?.message ?? 'Could not send the reset code.')
      const { error: logError } = await supabase!.rpc('record_password_reset_request', { p_target_profile: account.id })
      if (logError) throw logError
    } })
  }
  const regenerateTeacherQr = async (account: Account) => {
    if (!supabase || !account.teachers?.id) return
    await confirmAction({ title: 'Replace this teacher QR code?', description: 'The current QR code will stop working immediately. The new code must be shared securely with the teacher.', itemName: account.full_name, confirmLabel: 'Replace QR code', tone: 'danger', successMessage: 'A replacement QR code was generated.', onConfirm: async () => {
      const { data, error } = await supabase!.rpc('issue_qr_credential', { p_person_type: 'teacher', p_person_id: account.teachers!.id })
      if (error) throw error
      if (typeof data !== 'string' || data.length < 32) throw new Error('The QR code could not be generated. Please try again.')
      setTeacherQr({ token: data, teacherId: account.teachers!.teacher_id, name: account.full_name })
    } })
  }
  const revokeTeacherQr = async (account: Account) => {
    if (!supabase || !account.teachers?.id) return
    await confirmAction({ title: 'Deactivate this teacher QR?', description: 'The teacher will need a new QR code before scanning again.', itemName: account.full_name, confirmLabel: 'Deactivate QR', tone: 'danger', onConfirm: async () => {
      const { data, error } = await supabase!.rpc('revoke_teacher_qr_credential', { p_teacher_id: account.teachers!.id })
      if (error) throw error
      if (!data) throw new Error('No active QR code was found for this teacher.')
    } })
  }
  const saveAccount = async (event: FormEvent) => {
    event.preventDefault(); if (!supabase || !editing) return
    const account = editing
    await confirmAction({ title: 'Save account changes?', description: 'Please confirm that you want to update this account information.', itemName: account.full_name, confirmLabel: 'Save Changes', tone: 'primary', successMessage: 'Account details have been saved.', onConfirm: async () => {
    const { error } = await supabase!.rpc('admin_update_account_details', {
      p_profile_id: account.id,
      p_full_name: editName.trim(),
      p_phone: editPhone.trim() || null,
      p_student_number: account.role === 'student' ? editStudentNumber.trim() : null,
      p_grade_level: account.role === 'student' ? editGradeLevel.trim() : null,
      p_section_id: account.role === 'student' ? editSectionId || null : null,
      p_teacher_number: account.role === 'teacher' ? editTeacherNumber.trim() : null,
      p_designation: account.role === 'teacher' ? editDesignation.trim() || null : null,
    })
    if (error) throw error
    setEditing(null); await refresh()
    } })
  }
  const createTeacher = async (event: FormEvent) => {
    event.preventDefault(); if (!supabase) return
    setCreatingTeacher(true); setMessage('Creating teacher account…')
    const { data, error } = await supabase.functions.invoke('admin-create-user', { body: { role:'teacher', full_name:teacherRegistration.full_name.trim(), email:teacherRegistration.email.trim(), phone:teacherRegistration.phone.trim(), teacher_id:teacherRegistration.teacher_id.trim(), designation:teacherRegistration.designation.trim() } })
    if (error || data?.error) { setCreatingTeacher(false); setMessage(await accountProvisioningError(error, data)); return }
    const { data: teacher } = await supabase.from('teachers').select('id').eq('profile_id', data.profile_id).maybeSingle()
    let qrNotice = ''
    if (teacher?.id) {
      const { data: qr, error: qrError } = await supabase.rpc('issue_qr_credential', { p_person_type:'teacher', p_person_id:teacher.id })
      if (!qrError && typeof qr === 'string') setTeacherQr({ token:qr, teacherId:teacherRegistration.teacher_id, name:teacherRegistration.full_name, isNew:true })
      else qrNotice = ' The QR credential could not be issued; use Replace QR after refreshing.'
    }
    setTeacherRegistration({ full_name:'', email:'', phone:'', teacher_id:'', designation:'' }); setCreatingTeacher(false); await refresh()
    setMessage(`${data.setupEmailSent ? 'Teacher account created. A password setup email was sent to the teacher.' : data.setupEmailNotice ?? 'Teacher account created.'}${qrNotice}`)
  }
  const createGuard = async (event: FormEvent) => {
    event.preventDefault(); if (!supabase) return
    setCreatingGuard(true); setMessage('Creating guard account…')
    const { data, error } = await supabase.functions.invoke('admin-create-user', { body: { role:'guard', full_name:guardRegistration.full_name.trim(), email:guardRegistration.email.trim(), phone:guardRegistration.phone.trim() } })
    setCreatingGuard(false)
    if (error || data?.error) { setMessage(await accountProvisioningError(error, data)); return }
    setGuardRegistration({ full_name:'', email:'', phone:'' }); await refresh()
    setMessage(data.setupEmailSent ? 'Guard account created. A password setup email was sent to the guard.' : data.setupEmailNotice ?? 'Guard account created.')
  }
  const activity = async (account: Account) => {
    if (!supabase) return
    if(account.role==='guard'){
      setGuardActivityLoading(true);setGuardActivityRows([])
      let q=supabase.from('attendance_events').select('id,person_type,person_id,event_type,actual_scan_time,verification_result,sync_status,scan_origin,synchronized_at').eq('scanning_guard_id',account.id).order('actual_scan_time',{ascending:false}).limit(500)
      if(guardActivityFrom)q=q.gte('actual_scan_time',`${guardActivityFrom}T00:00:00+08:00`)
      if(guardActivityTo)q=q.lte('actual_scan_time',`${guardActivityTo}T23:59:59+08:00`)
      const {data,error}=await q
      setGuardActivityLoading(false)
      if(error){setMessage(friendlyError(error));return}
      const events=data??[];const studentIds=[...new Set(events.filter(e=>e.person_type==='student').map(e=>String(e.person_id)))];const teacherIds=[...new Set(events.filter(e=>e.person_type==='teacher').map(e=>String(e.person_id)))]
      const [students,teachers]=await Promise.all([studentIds.length?supabase.from('students').select('id,student_id,profiles(full_name)').in('id',studentIds):Promise.resolve({data:[],error:null}),teacherIds.length?supabase.from('teachers').select('id,teacher_id,profiles(full_name)').in('id',teacherIds):Promise.resolve({data:[],error:null})])
      const people=new Map<string,Record<string,unknown>>();for(const row of students.data??[])people.set(row.id,{...(row as any),person_type:'student'});for(const row of teachers.data??[])people.set(row.id,{...(row as any),person_type:'teacher'})
      setGuardActivityRows(events.map(e=>{const person=people.get(e.person_id);return {...e,person_name:(person?.profiles as any)?.full_name??'School member',person_display_id:person?.student_id??person?.teacher_id??''}}))
      return
    }
    const { data, error } = await supabase.from('audit_logs').select('action,entity_type,created_at,details').eq('entity_id', account.id).order('created_at', { ascending: false }).limit(20)
    if (error) setMessage(friendlyError(error))
    else setMessage(data?.length ? `${data.length} account activity record(s); latest: ${String(data[0].action)} · ${dateLabel(String(data[0].created_at))}` : 'No account activity records found.')
  }

  return <Frame title="User management" subtitle="Find and administer existing accounts by role.">
    <div className="flex gap-2 overflow-x-auto rounded-2xl border bg-white p-2">{roles.map((r) => <button key={r.id} onClick={() => setRole(r.id)} className={`shrink-0 rounded-xl px-4 py-2.5 text-sm font-semibold ${role === r.id ? 'bg-[var(--color-brand-dark)] text-white' : 'text-slate-600 hover:bg-slate-50'}`}>{r.label}</button>)}</div>
    {role === 'teacher' && <section className="rounded-3xl border bg-white p-5 shadow-sm"><h3 className="text-lg font-bold">Register new teacher</h3><p className="mb-4 text-sm text-slate-500">Creates the teacher account and emails a secure password setup link. The teacher verifies their email with a code before choosing a password.</p><form onSubmit={e=>void createTeacher(e)} className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5"><input required maxLength={120} placeholder="Full name" value={teacherRegistration.full_name} onChange={e=>setTeacherRegistration(v=>({...v,full_name:e.target.value}))} className="rounded-xl border px-3 py-2.5"/><input required type="email" placeholder="School email" value={teacherRegistration.email} onChange={e=>setTeacherRegistration(v=>({...v,email:e.target.value}))} className="rounded-xl border px-3 py-2.5"/><input required placeholder="Teacher number" value={teacherRegistration.teacher_id} onChange={e=>setTeacherRegistration(v=>({...v,teacher_id:e.target.value}))} className="rounded-xl border px-3 py-2.5"/><input placeholder="Designation" value={teacherRegistration.designation} onChange={e=>setTeacherRegistration(v=>({...v,designation:e.target.value}))} className="rounded-xl border px-3 py-2.5"/><input placeholder="Contact number" value={teacherRegistration.phone} onChange={e=>setTeacherRegistration(v=>({...v,phone:e.target.value}))} className="rounded-xl border px-3 py-2.5"/><button disabled={creatingTeacher} className="rounded-xl bg-emerald-800 px-4 py-2.5 font-semibold text-white disabled:opacity-50 sm:col-span-2 xl:col-span-5">{creatingTeacher?'Creating…':'Create teacher account'}</button></form></section>}
    {role === 'guard' && <section className="rounded-3xl border bg-white p-5 shadow-sm"><h3 className="text-lg font-bold">Register new guard</h3><p className="mb-4 text-sm text-slate-500">Creates an administrator-managed guard account and emails a secure password setup link. The guard verifies their email with a code before choosing a password.</p><form onSubmit={e=>void createGuard(e)} className="grid gap-3 sm:grid-cols-3"><input required maxLength={120} placeholder="Full name" value={guardRegistration.full_name} onChange={e=>setGuardRegistration(v=>({...v,full_name:e.target.value}))} className="rounded-xl border px-3 py-2.5"/><input required type="email" placeholder="School email" value={guardRegistration.email} onChange={e=>setGuardRegistration(v=>({...v,email:e.target.value}))} className="rounded-xl border px-3 py-2.5"/><input type="tel" placeholder="Contact number" value={guardRegistration.phone} onChange={e=>setGuardRegistration(v=>({...v,phone:e.target.value}))} className="rounded-xl border px-3 py-2.5"/><button disabled={creatingGuard} className="rounded-xl bg-emerald-800 px-4 py-2.5 font-semibold text-white disabled:opacity-50 sm:col-span-3">{creatingGuard?'Creating…':'Create guard account'}</button></form></section>}
    <section className="rounded-3xl border border-[var(--color-border)] bg-white p-4 shadow-sm sm:p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3"><div><h3 className="text-lg font-bold">{roles.find((r) => r.id === role)?.label} directory</h3><p className="text-sm text-slate-500">{filtered.length} matching account{filtered.length === 1 ? '' : 's'}</p></div><button onClick={() => void refresh()} className="rounded-xl border px-3 py-2 text-sm">Refresh</button></div>
      <div className="mb-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        <input value={search} onChange={(e) => { setSearch(e.target.value); setPage(1) }} placeholder="Search name, email, student number" className="rounded-xl border px-3 py-2 text-sm xl:col-span-2" />
        <select value={status} onChange={(e) => setStatus(e.target.value)} className="rounded-xl border px-3 py-2 text-sm"><option value="all">All account statuses</option><option value="active">Active</option><option value="inactive">Inactive</option></select>
        {role === 'student' && <><select value={grade} onChange={(e) => setGrade(e.target.value)} className="rounded-xl border px-3 py-2 text-sm"><option value="all">All grade levels</option>{grades.map((v) => <option key={v}>{v}</option>)}</select><select value={section} onChange={(e) => setSection(e.target.value)} className="rounded-xl border px-3 py-2 text-sm"><option value="all">All sections</option>{sections.map((v) => <option key={v}>{v}</option>)}</select></>}
        <label className="flex items-center gap-2 rounded-xl border px-3 py-2 text-xs text-slate-500">From<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="min-w-0 flex-1 text-sm text-slate-800" /></label><label className="flex items-center gap-2 rounded-xl border px-3 py-2 text-xs text-slate-500">To<input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="min-w-0 flex-1 text-sm text-slate-800" /></label>
        <select value={sort} onChange={(e) => setSort(e.target.value)} className="rounded-xl border px-3 py-2 text-sm"><option value="name">Sort by name</option><option value="newest">Newest first</option><option value="oldest">Oldest first</option></select>
        <button onClick={clear} className="rounded-xl border px-3 py-2 text-sm font-semibold">Clear filters</button>
      </div>
      {message && <p role="status" className="mb-3 rounded-xl bg-slate-50 p-3 text-sm text-slate-700">{message}</p>}
      <div className="overflow-x-auto"><table className="min-w-full text-left text-sm"><thead className="bg-slate-50 text-slate-500"><tr>{(role === 'student' ? ['Student no.','Full name','Email','Grade','Section','Status','Created','Actions'] : role === 'teacher' ? ['Teacher no.','Full name','Email','Designation','Status','Created','Actions'] : ['Full name','Email','Status','Created','Actions']).map((h) => <th key={h} className="whitespace-nowrap px-3 py-3 font-semibold">{h}</th>)}</tr></thead><tbody>{displayed.map((a) => <tr key={a.id} className="border-t"><>{role === 'student' && <td className="px-3 py-3 font-semibold">{a.students?.student_id ?? '—'}</td>}{role === 'teacher' && <td className="px-3 py-3 font-semibold">{a.teachers?.teacher_id ?? '—'}</td>}<td className="px-3 py-3 font-medium"><span className="flex items-center gap-2"><ProfileAvatar path={a.profile_photo_path} name={a.full_name} size={32}/>{a.full_name}</span></td><td className="px-3 py-3">{a.email}</td>{role === 'student' && <><td className="px-3 py-3">{a.students?.grade_level ?? '—'}</td><td className="px-3 py-3">{a.students?.sections?.name ?? '—'}</td></>}{role === 'teacher' && <td className="px-3 py-3">{a.teachers?.designation ?? '—'}</td>}<td className="px-3 py-3"><Tag value={a.is_active ? 'active' : 'inactive'} /></td><td className="whitespace-nowrap px-3 py-3">{dateLabel(a.created_at)}</td><td className="px-3 py-3"><div className="flex flex-wrap gap-2"><button onClick={() => setDetail(a)} className="font-semibold text-emerald-800">Details</button><button onClick={() => {void loadSections();setEditing(a);setEditName(a.full_name);setEditPhone(a.phone??'');setEditStudentNumber(a.students?.student_id??'');setEditGradeLevel(a.students?.grade_level??'');setEditSectionId(a.students?.section_id??'');setEditTeacherNumber(a.teachers?.teacher_id??'');setEditDesignation(a.teachers?.designation??'')}} className="font-semibold text-emerald-800">Edit</button>{role === 'teacher' && <><button onClick={() => void regenerateTeacherQr(a)} className="font-semibold text-emerald-800">Replace QR</button><button onClick={() => void revokeTeacherQr(a)} className="font-semibold text-rose-700">Revoke QR</button></>}<button onClick={() => void toggleAccount(a)} className="font-semibold text-emerald-800">{a.is_active ? 'Deactivate' : 'Activate'}</button><button onClick={() => void sendReset(a)} className="font-semibold text-emerald-800">Reset password</button>{role === 'student' && <a href={`/administrator/students?student_id=${encodeURIComponent(a.students?.student_id ?? '')}`} className="font-semibold text-emerald-800">Student record</a>}</div></td></></tr>)}{!displayed.length && <tr><td colSpan={role === 'student' ? 8 : role==='teacher'?7:5} className="px-3 py-8 text-center text-slate-500">{loading ? 'Loading accounts…' : 'No accounts match these filters.'}</td></tr>}</tbody></table></div>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm"><label className="flex items-center gap-2">Rows per page<select value={pageSize} onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1) }} className="rounded-lg border px-2 py-1"><option>10</option><option>25</option><option>50</option><option>100</option></select></label><div className="flex items-center gap-3"><span>Page {page} of {pages}</span><button disabled={page <= 1} onClick={() => setPage(page - 1)} className="rounded-lg border px-3 py-1 disabled:opacity-40">Previous</button><button disabled={page >= pages} onClick={() => setPage(page + 1)} className="rounded-lg border px-3 py-1 disabled:opacity-40">Next</button></div></div>
    </section>
    {detail && <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-4" role="presentation" onClick={() => setDetail(null)}><div role="dialog" aria-modal="true" aria-label="Account details" onClick={(e) => e.stopPropagation()} className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-3xl bg-white p-6 shadow-2xl"><div className="flex justify-between"><h3 className="text-xl font-bold">Account details</h3><button onClick={() => setDetail(null)} aria-label="Close">Close</button></div><dl className="mt-4 grid grid-cols-2 gap-3 text-sm"><dt className="text-slate-500">Name</dt><dd>{detail.full_name}</dd><dt className="text-slate-500">Email</dt><dd>{detail.email}</dd><dt className="text-slate-500">Role</dt><dd>{detail.role}</dd><dt className="text-slate-500">Status</dt><dd>{detail.is_active ? 'Active' : 'Inactive'}</dd><dt className="text-slate-500">Created</dt><dd>{dateLabel(detail.created_at)}</dd>{role === 'student' && <><dt className="text-slate-500">Student number</dt><dd>{detail.students?.student_id}</dd><dt className="text-slate-500">Grade and section</dt><dd>{detail.students?.grade_level} · {detail.students?.sections?.name ?? 'Unassigned'}</dd></>}</dl><button onClick={() => void activity(detail)} className="mt-5 rounded-xl border px-4 py-2 text-sm font-semibold">{detail.role==='guard'?'Load guard scan history':'View recent activity'}</button>{detail.role==='guard'&&<section className="mt-5 border-t pt-4"><h4 className="font-semibold">Guard scan activity</h4><div className="mt-3 flex flex-wrap gap-2"><input aria-label="Activity from date" type="date" value={guardActivityFrom} onChange={e=>setGuardActivityFrom(e.target.value)} className="rounded-lg border px-2 py-1.5 text-sm"/><input aria-label="Activity to date" type="date" value={guardActivityTo} onChange={e=>setGuardActivityTo(e.target.value)} className="rounded-lg border px-2 py-1.5 text-sm"/><button onClick={()=>void activity(detail)} className="rounded-lg border px-3 py-1.5 text-sm">Apply dates</button></div>{guardActivityLoading?<p className="mt-3 text-sm text-slate-500">Loading scan history…</p>:<><div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">{[['Total',guardActivityRows.length],['Student',guardActivityRows.filter(r=>r.person_type==='student').length],['Teacher',guardActivityRows.filter(r=>r.person_type==='teacher').length],['Early-out',guardActivityRows.filter(r=>r.event_type==='EARLY_OUT').length]].map(([label,value])=><div key={String(label)} className="rounded-xl bg-slate-50 p-3"><span className="text-xs text-slate-500">{label}</span><b className="block">{value}</b></div>)}</div><div className="mt-3 max-h-64 space-y-2 overflow-y-auto">{guardActivityRows.map(row=><div key={String(row.id)} className="rounded-xl border p-3 text-sm"><div className="flex justify-between gap-2"><b>{String(row.person_name)} · {String(row.person_display_id)}</b><Tag value={String(row.sync_status??row.verification_result)}/></div><p className="text-slate-500">{String(row.person_type)} · {String(row.event_type)} · {formatExportValue(row.actual_scan_time)} · {row.verification_result==='MANUAL_VERIFIED'?'Manual':'QR'} · {String(row.scan_origin??'Legacy / unknown origin')}</p></div>)}{!guardActivityRows.length&&<p className="rounded-xl bg-slate-50 p-3 text-sm text-slate-500">No recorded gate events for this guard and date range.</p>}</div></>}</section>}</div></div>}
    {editing&&<div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-4"><form onSubmit={(e)=>void saveAccount(e)} className="max-h-[90vh] w-full max-w-xl space-y-4 overflow-y-auto rounded-3xl bg-white p-6"><div className="flex justify-between"><h3 className="text-xl font-bold">Edit {editing.role} account</h3><button type="button" onClick={()=>setEditing(null)}>Close</button></div><label className="block text-sm font-semibold">Full name<input required maxLength={120} value={editName} onChange={(e)=>setEditName(e.target.value)} className="mt-1 w-full rounded-xl border px-3 py-2.5"/></label><label className="block text-sm font-semibold">Contact number<input value={editPhone} onChange={(e)=>setEditPhone(e.target.value)} className="mt-1 w-full rounded-xl border px-3 py-2.5"/></label>{editing.role==='student'&&<div className="grid gap-3 sm:grid-cols-2"><label className="block text-sm font-semibold">Student number<input required value={editStudentNumber} onChange={(e)=>setEditStudentNumber(e.target.value)} className="mt-1 w-full rounded-xl border px-3 py-2.5"/></label><label className="block text-sm font-semibold">Grade level<input required list="student-grade-level-options" value={editGradeLevel} onChange={(e)=>{setEditGradeLevel(e.target.value);if(!allSections.some((s)=>s.id===editSectionId&&normalizeGradeLevel(s.grade_level)===normalizeGradeLevel(e.target.value)))setEditSectionId('')}} className="mt-1 w-full rounded-xl border px-3 py-2.5"/><datalist id="student-grade-level-options">{editableGrades.map((g)=><option key={g} value={g}/>)}</datalist></label><label className="block text-sm font-semibold sm:col-span-2">Section<select value={editSectionId} onChange={(e)=>{const value=e.target.value;setEditSectionId(value);const selected=allSections.find((s)=>s.id===value);if(selected)setEditGradeLevel(selected.grade_level)}} className="mt-1 w-full rounded-xl border px-3 py-2.5"><option value="">Unassigned</option>{allSections.filter((s)=>normalizeGradeLevel(s.grade_level)===normalizeGradeLevel(editGradeLevel)).map((s)=><option key={s.id} value={s.id}>{s.name}</option>)}</select></label></div>}{editing.role==='teacher'&&<div className="grid gap-3 sm:grid-cols-2"><label className="block text-sm font-semibold">Teacher number<input required value={editTeacherNumber} onChange={(e)=>setEditTeacherNumber(e.target.value)} className="mt-1 w-full rounded-xl border px-3 py-2.5"/></label><label className="block text-sm font-semibold">Designation<input value={editDesignation} onChange={(e)=>setEditDesignation(e.target.value)} className="mt-1 w-full rounded-xl border px-3 py-2.5"/></label></div>}<p className="text-xs text-slate-500">Email is managed by the authentication account and is not changed here.</p><button className="rounded-xl bg-emerald-800 px-4 py-2 font-semibold text-white">Save changes</button></form></div>}
    {teacherQr&&<div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-4" onClick={()=>setTeacherQr(null)}><section role="dialog" aria-modal="true" aria-label="New teacher QR credential" onClick={event=>event.stopPropagation()} className="w-full max-w-md rounded-3xl bg-white p-6 text-center shadow-2xl"><div className="flex justify-between"><h3 className="text-lg font-bold">{teacherQr.isNew?"New teacher QR":"Replacement teacher QR"}</h3><button onClick={()=>setTeacherQr(null)}>Close</button></div><QRCodeSVG value={teacherQr.token} size={240} level="H" includeMargin className="mx-auto mt-4"/><p className="font-semibold">{teacherQr.name}</p><p className="text-sm text-slate-500">Teacher ID: {teacherQr.teacherId}</p><p className="mt-3 text-xs text-rose-700">{teacherQr.isNew?"This code is shown only now. Share it securely with the teacher.":"This one-time code is shown only now. The previous QR has been deactivated."}</p><button onClick={()=>window.print()} className="mt-4 rounded-xl border px-4 py-2 text-sm font-semibold">Print QR</button></section></div>}
  </Frame>
}

type Registration = {
  first_name: string; middle_name: string; last_name: string; suffix: string; birth_date: string; gender: string; address: string; phone: string
  guardian_full_name: string; guardian_relationship: string; guardian_contact_number: string; guardian_address: string
  student_id: string; grade_level: string; section_id: string; school_year: string; enrollment_type: 'NEW' | 'RETURNING'; email: string
}
const blankRegistration: Registration = { first_name: '', middle_name: '', last_name: '', suffix: '', birth_date: '', gender: '', address: '', phone: '', guardian_full_name: '', guardian_relationship: '', guardian_contact_number: '', guardian_address: '', student_id: '', grade_level: '', section_id: '', school_year: '', enrollment_type: 'NEW', email: '' }

export function EnrollmentManagement() {
  const { confirmAction } = useFeedback()
  const [rows, setRows] = useState<Enrollment[]>([])
  const [sections, setSections] = useState<{ id: string; name: string; grade_level: string }[]>([])
  const [existingStudents, setExistingStudents] = useState<{id:string;student_id:string;grade_level:string;full_name:string;email:string}[]>([])
  const [existingStudentId, setExistingStudentId] = useState('')
  const [registration, setRegistration] = useState<Registration>(blankRegistration)
  const [step, setStep] = useState(0)
  const [showForm, setShowForm] = useState(false)
  const [tempPassword, setTempPassword] = useState('')
  const [query, setQuery] = useState('')
  const [gradeFilter, setGradeFilter] = useState('all')
  const [sectionFilter, setSectionFilter] = useState('all')
  const [yearFilter, setYearFilter] = useState('all')
  const [statusFilter, setStatusFilter] = useState('all')
  const [remarks, setRemarks] = useState<Record<string, string>>({})
  const [history, setHistory] = useState<{id:string;items:Record<string,unknown>[]} | null>(null)
  const [editingEnrollment, setEditingEnrollment] = useState<Enrollment | null>(null)
  const [editYear, setEditYear] = useState('')
  const [editGrade, setEditGrade] = useState('')
  const [editSection, setEditSection] = useState('')
  const [editType, setEditType] = useState<'NEW'|'RETURNING'>('NEW')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)

  const refresh = async () => {
    if (!supabase) return
    const [enrollments, sectionRows, students] = await Promise.all([
      supabase.from('enrollment_records').select('id,student_id,school_year,grade_level,section_id,enrollment_type,status,date_registered,remarks,sections(name),students(student_id,profiles(full_name,email))').order('date_registered', { ascending: false }).limit(10000),
      supabase.from('sections').select('id,name,grade_level').order('grade_level').order('name'),
      supabase.from('students').select('id,student_id,grade_level,profiles(full_name,email)').order('student_id').limit(10000),
    ])
    if (enrollments.error) setMessage(friendlyError(enrollments.error)); else setRows((enrollments.data ?? []) as unknown as Enrollment[])
    if (sectionRows.error) setMessage(friendlyError(sectionRows.error)); else setSections(sectionRows.data ?? [])
    if (students.error) setMessage(friendlyError(students.error)); else setExistingStudents((students.data ?? []).map((s:any)=>({id:s.id,student_id:s.student_id,grade_level:s.grade_level,full_name:s.profiles?.full_name??'',email:s.profiles?.email??''})))
  }
  useEffect(() => { void refresh() }, [])

  const filtered = rows.filter((r) => `${r.students?.student_id ?? ''} ${r.students?.profiles?.full_name ?? ''}`.toLowerCase().includes(query.toLowerCase()) && (gradeFilter === 'all' || r.grade_level === gradeFilter) && (sectionFilter === 'all' || r.section_id === sectionFilter) && (yearFilter === 'all' || r.school_year === yearFilter) && (statusFilter === 'all' || r.status === statusFilter))
  const counts = { total: rows.filter((r) => r.status === 'ENROLLED').length, pending: rows.filter((r) => r.status === 'PENDING').length, approved: rows.filter((r) => r.status === 'APPROVED').length, rejected: rows.filter((r) => r.status === 'REJECTED').length, newStudents: rows.filter((r) => r.enrollment_type === 'NEW').length }
  const groupCounts = (values: string[], read: (row: Enrollment) => string) => [...new Set(values.filter(Boolean))].sort().map((value) => ({ value, count: rows.filter((row) => read(row) === value).length }))
  const gradeStats = groupCounts(rows.map((r) => r.grade_level), (r) => r.grade_level)
  const sectionStats = groupCounts(rows.map((r) => r.sections?.name ?? ''), (r) => r.sections?.name ?? '')
  const yearStats = groupCounts(rows.map((r) => r.school_year), (r) => r.school_year)
  const updateField = <K extends keyof Registration>(key: K, value: Registration[K]) => setRegistration((old) => ({ ...old, [key]: value }))
  const next = (event: MouseEvent<HTMLButtonElement>) => {
    const form = event.currentTarget.closest('form')
    if (!form) return
    const invalid = [...form.querySelectorAll< HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement >('[data-step="active"]:required')].find((el) => !el.checkValidity())
    if (invalid) { invalid.reportValidity(); return }
    setStep(Math.min(4, step + 1))
  }
  const createStudent = async (event: FormEvent) => {
    event.preventDefault(); if (!supabase) return
    setBusy(true); setMessage('Registering student…')
    const fullName = [registration.first_name, registration.middle_name, registration.last_name, registration.suffix].filter(Boolean).join(' ')
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%'
    const generated = registration.enrollment_type === 'NEW' ? Array.from(crypto.getRandomValues(new Uint8Array(22)), (n) => alphabet[n % alphabet.length]).join('') : ''
    const selectedStudent = existingStudents.find((s)=>s.id===existingStudentId)
    const { data, error } = await supabase.functions.invoke('admin-create-user', { body: registration.enrollment_type === 'RETURNING' ? {
      role: 'student', enrollment_type: 'RETURNING', existing_student_id: existingStudentId,
      student_id: selectedStudent?.student_id, grade_level: registration.grade_level, section_id: registration.section_id || null, school_year: registration.school_year.trim(),
    } : {
      email: registration.email.trim(), full_name: fullName, password: generated, role: 'student', student_id: registration.student_id.trim(),
      grade_level: registration.grade_level, section_id: registration.section_id || null, school_year: registration.school_year.trim(), enrollment_type: registration.enrollment_type,
      first_name: registration.first_name, middle_name: registration.middle_name, last_name: registration.last_name, suffix: registration.suffix,
      birth_date: registration.birth_date, gender: registration.gender, address: registration.address, phone: registration.phone,
      guardian_full_name: registration.guardian_full_name, guardian_relationship: registration.guardian_relationship,
      guardian_contact_number: registration.guardian_contact_number, guardian_address: registration.guardian_address,
    } })
    setBusy(false)
    if (error || data?.error) { setMessage(friendlyError(error ?? data.error)); return }
    setTempPassword(generated); setMessage(registration.enrollment_type === 'RETURNING' ? `Returning student ${selectedStudent?.full_name ?? ''} added for ${registration.school_year}. Enrollment is pending review.` : `Student ${fullName} registered. Enrollment is pending review.`)
    setRegistration(blankRegistration); setExistingStudentId(''); setStep(0); await refresh()
  }
  const review = async (row: Enrollment, nextStatus: Enrollment['status']) => {
    if (!supabase) return
    const note = remarks[row.id] ?? ''
    if (nextStatus === 'REJECTED' && !note.trim()) { setMessage('Add a remark before rejecting an enrollment.'); return }
    await confirmAction({title: 'Update this enrollment?', description: `The student’s enrollment status will change to ${nextStatus.toLowerCase()}.`, itemName: row.students?.student_id ?? 'Student enrollment', confirmLabel: nextStatus === 'REJECTED' ? 'Reject enrollment' : 'Confirm update', tone: nextStatus === 'REJECTED' ? 'danger' : 'primary', successMessage: `Enrollment updated to ${nextStatus.toLowerCase()}.`, onConfirm: async () => { const { error } = await supabase!.rpc('admin_update_enrollment_status', { p_enrollment_id: row.id, p_status: nextStatus, p_remarks: note || null }); if (error) throw error; await refresh() } })
  }
  const showHistory = async (row: Enrollment) => {
    if (!supabase) return
    const { data, error } = await supabase.from('enrollment_record_history').select('old_status,new_status,remarks,changed_at,changed_by').eq('enrollment_record_id', row.id).order('changed_at', { ascending: false })
    if (error) setMessage(friendlyError(error)); else setHistory({ id: row.students?.student_id ?? row.id, items: data ?? [] })
  }
  const saveEnrollment = async (event: FormEvent) => {
    event.preventDefault(); if (!supabase || !editingEnrollment) return
    const { error } = await supabase.rpc('admin_update_enrollment_details', { p_enrollment_id: editingEnrollment.id, p_school_year: editYear, p_grade_level: editGrade, p_section_id: editSection || null, p_enrollment_type: editType })
    if (error) setMessage(friendlyError(error)); else { setMessage('Enrollment details updated.'); setEditingEnrollment(null); await refresh() }
  }
  const years = [...new Set(rows.map((r) => r.school_year))].sort().reverse()
  const grades = [...new Set(rows.map((r) => r.grade_level))].sort()
  const steps = registration.enrollment_type === 'RETURNING' ? ['Existing student & academic information','Review'] : ['Personal information', 'Parent / guardian', 'Academic information', 'Account registration', 'Review']
  const field = (label: string, key: keyof Registration, type = 'text', required = true) => <label className="block text-sm font-medium">{label}<input data-step="active" required={required} type={type} value={registration[key]} onChange={(e) => updateField(key, e.target.value as Registration[typeof key])} className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5" /></label>

  return <Frame title="Enrollment management" subtitle="Register students, review enrollment status, and maintain school-year records.">
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">{[['Total enrolled', counts.total], ['New registrations', counts.newStudents], ['Pending', counts.pending], ['Approved', counts.approved], ['Rejected', counts.rejected]].map(([label, value]) => <div key={String(label)} className="rounded-2xl border bg-white p-4 shadow-sm"><p className="text-sm text-slate-500">{label}</p><p className="mt-2 text-2xl font-bold">{value}</p></div>)}</div>
    <div className="grid gap-4 lg:grid-cols-3">{[['By grade level',gradeStats],['By section',sectionStats],['By school year',yearStats]].map(([title,entries])=><section key={String(title)} className="rounded-2xl border bg-white p-4 shadow-sm"><h3 className="font-bold">{String(title)}</h3>{(entries as {value:string;count:number}[]).map((item)=><div key={item.value} className="mt-3 flex justify-between border-t pt-2 text-sm"><span>{item.value}</span><b>{item.count}</b></div>)}{!(entries as {value:string;count:number}[]).length&&<p className="mt-3 text-sm text-slate-500">No enrollment records.</p>}</section>)}</div>
    <section className="rounded-3xl border bg-white p-4 shadow-sm sm:p-5"><div className="mb-4 flex flex-wrap items-center justify-between gap-3"><div><h3 className="text-lg font-bold">Enrollment records</h3><p className="text-sm text-slate-500">{filtered.length} matching record{filtered.length === 1 ? '' : 's'}</p></div><button onClick={() => { setShowForm((v) => !v); setTempPassword('') }} className="rounded-xl bg-[var(--color-brand-dark)] px-4 py-2.5 text-sm font-semibold text-white">{showForm ? 'Close registration' : '+ Register new student'}</button></div>
      {message && <p role="status" className="mb-4 rounded-xl bg-slate-50 p-3 text-sm text-slate-700">{message}</p>}
      {tempPassword && <div className="mb-4 rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm"><b>One-time temporary password</b><p className="mt-1">Copy this securely and provide it to the student: <code className="select-all font-bold">{tempPassword}</code></p><button onClick={() => void navigator.clipboard?.writeText(tempPassword)} className="mt-2 rounded-lg border bg-white px-3 py-1.5">Copy password</button></div>}
      {showForm && <form onSubmit={(e) => void createStudent(e)} className="mb-5 rounded-2xl bg-slate-50 p-4 sm:p-5"><label className="mb-4 block max-w-sm text-sm font-semibold">Enrollment type<select value={registration.enrollment_type} onChange={(e)=>{updateField('enrollment_type',e.target.value as Registration['enrollment_type']);setExistingStudentId('');setStep(0)}} className="mt-1 w-full rounded-xl border bg-white px-3 py-2.5"><option value="NEW">New student</option><option value="RETURNING">Returning student</option></select></label><div className="mb-4 flex flex-wrap gap-2">{steps.map((title, i) => <button type="button" onClick={() => setStep(i)} key={title} className={`rounded-full px-3 py-1.5 text-xs font-semibold ${step === i ? 'bg-emerald-800 text-white' : 'bg-white text-slate-600'}`}>{i + 1}. {title}</button>)}</div>
        {step === 0 && registration.enrollment_type==='RETURNING' && <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"><label className="block text-sm font-medium sm:col-span-2">Existing student account<select data-step="active" required value={existingStudentId} onChange={(e)=>{setExistingStudentId(e.target.value);const selected=existingStudents.find((s)=>s.id===e.target.value);if(selected){updateField('student_id',selected.student_id);updateField('grade_level',selected.grade_level)}}} className="mt-1 w-full rounded-xl border bg-white px-3 py-2.5"><option value="">Select a student</option>{existingStudents.map((s)=><option key={s.id} value={s.id}>{s.student_id} · {s.full_name} · {s.email}</option>)}</select></label><label className="block text-sm font-medium">Grade level<input data-step="active" required value={registration.grade_level} onChange={(e)=>updateField('grade_level',e.target.value)} className="mt-1 w-full rounded-xl border bg-white px-3 py-2.5"/></label><label className="block text-sm font-medium">Section<select value={registration.section_id} onChange={(e)=>updateField('section_id',e.target.value)} className="mt-1 w-full rounded-xl border bg-white px-3 py-2.5"><option value="">Unassigned</option>{sections.filter((s)=>s.grade_level===registration.grade_level).map((s)=><option key={s.id} value={s.id}>{s.name}</option>)}</select></label>{field('School year','school_year')}</div>}
        {step === 0 && registration.enrollment_type==='NEW' && <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{field('First name','first_name')}{field('Middle name','middle_name','text',false)}{field('Last name','last_name')}{field('Suffix','suffix','text',false)}{field('Date of birth','birth_date','date')}{<label className="block text-sm font-medium">Gender<select data-step="active" required value={registration.gender} onChange={(e)=>updateField('gender',e.target.value)} className="mt-1 w-full rounded-xl border bg-white px-3 py-2.5"><option value="">Select</option><option>Female</option><option>Male</option><option>Prefer not to say</option></select></label>}{field('Address','address')}{field('Contact number','phone','tel',false)}</div>}
        {step === 1 && registration.enrollment_type==='NEW' && <div className="grid gap-3 sm:grid-cols-2">{field('Parent / guardian full name','guardian_full_name')}{field('Relationship','guardian_relationship')}{field('Contact number','guardian_contact_number','tel')}{field('Address','guardian_address','text',false)}</div>}
        {step === 2 && registration.enrollment_type==='NEW' && <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{field('Student number','student_id')}{field('Grade level','grade_level')}{<label className="block text-sm font-medium">Section<select value={registration.section_id} onChange={(e)=>updateField('section_id',e.target.value)} className="mt-1 w-full rounded-xl border bg-white px-3 py-2.5"><option value="">Unassigned</option>{sections.filter((s)=>s.grade_level===registration.grade_level).map((s)=><option key={s.id} value={s.id}>{s.name}</option>)}</select></label>}{field('School year (e.g. 2026–2027)','school_year')}</div>}
        {step === 3 && registration.enrollment_type==='NEW' && <div className="grid gap-3 sm:grid-cols-2"><div className="rounded-xl bg-white p-4 text-sm text-slate-600 sm:col-span-2">A secure temporary password will be generated during registration and shown once for the administrator to share through the school’s approved process.</div>{field('Student email address','email','email')}</div>}
        {((registration.enrollment_type==='NEW'&&step===4)||(registration.enrollment_type==='RETURNING'&&step===1)) && <div className="rounded-xl bg-white p-4"><h4 className="font-bold">Review registration</h4><dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">{Object.entries(registration).map(([key,value])=><div key={key}><dt className="text-xs capitalize text-slate-500">{key.replaceAll('_',' ')}</dt><dd>{key==='section_id' ? sections.find((s)=>s.id===value)?.name ?? 'Unassigned' : value || '—'}</dd></div>)}</dl><p className="mt-4 text-sm text-amber-800">{registration.enrollment_type==='NEW'?'A new student account and pending enrollment record will be created. Student number and email must be unique.':'The existing student account will be reused and a pending enrollment record will be added for this school year.'}</p></div>}
        <div className="mt-4 flex justify-between"><button type="button" disabled={step===0} onClick={()=>setStep(step-1)} className="rounded-xl border px-4 py-2 text-sm disabled:opacity-40">Back</button>{step<steps.length-1?<button type="button" onClick={next} className="rounded-xl bg-emerald-800 px-4 py-2 text-sm font-semibold text-white">Continue</button>:<button disabled={busy} className="rounded-xl bg-emerald-800 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{busy?'Registering…':'Confirm registration'}</button>}</div>
      </form>}
      <div className="mb-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-6"><input value={query} onChange={(e)=>setQuery(e.target.value)} placeholder="Search student name or number" className="rounded-xl border px-3 py-2 text-sm xl:col-span-2"/><select value={gradeFilter} onChange={(e)=>setGradeFilter(e.target.value)} className="rounded-xl border px-3 py-2 text-sm"><option value="all">All grades</option>{grades.map((g)=><option key={g}>{g}</option>)}</select><select value={sectionFilter} onChange={(e)=>setSectionFilter(e.target.value)} className="rounded-xl border px-3 py-2 text-sm"><option value="all">All sections</option>{sections.map((s)=><option key={s.id} value={s.id}>{s.name}</option>)}</select><select value={yearFilter} onChange={(e)=>setYearFilter(e.target.value)} className="rounded-xl border px-3 py-2 text-sm"><option value="all">All school years</option>{years.map((y)=><option key={y}>{y}</option>)}</select><select value={statusFilter} onChange={(e)=>setStatusFilter(e.target.value)} className="rounded-xl border px-3 py-2 text-sm"><option value="all">All statuses</option>{['PENDING','APPROVED','REJECTED','ENROLLED'].map((v)=><option key={v}>{v}</option>)}</select></div>
      <div className="overflow-x-auto"><table className="min-w-full text-left text-sm"><thead className="bg-slate-50 text-slate-500"><tr>{['Student no.','Student name','Grade','Section','School year','Type','Status','Registered','Review'].map((h)=><th key={h} className="whitespace-nowrap px-3 py-3">{h}</th>)}</tr></thead><tbody>{filtered.map((r)=><tr key={r.id} className="border-t"><td className="px-3 py-3 font-semibold">{r.students?.student_id}</td><td className="px-3 py-3">{r.students?.profiles?.full_name}<span className="block text-xs text-slate-500">{r.students?.profiles?.email}</span></td><td className="px-3 py-3">{r.grade_level}</td><td className="px-3 py-3">{r.sections?.name ?? 'Unassigned'}</td><td className="px-3 py-3">{r.school_year}</td><td className="px-3 py-3">{r.enrollment_type}</td><td className="px-3 py-3"><Tag value={r.status}/></td><td className="px-3 py-3">{dateLabel(r.date_registered)}</td><td className="min-w-64 px-3 py-3"><input aria-label="Review remarks" value={remarks[r.id] ?? r.remarks ?? ''} onChange={(e)=>setRemarks((old)=>({...old,[r.id]:e.target.value}))} placeholder="Remarks (required to reject)" className="mb-2 w-full rounded-lg border px-2 py-1.5 text-xs"/><div className="flex flex-wrap gap-2"><button onClick={()=>{setEditingEnrollment(r);setEditYear(r.school_year);setEditGrade(r.grade_level);setEditSection(r.section_id??'');setEditType(r.enrollment_type)}} className="font-semibold text-slate-700">Edit</button><button onClick={()=>void showHistory(r)} className="font-semibold text-slate-700">History</button>{r.status==='PENDING'&&<><button onClick={()=>void review(r,'APPROVED')} className="font-semibold text-emerald-800">Approve</button><button onClick={()=>void review(r,'REJECTED')} className="font-semibold text-rose-700">Reject</button></>}{r.status==='APPROVED'&&<button onClick={()=>void review(r,'ENROLLED')} className="font-semibold text-emerald-800">Mark enrolled</button>}{r.status==='REJECTED'&&<button onClick={()=>void review(r,'PENDING')} className="font-semibold">Reopen</button>}</div></td></tr>)}{!filtered.length&&<tr><td colSpan={9} className="px-3 py-8 text-center text-slate-500">No enrollment records match these filters.</td></tr>}</tbody></table></div>
    </section>
    {history&&<div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-4" onClick={()=>setHistory(null)}><div role="dialog" aria-modal="true" onClick={(e)=>e.stopPropagation()} className="w-full max-w-xl rounded-3xl bg-white p-5"><div className="flex justify-between"><h3 className="font-bold">Enrollment history · {history.id}</h3><button onClick={()=>setHistory(null)}>Close</button></div><div className="mt-4 space-y-3">{history.items.map((item,i)=><div key={i} className="rounded-xl bg-slate-50 p-3 text-sm"><b>{String(item.old_status??'Created')} ? {String(item.new_status)}</b><p className="text-slate-500">{dateLabel(String(item.changed_at))} · {String(item.remarks??'No remarks')}</p></div>)}{!history.items.length&&<p className="text-sm text-slate-500">No history recorded.</p>}</div></div></div>}
    {editingEnrollment&&<div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-4"><form onSubmit={(e)=>void saveEnrollment(e)} className="w-full max-w-lg space-y-3 rounded-3xl bg-white p-6"><div className="flex justify-between"><h3 className="text-lg font-bold">Edit enrollment · {editingEnrollment.students?.student_id}</h3><button type="button" onClick={()=>setEditingEnrollment(null)}>Close</button></div><label className="block text-sm font-semibold">School year<input required value={editYear} onChange={(e)=>setEditYear(e.target.value)} className="mt-1 w-full rounded-xl border px-3 py-2.5"/></label><label className="block text-sm font-semibold">Grade level<input required value={editGrade} onChange={(e)=>{setEditGrade(e.target.value);setEditSection('')}} className="mt-1 w-full rounded-xl border px-3 py-2.5"/></label><label className="block text-sm font-semibold">Section<select value={editSection} onChange={(e)=>setEditSection(e.target.value)} className="mt-1 w-full rounded-xl border px-3 py-2.5"><option value="">Unassigned</option>{sections.filter((s)=>s.grade_level===editGrade).map((s)=><option key={s.id} value={s.id}>{s.name}</option>)}</select></label><label className="block text-sm font-semibold">Enrollment type<select value={editType} onChange={(e)=>setEditType(e.target.value as 'NEW'|'RETURNING')} className="mt-1 w-full rounded-xl border px-3 py-2.5"><option value="NEW">New</option><option value="RETURNING">Returning</option></select></label><button className="rounded-xl bg-emerald-800 px-4 py-2 font-semibold text-white">Save enrollment</button></form></div>}
  </Frame>
}

type ExportKind = 'students'|'student-personal'|'student-academic'|'student-grade'|'student-section'|'attendance-history'|'early-out-history'|'guard-scan-activity'|'enrollments'|'new-enrollments'|'returning-enrollments'|'enrollment-summary'|'enrollment-grade'|'enrollment-section'|'enrollment-year'|'pending-enrollments'|'approved-enrollments'|'rejected-enrollments'|'administrators'|'teachers'|'guards'|'parents'|'student-accounts'|'active-accounts'|'inactive-accounts'|'grades'|'sections'|'assignments'
type ExportField = { key: string; label: string }
const exportChoices: {id:ExportKind;label:string;group:string}[] = [
  {id:'students',label:'Complete student master list',group:'Student information'}, {id:'student-personal',label:'Student personal information',group:'Student information'}, {id:'student-academic',label:'Student academic information',group:'Student information'}, {id:'student-grade',label:'Student directory by grade level',group:'Student information'}, {id:'student-section',label:'Student directory by section',group:'Student information'}, {id:'attendance-history',label:'Student daily / monthly attendance history',group:'Student information'}, {id:'early-out-history',label:'Early-out gate transactions',group:'Student information'}, {id:'guard-scan-activity',label:'Guard scan activity',group:'Security activity'},
  {id:'enrollments',label:'Student enrollment records',group:'Enrollment information'}, {id:'new-enrollments',label:'New student enrollments',group:'Enrollment information'}, {id:'returning-enrollments',label:'Returning student enrollments',group:'Enrollment information'}, {id:'enrollment-summary',label:'Enrollment summary',group:'Enrollment information'}, {id:'enrollment-grade',label:'Enrollment by grade level',group:'Enrollment information'}, {id:'enrollment-section',label:'Enrollment by section',group:'Enrollment information'}, {id:'enrollment-year',label:'Enrollment by school year',group:'Enrollment information'}, {id:'pending-enrollments',label:'Pending enrollment records',group:'Enrollment information'}, {id:'approved-enrollments',label:'Approved enrollment records',group:'Enrollment information'}, {id:'rejected-enrollments',label:'Rejected enrollment records',group:'Enrollment information'},
  {id:'administrators',label:'Administrator accounts',group:'User accounts'}, {id:'teachers',label:'Teacher accounts',group:'User accounts'}, {id:'guards',label:'Guard accounts',group:'User accounts'}, {id:'parents',label:'Parent / guardian accounts',group:'User accounts'}, {id:'student-accounts',label:'Student accounts',group:'User accounts'}, {id:'active-accounts',label:'Active accounts',group:'User accounts'}, {id:'inactive-accounts',label:'Inactive accounts',group:'User accounts'},
  {id:'grades',label:'Grade level lists',group:'Academic organization'}, {id:'sections',label:'Section lists',group:'Academic organization'}, {id:'assignments',label:'Student-to-section assignments',group:'Academic organization'},
]
const exportFieldMap: Record<ExportKind,ExportField[]> = {
  students:[['student_id','Student number'],['full_name','Full name'],['gender','Gender'],['birth_date','Date of birth'],['grade_level','Grade level'],['section','Section'],['school_year','School year'],['enrollment_status','Enrollment status'],['email','Email'],['phone','Contact number'],['address','Address'],['guardian_full_name','Guardian name'],['guardian_relationship','Guardian relationship'],['guardian_contact_number','Guardian contact'],['guardian_address','Guardian address'],['created_at','Date registered']].map(([key,label])=>({key,label})),
  'student-personal':[['student_id','Student number'],['full_name','Full name'],['gender','Gender'],['birth_date','Date of birth'],['address','Address'],['phone','Contact number'],['guardian_full_name','Guardian name'],['guardian_relationship','Guardian relationship'],['guardian_contact_number','Guardian contact'],['guardian_address','Guardian address']].map(([key,label])=>({key,label})),
  'student-academic':[['student_id','Student number'],['full_name','Full name'],['grade_level','Grade level'],['section','Section'],['school_year','School year'],['enrollment_status','Enrollment status'],['date_registered','Date registered']].map(([key,label])=>({key,label})),
  'student-grade':[['student_id','Student number'],['full_name','Full name'],['grade_level','Grade level'],['section','Section'],['enrollment_status','Enrollment status']].map(([key,label])=>({key,label})),
  'student-section':[['student_id','Student number'],['full_name','Full name'],['grade_level','Grade level'],['section','Section'],['enrollment_status','Enrollment status']].map(([key,label])=>({key,label})),
  'attendance-history':[['student_id','Student number'],['full_name','Student name'],['grade_level','Grade level'],['section','Section'],['event_type','Gate transaction'],['actual_scan_time','Actual transaction time'],['verification_result','Verification'],['sync_status','Transaction status'],['guard_name','Recorded by guard'],['scanning_guard_id','Guard account ID'],['scan_origin','Origin'],['synchronized_at','Synchronized at']].map(([key,label])=>({key,label})),
  'early-out-history':[['student_id','Student number'],['full_name','Student name'],['grade_level','Grade level'],['section','Section'],['event_type','Gate transaction'],['actual_scan_time','Actual departure time'],['verification_result','Verification'],['sync_status','Transaction status'],['guard_name','Recorded by guard'],['scanning_guard_id','Guard account ID'],['scan_origin','Origin'],['synchronized_at','Synchronized at']].map(([key,label])=>({key,label})),
  'guard-scan-activity':[['actual_scan_time','Scan time'],['person_name','Student or teacher'],['person_type','Person type'],['person_display_id','Student / teacher ID'],['guard_name','Guard'],['scanning_guard_id','Guard account ID'],['event_type','Action'],['transaction_method','Method'],['scan_origin','Origin'],['sync_status','Transaction status'],['synchronized_at','Synchronized at'],['scan_device_id','Device ID']].map(([key,label])=>({key,label})),
  enrollments:[['student_id','Student number'],['full_name','Student name'],['grade_level','Grade level'],['section','Section'],['school_year','School year'],['enrollment_type','Enrollment type'],['status','Enrollment status'],['date_registered','Date registered'],['remarks','Remarks']].map(([key,label])=>({key,label})),
  'new-enrollments':[['student_id','Student number'],['full_name','Student name'],['grade_level','Grade level'],['section','Section'],['school_year','School year'],['enrollment_type','Enrollment type'],['status','Enrollment status'],['date_registered','Date registered'],['remarks','Remarks']].map(([key,label])=>({key,label})), 'returning-enrollments':[['student_id','Student number'],['full_name','Student name'],['grade_level','Grade level'],['section','Section'],['school_year','School year'],['enrollment_type','Enrollment type'],['status','Enrollment status'],['date_registered','Date registered'],['remarks','Remarks']].map(([key,label])=>({key,label})),
  'enrollment-summary':[{key:'group',label:'School year'},{key:'total',label:'Total'},{key:'pending',label:'Pending'},{key:'approved',label:'Approved'},{key:'rejected',label:'Rejected'},{key:'enrolled',label:'Enrolled'}], 'enrollment-grade':[{key:'group',label:'Grade level'},{key:'total',label:'Total'},{key:'pending',label:'Pending'},{key:'approved',label:'Approved'},{key:'rejected',label:'Rejected'},{key:'enrolled',label:'Enrolled'}], 'enrollment-section':[{key:'group',label:'Section'},{key:'total',label:'Total'},{key:'pending',label:'Pending'},{key:'approved',label:'Approved'},{key:'rejected',label:'Rejected'},{key:'enrolled',label:'Enrolled'}], 'enrollment-year':[{key:'group',label:'School year'},{key:'total',label:'Total'},{key:'pending',label:'Pending'},{key:'approved',label:'Approved'},{key:'rejected',label:'Rejected'},{key:'enrolled',label:'Enrolled'}], 'pending-enrollments':[['student_id','Student number'],['full_name','Student name'],['grade_level','Grade level'],['section','Section'],['school_year','School year'],['date_registered','Date registered'],['remarks','Remarks']].map(([key,label])=>({key,label})), 'approved-enrollments':[['student_id','Student number'],['full_name','Student name'],['grade_level','Grade level'],['section','Section'],['school_year','School year'],['date_registered','Date registered'],['remarks','Remarks']].map(([key,label])=>({key,label})), 'rejected-enrollments':[['student_id','Student number'],['full_name','Student name'],['grade_level','Grade level'],['section','Section'],['school_year','School year'],['date_registered','Date registered'],['remarks','Remarks']].map(([key,label])=>({key,label})),
  administrators:[],teachers:[],guards:[],parents:[],'student-accounts':[],'active-accounts':[],'inactive-accounts':[],grades:[{key:'grade_level',label:'Grade level'}],sections:[{key:'grade_level',label:'Grade level'},{key:'section',label:'Section'}],assignments:[{key:'student_id',label:'Student number'},{key:'full_name',label:'Full name'},{key:'grade_level',label:'Grade level'},{key:'section',label:'Section'}],
}
const accountFields:ExportField[]=[{key:'full_name',label:'Full name'},{key:'email',label:'Email'},{key:'role',label:'Role'},{key:'is_active',label:'Active'},{key:'created_at',label:'Date created'}]
const studentExportKinds: ExportKind[] = ['students','student-personal','student-academic','student-grade','student-section']
const attendanceExportKinds: ExportKind[] = ['attendance-history','early-out-history']
const guardActivityKind = (kind: ExportKind) => kind === 'guard-scan-activity'
const enrollmentExportKinds: ExportKind[] = ['enrollments','new-enrollments','returning-enrollments','enrollment-summary','enrollment-grade','enrollment-section','enrollment-year','pending-enrollments','approved-enrollments','rejected-enrollments']

export function DataExport({ profile }: Props) {
  const [kind,setKind]=useState<ExportKind>('students'); const [fields,setFields]=useState<string[]>([]); const [rows,setRows]=useState<Record<string,unknown>[]>([]); const [loading,setLoading]=useState(false); const [previewed,setPreviewed]=useState(false); const [message,setMessage]=useState('')
  const [grade,setGrade]=useState('all');const [section,setSection]=useState('all');const [year,setYear]=useState('all');const [status,setStatus]=useState('all');const [accountStatus,setAccountStatus]=useState('all');const [dateFrom,setDateFrom]=useState('');const [dateTo,setDateTo]=useState('')
  const [gender,setGender]=useState('all')
  const [facets,setFacets]=useState({grades:[] as string[],sections:[] as {id:string;name:string}[],years:[] as string[],guards:[] as {id:string;full_name:string}[]})
  const [guardFilter,setGuardFilter]=useState('all');const [personTypeFilter,setPersonTypeFilter]=useState('all');const [eventTypeFilter,setEventTypeFilter]=useState('all');const [originFilter,setOriginFilter]=useState('all');const [syncFilter,setSyncFilter]=useState('all')
  const [reportSearch,setReportSearch]=useState('');const [reportPage,setReportPage]=useState(0)
  const [scanSort,setScanSort]=useState('latest')
  const accountKind=['administrators','teachers','guards','parents','student-accounts','active-accounts','inactive-accounts'].includes(kind)
  const studentKind=studentExportKinds.includes(kind)
  const attendanceKind=attendanceExportKinds.includes(kind)||guardActivityKind(kind)
  const enrollmentKind=enrollmentExportKinds.includes(kind)
  const columns=kind==='student-accounts'?[...accountFields,{key:'student_id',label:'Student number'},{key:'grade_level',label:'Grade level'},{key:'section',label:'Section'}]:accountKind?accountFields:exportFieldMap[kind]
  const defaults=()=>kind==='student-personal'?columns.filter((c)=>['student_id','full_name','gender'].includes(c.key)).map((c)=>c.key):studentKind?columns.filter((c)=>['student_id','full_name','grade_level','section','school_year','enrollment_status','created_at'].includes(c.key)).map((c)=>c.key):columns.map((c)=>c.key)
  useEffect(()=>{void(async()=>{if(!supabase)return;const [students,enrollments,sectionRows,guardRows]=await Promise.all([supabase.from('students').select('grade_level').limit(10000),supabase.from('enrollment_records').select('school_year').limit(10000),supabase.from('sections').select('id,name').order('name'),supabase.from('profiles').select('id,full_name').eq('role','guard').order('full_name')]);setFacets({grades:[...new Set((students.data??[]).map((r)=>r.grade_level))].sort(),sections:sectionRows.data??[],years:[...new Set((enrollments.data??[]).map((r)=>r.school_year))].sort().reverse(),guards:guardRows.data??[]})})()},[])
  useEffect(()=>{setFields(defaults());setPreviewed(false);setRows([]);setStatus('all');setAccountStatus('all');setGuardFilter('all');setPersonTypeFilter('all');setEventTypeFilter('all');setOriginFilter('all');setSyncFilter('all')},[kind])
  const loadRows=async()=>{
    if(!supabase)return
    setLoading(true);setPreviewed(false);setMessage('');setReportPage(0)
    let data:Record<string,unknown>[]=[];let error: {message:string}|null=null
    if(accountKind){
      const role:ManagedRole|undefined=kind==='administrators'?'administrator':kind==='teachers'?'teacher':kind==='guards'?'guard':kind==='parents'?'parent':kind==='student-accounts'?'student':undefined
      let q=supabase.from('profiles').select('id,full_name,email,role,is_active,created_at,students(student_id,grade_level,section_id,sections(name))').in('role',['administrator','teacher','guard','student','parent']).order('created_at',{ascending:false}).limit(10000)
      if(role)q=q.eq('role',role);if(kind==='active-accounts'||(kind!=='inactive-accounts'&&accountStatus==='active'))q=q.eq('is_active',true);if(kind==='inactive-accounts'||(kind!=='active-accounts'&&accountStatus==='inactive'))q=q.eq('is_active',false)
      if(dateFrom)q=q.gte('created_at',`${dateFrom}T00:00:00`);if(dateTo)q=q.lte('created_at',`${dateTo}T23:59:59`)
      const result=await q;error=result.error;data=(result.data??[]).map((p:any)=>({...p,student_id:p.students?.student_id,grade_level:p.students?.grade_level,section:p.students?.sections?.name}))
    }else if(kind==='grades'||kind==='sections'){
      let q=supabase.from('sections').select('id,name,grade_level').order('grade_level').order('name').limit(10000)
      const result=await q;error=result.error;data=(result.data??[]).map((s)=>({grade_level:s.grade_level,section:s.name}))
      if(kind==='grades')data=[...new Map(data.map((r)=>[String(r.grade_level),r])).values()]
    }else if(enrollmentKind){
      let q=supabase.from('enrollment_records').select('id,student_id,school_year,grade_level,section_id,enrollment_type,status,date_registered,remarks,sections(name),students(student_id,profiles(full_name))').order('date_registered',{ascending:false}).limit(10000)
      if(grade!=='all')q=q.eq('grade_level',grade);if(section!=='all')q=q.eq('section_id',section);if(year!=='all')q=q.eq('school_year',year);if(status!=='all')q=q.eq('status',status);if(kind==='new-enrollments')q=q.eq('enrollment_type','NEW');if(kind==='returning-enrollments')q=q.eq('enrollment_type','RETURNING');if(kind==='pending-enrollments')q=q.eq('status','PENDING');if(kind==='approved-enrollments')q=q.eq('status','APPROVED');if(kind==='rejected-enrollments')q=q.eq('status','REJECTED');if(dateFrom)q=q.gte('date_registered',`${dateFrom}T00:00:00`);if(dateTo)q=q.lte('date_registered',`${dateTo}T23:59:59`)
      const result=await q;error=result.error;data=(result.data??[]).map((r:any)=>({...r,student_id:r.students?.student_id,full_name:r.students?.profiles?.full_name,section:r.sections?.name}))
      if(!error&&['enrollment-summary','enrollment-grade','enrollment-section','enrollment-year'].includes(kind)){const groupKey=kind==='enrollment-grade'?'grade_level':kind==='enrollment-section'?'section':kind==='enrollment-year'?'school_year':'school_year';const groups=new Map<string,Record<string,unknown>>();for(const row of data){const key=String(row[groupKey]??'Unspecified');const current=groups.get(key)??{group:key,total:0,pending:0,approved:0,rejected:0,enrolled:0};current.total=Number(current.total)+1;current[String(row.status).toLowerCase()]=Number(current[String(row.status).toLowerCase()]??0)+1;groups.set(key,current)}data=[...groups.values()].sort((a,b)=>String(a.group).localeCompare(String(b.group)))}
    }else if(attendanceKind){
      const scanReport=guardActivityKind(kind)
      let q=supabase.from('attendance_events').select('id,person_type,person_id,event_type,actual_scan_time,verification_result,sync_status,scanning_guard_id,scanning_guard_name,scan_origin,synchronized_at,scan_device_id').order('actual_scan_time',{ascending:scanSort==='earliest'}).limit(10000)
      if(!scanReport)q=q.eq('person_type','student')
      if(kind==='early-out-history')q=q.eq('event_type','EARLY_OUT')
      if(scanReport&&guardFilter!=='all')q=q.eq('scanning_guard_id',guardFilter)
      if(scanReport&&personTypeFilter!=='all')q=q.eq('person_type',personTypeFilter)
      if(scanReport&&eventTypeFilter!=='all')q=q.eq('event_type',eventTypeFilter)
      if(scanReport&&originFilter!=='all')q=q.eq('scan_origin',originFilter)
      if(scanReport&&syncFilter!=='all')q=q.eq('sync_status',syncFilter)
      if(dateFrom)q=q.gte('actual_scan_time',`${dateFrom}T00:00:00+08:00`);if(dateTo)q=q.lte('actual_scan_time',`${dateTo}T23:59:59+08:00`)
      const result=await q;error=result.error
      const events=result.data??[];const studentIds=[...new Set(events.filter(e=>e.person_type==='student').map(e=>String(e.person_id)))];const teacherIds=[...new Set(events.filter(e=>e.person_type==='teacher').map(e=>String(e.person_id)))];const guardIds=[...new Set(events.map(e=>e.scanning_guard_id).filter(Boolean).map(String))]
      const [studentRows,teacherRows,guardRows]=await Promise.all([
        studentIds.length?supabase.from('students').select('id,student_id,grade_level,section_id,profiles(full_name),sections(name)').in('id',studentIds):Promise.resolve({data:[],error:null}),
        teacherIds.length?supabase.from('teachers').select('id,teacher_id,designation,profiles(full_name)').in('id',teacherIds):Promise.resolve({data:[],error:null}),
        guardIds.length?supabase.from('profiles').select('id,full_name').in('id',guardIds):Promise.resolve({data:[],error:null}),
      ])
      error=error??studentRows.error??teacherRows.error??guardRows.error
      const studentMap=new Map((studentRows.data??[]).map((s:any)=>[s.id,s]));const teacherMap=new Map((teacherRows.data??[]).map((t:any)=>[t.id,t]));const guardMap=new Map((guardRows.data??[]).map((g:any)=>[g.id,g.full_name]))
      data=events.flatMap(event=>{
        const student:any=event.person_type==='student'?studentMap.get(event.person_id):null;const teacher:any=event.person_type==='teacher'?teacherMap.get(event.person_id):null;const person=student??teacher
        if(!person)return[]
        const sectionName=student?.sections?.name??'';if(grade!=='all'&&student?.grade_level!==grade)return[];if(section!=='all'&&student?.section_id!==section)return[]
        const personName=person.profiles?.full_name??'';const displayId=student?.student_id??teacher?.teacher_id??''
        return [{id:event.id,student_id:displayId,person_display_id:displayId,person_name:personName,person_type:event.person_type,full_name:personName,grade_level:student?.grade_level??teacher?.designation??'',section:sectionName,event_type:event.event_type,actual_scan_time:event.actual_scan_time,verification_result:event.verification_result,sync_status:event.sync_status,guard_name:event.scanning_guard_name??guardMap.get(event.scanning_guard_id)??'',scanning_guard_id:event.scanning_guard_id??'',scan_origin:event.scan_origin??'Unknown',synchronized_at:event.synchronized_at,scan_device_id:event.scan_device_id??'',transaction_method:event.verification_result==='MANUAL_VERIFIED'?'Manual':'QR'}]
      })
    }else if(studentKind){
      let q=supabase.from('students').select('id,student_id,grade_level,section_id,status,first_name,middle_name,last_name,suffix,created_at,profiles(full_name,email,phone),sections(name),enrollment_records(school_year,status,date_registered),student_private_details(birth_date,gender,address,guardian_full_name,guardian_relationship,guardian_contact_number,guardian_address)').order('student_id').limit(10000)
      if(grade!=='all')q=q.eq('grade_level',grade);if(section!=='all')q=q.eq('section_id',section);if(dateFrom)q=q.gte('created_at',`${dateFrom}T00:00:00`);if(dateTo)q=q.lte('created_at',`${dateTo}T23:59:59`)
      const result=await q;error=result.error;data=(result.data??[]).map((r:any)=>{const e=Array.isArray(r.enrollment_records)?r.enrollment_records[0]:r.enrollment_records;const d=Array.isArray(r.student_private_details)?r.student_private_details[0]:r.student_private_details;return {...r,...d,full_name:r.profiles?.full_name,email:r.profiles?.email,phone:r.profiles?.phone,section:r.sections?.name,school_year:e?.school_year,enrollment_status:e?.status??r.status,date_registered:e?.date_registered??r.created_at}})
    }
    if(error){setMessage(friendlyError(error));setRows([])}else{if(guardActivityKind(kind)&&['guard','person','event'].includes(scanSort)){const key=scanSort==='guard'?'guard_name':scanSort==='person'?'person_name':'event_type';data.sort((a,b)=>String(a[key]??'').localeCompare(String(b[key]??'')))}setRows(data);setPreviewed(true)}
    setLoading(false)
  }
  const filteredRows=rows.filter((r)=>{if(accountKind&&kind!=='active-accounts'&&kind!=='inactive-accounts'&&accountStatus!=='all'&&String(r.is_active)!==(accountStatus==='active'?'true':'false'))return false;if((studentKind||attendanceKind||kind==='assignments')&&grade!=='all'&&r.grade_level!==grade)return false;if(studentKind&&status!=='all'&&r.enrollment_status!==status&&r.status!==status)return false;if(studentKind&&gender!=='all'&&r.gender!==gender)return false;if(studentKind&&year!=='all'&&r.school_year!==year)return false;if(studentKind&&dateFrom&&String(r.created_at).slice(0,10)<dateFrom)return false;if(studentKind&&dateTo&&String(r.created_at).slice(0,10)>dateTo)return false;if((studentKind||attendanceKind)&&section!=='all'&&r.section!==sectionsName(rows,section)&&r.section!==facets.sections.find(s=>s.id===section)?.name)return false;if(guardActivityKind(kind)&&reportSearch&&!`${r.person_name??''} ${r.person_display_id??''} ${r.guard_name??''} ${r.scanning_guard_id??''}`.toLowerCase().includes(reportSearch.toLowerCase()))return false;return true})
  const selectedColumns=columns.filter((c)=>fields.includes(c.key))
  const toggleField=(key:string)=>setFields((old)=>old.includes(key)?old.filter((x)=>x!==key):[...old,key])
  const setDefault=()=>setFields(defaults())
  const reportTitle=exportChoices.find((x)=>x.id===kind)?.label??'School report'
  const dataRows=filteredRows.map((r)=>Object.fromEntries(selectedColumns.map((c)=>[c.label,formatExportValue(r[c.key])])) )
  const guardSummaryRows=Array.from(rows.reduce((groups,row)=>{const id=String(row.scanning_guard_id||'unknown');const current=groups.get(id)??{guard_name:String(row.guard_name||'Unknown guard'),scanning_guard_id:id,total:0,entries:0,exits:0,early_outs:0,manual:0};current.total++;if(row.event_type==='ENTRY')current.entries++;if(row.event_type==='EXIT')current.exits++;if(row.event_type==='EARLY_OUT')current.early_outs++;if(row.transaction_method==='Manual')current.manual++;groups.set(id,current);return groups},new Map<string,{guard_name:string;scanning_guard_id:string;total:number;entries:number;exits:number;early_outs:number;manual:number}>()).values())
  const recordExport=async(format:'csv'|'xlsx'|'pdf')=>{
    if(!supabase)return
    const {error}=await supabase.rpc('record_export_activity',{p_report:reportTitle,p_category:kind,p_format:format,p_record_count:dataRows.length,p_filters:{grade,section,year,status,accountStatus,gender,dateFrom:dateFrom||null,dateTo:dateTo||null,fields:selectedColumns.map(c=>c.key)}})
    if(error)setMessage(`Export created, but audit logging failed: ${friendlyError(error)}`)
  }
  const exportFile=async(format:'csv'|'xlsx'|'pdf'|'print')=>{
    if(!selectedColumns.length){setMessage('Select at least one field to export.');return}
    const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Manila'}).format(new Date());const base=`valencia-${kind}-${today}`
    if(format==='csv'){const heads=selectedColumns.map((c)=>csvEscape(c.label));const lines=dataRows.map((r)=>selectedColumns.map((c)=>csvEscape(r[c.label])).join(','));downloadBlob(new Blob(['\uFEFF',[heads.join(','),...lines].join('\r\n')],{type:'text/csv;charset=utf-8'}),`${base}.csv`);await recordExport('csv');return}
    if(format==='xlsx'){const XLSX=await import('xlsx');const sheet=XLSX.utils.aoa_to_sheet([['Valencia National High School'],[reportTitle],[`Generated: ${new Date().toLocaleString('en-PH',{timeZone:'Asia/Manila'})} · By ${profile.full_name}`],[`Records: ${dataRows.length}`],selectedColumns.map((c)=>c.label),...dataRows.map((r)=>selectedColumns.map((c)=>r[c.label]))]);sheet['!cols']=selectedColumns.map((c)=>({wch:Math.max(14,Math.min(32,c.label.length+8))}));sheet['!autofilter']={ref:`A5:${String.fromCharCode(64+selectedColumns.length)}${5+dataRows.length}`};const wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,sheet,'Report');XLSX.writeFile(wb,`${base}.xlsx`);await recordExport('xlsx');return}
    if(format==='print'){const escape=(v:unknown)=>String(v??'').replace(/[&<>"']/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));const w=window.open('','_blank');if(!w){setMessage('Allow pop-ups to print the report.');return}w.document.write(`<html><head><title>${escape(reportTitle)}</title><style>body{font:12px Arial;padding:28px;color:#172b24}h1{margin-bottom:4px}table{border-collapse:collapse;width:100%;margin-top:20px}th,td{border:1px solid #cad5cf;padding:7px;text-align:left}th{background:#e8f3ed}@media print{thead{display:table-header-group}tr{break-inside:avoid}}</style></head><body><h1>Valencia National High School</h1><h2>${escape(reportTitle)}</h2><p>Generated ${escape(new Date().toLocaleString('en-PH',{timeZone:'Asia/Manila'}))} by ${escape(profile.full_name)} · ${dataRows.length} records</p><table><thead><tr>${selectedColumns.map((c)=>`<th>${escape(c.label)}</th>`).join('')}</tr></thead><tbody>${dataRows.map((r)=>`<tr>${selectedColumns.map((c)=>`<td>${escape(r[c.label])}</td>`).join('')}</tr>`).join('')}</tbody></table><script>window.print()</script></body></html>`);w.document.close();return}
    const {jsPDF}=await import('jspdf');const landscape=selectedColumns.length>5;const pdf=new jsPDF({orientation:landscape?'landscape':'portrait',unit:'pt',format:'a4'});const pageW=pdf.internal.pageSize.getWidth(),pageH=pdf.internal.pageSize.getHeight(),margin=32;const colW=(pageW-margin*2)/selectedColumns.length;let y=94;const drawHeader=()=>{pdf.setFontSize(14);pdf.setFont('helvetica','bold');pdf.text('Valencia National High School',margin,28);pdf.setFontSize(11);pdf.text(reportTitle,margin,46);pdf.setFont('helvetica','normal');pdf.setFontSize(8);pdf.text(`Generated ${new Date().toLocaleString('en-PH',{timeZone:'Asia/Manila'})} · ${profile.full_name} · ${dataRows.length} records`,margin,61);pdf.setFillColor(225,240,232);pdf.rect(margin,72,pageW-margin*2,18,'F');pdf.setFont('helvetica','bold');selectedColumns.forEach((c,i)=>pdf.text(pdf.splitTextToSize(c.label,colW-8).slice(0,2),margin+i*colW+4,84));pdf.setFont('helvetica','normal');y=98};drawHeader();dataRows.forEach((row,ri)=>{const cells=selectedColumns.map((c)=>pdf.splitTextToSize(String(row[c.label]??''),colW-8) as string[]);const rh=Math.max(20,...cells.map((c)=>c.length*9+8));if(y+rh>pageH-35){pdf.addPage();drawHeader()}if(ri%2===0){pdf.setFillColor(248,250,249);pdf.rect(margin,y-12,pageW-margin*2,rh,'F')}cells.forEach((lines,i)=>pdf.text(lines,margin+i*colW+4,y));pdf.setDrawColor(220,228,223);pdf.line(margin,y+rh-12,pageW-margin,y+rh-12);y+=rh});const pages=pdf.getNumberOfPages();for(let p=1;p<=pages;p++){pdf.setPage(p);pdf.setFontSize(8);pdf.text(`Valencia National High School · Confidential student information`,margin,pageH-16);pdf.text(`${p} / ${pages}`,pageW-margin-30,pageH-16)}pdf.save(`${base}.pdf`);await recordExport('pdf')
  }

  const filtersNeeded=studentKind||attendanceKind||enrollmentKind||kind==='assignments'
  return <Frame title="Data export" subtitle="Choose live school data, select report fields, preview, then export.">
    <section className="rounded-3xl border bg-white p-4 shadow-sm sm:p-5"><div className="grid gap-5 lg:grid-cols-[.8fr_1.2fr]">
      <div><label className="block text-sm font-semibold">Report category<select value={kind} onChange={(e)=>setKind(e.target.value as ExportKind)} className="mt-2 w-full rounded-xl border px-3 py-2.5">{['Student information','Enrollment information','Security activity','User accounts','Academic organization'].map((group)=><optgroup key={group} label={group}>{exportChoices.filter((x)=>x.group===group).map((x)=><option key={x.id} value={x.id}>{x.label}</option>)}</optgroup>)}</select></label>
        <div className="mt-4 flex flex-wrap gap-2">
          {filtersNeeded && <>
            <select value={grade} onChange={e=>{setGrade(e.target.value);setPreviewed(false)}} className="rounded-xl border px-3 py-2 text-sm"><option value="all">All grade levels</option>{facets.grades.map(v=><option key={v}>{v}</option>)}</select>
            {(studentKind||enrollmentKind||attendanceKind) && <select value={section} onChange={e=>{setSection(e.target.value);setPreviewed(false)}} className="rounded-xl border px-3 py-2 text-sm"><option value="all">All sections</option>{facets.sections.map(v=><option key={v.id} value={v.id}>{v.name}</option>)}</select>}
          </>}
          {enrollmentKind && !['pending-enrollments','approved-enrollments','rejected-enrollments'].includes(kind) && <>
            <select value={year} onChange={e=>{setYear(e.target.value);setPreviewed(false)}} className="rounded-xl border px-3 py-2 text-sm"><option value="all">All school years</option>{facets.years.map(v=><option key={v}>{v}</option>)}</select>
            <select value={status} onChange={e=>{setStatus(e.target.value);setPreviewed(false)}} className="rounded-xl border px-3 py-2 text-sm"><option value="all">All enrollment statuses</option>{['PENDING','APPROVED','REJECTED','ENROLLED'].map(v=><option key={v}>{v}</option>)}</select>
          </>}
          {studentKind && <>
            <select value={year} onChange={e=>{setYear(e.target.value);setPreviewed(false)}} className="rounded-xl border px-3 py-2 text-sm"><option value="all">All school years</option>{facets.years.map(v=><option key={v}>{v}</option>)}</select>
            <select value={status} onChange={e=>{setStatus(e.target.value);setPreviewed(false)}} className="rounded-xl border px-3 py-2 text-sm"><option value="all">All student statuses</option>{['pending','active','archived'].map(v=><option key={v}>{v}</option>)}</select>
            <select value={gender} onChange={e=>{setGender(e.target.value);setPreviewed(false)}} className="rounded-xl border px-3 py-2 text-sm"><option value="all">All genders</option>{['Female','Male','Prefer not to say'].map(v=><option key={v}>{v}</option>)}</select>
          </>}
          {guardActivityKind(kind) && <>
            <select value={guardFilter} onChange={e=>{setGuardFilter(e.target.value);setPreviewed(false)}} className="rounded-xl border px-3 py-2 text-sm"><option value="all">All guards</option>{facets.guards.map(g=><option key={g.id} value={g.id}>{g.full_name}</option>)}</select>
            <select value={personTypeFilter} onChange={e=>{setPersonTypeFilter(e.target.value);setPreviewed(false)}} className="rounded-xl border px-3 py-2 text-sm"><option value="all">Students and teachers</option><option value="student">Students</option><option value="teacher">Teachers</option></select>
            <select value={eventTypeFilter} onChange={e=>{setEventTypeFilter(e.target.value);setPreviewed(false)}} className="rounded-xl border px-3 py-2 text-sm"><option value="all">All actions</option>{['ENTRY','EXIT','EARLY_OUT','TEMPORARY_EXIT','RETURN'].map(v=><option key={v}>{v}</option>)}</select>
            <select value={originFilter} onChange={e=>{setOriginFilter(e.target.value);setPreviewed(false)}} className="rounded-xl border px-3 py-2 text-sm"><option value="all">All origins</option><option value="ONLINE">Online</option><option value="OFFLINE">Offline</option></select>
            <select value={syncFilter} onChange={e=>{setSyncFilter(e.target.value);setPreviewed(false)}} className="rounded-xl border px-3 py-2 text-sm"><option value="all">All transaction statuses</option>{['SYNCED','NEEDS_REVIEW','PENDING','FAILED'].map(v=><option key={v}>{v}</option>)}</select>
            <select value={scanSort} onChange={e=>{setScanSort(e.target.value);setPreviewed(false)}} className="rounded-xl border px-3 py-2 text-sm"><option value="latest">Latest scan</option><option value="earliest">Earliest scan</option><option value="guard">Sort by guard</option><option value="person">Sort by person</option><option value="event">Sort by action</option></select>
          </>}
          {accountKind && <select value={accountStatus} onChange={e=>{setAccountStatus(e.target.value);setPreviewed(false)}} className="rounded-xl border px-3 py-2 text-sm"><option value="all">All account statuses</option><option value="active">Active only</option><option value="inactive">Inactive only</option></select>}
          <label className="flex items-center gap-2 rounded-xl border px-2 text-xs text-slate-500">From<input type="date" value={dateFrom} onChange={e=>{setDateFrom(e.target.value);setPreviewed(false)}} className="w-32 py-2 text-sm text-slate-800"/></label>
          <label className="flex items-center gap-2 rounded-xl border px-2 text-xs text-slate-500">To<input type="date" value={dateTo} onChange={e=>{setDateTo(e.target.value);setPreviewed(false)}} className="w-32 py-2 text-sm text-slate-800"/></label>
        </div>
      </div>
      <div>{guardActivityKind(kind)&&<label className="mb-3 block text-sm font-semibold">Search person or guard<input value={reportSearch} onChange={e=>{setReportSearch(e.target.value);setReportPage(0)}} placeholder="Name or account ID" className="mt-1 w-full rounded-xl border px-3 py-2"/></label>}<div className="mb-2 flex flex-wrap items-center justify-between gap-2"><h3 className="font-bold">Fields to include</h3><div className="flex gap-2 text-xs"><button onClick={()=>setFields(columns.map((c)=>c.key))} className="font-semibold text-emerald-800">Select all</button><button onClick={()=>setFields([])} className="font-semibold text-emerald-800">Deselect all</button><button onClick={setDefault} className="font-semibold text-emerald-800">Restore defaults</button></div></div><div className="grid max-h-48 gap-2 overflow-y-auto rounded-xl bg-slate-50 p-3 sm:grid-cols-2">{columns.map((c)=><label key={c.key} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={fields.includes(c.key)} onChange={()=>toggleField(c.key)} className="accent-emerald-700"/>{c.label}</label>)}</div></div>
    </div><div className="mt-5 flex flex-wrap items-center gap-3"><button disabled={loading} onClick={()=>void loadRows()} className="rounded-xl bg-[var(--color-brand-dark)] px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50">{loading?'Loading records…':'Preview report'}</button><span className="text-sm text-slate-600">{previewed?`${filteredRows.length} records will be included`:'Preview to load matching records'}</span></div>{message&&<p role="alert" className="mt-3 text-sm text-rose-700">{message}</p>}</section>
    {previewed&&<section className="rounded-3xl border bg-white p-4 shadow-sm sm:p-5"><div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="text-lg font-bold">{reportTitle}</h3><p className="text-sm text-slate-500">Valencia National High School · Generated by {profile.full_name} · {new Date().toLocaleDateString('en-PH',{timeZone:'Asia/Manila'})} · {filteredRows.length} records</p></div><div className="flex flex-wrap gap-2">{(['pdf','xlsx','csv','print'] as const).map((f)=><button key={f} disabled={!filteredRows.length||!fields.length} onClick={()=>void exportFile(f)} className="rounded-xl border px-3 py-2 text-sm font-semibold uppercase disabled:opacity-40">{f==='xlsx'?'Excel':f==='print'?'Print':f}</button>)}</div></div>{guardActivityKind(kind)&&<div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">{[['Scans',rows.length],['Students',rows.filter(r=>r.person_type==='student').length],['Teachers',rows.filter(r=>r.person_type==='teacher').length],['Entries',rows.filter(r=>r.event_type==='ENTRY').length],['Exits',rows.filter(r=>r.event_type==='EXIT').length],['Early-outs',rows.filter(r=>r.event_type==='EARLY_OUT').length],['Manual',rows.filter(r=>r.transaction_method==='Manual').length],['Offline synced',rows.filter(r=>r.scan_origin==='OFFLINE').length],['Needs review',rows.filter(r=>r.sync_status==='NEEDS_REVIEW').length]].map(([label,value])=><div key={String(label)} className="rounded-xl bg-slate-50 p-3"><p className="text-xs text-slate-500">{label}</p><p className="mt-1 text-lg font-bold">{value}</p></div>)}</div>}<div className="mt-4 overflow-x-auto"><table className="min-w-full text-left text-sm"><thead className="bg-emerald-50"><tr>{selectedColumns.map((c)=><th key={c.key} className="whitespace-nowrap px-3 py-2.5">{c.label}</th>)}</tr></thead><tbody>{dataRows.slice(reportPage*25,reportPage*25+25).map((row,i)=><tr key={i} className="border-t">{selectedColumns.map((c)=><td key={c.key} className="max-w-72 truncate px-3 py-2">{String(row[c.label]??'')}</td>)}</tr>)}{!dataRows.length&&<tr><td colSpan={selectedColumns.length} className="px-3 py-6 text-center text-slate-500">No records match the selected filters.</td></tr>}</tbody></table></div><div className="mt-3 flex items-center justify-end gap-3 text-sm"><span>Page {reportPage+1} of {Math.max(1,Math.ceil(dataRows.length/25))}</span><button disabled={reportPage===0} onClick={()=>setReportPage(p=>Math.max(0,p-1))} className="rounded-lg border px-3 py-1 disabled:opacity-40">Previous</button><button disabled={(reportPage+1)*25>=dataRows.length} onClick={()=>setReportPage(p=>p+1)} className="rounded-lg border px-3 py-1 disabled:opacity-40">Next</button></div><p className="mt-2 text-xs text-slate-500">Preview is paginated by 25 rows. Exports include every matching record loaded from the database.</p></section>}{previewed&&guardActivityKind(kind)&&<section className="rounded-3xl border bg-white p-4 shadow-sm sm:p-5"><h3 className="font-bold">Guard activity summary</h3><div className="mt-3 overflow-x-auto"><table className="min-w-full text-left text-sm"><thead className="bg-slate-50"><tr>{['Guard','Guard account ID','Total','Entries','Exits','Early-outs','Manual'].map(x=><th key={x} className="px-3 py-2">{x}</th>)}</tr></thead><tbody>{guardSummaryRows.map(row=><tr key={row.scanning_guard_id} className="border-t"><td className="px-3 py-2">{row.guard_name}</td><td className="px-3 py-2 font-mono text-xs">{row.scanning_guard_id}</td><td className="px-3 py-2">{row.total}</td><td className="px-3 py-2">{row.entries}</td><td className="px-3 py-2">{row.exits}</td><td className="px-3 py-2">{row.early_outs}</td><td className="px-3 py-2">{row.manual}</td></tr>)}{!guardSummaryRows.length&&<tr><td colSpan={7} className="px-3 py-3 text-center text-slate-500">No guard scan data in this date range.</td></tr>}</tbody></table></div></section>}
  </Frame>
}

function sectionsName(rows:Record<string,unknown>[],id:string){const row=rows.find((r)=>r.section_id===id);return row?.section as string|undefined}
function formatExportValue(value:unknown){if(value===null||value===undefined)return '';if(typeof value==='boolean')return value?'Yes':'No';if(typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T/.test(value))return new Intl.DateTimeFormat('en-PH',{timeZone:'Asia/Manila',dateStyle:'medium',timeStyle:'short'}).format(new Date(value));return String(value)}
function csvEscape(value:unknown){return `"${String(value??'').replaceAll('"','""')}"`}

