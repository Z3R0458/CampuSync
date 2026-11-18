import {
  Activity,
  ArrowRight,
  Bell,
  Clock3,
  BookOpen,
  CalendarDays,
  Camera,
  CameraOff,
  ChevronRight,
  GraduationCap,
  Eye,
  EyeOff,
  LayoutDashboard,
  GraduationCap as StudentIcon,
  ClipboardList,
  PanelsTopLeft,
  UserRoundCog,
  Megaphone,
  ChartNoAxesCombined,
  ScrollText,
  Settings,
  LockKeyhole,
  Mail,
  LogOut,
  QrCode,
  ShieldCheck,
  Shield,
  UserCog,
  Users,
  Wifi,
  WifiOff,
} from 'lucide-react'
import type { Html5Qrcode as Html5QrcodeType } from 'html5-qrcode'
import { TeacherPortal } from './teacher/TeacherPortal'
import { ProfileAvatar, ProfilePhotoManager } from './components/ProfilePhoto'
import { type FormEvent, type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { BrowserRouter, Link, Navigate, NavLink, Route, Routes, useLocation, useSearchParams } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { Session } from '@supabase/supabase-js'

import { addPendingVisitor, getPendingSyncCount, getRecentQueuedAttendance, getRecentVisitors, type CachedVisitorApproval, type PendingVisitorLog } from './lib/db'
import { isSupabaseConfigured } from './lib/supabaseConfig'
import { supabase } from './lib/supabase'
import { getGuardStudentSnapshot, lookupGuardPerson, previewGuardQr, queueApprovedVisitorCheckIn, recordManualScan, recordQrScan, recoverSyncingEvents, refreshApprovedVisitorCache, refreshOfflineQrCache, registerGuardDevice, searchGuardStudents, syncPendingAttendance, syncPendingVisitors, type AttendanceScanResult } from './lib/attendance'
import type { GateEventType } from './lib/db'
import { UserManagement, EnrollmentManagement, DataExport } from './admin/AdminModules'
import { AnnouncementFeed, AnnouncementManagement } from './admin/AnnouncementManagement'
import { ActivityLogs } from './admin/ActivityLogs'
import { StudentPortal } from './student/StudentPortal'
import { StudentRequestReview } from './admin/StudentRequestReview'
import { ParentLinkRequests } from './admin/ParentLinkRequests'
import { ParentPortal } from './parent/ParentPortal'
import { StudentRegistration } from './student/StudentRegistration'
import { StudentApplications } from './admin/StudentApplications'
import { GuardEarlyOutApprovals } from './guard/GuardEarlyOutApprovals'
import { FeedbackProvider, friendlyError, useFeedback } from './components/UserFeedback'
import { AdminLoginMonitoring, SecurityLoginActivity } from './security/SecurityPages'

const queryClient = new QueryClient()

const roleMeta = [
  { id: 'administrator', label: 'Administrator', path: '/administrator', icon: LayoutDashboard },
  { id: 'guard', label: 'Guard', path: '/guard', icon: ShieldCheck },
  { id: 'student', label: 'Student', path: '/student', icon: GraduationCap },
  { id: 'teacher', label: 'Teacher', path: '/teacher', icon: UserCog },
  { id: 'parent', label: 'Parent', path: '/parent', icon: Users },
] as const

type ActiveProfile = { id: string; full_name: string; role: (typeof roleMeta)[number]['id']; is_active: boolean; profile_photo_path?: string | null }

const adminNavigation = [
  { id: 'dashboard', label: 'Dashboard', path: '/administrator', icon: LayoutDashboard },
  { id: 'students', label: 'Student Management', path: '/administrator/students', icon: StudentIcon },
  { id: 'enrollment', label: 'Enrollment Management', path: '/administrator/enrollment', icon: ClipboardList },
  { id: 'student-applications', label: 'Student Applications', path: '/administrator/applications', icon: ClipboardList },
  { id: 'classes', label: 'Class & Sections', path: '/administrator/classes', icon: PanelsTopLeft },
  { id: 'accounts', label: 'User Accounts', path: '/administrator/accounts', icon: UserRoundCog },
  { id: 'student-requests', label: 'Student Requests', path: '/administrator/requests', icon: ClipboardList },
  { id: 'parent-links', label: 'Parent Link Requests', path: '/administrator/parent-links', icon: Users },
  { id: 'announcements', label: 'Announcements', path: '/administrator/announcements', icon: Megaphone },
  { id: 'reports', label: 'Data Export', path: '/administrator/reports', icon: ChartNoAxesCombined },
  { id: 'logs', label: 'Activity Logs', path: '/administrator/logs', icon: ScrollText },
  { id: 'settings', label: 'School Settings', path: '/administrator/settings', icon: Settings },
  { id: 'security', label: 'Security Monitoring', path: '/administrator/security', icon: Shield },
] as const

const teacherNavigation = [
  { id: 'dashboard', label: 'Dashboard', path: '/teacher', icon: LayoutDashboard },
  { id: 'teacher-qr', label: 'My QR Code', path: '/teacher/qr', icon: QrCode },
  { id: 'teacher-attendance', label: 'My Attendance', path: '/teacher/attendance', icon: CalendarDays },
  { id: 'teacher-profile', label: 'My Profile', path: '/teacher/profile', icon: UserRoundCog },
  { id: 'teacher-announcements', label: 'Announcements', path: '/teacher/announcements', icon: Megaphone },
  { id: 'teacher-notifications', label: 'Notifications', path: '/teacher/notifications', icon: Bell },
  { id: 'teacher-requests', label: 'Student Requests', path: '/teacher/requests', icon: ClipboardList },
  { id: 'teacher-security', label: 'Security & Login Activity', path: '/teacher/security', icon: Shield },
] as const

const guardNavigation = [
  { id: 'dashboard', label: 'Dashboard', path: '/guard', icon: LayoutDashboard },
  { id: 'guard-scanner', label: 'QR Scanner', path: '/guard/scanner', icon: QrCode },
  { id: 'guard-early-outs', label: 'Early-Out Approvals', path: '/guard/early-outs', icon: Clock3 },
  { id: 'guard-students', label: 'Student Lookup', path: '/guard/students', icon: StudentIcon },
  { id: 'guard-visitors', label: 'Visitor Management', path: '/guard/visitors', icon: Users },
  { id: 'guard-announcements', label: 'Announcements', path: '/guard/announcements', icon: Megaphone },
  { id: 'guard-notifications', label: 'Notifications', path: '/guard/notifications', icon: Bell },
  { id: 'guard-activity', label: 'Gate History', path: '/guard/activity', icon: Activity },
  { id: 'guard-security', label: 'Security & Login Activity', path: '/guard/security', icon: Shield },
] as const

const studentNavigation = [
  { id:'student-home', label:'Dashboard', path:'/student', icon:LayoutDashboard },
  { id:'student-attendance', label:'My Attendance', path:'/student/attendance', icon:CalendarDays },
  { id:'student-academic', label:'My Academic Information', path:'/student/academic', icon:BookOpen },
  { id:'student-profile', label:'My Profile', path:'/student/profile', icon:UserRoundCog },
  { id:'student-early-out', label:'Early Out Request', path:'/student/early-out', icon:Clock3 },
  { id:'student-visitor', label:'Visitor Permission', path:'/student/visitor', icon:Users },
  { id:'student-absence', label:'Absence Notice', path:'/student/absence', icon:ClipboardList },
  { id:'student-correction', label:'Attendance Correction', path:'/student/correction', icon:Activity },
  { id:'student-announcements', label:'Announcements', path:'/student/announcements', icon:Megaphone },
  { id:'student-notifications', label:'Notifications', path:'/student/notifications', icon:Bell },
  { id:'student-requests', label:'My Requests', path:'/student/requests', icon:ScrollText },
  { id:'student-security', label:'Security & Login Activity', path:'/student/security', icon:Shield },
] as const

const parentNavigation = [
  { id:'parent-home',label:'Dashboard',path:'/parent',icon:LayoutDashboard },
  { id:'parent-children',label:'My Children',path:'/parent/children',icon:Users },
  { id:'parent-attendance',label:'Attendance',path:'/parent/attendance',icon:CalendarDays },
  { id:'parent-requests',label:'Permission Requests',path:'/parent/requests',icon:ClipboardList },
  { id:'parent-announcements',label:'Announcements',path:'/parent/announcements',icon:Megaphone },
  { id:'parent-notifications',label:'Notifications',path:'/parent/notifications',icon:Bell },
  { id:'parent-preferences',label:'Notification Preferences',path:'/parent/preferences',icon:Settings },
  { id:'parent-security',label:'Security & Login Activity',path:'/parent/security',icon:Shield },
] as const

function App() {
  return (
    <FeedbackProvider>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <AuthGate />
        </BrowserRouter>
      </QueryClientProvider>
    </FeedbackProvider>
  )
}

async function loginFunctionError(error: unknown, data: unknown, fallback: string) {
  if (data && typeof data === 'object' && 'error' in data && typeof data.error === 'string') return data.error
  const response = error && typeof error === 'object' ? (error as { context?: unknown }).context : null
  if (response instanceof Response) {
    try { const payload = await response.clone().json() as { error?: unknown }; if (typeof payload.error === 'string') return payload.error } catch { /* Use the safe fallback below. */ }
  }
  return fallback
}

function LoginScreen() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [showPassword, setShowPassword] = useState(false)
  const [recoveryMessage, setRecoveryMessage] = useState('')
  const [challenge, setChallenge] = useState<{ id: string; email: string; expiresAt: string; resendAt: string; firstTime: boolean } | null>(null)
  const [code, setCode] = useState('')
  const [clockNow, setClockNow] = useState(Date.now())
  const deviceIdRef = useRef('')
  const getDeviceIdentifier = () => {
    if (deviceIdRef.current) return deviceIdRef.current
    try {
      const saved = localStorage.getItem('campusync:device-id')
      const id = saved && /^[0-9a-f]{8}-[0-9a-f-]{27,40}$/i.test(saved) ? saved : crypto.randomUUID()
      localStorage.setItem('campusync:device-id', id)
      deviceIdRef.current = id
    } catch { deviceIdRef.current = crypto.randomUUID() }
    return deviceIdRef.current
  }
  useEffect(() => { const timer = window.setInterval(() => setClockNow(Date.now()), 1000); return () => window.clearInterval(timer) }, [])
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError('')
    const client = supabase
    if (!client) {
      setError('Supabase is not configured. Add the project URL and publishable key to .env.local.')
      return
    }
    setSubmitting(true)
    const { data, error: authError } = await client.functions.invoke('login-otp', { body: { action: 'start', email: email.trim().toLowerCase(), password, deviceIdentifier: getDeviceIdentifier() } })
    if (authError) {
      setSubmitting(false)
      setError(await loginFunctionError(authError, data, 'Sign-in could not be completed. Check your email and password, then try again.'))
      return
    }
    if (data?.access_token && data?.refresh_token) {
      const { error: sessionError } = await client.auth.setSession({ access_token: data.access_token, refresh_token: data.refresh_token })
      setSubmitting(false)
      if (sessionError) setError('Sign-in was verified, but CampuSync could not start your session. Please try again.')
      else { setChallenge(null); setCode('') }
      return
    }
    setSubmitting(false)
    if (!data?.challengeId) setError('Sign-in could not be completed. Check your credentials and try again.')
    else setChallenge({ id: data.challengeId, email: data.maskedEmail, expiresAt: data.expiresAt, resendAt: data.resendAt, firstTime: data.verificationKind === 'FIRST_TIME' })
  }
  const verifyCode = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setError(''); const client = supabase; if (!client || !challenge) return; setSubmitting(true)
    const { data, error: verifyError } = await client.functions.invoke('login-otp', { body: { action: 'verify', challengeId: challenge.id, code, deviceIdentifier: getDeviceIdentifier() } })
    if (verifyError || !data?.access_token || !data?.refresh_token) { setSubmitting(false); setError(await loginFunctionError(verifyError, data, 'That code could not be verified. Check it and try again, or request a new one.')); return }
    const { error: sessionError } = await client.auth.setSession({ access_token: data.access_token, refresh_token: data.refresh_token })
    setSubmitting(false)
    if (sessionError) setError('Verification succeeded, but your sign-in session could not be started. Please sign in again.')
    else void client.rpc('record_auth_activity', { p_action: 'login' })
  }
  const resendCode = async () => {
    const client = supabase
    if (!client || !challenge) return
    setError(''); setSubmitting(true)
    const { data, error: resendError } = await client.functions.invoke('login-otp', { body: { action: 'resend', challengeId: challenge.id } })
    setSubmitting(false)
    if (resendError || !data?.challengeId) setError(await loginFunctionError(resendError, data, 'A new code could not be sent yet. Please try again shortly.'))
    else { setChallenge({ ...challenge, expiresAt: data.expiresAt, resendAt: data.resendAt }); setCode('') }
  }
  const sendRecovery = async () => {
    if (!supabase) return
    if (!email.trim()) { setRecoveryMessage('Enter your account email first.'); return }
    const { error: recoveryError } = await supabase.auth.resetPasswordForEmail(email.trim().toLowerCase(), { redirectTo: `${window.location.origin}/` })
    setRecoveryMessage(recoveryError?.message ?? 'If this email belongs to an account, a password recovery link has been sent.')
  }

  return (
    <main className="login-page min-h-screen lg:grid lg:grid-cols-[minmax(0,1.08fr)_minmax(420px,0.92fr)]">
      <section className="login-campus relative flex min-h-[260px] flex-col justify-between overflow-hidden px-6 py-7 text-white sm:min-h-[340px] sm:px-10 sm:py-9 lg:min-h-screen lg:px-14 lg:py-12 xl:px-20">
        <img src="/valencia-nhs-campus.jpg" alt="Valencia National High School campus sign and grounds" className="absolute inset-0 h-full w-full object-cover" />
        <div className="absolute inset-0 bg-[linear-gradient(120deg,rgba(5,35,28,.82)_0%,rgba(13,69,48,.58)_48%,rgba(10,45,42,.18)_100%)]" />
        <div className="relative z-10 flex items-center gap-3">
          <span className="flex h-14 w-14 items-center justify-center overflow-hidden rounded-2xl border border-white/30 bg-white/95 shadow-lg backdrop-blur"><img src="/campusync-logo.png" alt="CampuSync" className="h-full w-full object-contain" /></span>
          <span><span className="block font-[var(--font-display)] text-lg font-extrabold tracking-tight">CampuSync</span><span className="block text-xs text-white/75">Valencia NHS portal</span></span>
        </div>
        <div className="relative z-10 max-w-2xl py-8 lg:pb-16 lg:pt-20">
          <p className="mb-4 inline-flex items-center gap-2 rounded-full border border-white/25 bg-white/10 px-3 py-1.5 text-[11px] font-bold uppercase tracking-[0.18em] text-white/90 backdrop-blur"><span className="h-1.5 w-1.5 rounded-full bg-emerald-300" /> Campus operations portal</p>
          <h1 className="max-w-xl font-[var(--font-display)] text-3xl font-extrabold leading-[1.12] tracking-tight sm:text-4xl lg:text-5xl xl:text-6xl">A safer, more connected school day.</h1>
          <p className="mt-4 max-w-lg text-sm leading-6 text-white/80 sm:text-base sm:leading-7">Attendance, campus access, and school updates—together in one secure place.</p>
        </div>
        <p className="relative z-10 hidden text-xs text-white/70 lg:block">Valencia National High School <span className="mx-2 text-white/40">•</span> Secure school access</p>
        <div className="absolute bottom-5 right-5 z-10 rounded-full border border-white/20 bg-black/25 px-3 py-1 text-[10px] font-medium tracking-wide text-white/85 backdrop-blur sm:bottom-7 sm:right-8">VALENCIA NATIONAL HIGH SCHOOL</div>
      </section>

      <section className="login-panel flex min-h-[calc(100vh-260px)] items-center justify-center bg-[#f7f9f8] px-5 py-10 sm:min-h-[calc(100vh-340px)] sm:px-10 lg:min-h-screen lg:px-12 xl:px-20">
        <div className="w-full max-w-[430px]">
          <div className="mb-8 flex items-center gap-3 lg:hidden"><img src="/campusync-logo.png" alt="CampuSync" className="h-14 w-14 rounded-xl bg-white object-contain" /><span><p className="font-[var(--font-display)] text-xl font-extrabold tracking-tight text-[var(--color-main-text)]">CampuSync</p><p className="mt-1 text-sm text-[var(--color-secondary-text)]">Valencia NHS portal</p></span></div>
          <div className="mb-8">
            <p className="text-xs font-bold uppercase tracking-[0.18em] text-[var(--color-brand-dark)]">Welcome back</p>
            <h2 className="mt-2 font-[var(--font-display)] text-3xl font-extrabold tracking-tight text-slate-900 sm:text-[2.1rem]">Sign in to continue</h2>
            <p className="mt-2 text-sm leading-6 text-slate-500">Use the school account provided by your administrator.</p>
          </div>
          {challenge ? <form onSubmit={verifyCode} className="space-y-5">
            <h3 className="text-xl font-bold text-slate-900">{challenge.firstTime ? 'Verify Your Email' : 'Two-Step Login Verification'}</h3>
            <p className="rounded-xl bg-emerald-50 p-4 text-sm leading-6 text-emerald-950">{challenge.firstTime ? 'Welcome to CampuSync! Before accessing your account, verify your email using the code we sent to your registered address.' : 'We sent a new security code to your registered email address. Enter it to securely access CampuSync.'}<span className="mt-2 block">Code sent to <b>{challenge.email}</b>. {clockNow < Date.parse(challenge.expiresAt) ? `Expires in ${Math.ceil((Date.parse(challenge.expiresAt)-clockNow)/1000)} seconds.` : 'This code has expired; request a new one.'}</span></p>
            <label className="block text-sm font-semibold text-slate-700">Six-digit code<input required inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} value={code} onChange={event=>setCode(event.target.value.replace(/\D/g,'').slice(0,6))} className="mt-2 h-12 w-full rounded-xl border border-slate-200 px-4 text-center text-xl tracking-[.5em]" /></label>
            {error && <p role="alert" className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>}
            <button disabled={submitting || code.length!==6} className="h-12 w-full rounded-xl bg-[#16794f] font-semibold text-white disabled:opacity-50">{submitting?'Verifying…':'Verify and continue'}</button>
            <button type="button" disabled={submitting || clockNow<Date.parse(challenge.resendAt) || clockNow>=Date.parse(challenge.expiresAt)} onClick={()=>void resendCode()} className="w-full text-sm font-semibold text-emerald-800 underline disabled:text-slate-400">{clockNow>=Date.parse(challenge.expiresAt)?'Code expired — return to login for a new one':clockNow<Date.parse(challenge.resendAt)?`Resend available in ${Math.ceil((Date.parse(challenge.resendAt)-clockNow)/1000)} seconds`:'Resend code'}</button>
            <button type="button" onClick={()=>{setChallenge(null);setCode('');setError('')}} className="w-full text-sm text-slate-600 underline">Return to login</button>
          </form> : <form onSubmit={submit} className="space-y-5">
            <label className="block text-sm font-semibold text-slate-700">School email
              <span className="mt-2 flex h-12 items-center gap-3 rounded-xl border border-slate-200 bg-white px-3.5 transition focus-within:border-emerald-600 focus-within:ring-4 focus-within:ring-emerald-600/10">
                <Mail className="h-4 w-4 shrink-0 text-slate-400" />
                <input required type="email" autoComplete="username" placeholder="you@school.edu.ph" value={email} onChange={(event) => setEmail(event.target.value)} className="h-full min-w-0 flex-1 bg-transparent text-sm font-normal outline-none placeholder:text-slate-400" />
              </span>
            </label>
            <label className="block text-sm font-semibold text-slate-700">Password
              <span className="mt-2 flex h-12 items-center gap-3 rounded-xl border border-slate-200 bg-white px-3.5 transition focus-within:border-emerald-600 focus-within:ring-4 focus-within:ring-emerald-600/10">
                <LockKeyhole className="h-4 w-4 shrink-0 text-slate-400" />
                <input required type={showPassword ? 'text' : 'password'} autoComplete="current-password" placeholder="Enter your password" value={password} onChange={(event) => setPassword(event.target.value)} className="h-full min-w-0 flex-1 bg-transparent text-sm font-normal outline-none placeholder:text-slate-400" />
                <button type="button" onClick={() => setShowPassword((current) => !current)} aria-label={showPassword ? 'Hide password' : 'Show password'} className="rounded-md p-1 text-slate-400 transition hover:text-slate-700"><span className="sr-only">{showPassword ? 'Hide password' : 'Show password'}</span>{showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}</button>
              </span>
            </label>
            {error && <p role="alert" className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm leading-5 text-red-700">{error}</p>}
            <button disabled={submitting} className="group flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-[#16794f] px-4 font-semibold text-white shadow-[0_8px_18px_rgba(22,121,79,.18)] transition hover:bg-[#126743] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-emerald-700/20 disabled:cursor-wait disabled:opacity-65">{submitting ? 'Signing in…' : <>Sign in securely <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" /></>}</button>
          </form>}
          <button type="button" onClick={() => void sendRecovery()} className="mt-3 block w-full text-right text-xs font-semibold text-emerald-800 underline">Forgot your password?</button>
          {recoveryMessage && <p role="status" className="mt-2 text-xs text-slate-600">{recoveryMessage}</p>}
          <p className="mt-5 text-center text-sm text-slate-600">Parent or guardian? <Link to="/parent/register" className="font-semibold text-emerald-800 underline">Create an account</Link></p>
          <p className="mt-2 text-center text-sm text-slate-600">New student? <Link to="/student-registration" className="font-semibold text-emerald-800 underline">Apply for registration</Link></p>
          <div className="mt-6 flex items-start gap-3 rounded-xl border border-slate-200/80 bg-white/70 p-4">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-700" />
            <p className="text-xs leading-5 text-slate-500">School-managed accounts only. For access help, contact your school administrator.</p>
          </div>
          <p className="mt-8 text-center text-[11px] text-slate-400">© {new Date().getFullYear()} Valencia National High School</p>
        </div>
      </section>
    </main>
  )
}

function ParentRegistrationScreen() {
  const [fullName,setFullName]=useState('');const [email,setEmail]=useState('');const [phone,setPhone]=useState('');const [relationship,setRelationship]=useState('Mother');const [password,setPassword]=useState('');const [confirmation,setConfirmation]=useState('');const [busy,setBusy]=useState(false);const [error,setError]=useState('');const [sent,setSent]=useState(false)
  const submit=async(event:FormEvent<HTMLFormElement>)=>{event.preventDefault();setError('');if(!supabase)return;if(password.length<12){setError('Use a password with at least 12 characters.');return}if(password!==confirmation){setError('The passwords do not match.');return}setBusy(true);const {error:signupError}=await supabase.auth.signUp({email:email.trim().toLowerCase(),password,options:{data:{parent_self_registration:true,full_name:fullName.trim(),phone:phone.trim(),relationship},emailRedirectTo:`${window.location.origin}/`}});setBusy(false);if(signupError)setError(friendlyError(signupError));else setSent(true)}
  return <main className="flex min-h-screen items-center justify-center bg-slate-50 p-4"><section className="w-full max-w-xl rounded-3xl border bg-white p-6 shadow-sm sm:p-8"><div className="mb-6 flex items-center gap-3"><img src="/campusync-logo.png" alt="CampuSync" className="h-12 w-12 object-contain"/><div><p className="text-xs font-bold uppercase tracking-widest text-emerald-800">CampuSync · Valencia NHS</p><h1 className="text-2xl font-bold">Parent / guardian registration</h1></div></div>{sent?<div role="status" className="rounded-2xl bg-emerald-50 p-4 text-sm text-emerald-950"><b>Check your email to verify your account.</b><p className="mt-2">We have not linked a student to this account. After email verification, submit a link request and wait for the school administrator to verify it.</p><Link to="/" className="mt-4 inline-block font-semibold underline">Return to sign in</Link></div>:<form onSubmit={e=>void submit(e)} className="space-y-4"><label className="block text-sm font-semibold">Complete name<input required minLength={2} maxLength={120} value={fullName} onChange={e=>setFullName(e.target.value)} className="mt-1 w-full rounded-xl border p-3"/></label><label className="block text-sm font-semibold">Email address<input required type="email" autoComplete="email" value={email} onChange={e=>setEmail(e.target.value)} className="mt-1 w-full rounded-xl border p-3"/></label><label className="block text-sm font-semibold">Contact number<input required type="tel" maxLength={40} value={phone} onChange={e=>setPhone(e.target.value)} className="mt-1 w-full rounded-xl border p-3"/></label><label className="block text-sm font-semibold">Relationship to student<select value={relationship} onChange={e=>setRelationship(e.target.value)} className="mt-1 w-full rounded-xl border bg-white p-3">{['Mother','Father','Legal Guardian','Other'].map(x=><option key={x}>{x}</option>)}</select></label><label className="block text-sm font-semibold">Password<input required minLength={12} type="password" autoComplete="new-password" value={password} onChange={e=>setPassword(e.target.value)} className="mt-1 w-full rounded-xl border p-3"/></label><label className="block text-sm font-semibold">Confirm password<input required minLength={12} type="password" autoComplete="new-password" value={confirmation} onChange={e=>setConfirmation(e.target.value)} className="mt-1 w-full rounded-xl border p-3"/></label>{error&&<p role="alert" className="rounded-xl bg-rose-50 p-3 text-sm text-rose-800">{error}</p>}<p className="text-xs text-slate-500">Student access requires both email verification and administrator approval of a parent-student link request.</p><button disabled={busy} className="w-full rounded-xl bg-emerald-800 px-4 py-3 font-semibold text-white disabled:opacity-50">{busy?'Creating account…':'Create parent account'}</button><p className="text-center text-sm text-slate-600">Already registered? <Link to="/" className="font-semibold text-emerald-800 underline">Sign in</Link></p></form>}</section></main>
}

function AuthGate() {
  const location = useLocation()
  const [session, setSession] = useState<Session | null | undefined>(undefined)
  const [profile, setProfile] = useState<ActiveProfile | null>(null)
  const [profileLoading, setProfileLoading] = useState(false)
  const [profileError, setProfileError] = useState('')
  const [passwordRecovery, setPasswordRecovery] = useState(false)

  useEffect(() => {
    if (!supabase) {
      setSession(null)
      return
    }
    let active = true
    void supabase.auth.getSession().then(({ data }) => {
      if (active) setSession(data.session)
    })
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, nextSession) => {
      setSession(nextSession)
      setPasswordRecovery(event === 'PASSWORD_RECOVERY')
      setProfile(null)
      setProfileError('')
    })
    return () => {
      active = false
      subscription.unsubscribe()
    }
  }, [])

  useEffect(() => {
    const client = supabase
    if (!session || !client) {
      setProfile(null)
      setProfileLoading(false)
      return
    }
    if (passwordRecovery) { setProfile(null); setProfileLoading(false); return }
    let active = true
    setProfileLoading(true)
    const loadProfile = async () => {
      const { data, error } = await client.from('profiles').select('id, full_name, role, is_active, profile_photo_path')
        .eq('auth_user_id', session.user.id).maybeSingle()
        if (!active) return
        if (error && !navigator.onLine) {
          try {
            const cached = localStorage.getItem(`schoolguard:profile:${session.user.id}`)
            const record = cached ? JSON.parse(cached) as { profile: ActiveProfile; cachedAt: string } : null
            if (record && record.profile.role === 'guard' && Date.now() - Date.parse(record.cachedAt) < 24 * 60 * 60 * 1000) setProfile(record.profile)
            else setProfileError('Offline guard access requires a profile cache refreshed within the last 24 hours.')
          } catch { setProfileError('Offline profile cache is unavailable on this device.') }
        } else if (error) setProfileError(friendlyError(error))
        else if (!data || !data.is_active) setProfileError('No active Valencia National High School profile is linked to this login.')
        else if (!['administrator','guard','student','teacher','parent'].includes(data.role)) setProfileError('This account role is not supported by the school portal.')
        else {
          const nextProfile = data as ActiveProfile
          setProfile(nextProfile)
          try { localStorage.setItem(`schoolguard:profile:${session.user.id}`, JSON.stringify({ profile: nextProfile, cachedAt: new Date().toISOString() })) } catch { /* Online sign-in remains available without storage. */ }
        }
        setProfileLoading(false)
    }
    const validateSessionAndLoad = async () => {
      if (navigator.onLine) {
        // Validate the server-recorded OTP session directly. This avoids
        // depending on an optional Auth Hook to inject a custom JWT claim.
        const { data: verified, error } = await client.rpc('schoolguard_login_otp_verified')
        if (!active) return
        if (error || verified !== true) {
          void client.auth.signOut()
          setProfile(null)
          setProfileLoading(false)
          setProfileError(error ? 'Could not confirm your verified session. Please try signing in again.' : 'Your verified session could not be found. Please request a new code and sign in again.')
          return
        }
      } else {
        // Offline guard access can only use a signed claim issued while online.
        try {
          const claims = JSON.parse(atob(session.access_token.split('.')[1].replaceAll('-', '+').replaceAll('_', '/'))) as { schoolguard_otp_verified?: boolean }
          if (claims.schoolguard_otp_verified !== true) {
            setProfile(null)
            setProfileLoading(false)
            setProfileError('Connect to the internet once to confirm this verified sign-in before using offline access.')
            return
          }
        } catch {
          setProfile(null)
          setProfileLoading(false)
          setProfileError('The sign-in session is invalid. Connect to the internet and sign in again.')
          return
        }
      }
      await loadProfile()
    }
    void validateSessionAndLoad()
    return () => { active = false }
  }, [session, passwordRecovery])

  if (!isSupabaseConfigured || !supabase) {
    return <main className="mx-auto mt-20 max-w-xl rounded-3xl bg-white p-8 text-center shadow"><h1 className="text-2xl font-bold">Supabase configuration required</h1><p className="mt-3 text-sm text-slate-600">Set the project URL and publishable key in .env.local, then restart Vite.</p></main>
  }
  if (session === undefined || profileLoading) {
    return <main className="flex min-h-screen items-center justify-center text-sm text-slate-600">Loading CampuSync securely…</main>
  }
  if (!session) return location.pathname === '/parent/register' ? <ParentRegistrationScreen /> : location.pathname === '/student-registration' ? <StudentRegistration /> : <LoginScreen />
  if (passwordRecovery) return <PasswordRecoveryScreen onComplete={() => { setPasswordRecovery(false); void supabase?.auth.signOut() }} />
  if (profileError || !profile) {
    return <main className="mx-auto mt-20 max-w-xl rounded-3xl bg-white p-8 text-center shadow"><h1 className="text-2xl font-bold">School account not provisioned</h1><p role="alert" className="mt-3 text-sm text-red-700">{profileError || 'No active profile is linked to this account.'}</p><button onClick={() => void supabase?.auth.signOut()} className="mt-6 rounded-xl bg-slate-900 px-5 py-3 font-semibold text-white">Sign out</button></main>
  }
  return <DashboardApp profile={profile} onPhotoSaved={path=>setProfile(current=>current?{...current,profile_photo_path:path}:current)} />
}

function PasswordRecoveryScreen({ onComplete }: { onComplete: () => void }) {
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (password.length < 12) { setMessage('Use at least 12 characters.'); return }
    if (password !== confirmation) { setMessage('The passwords do not match.'); return }
    if (!supabase) return
    setBusy(true)
    const { error } = await supabase.auth.updateUser({ password })
    setBusy(false)
    if (error) setMessage(friendlyError(error))
    else { setMessage('Password updated.'); onComplete() }
  }
  return <main className="flex min-h-screen items-center justify-center bg-slate-50 p-5"><form onSubmit={(e)=>void submit(e)} className="w-full max-w-md space-y-4 rounded-3xl border bg-white p-7 shadow"><h1 className="text-2xl font-bold">Set a new password</h1><p className="text-sm text-slate-600">Choose a new password for your CampuSync account at Valencia NHS.</p><label className="block text-sm font-semibold">New password<input required minLength={12} type="password" autoComplete="new-password" value={password} onChange={(e)=>setPassword(e.target.value)} className="mt-1 w-full rounded-xl border p-3"/></label><label className="block text-sm font-semibold">Confirm password<input required minLength={12} type="password" autoComplete="new-password" value={confirmation} onChange={(e)=>setConfirmation(e.target.value)} className="mt-1 w-full rounded-xl border p-3"/></label>{message&&<p role="status" className="text-sm text-rose-700">{message}</p>}<button disabled={busy} className="w-full rounded-xl bg-[var(--color-brand-dark)] p-3 font-semibold text-white">{busy?'Updating…':'Update password'}</button></form></main>
}

function RoleRoute({ profile, role, children }: { profile: ActiveProfile; role: ActiveProfile['role']; children: ReactNode }) {
  return profile.role === role ? children : <Navigate to={`/${profile.role}`} replace />
}

function DashboardApp({ profile, onPhotoSaved }: { profile: ActiveProfile; onPhotoSaved: (path: string | null) => void }) {
  const [isOnline, setIsOnline] = useState(() => navigator.onLine)
  const [supabaseStatus, setSupabaseStatus] = useState<'checking' | 'connected' | 'offline' | 'error' | 'not-configured'>(
    () => isSupabaseConfigured ? 'checking' : 'not-configured',
  )
  const [supabaseMessage, setSupabaseMessage] = useState('Checking Supabase connection…')

  useEffect(() => {
    const updateConnection = () => setIsOnline(navigator.onLine)
    window.addEventListener('online', updateConnection)
    window.addEventListener('offline', updateConnection)
    return () => {
      window.removeEventListener('online', updateConnection)
      window.removeEventListener('offline', updateConnection)
    }
  }, [])

  useEffect(() => {
    let active = true
    const checkConnection = async () => {
      if (!isSupabaseConfigured) {
        setSupabaseStatus('not-configured')
        setSupabaseMessage('Add the Supabase URL and publishable key to .env.local.')
        return
      }
      if (!navigator.onLine) {
        setSupabaseStatus('offline')
        setSupabaseMessage('Device is offline; Supabase cannot be reached.')
        return
      }

      setSupabaseStatus('checking')
      try {
        const { checkSupabaseConnection } = await import('./lib/supabase')
        const result = await checkSupabaseConnection()
        if (!active) return
        setSupabaseStatus(result.connected ? 'connected' : 'error')
        setSupabaseMessage(friendlyError(result))
      } catch (error) {
        if (!active) return
        setSupabaseStatus('error')
        setSupabaseMessage(friendlyError(error, 'Could not reach Supabase.'))
      }
    }
    const handleOnline = () => void checkConnection()
    const handleOffline = () => {
      setSupabaseStatus('offline')
      setSupabaseMessage('Device is offline; Supabase cannot be reached.')
    }
    void checkConnection()
    const timer = window.setInterval(() => void checkConnection(), 60_000)
    window.addEventListener('online', handleOnline)
    window.addEventListener('offline', handleOffline)
    return () => {
      active = false
      window.clearInterval(timer)
      window.removeEventListener('online', handleOnline)
      window.removeEventListener('offline', handleOffline)
    }
  }, [])

  return (
        <div className="min-h-screen bg-[radial-gradient(ellipse_at_top_left,_rgba(220,243,232,.65),_transparent_38%),linear-gradient(180deg,#f7faf9_0%,#f1f5f4_100%)] text-[var(--color-main-text)]">
          <div className="mx-auto flex max-w-[1680px] gap-5 p-3 sm:p-5 xl:gap-7 xl:p-7">
            <aside className="sticky top-5 hidden h-[calc(100vh-2.5rem)] w-72 shrink-0 flex-col rounded-[26px] border border-white bg-white/90 p-5 shadow-[0_16px_45px_rgba(36,59,83,0.07)] backdrop-blur md:flex">
              <div className="mb-8 flex items-center gap-3">
                <div className="flex h-11 w-11 items-center justify-center overflow-hidden rounded-2xl bg-white">
                  <img src="/campusync-logo.png" alt="CampuSync" className="h-full w-full object-contain" />
                </div>
                <div>
                  <p className="font-[var(--font-display)] text-lg font-bold tracking-tight">CampuSync</p>
                  <p className="text-xs text-[var(--color-secondary-text)]">Valencia NHS · {roleMeta.find(({ id }) => id === profile.role)?.label} portal</p>
                </div>
              </div>

              <div className="mb-6 rounded-2xl border border-[var(--color-border)] bg-[var(--color-brand-soft)] p-3">
                <p className="text-[10px] uppercase tracking-[0.2em] text-[var(--color-secondary-text)]">Active role</p>
                <div className="mt-2 flex items-center gap-3">
                  <ProfileAvatar path={profile.profile_photo_path} name={profile.full_name} size={40} />
                  <div>
                  <p className="font-semibold">{profile.full_name}</p>
                    <p className="text-xs capitalize text-[var(--color-secondary-text)]">{profile.role} account</p>
                  </div>
                </div>
              </div>

              <nav className="space-y-2 overflow-y-auto">
                {(profile.role === 'administrator' ? adminNavigation : profile.role === 'student' ? studentNavigation : profile.role === 'teacher' ? teacherNavigation : profile.role === 'guard' ? guardNavigation : profile.role === 'parent' ? parentNavigation : roleMeta.filter(({ id }) => id === profile.role)).map(({ id, label, path, icon: Icon }) => (
                  <NavLink
                    key={id}
                    to={path}
                    end={id === 'dashboard' || id === 'student-home' || id === 'parent-home'}
                    className={({ isActive }) =>
                      `flex items-center justify-between rounded-2xl px-3 py-2.5 text-sm font-medium transition ${
                        isActive
                          ? 'bg-[var(--color-brand-soft)] text-[var(--color-brand-dark)] shadow-sm ring-1 ring-[var(--color-brand-green)]/30'
                          : 'text-[var(--color-secondary-text)] hover:bg-slate-50'
                      }`
                    }
                  >
                    <span className="flex items-center gap-3">
                      <Icon className="h-4 w-4" />
                      {label}
                    </span>
                    <ChevronRight className="h-4 w-4" />
                  </NavLink>
                ))}
              </nav>

              <div className="mt-auto rounded-2xl border border-[var(--color-border)] bg-slate-50 p-4">
                <div className="mb-2 flex items-center justify-between">
                  <p className="text-sm font-semibold">Sync status</p>
                  <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.18em] ${supabaseStatus === 'connected' ? 'bg-emerald-100 text-emerald-700' : supabaseStatus === 'checking' ? 'bg-sky-100 text-sky-700' : 'bg-amber-100 text-amber-700'}`}>
                    {supabaseStatus === 'connected' ? 'Connected' : supabaseStatus === 'checking' ? 'Checking' : supabaseStatus === 'offline' ? 'Offline' : supabaseStatus === 'error' ? 'Unavailable' : 'Not configured'}
                  </span>
                </div>
                <p className="break-words text-sm text-[var(--color-secondary-text)]">{supabaseMessage}</p>
              </div>
            </aside>

            <main className="min-w-0 flex-1">
              <header className="mb-5 flex flex-col gap-4 rounded-[26px] border border-white bg-white/90 p-4 shadow-[0_12px_40px_rgba(36,59,83,0.05)] backdrop-blur sm:p-5 md:flex-row md:items-center md:justify-between">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--color-secondary-text)]">Operations hub</p>
                  <h1 className="mt-1 font-[var(--font-display)] text-2xl font-extrabold tracking-tight md:text-3xl">
                    {roleMeta.find(({ id }) => id === profile.role)?.label ?? 'School'} Dashboard
                  </h1>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  <details className="relative"><summary className="flex cursor-pointer list-none items-center gap-2 rounded-full border bg-white px-2 py-1.5 text-xs font-semibold"><ProfileAvatar path={profile.profile_photo_path} name={profile.full_name} size={28}/><span className="max-w-32 truncate">{profile.full_name}</span></summary><div className="absolute right-0 top-12 z-40 w-[min(24rem,calc(100vw-2rem))] rounded-2xl border bg-white p-3 shadow-xl">{profile.role === 'student' || profile.role === 'teacher' ? <ProfilePhotoManager currentPath={profile.profile_photo_path} name={profile.full_name} onSaved={onPhotoSaved}/> : <p className="p-2 text-sm text-slate-600">Account settings</p>}</div></details>
                  <div className={`flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-semibold ${isOnline ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-amber-200 bg-amber-50 text-amber-700'}`}>
                    {isOnline ? <Wifi className="h-3.5 w-3.5" /> : <WifiOff className="h-3.5 w-3.5" />}
                    {isOnline ? 'ONLINE' : 'OFFLINE'}
                  </div>
                  <PushNotificationToggle profileId={profile.id} />
                  <button onClick={() => void (async()=>{if(supabase){await supabase.rpc('record_auth_activity',{p_action:'logout'});await supabase.rpc('revoke_my_login_otp_session');await supabase.auth.signOut()}})()} className="flex items-center gap-2 rounded-full bg-[var(--color-brand-dark)] px-4 py-2 text-sm font-semibold text-white transition hover:bg-[#1d5d45]">
                    <LogOut className="h-4 w-4" />
                    Logout
                  </button>
                </div>
              </header>

              <nav aria-label="Dashboard navigation" className="mb-4 flex gap-2 overflow-x-auto rounded-2xl border border-[var(--color-border)] bg-white p-2 md:hidden">
                {(profile.role === 'administrator' ? adminNavigation : profile.role === 'student' ? studentNavigation : profile.role === 'teacher' ? teacherNavigation : profile.role === 'guard' ? guardNavigation : profile.role === 'parent' ? parentNavigation : roleMeta.filter(({ id }) => id === profile.role)).map(({ id, label, path }) => (
                  <NavLink
                    key={id}
                    to={path}
                    end={id === 'dashboard' || id === 'student-home' || id === 'parent-home'}
                    className={({ isActive }) => `shrink-0 rounded-xl px-3 py-2 text-xs font-semibold ${isActive ? 'bg-[var(--color-brand-soft)] text-[var(--color-brand-dark)]' : 'text-[var(--color-secondary-text)] hover:bg-slate-50'}`}
                  >
                    {label}
                  </NavLink>
                ))}
              </nav>

              <Routes>
                <Route path="/" element={<Navigate to={`/${profile.role}`} replace />} />
                <Route path="/administrator/security" element={<RoleRoute profile={profile} role="administrator"><DashboardShell title="Security Monitoring" subtitle="Review account sign-ins and security events"><AdminLoginMonitoring /></DashboardShell></RoleRoute>} />
                <Route path="/administrator/*" element={<RoleRoute profile={profile} role="administrator"><AdministratorDashboard profile={profile} /></RoleRoute>} />
                <Route path="/administrator/parent-links" element={<RoleRoute profile={profile} role="administrator"><DashboardShell title="Parent-student link requests" subtitle="Verify family relationships"><ParentLinkRequests /></DashboardShell></RoleRoute>} />
                <Route path="/guard/security" element={<RoleRoute profile={profile} role="guard"><DashboardShell title="Security & Login Activity" subtitle="Review the devices and sessions accessing your account"><SecurityLoginActivity profile={profile} /></DashboardShell></RoleRoute>} />
                <Route path="/guard/*" element={<RoleRoute profile={profile} role="guard"><GuardDashboard profile={profile} /></RoleRoute>} />
                <Route path="/student/security" element={<RoleRoute profile={profile} role="student"><DashboardShell title="Security & Login Activity" subtitle="Review the devices and sessions accessing your account"><SecurityLoginActivity profile={profile} /></DashboardShell></RoleRoute>} />
                <Route path="/student/*" element={<RoleRoute profile={profile} role="student"><StudentPortal profile={profile} /></RoleRoute>} />
                <Route path="/teacher/requests" element={<RoleRoute profile={profile} role="teacher"><DashboardShell title="Student Requests" subtitle="Review requests for your assigned students"><StudentRequestReview role="teacher" profileId={profile.id} /></DashboardShell></RoleRoute>} />
                <Route path="/teacher/security" element={<RoleRoute profile={profile} role="teacher"><DashboardShell title="Security & Login Activity" subtitle="Review the devices and sessions accessing your account"><SecurityLoginActivity profile={profile} /></DashboardShell></RoleRoute>} />
                <Route path="/teacher/*" element={<RoleRoute profile={profile} role="teacher"><TeacherPortal profile={profile} /></RoleRoute>} />
                <Route path="/parent/security" element={<RoleRoute profile={profile} role="parent"><DashboardShell title="Security & Login Activity" subtitle="Review the devices and sessions accessing your account"><SecurityLoginActivity profile={profile} /></DashboardShell></RoleRoute>} />
                <Route path="/parent/*" element={<RoleRoute profile={profile} role="parent"><ParentPortal profile={profile} /></RoleRoute>} />
                <Route path="*" element={<Navigate to={`/${profile.role}`} replace />} />
              </Routes>
            </main>
          </div>
        </div>
  )
}

function DashboardShell({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) {
  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-[var(--color-brand-dark)]">School operations</p>
          <h2 className="mt-1 font-[var(--font-display)] text-2xl font-bold tracking-tight text-[var(--color-main-text)]">{title}</h2>
        </div>
        <p className="w-fit rounded-full border border-white bg-white/80 px-3 py-1.5 text-xs text-[var(--color-secondary-text)] shadow-sm">{subtitle}</p>
      </div>
      {children}
    </div>
  )
}

function KpiCard({ label, value, trend, accent = 'green' }: { label: string; value: string; trend: string; accent?: 'green' | 'blue' | 'amber' | 'rose' }) {
  const accentMap = {
    green: 'bg-emerald-50 text-emerald-700',
    blue: 'bg-blue-50 text-blue-700',
    amber: 'bg-amber-50 text-amber-700',
    rose: 'bg-rose-50 text-rose-700',
  }

  return (
    <div className="rounded-[24px] border border-[var(--color-border)] bg-white p-4 shadow-sm">
      <div className="flex items-center justify-between">
        <p className="text-sm text-[var(--color-secondary-text)]">{label}</p>
        <span className={`rounded-full px-2 py-1 text-[10px] font-bold uppercase tracking-[0.18em] ${accentMap[accent]}`}>
          {trend}
        </span>
      </div>
      <p className="mt-5 font-[var(--font-display)] text-3xl font-extrabold tracking-tight">{value}</p>
    </div>
  )
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    VERIFIED: 'bg-emerald-100 text-emerald-700',
    PENDING: 'bg-amber-100 text-amber-700',
    APPROVED: 'bg-emerald-100 text-emerald-700',
    REJECTED: 'bg-red-100 text-red-700',
    FAILED: 'bg-red-100 text-red-700',
    SYNCED: 'bg-emerald-100 text-emerald-700',
    NEEDS_REVIEW: 'bg-orange-100 text-orange-700',
    Present: 'bg-emerald-100 text-emerald-700',
    Late: 'bg-amber-100 text-amber-700',
    Absent: 'bg-red-100 text-red-700',
    'Early departure': 'bg-purple-100 text-purple-700',
    'Incomplete': 'bg-sky-100 text-sky-700',
  }

  return (
    <span className={`inline-flex rounded-full px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] ${map[status] ?? 'bg-slate-100 text-slate-700'}`}>
      {status}
    </span>
  )
}

function formatPhilippineDateTime(value: string) {
  return new Intl.DateTimeFormat('en-PH', {
    timeZone: 'Asia/Manila', dateStyle: 'medium', timeStyle: 'short',
  }).format(new Date(value))
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}

function vapidApplicationKey(value: string) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='))
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

function PushNotificationToggle({ profileId }: { profileId: string }) {
  const [enabled, setEnabled] = useState(false)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return
    void navigator.serviceWorker.getRegistration().then((registration) => registration?.pushManager.getSubscription() ?? null)
      .then((subscription) => setEnabled(Boolean(subscription)))
      .catch(() => undefined)
  }, [])

  const toggle = async () => {
    if (!supabase) return
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
      setMessage('Push notifications are not supported in this browser.')
      return
    }
    setBusy(true); setMessage('')
    try {
      const existingRegistration = await navigator.serviceWorker.getRegistration()
      if (!existingRegistration) throw new Error('Install or open CampuSync over HTTPS before enabling push.')
      const registration = existingRegistration
      const subscription = await registration.pushManager.getSubscription()
      if (subscription) {
        const endpoint = subscription.endpoint
        await subscription.unsubscribe()
        const { error } = await supabase.from('push_subscriptions').delete().eq('user_id', profileId).eq('endpoint', endpoint)
        if (error) throw error
        setEnabled(false); setMessage('Push notifications disabled on this device.')
      } else {
        const key = import.meta.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY
        if (!key) throw new Error('Set NEXT_PUBLIC_VAPID_PUBLIC_KEY and restart Vite to enable push notifications.')
        const permission = await Notification.requestPermission()
        if (permission !== 'granted') throw new Error('Notification permission was not granted.')
        const nextSubscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: vapidApplicationKey(key) })
        const json = nextSubscription.toJSON()
        const { error } = await supabase.from('push_subscriptions').upsert({
          user_id: profileId, endpoint: nextSubscription.endpoint, auth_key: json.keys?.auth, p256dh: json.keys?.p256dh,
        }, { onConflict: 'user_id,endpoint' })
        if (error) { await nextSubscription.unsubscribe(); throw error }
        setEnabled(true); setMessage('This device is subscribed. Push delivery also needs the dispatch-push Edge Function and VAPID secrets.')
      }
    } catch (error) {
      setMessage(friendlyError(error, 'Could not update push notification settings.'))
    } finally { setBusy(false) }
  }

  return <div className="flex flex-wrap items-center gap-2">
    <button onClick={() => void toggle()} disabled={busy} className="rounded-full border border-[var(--color-border)] bg-slate-50 px-3 py-2 text-xs font-semibold disabled:opacity-50">{busy ? 'Please wait…' : enabled ? 'Push on' : 'Enable push'}</button>
    {message && <span role="status" className="max-w-52 text-xs text-slate-500">{message}</span>}
  </div>
}

function AdministratorDashboard({ profile }: { profile: ActiveProfile }) {
  const location = useLocation()
  const section = location.pathname.split('/')[2] ?? ''
  if (section) {
    if (section === 'students') return <StudentDirectory />
    if (section === 'enrollment') return <EnrollmentManagement />
    if (section === 'applications') return <StudentApplications />
    if (section === 'classes') return <ClassModule />
    if (section === 'accounts') return <UserManagement profile={profile} />
    if (section === 'requests') return <DashboardShell title="Student Requests" subtitle="Review student permissions, absence notices, and attendance correction requests"><StudentRequestReview role="administrator" profileId={profile.id} /></DashboardShell>
    if (section === 'parent-links') return <DashboardShell title="Parent-student link requests" subtitle="Verify family relationships"><ParentLinkRequests /></DashboardShell>
    if (section === 'announcements') return <DashboardShell title="Announcements" subtitle="Publish school updates"><AnnouncementManagement profileId={profile.id} /></DashboardShell>
    if (section === 'reports') return <DataExport profile={profile} />
    if (section === 'logs') return <ActivityModule profile={profile} />
    if (section === 'settings') return <SettingsModule />
  }
  return <AdminOverview />
}

function AdminOverview() {
  const [metrics, setMetrics] = useState({ students: 0, teachers: 0, guards: 0, enrolled: 0, pendingEnrollments: null as number | null, announcements: 0, inside: 0, visitors: 0 })
  const [requests, setRequests] = useState<{ id: string; kind: 'early' | 'visitor'; student: string; grade: string; reason: string; requested: string }[]>([])
  const [recent, setRecent] = useState<Record<string, unknown>[]>([])
  const [weekCounts, setWeekCounts] = useState<number[]>([])
  const [dataError, setDataError] = useState('')
  const [loading, setLoading] = useState(true)

  const refresh = async () => {
    if (!supabase) return
    setLoading(true)
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date())
    const todayStart = new Date(`${day}T00:00:00+08:00`)
    const weekStartDate = new Date(todayStart)
    weekStartDate.setUTCDate(weekStartDate.getUTCDate() - 6)
    const start = weekStartDate.toISOString()
    const [studentCount, enrolledCount, teacherCount, guardCount, pendingEnrollmentCount, announcementCount, todayEvents, earlyOuts, visitorRequestsData, snapshotResult] = await Promise.all([
      supabase.from('students').select('id', { count: 'exact', head: true }),
      supabase.from('students').select('id', { count: 'exact', head: true }).eq('status', 'active'),
      supabase.from('teachers').select('id', { count: 'exact', head: true }),
      supabase.from('profiles').select('id', { count: 'exact', head: true }).eq('role', 'guard'),
      supabase.from('enrollment_records').select('id', { count: 'exact', head: true }).eq('status', 'PENDING'),
      supabase.from('announcements').select('id', { count: 'exact', head: true }).in('status', ['published', 'scheduled']).lte('published_at', new Date().toISOString()).or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`),
      supabase.from('attendance_events').select('person_type,person_id,event_type,actual_scan_time').gte('actual_scan_time', start).order('actual_scan_time'),
      supabase.from('early_out_requests').select('id,student_id,requested_departure,reason,students(student_id,grade_level,profiles(full_name))').eq('status', 'PENDING').order('created_at').limit(8),
      supabase.from('visitor_requests').select('id,student_id,visitor_name,visit_date,purpose,students(student_id,grade_level,profiles(full_name))').eq('status', 'PENDING').order('created_at').limit(8),
      supabase.rpc('get_guard_dashboard_snapshot'),
    ])
    const errors = [studentCount.error, enrolledCount.error, teacherCount.error, guardCount.error, pendingEnrollmentCount.error, announcementCount.error, todayEvents.error, earlyOuts.error, visitorRequestsData.error, snapshotResult.error].filter(Boolean)
    if (errors.length) setDataError(errors[0]?.message ?? 'Could not load dashboard records.')
    else setDataError('')

    const snapshot = snapshotResult.data as { inside_count?: number; visitors_inside?: number; recent_events?: Record<string, unknown>[] } | null
    const dateKey = (value: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(value)
    const days = Array.from({ length: 7 }, (_, index) => {
      const value = new Date(weekStartDate)
      value.setUTCDate(value.getUTCDate() + index)
      return dateKey(value)
    })
    const dailyCounts = days.map((date) => new Set((todayEvents.data ?? [])
      .filter((event) => event.event_type === 'ENTRY' && dateKey(new Date(event.actual_scan_time)) === date)
      .map((event) => `${event.person_type}:${event.person_id}`)).size)
    setWeekCounts(dailyCounts)
    setMetrics({
      students: studentCount.count ?? 0,
      teachers: teacherCount.count ?? 0,
      guards: guardCount.count ?? 0,
      pendingEnrollments: pendingEnrollmentCount.error ? null : pendingEnrollmentCount.count ?? 0,
      enrolled: enrolledCount.count ?? 0,
      announcements: announcementCount.count ?? 0,
      inside: snapshot?.inside_count ?? 0,
      visitors: snapshot?.visitors_inside ?? 0,
    })
    setRecent(snapshot?.recent_events ?? [])
    const earlyRows = (earlyOuts.data ?? []).map((row: any) => ({
      id: row.id, kind: 'early' as const,
      student: row.students?.profiles?.full_name ?? row.students?.student_id ?? 'Student',
      grade: row.students?.grade_level ?? '', reason: row.reason,
      requested: new Date(row.requested_departure).toLocaleString('en-PH', { timeZone: 'Asia/Manila' }),
    }))
    const visitorRows = (visitorRequestsData.data ?? []).map((row: any) => ({
      id: row.id, kind: 'visitor' as const,
      student: `${row.visitor_name} · ${row.students?.profiles?.full_name ?? row.students?.student_id ?? 'Student'}`,
      grade: row.students?.grade_level ?? '', reason: row.purpose,
      requested: row.visit_date,
    }))
    setRequests([...earlyRows, ...visitorRows].slice(0, 10))
    setLoading(false)
  }

  useEffect(() => { void refresh() }, [])

  const reviewRequest = async (request: (typeof requests)[number], approved: boolean) => {
    if (!supabase) return
    const { error } = await supabase.rpc('review_student_request', { p_request_type: request.kind === 'early' ? 'early_out' : 'visitor', p_request_id: request.id, p_status: approved ? 'APPROVED' : 'REJECTED', p_remarks: null })
    if (error) setDataError(friendlyError(error))
    else { void supabase.functions.invoke('dispatch-push', { body: { request_id: request.id } }); await refresh() }
  }

  const exportAttendanceReport = async (format: 'csv' | 'xlsx' | 'pdf') => {
    if (!supabase) return
    const { data, error } = await supabase.from('attendance_events')
      .select('id,person_type,person_id,event_type,actual_scan_time,scanning_guard_id,scan_device_id,verification_result,sync_status')
      .order('actual_scan_time', { ascending: false }).limit(10000)
    if (error) { setDataError(friendlyError(error)); return }
    const columns = ['id', 'person_type', 'person_id', 'event_type', 'actual_scan_time', 'scanning_guard_id', 'scan_device_id', 'verification_result', 'sync_status'] as const
    const escapeCsv = (value: unknown) => `"${String(value ?? '').replaceAll('"', '""')}"`
    const fileBase = `valencia-nhs-attendance-${new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date())}`
    const rows = (data ?? []).map((row) => Object.fromEntries(columns.map((column) => [column, row[column]])))
    if (format === 'csv') {
      const csv = [columns.join(','), ...rows.map((row) => columns.map((column) => escapeCsv(row[column])).join(','))].join('\r\n')
      downloadBlob(new Blob([csv], { type: 'text/csv;charset=utf-8' }), `${fileBase}.csv`)
    } else if (format === 'xlsx') {
      const XLSX = await import('xlsx')
      const sheet = XLSX.utils.json_to_sheet(rows)
      const workbook = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(workbook, sheet, 'Attendance')
      XLSX.writeFile(workbook, `${fileBase}.xlsx`)
    } else {
      const { jsPDF } = await import('jspdf')
      const pdf = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' })
      pdf.setFontSize(14); pdf.text('Valencia National High School Attendance Report', 36, 36)
      pdf.setFontSize(8)
      let y = 56
      for (const row of rows) {
        const line = columns.map((column) => String(row[column] ?? '')).join('  |  ')
        const wrapped = pdf.splitTextToSize(line, 770) as string[]
        if (y + wrapped.length * 11 > 560) { pdf.addPage(); y = 36 }
        pdf.text(wrapped, 36, y)
        y += wrapped.length * 11 + 5
      }
      pdf.save(`${fileBase}.pdf`)
    }
  }

  const kpis = [
    { label: 'Total students', value: String(metrics.students), trend: 'Records', accent: 'green' as const },
    { label: 'Total teachers', value: String(metrics.teachers), trend: 'Records', accent: 'blue' as const },
    { label: 'Total guards', value: String(metrics.guards), trend: 'Active accounts', accent: 'blue' as const },
    { label: 'Pending enrollment applications', value: metrics.pendingEnrollments === null ? '—' : String(metrics.pendingEnrollments), trend: 'Needs review', accent: 'amber' as const },
    { label: 'Currently enrolled students', value: String(metrics.enrolled), trend: 'Active records', accent: 'green' as const },
    { label: 'Active announcements', value: String(metrics.announcements), trend: 'Published records', accent: 'amber' as const },
  ]

  return (
    <DashboardShell title="Administrator overview" subtitle="Updated 2 minutes ago">
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {kpis.map((item) => (
          <KpiCard key={item.label} {...item} />
        ))}
      </div>

      <div className="grid gap-6 lg:grid-cols-[1.6fr_0.9fr]">
        <section className="rounded-[28px] border border-[var(--color-border)] bg-white p-5 shadow-sm">
          <div className="mb-5 flex items-center justify-between">
            <div>
              <p className="text-sm font-semibold text-[var(--color-secondary-text)]">Attendance trends</p>
              <h3 className="mt-1 font-[var(--font-display)] text-xl font-bold">Unique entries · last 7 days</h3>
            </div>
            <span className="inline-flex items-center gap-2 rounded-full border border-[var(--color-border)] bg-slate-50 px-3 py-1.5 text-xs font-semibold text-[var(--color-secondary-text)]">
              <CalendarDays className="h-3.5 w-3.5" />
              {loading ? 'Loading' : 'Live records'}
            </span>
          </div>

          <div className="flex h-52 items-end gap-3">
            {weekCounts.map((value, index) => (
              <div key={index} className="flex w-full flex-col items-center gap-2">
                <div className="flex h-full w-full items-end justify-center">
                  <div
                    title={`${value} unique entries`}
                    className="w-full rounded-t-2xl bg-gradient-to-t from-[var(--color-brand-green)] to-[var(--color-brand-soft)]"
                    style={{ height: `${value ? Math.max(8, value / Math.max(1, ...weekCounts) * 100) : 2}%` }}
                  />
                </div>
                <span className="text-[10px] text-[var(--color-secondary-text)]">D{index + 1}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="rounded-[28px] border border-[var(--color-border)] bg-white p-5 shadow-sm">
          <div className="mb-4 flex items-center justify-between">
            <p className="text-sm font-semibold text-[var(--color-secondary-text)]">Campus occupancy</p>
            <Activity className="h-4 w-4 text-[var(--color-brand-green)]" />
          </div>
          <div className="space-y-4">
            <div className="rounded-2xl bg-slate-50 p-3">
              <p className="text-xs uppercase tracking-[0.16em] text-[var(--color-secondary-text)]">Inside campus</p>
              <p className="mt-2 text-3xl font-bold">{metrics.inside}</p>
            </div>
            <div className="rounded-2xl bg-slate-50 p-3">
              <p className="text-xs uppercase tracking-[0.16em] text-[var(--color-secondary-text)]">Outside campus</p>
              <p className="mt-2 text-3xl font-bold">{Math.max(0, metrics.students + metrics.teachers - metrics.inside)}</p>
            </div>
            <div className="rounded-2xl bg-sky-50 p-3">
              <p className="text-xs uppercase tracking-[0.16em] text-[var(--color-secondary-text)]">Visitors inside</p>
              <p className="mt-2 text-3xl font-bold text-sky-700">{metrics.visitors}</p>
            </div>
          </div>
        </section>
      </div>

      <div className="grid gap-6 xl:grid-cols-[1.2fr_0.8fr]">
        <section className="rounded-[28px] border border-[var(--color-border)] bg-white p-5 shadow-sm">
          <div className="mb-4 flex items-center justify-between">
            <h3 className="font-[var(--font-display)] text-xl font-bold">Recent gate activity</h3>
            <span className="flex flex-wrap gap-3 text-sm font-semibold text-[var(--color-brand-dark)]">
              <button onClick={() => void exportAttendanceReport('csv')}>CSV</button>
              <button onClick={() => void exportAttendanceReport('xlsx')}>Excel</button>
              <button onClick={() => void exportAttendanceReport('pdf')}>PDF</button>
            </span>
          </div>
          <div className="overflow-hidden rounded-2xl border border-[var(--color-border)]">
            <table className="min-w-full text-left text-sm">
              <thead className="bg-slate-50 text-[var(--color-secondary-text)]">
                <tr>
                  <th className="px-4 py-3 font-semibold">Time</th>
                  <th className="px-4 py-3 font-semibold">Person</th>
                  <th className="px-4 py-3 font-semibold">Event</th>
                  <th className="px-4 py-3 font-semibold">Status</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((item) => (
                  <tr key={String(item.id)} className="border-t border-[var(--color-border)]">
                    <td className="px-4 py-3 text-[var(--color-secondary-text)]">{formatPhilippineDateTime(String(item.actual_scan_time))}</td>
                    <td className="px-4 py-3 font-medium">{String(item.full_name ?? item.display_id ?? 'School member')}</td>
                    <td className="px-4 py-3">{String(item.event_type)}</td>
                    <td className="px-4 py-3"><StatusBadge status={String(item.sync_status ?? item.verification_result)} /></td>
                  </tr>
                ))}
                {!recent.length && <tr><td colSpan={4} className="px-4 py-6 text-center text-sm text-slate-500">No gate events found.</td></tr>}
              </tbody>
            </table>
          </div>
        </section>

        <section className="rounded-[28px] border border-[var(--color-border)] bg-white p-5 shadow-sm">
          <div className="mb-4 flex items-center justify-between">
            <h3 className="font-[var(--font-display)] text-xl font-bold">Pending approvals</h3>
            <button className="text-sm font-semibold text-[var(--color-brand-dark)]">Review</button>
          </div>
          <div className="space-y-3">
            {requests.map((request) => (
              <div key={request.id} className="rounded-2xl border border-[var(--color-border)] bg-slate-50 p-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="font-semibold">{request.student}</p>
                    <p className="text-xs text-[var(--color-secondary-text)]">{request.kind === 'early' ? 'Early dismissal' : 'Visitor authorization'}{request.grade ? ` · ${request.grade}` : ''}</p>
                  </div>
                  <StatusBadge status="PENDING" />
                </div>
                <p className="mt-3 text-sm text-[var(--color-secondary-text)]">{request.reason}</p>
                <div className="mt-3 flex items-center justify-between text-xs text-[var(--color-secondary-text)]">
                  <span>{request.requested}</span>
                  <span className="flex gap-2">
                    <button onClick={() => void reviewRequest(request, true)} className="font-semibold text-emerald-700">Approve</button>
                    <button onClick={() => void reviewRequest(request, false)} className="font-semibold text-red-700">Reject</button>
                  </span>
                </div>
              </div>
            ))}
            {!requests.length && <p className="rounded-xl bg-slate-50 p-4 text-sm text-slate-500">{loading ? 'Loading requests…' : 'No pending requests.'}</p>}
          </div>
        </section>
      </div>
      {dataError && <p role="alert" className="rounded-xl bg-red-50 p-3 text-sm text-red-700">{dataError}</p>}
    </DashboardShell>
  )
}

type DirectoryStudent = { id: string; student_id: string; grade_level: string; status: string; created_at: string; profile_id: string; profiles?: { full_name?: string; email?: string; phone?: string } | null; sections?: { name?: string } | null }

function StudentDirectory() {
  const { confirmAction } = useFeedback()
  const [searchParams] = useSearchParams()
  const [rows, setRows] = useState<DirectoryStudent[]>([])
  const [query, setQuery] = useState(() => searchParams.get('student_id') ?? '')
  const [grade, setGrade] = useState('all')
  const [busy, setBusy] = useState(true)
  const [message, setMessage] = useState('')
  const refresh = async () => {
    if (!supabase) return
    setBusy(true)
    const { data, error } = await supabase.from('students').select('id,student_id,grade_level,status,created_at,profile_id,profiles(full_name,email,phone),sections(name)').order('student_id').limit(1000)
    if (error) setMessage(friendlyError(error)); else { setRows((data ?? []) as unknown as DirectoryStudent[]); setMessage('') }
    setBusy(false)
  }
  useEffect(() => { void refresh() }, [])
  const grades = [...new Set(rows.map((row) => row.grade_level))].sort()
  const filtered = rows.filter((row) => `${row.student_id} ${row.profiles?.full_name ?? ''} ${row.profiles?.email ?? ''}`.toLowerCase().includes(query.toLowerCase()) && (grade === 'all' || row.grade_level === grade))
  const exportCsv = () => {
    const columns = ['student_id', 'name', 'grade_level', 'section', 'status', 'email', 'phone']
    const quote = (v: unknown) => `"${String(v ?? '').replaceAll('"', '""')}"`
    const csv = [columns.join(','), ...filtered.map((r) => [r.student_id, r.profiles?.full_name, r.grade_level, r.sections?.name, r.status, r.profiles?.email, r.profiles?.phone].map(quote).join(','))].join('\r\n')
    downloadBlob(new Blob([csv], { type: 'text/csv;charset=utf-8' }), 'valencia-student-directory.csv')
  }
  const archive = async (row: DirectoryStudent) => {
    const restoring = row.status === 'archived'
    await confirmAction({title: restoring ? 'Restore student record?' : 'Archive student record?', description: restoring ? 'This student will become active in the student directory again.' : 'This will archive the student record while preserving its history.', itemName: row.profiles?.full_name ?? row.student_id, confirmLabel: restoring ? 'Restore record' : 'Archive record', tone: restoring ? 'primary' : 'danger', successMessage: restoring ? 'Student record restored.' : 'Student record archived.', onConfirm: async () => { const { error } = await supabase!.from('students').update({ status: restoring ? 'active' : 'archived' }).eq('id', row.id); if (error) throw error; await refresh() } })
  }
  return <DashboardShell title="Student management" subtitle={`${rows.length} student records`}>
    <div className="rounded-[24px] border border-[var(--color-border)] bg-white p-4 shadow-sm">
      <div className="mb-4 flex flex-wrap items-center gap-3"><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search name, number, or email" className="min-w-56 flex-1 rounded-xl border border-slate-200 px-3 py-2 text-sm"/><select value={grade} onChange={(e) => setGrade(e.target.value)} className="rounded-xl border border-slate-200 px-3 py-2 text-sm"><option value="all">All grade levels</option>{grades.map((g) => <option key={g}>{g}</option>)}</select><button onClick={exportCsv} className="rounded-xl bg-[var(--color-brand-dark)] px-4 py-2 text-sm font-semibold text-white">Export CSV</button></div>
      {message && <p role="status" className="mb-3 text-sm text-rose-700">{message}</p>}
      <div className="overflow-x-auto"><table className="min-w-full text-left text-sm"><thead className="bg-slate-50 text-slate-500"><tr>{['Student number','Student','Grade','Section','Contact','Registered','Status',''].map((h) => <th key={h} className="px-3 py-3 font-semibold">{h}</th>)}</tr></thead><tbody>{filtered.map((r) => <tr key={r.id} className="border-t border-slate-100"><td className="px-3 py-3 font-medium">{r.student_id}</td><td className="px-3 py-3">{r.profiles?.full_name ?? '—'}<span className="block text-xs text-slate-500">{r.profiles?.email}</span></td><td className="px-3 py-3">{r.grade_level}</td><td className="px-3 py-3">{r.sections?.name ?? 'Unassigned'}</td><td className="px-3 py-3">{r.profiles?.phone ?? '—'}</td><td className="px-3 py-3">{new Date(r.created_at).toLocaleDateString('en-PH')}</td><td className="px-3 py-3"><StatusBadge status={r.status}/></td><td className="px-3 py-3"><button onClick={() => void archive(r)} className="font-semibold text-rose-700">{r.status === 'archived' ? 'Restore' : 'Archive'}</button></td></tr>)}{!filtered.length && <tr><td colSpan={8} className="px-3 py-8 text-center text-slate-500">{busy ? 'Loading students…' : 'No matching students.'}</td></tr>}</tbody></table></div>
    </div>
  </DashboardShell>
}

function ClassModule() {
  const { confirmAction } = useFeedback()
  const [sections, setSections] = useState<{id:string;name:string;grade_level:string}[]>([])
  const [name, setName] = useState(''); const [grade, setGrade] = useState(''); const [message, setMessage] = useState('')
  const refresh = async () => { if (!supabase) return; const {data,error}=await supabase.from('sections').select('id,name,grade_level').order('grade_level').order('name'); if(error)setMessage(friendlyError(error)); else setSections(data ?? []) }
  useEffect(()=>{void refresh()},[])
  const create = async (e: FormEvent) => { e.preventDefault(); if(!supabase)return; const {error}=await supabase.from('sections').insert({name:name.trim(),grade_level:grade.trim()}); if(error)setMessage(friendlyError(error)); else {setMessage('Section created.');setName('');setGrade('');await refresh()} }
  const remove = async (id:string) => { if(!supabase)return; const section=sections.find(item=>item.id===id); await confirmAction({title:'Delete this section?',description:'Students assigned to this section may need reassignment before deletion can complete.',itemName:section?`${section.name} · Grade ${section.grade_level}`:'School section',confirmLabel:'Delete section',tone:'danger',successMessage:'Section deleted.',onConfirm:async()=>{const {error}=await supabase!.from('sections').delete().eq('id',id);if(error)throw error;await refresh()}}) }
  return <DashboardShell title="Class & section management" subtitle="Existing school sections"><div className="grid gap-5 lg:grid-cols-[.8fr_1.2fr]"><form onSubmit={(e)=>void create(e)} className="space-y-3 rounded-2xl border border-slate-200 bg-white p-5"><h3 className="font-bold">Create section</h3><label className="block text-sm">Grade level<input required value={grade} onChange={(e)=>setGrade(e.target.value)} className="mt-1 w-full rounded-xl border p-2.5"/></label><label className="block text-sm">Section name<input required value={name} onChange={(e)=>setName(e.target.value)} className="mt-1 w-full rounded-xl border p-2.5"/></label><button className="rounded-xl bg-[var(--color-brand-dark)] px-4 py-2 text-sm font-semibold text-white">Add section</button>{message&&<p role="status" className="text-sm text-rose-700">{message}</p>}</form><div className="rounded-2xl border border-slate-200 bg-white p-5"><h3 className="mb-3 font-bold">Sections ({sections.length})</h3>{sections.map(s=><div key={s.id} className="flex justify-between border-t py-3 text-sm"><span><b>{s.name}</b><span className="ml-2 text-slate-500">Grade {s.grade_level}</span></span><button onClick={()=>void remove(s.id)} className="text-rose-700">Delete</button></div>)}</div></div></DashboardShell>
}

function ActivityModule({profile}:{profile:ActiveProfile}){return <DashboardShell title="Activity Logs" subtitle="Searchable school administration audit trail"><ActivityLogs profile={profile}/></DashboardShell>}
function SettingsModule(){return <DashboardShell title="School settings" subtitle="Configuration supported by this portal"><div className="rounded-2xl border bg-white p-5"><h3 className="font-bold">Valencia National High School</h3><p className="mt-2 text-sm text-slate-600">The current schema has no school profile, current school year, logo, or portal configuration settings. Section and schedule management are available in Class & Sections and the existing schedule workflow.</p></div></DashboardShell>}

function GuardCameraScanner({
  onScanStateChange,
  onPreview,
  onScan,
  disabled,
}: {
  onScanStateChange: (captured: boolean, error?: string) => void
  onPreview: (qrToken: string) => Promise<Record<string, unknown>>
  onScan: (qrToken: string, eventType: GateEventType) => Promise<AttendanceScanResult>
  disabled: boolean
}) {
  const scannerRef = useRef<Html5QrcodeType | null>(null)
  const [isScanning, setIsScanning] = useState(false)
  const [cameras, setCameras] = useState<{ id: string; label: string }[]>([])
  const [cameraId, setCameraId] = useState('')
  const [message, setMessage] = useState('Camera is off. Start the camera to scan a QR credential.')
  const [scanCaptured, setScanCaptured] = useState(false)
  const [eventType, setEventType] = useState<GateEventType>('ENTRY')
  const [pendingQr, setPendingQr] = useState('')
  const [preview, setPreview] = useState<Record<string, unknown> | null>(null)
  const [confirming, setConfirming] = useState(false)
  const scanInProgress = useRef(false)

  const stopCamera = async () => {
    const scanner = scannerRef.current
    if (!scanner) return
    scannerRef.current = null
    try {
      if (scanner.isScanning) await scanner.stop()
      scanner.clear()
    } catch {
      // The browser may already have stopped the camera.
    }
    setIsScanning(false)
  }

  const startCamera = async (requestedCameraId?: string) => {
    setMessage('Requesting camera access…')
    setScanCaptured(false)
    onScanStateChange(false)
    try {
      if (!window.isSecureContext) {
        throw new Error('Camera access requires HTTPS or localhost. Open this app on a secure connection.')
      }
      const { Html5Qrcode } = await import('html5-qrcode')
      const available = await Html5Qrcode.getCameras()
      if (!available.length) throw new Error('No camera was found on this device.')
      const preferred = available.find(({ label }) => /back|rear|environment/i.test(label)) ?? available[0]
      const selectedId = requestedCameraId ?? (cameraId || preferred.id)
      setCameras(available)
      setCameraId(selectedId)

      const scanner = new Html5Qrcode('schoolguard-qr-reader', { verbose: false })
      scannerRef.current = scanner
      await scanner.start(
        selectedId,
        {
          fps: 10,
          qrbox: (width, height) => {
            const size = Math.floor(Math.min(width, height) * 0.78)
            return { width: size, height: size }
          },
          aspectRatio: 1,
        },
        (decodedText) => {
          if (scanInProgress.current) return
          scanInProgress.current = true
          void (async () => {
            await stopCamera()
            try {
            if (!navigator.onLine) {
              const result = await onScan(decodedText, eventType)
              setScanCaptured(true); onScanStateChange(true); setMessage(friendlyError(result))
            } else {
              const identity = await onPreview(decodedText)
              setPendingQr(decodedText); setPreview(identity); setScanCaptured(true); onScanStateChange(true)
              setMessage('Verify the identity and selected action, then confirm the gate transaction.')
            }
            } catch (error) {
              const reason = friendlyError(error, 'Could not verify the QR credential.')
              setMessage(reason)
              onScanStateChange(false, reason)
            } finally {
              scanInProgress.current = false
            }
          })()
        },
        () => undefined,
      )
      setIsScanning(true)
      setMessage('Point the camera at a school QR code.')
    } catch (error) {
      scannerRef.current = null
      const reason = friendlyError(error, 'Camera could not be started.')
      setMessage(/permission|notallowed/i.test(reason)
        ? 'Camera permission was denied. Allow camera access in your browser settings and try again.'
        : reason)
      setIsScanning(false)
    }
  }

  useEffect(() => () => {
    const scanner = scannerRef.current
    if (scanner?.isScanning) void scanner.stop().catch(() => undefined)
  }, [])

  const confirmTransaction = async () => {
    if (!pendingQr || confirming) return
    setConfirming(true)
    try { const result = await onScan(pendingQr,eventType);setPendingQr('');setPreview(null);setMessage(friendlyError(result)) }
    catch(error){const reason=friendlyError(error, 'Could not record the gate transaction.');setMessage(reason);onScanStateChange(true,reason)}
    finally{setConfirming(false)}
  }

  const previewDetails = preview?.student_details && typeof preview.student_details === 'object' ? preview.student_details as Record<string, unknown> : null
  const approvedOuts = Array.isArray(previewDetails?.approved_early_outs) ? previewDetails.approved_early_outs as Record<string, unknown>[] : []
  const localDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
  const localTime = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Manila', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date())
  const validApproval = approvedOuts.find(row => String(row.status) === 'APPROVED' && String(row.approved_departure_date) === localDate && String(row.approved_departure_start).slice(0,5) <= localTime && String(row.approved_departure_end).slice(0,5) >= localTime && Date.parse(String(row.expires_at)) > Date.now())
  const authorizedEarlyOut = preview?.person_type === 'student' && previewDetails?.inside_campus === true && Boolean(validApproval)

  return (
    <div className="space-y-4">
      <label className="block text-sm font-medium">
        Gate action
        <select value={eventType} onChange={(event) => setEventType(event.target.value as GateEventType)} className="mt-1.5 w-full rounded-xl border border-[var(--color-border)] bg-white px-3 py-2.5">
          <option value="ENTRY">Entry</option>
          <option value="EXIT">Exit</option>
          <option value="EARLY_OUT">Early out</option>
          <option value="TEMPORARY_EXIT">Temporary exit</option>
          <option value="RETURN">Return to campus</option>
        </select>
      </label>
      {eventType === 'EARLY_OUT' && preview && <div className={`rounded-xl border p-3 text-sm ${authorizedEarlyOut ? 'border-emerald-300 bg-emerald-50 text-emerald-950' : 'border-amber-300 bg-amber-50 text-amber-950'}`} role="status"><b>{authorizedEarlyOut ? 'EARLY-OUT AUTHORIZED' : validApproval && previewDetails?.inside_campus !== true ? 'An approved request exists, but this student is not recorded inside school' : 'No valid early-out authorization for this student right now'}</b>{validApproval && <p className="mt-1">Window: {String(validApproval.approved_departure_start).slice(0,5)}–{String(validApproval.approved_departure_end).slice(0,5)} · Expires {formatPhilippineDateTime(String(validApproval.expires_at))}</p>}</div>}
      {preview && <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4" role="status"><div className="mb-2 flex items-center gap-3"><ProfileAvatar path={typeof preview.profile_photo_path === 'string' ? preview.profile_photo_path : null} name={String(preview.full_name)} size={48}/><p className="font-bold text-emerald-950">Identity verified · {String(preview.person_type).toUpperCase()}</p></div><p className="mt-1 text-lg font-semibold">{String(preview.full_name)}</p><p className="text-sm">{String(preview.display_id)}{preview.grade_level?` · ${String(preview.grade_level)}`:''}{preview.section_name?` · ${String(preview.section_name)}`:''}</p>{Boolean(preview.student_details&&typeof preview.student_details==='object')&&(()=>{const details=preview.student_details as Record<string,unknown>;const attendance=details.today_attendance as Record<string,unknown>|null;const activity=Array.isArray(details.recent_gate_activity)?details.recent_gate_activity as Record<string,unknown>[]:[];const outs=Array.isArray(details.approved_early_outs)?details.approved_early_outs as Record<string,unknown>[]:[];return <div className="mt-3 space-y-3 text-xs"><div className="grid gap-2 sm:grid-cols-3"><span>Enrollment: {String(details.enrollment_status??'—')}</span><span>Attendance: {String(attendance?.status??'No daily record')}{attendance?.entry_time?` · in ${formatPhilippineDateTime(String(attendance.entry_time))}`:''}</span><span>Campus: {details.inside_campus===true?'Inside':details.inside_campus===false?'Outside':'Unknown'}</span>{Boolean(details.contact_number)&&<span>Student contact: {String(details.contact_number)}</span>}{Boolean(details.guardian_name)&&<span>Guardian: {String(details.guardian_name)}</span>}{Boolean(details.guardian_contact)&&<span>Guardian contact: {String(details.guardian_contact)}</span>}{outs.map(r=><span key={String(r.id)} className="sm:col-span-3">Approved early out: {formatPhilippineDateTime(String(r.requested_departure))} · {String(r.reason)} · {String(r.approved_departure_start??'').slice(0,5)}–{String(r.approved_departure_end??'').slice(0,5)} · {String(r.status)}</span>)}</div>{activity.length>0&&<div><p className="font-semibold">Recent gate activity</p><ul className="mt-1 space-y-1">{activity.slice(0,5).map((event,i)=><li key={`${String(event.actual_scan_time)}-${i}`}>{String(event.event_type).replaceAll('_',' ')} · {formatPhilippineDateTime(String(event.actual_scan_time))} · {String(event.sync_status)}</li>)}</ul></div>}</div>})()}<div className="mt-3 flex gap-2"><button disabled={confirming||(eventType==='EARLY_OUT'&&(!navigator.onLine||!authorizedEarlyOut))} onClick={()=>void confirmTransaction()} className="rounded-xl bg-emerald-800 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60">{confirming?'Recording…':`Confirm ${eventType.replace('_',' ').toLowerCase()}`}</button><button disabled={confirming} onClick={()=>{setPendingQr('');setPreview(null);setMessage('Scan cancelled.');onScanStateChange(false)}} className="rounded-xl border bg-white px-4 py-2 text-sm font-semibold">Cancel</button></div></div>}
      <div className="overflow-hidden rounded-2xl border border-[var(--color-border)] bg-slate-950">
        <div id="schoolguard-qr-reader" className="min-h-48 w-full sm:min-h-64" />
        {!isScanning && (
          <div className="flex min-h-48 flex-col items-center justify-center px-5 py-8 text-center text-white sm:min-h-64">
            {scanCaptured ? <QrCode className="mb-3 h-10 w-10 text-emerald-300" /> : <CameraOff className="mb-3 h-10 w-10 text-slate-300" />}
            <p className="max-w-lg text-sm text-slate-200">{message}</p>
          </div>
        )}
      </div>
      {cameras.length > 1 && (
        <label className="block text-sm font-medium">
          Camera
          <select
            className="mt-1.5 w-full rounded-xl border border-[var(--color-border)] bg-white px-3 py-2.5"
            value={cameraId}
            onChange={(event) => {
              const nextCamera = event.target.value
              setCameraId(nextCamera)
              if (isScanning) void stopCamera().then(() => startCamera(nextCamera))
            }}
          >
            {cameras.map((camera, index) => <option key={camera.id} value={camera.id}>{camera.label || `Camera ${index + 1}`}</option>)}
          </select>
        </label>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        {isScanning ? (
          <button onClick={() => void stopCamera()} className="inline-flex min-h-12 items-center justify-center gap-2 rounded-2xl bg-red-600 px-4 py-3 text-sm font-semibold text-white hover:bg-red-700">
            <CameraOff className="h-4 w-4" /> Stop camera
          </button>
        ) : (
          <button disabled={disabled} onClick={() => void startCamera()} className="inline-flex min-h-12 items-center justify-center gap-2 rounded-2xl bg-[var(--color-brand-dark)] px-4 py-3 text-sm font-semibold text-white hover:bg-[#1d5d45] disabled:cursor-not-allowed disabled:opacity-50">
            <Camera className="h-4 w-4" /> {disabled ? 'Register device first' : scanCaptured ? 'Scan another QR' : 'Start camera'}
          </button>
        )}
        <p className="flex items-center justify-center rounded-2xl border border-[var(--color-border)] bg-slate-50 px-4 py-3 text-center text-xs text-[var(--color-secondary-text)]">
          Camera access works on HTTPS or localhost. Mobile devices prefer the rear camera.
        </p>
      </div>
    </div>
  )
}

function ManualGuardLookup({ deviceId, guardId, onRecorded }: { deviceId: string; guardId: string; onRecorded: (result: AttendanceScanResult) => void }) {
  const [displayId,setDisplayId]=useState('');const [person,setPerson]=useState<Awaited<ReturnType<typeof lookupGuardPerson>>|null>(null);const [results,setResults]=useState<Awaited<ReturnType<typeof searchGuardStudents>>>([]);const [details,setDetails]=useState<Record<string,unknown>|null>(null);const [eventType,setEventType]=useState<GateEventType>('ENTRY');const [message,setMessage]=useState('');const [busy,setBusy]=useState(false)
  const lookup=async(event:FormEvent<HTMLFormElement>)=>{event.preventDefault();setBusy(true);setMessage('');setPerson(null);setDetails(null);try{if(!navigator.onLine){setPerson(await lookupGuardPerson(displayId));setMessage('Confirm the physical school ID. Offline lookup only supports an exact school ID.') }else{const found=await searchGuardStudents(displayId);setResults(found);if(!found.length)setMessage('No active student matched that name or student number.');else if(found.length===1){const row=found[0];setPerson({personId:row.student_id,personType:'student',displayId:row.school_student_id,fullName:row.full_name,gradeLevel:row.grade_level,sectionName:row.section_name});setDetails(await getGuardStudentSnapshot(row.student_id));setMessage('Confirm the student’s physical school ID before recording manually.')}else setMessage(`${found.length} students matched. Select the correct student and verify their school ID.`)}}catch(error){setMessage(friendlyError(error, 'Lookup failed.'))}finally{setBusy(false)}}
  const choose=async(row:Awaited<ReturnType<typeof searchGuardStudents>>[number])=>{setBusy(true);try{setPerson({personId:row.student_id,personType:'student',displayId:row.school_student_id,fullName:row.full_name,gradeLevel:row.grade_level,sectionName:row.section_name});setDetails(await getGuardStudentSnapshot(row.student_id));setResults([]);setMessage('Confirm the student’s physical school ID before recording manually.')}catch(error){setMessage(friendlyError(error, 'Could not load the student record.'))}finally{setBusy(false)}}
  const record=async()=>{if(!person||!deviceId)return;setBusy(true);try{const result=await recordManualScan(person,eventType,deviceId,guardId);onRecorded(result);setMessage(friendlyError(result));setPerson(null);setDetails(null);setDisplayId('')}catch(error){setMessage(friendlyError(error, 'Manual attendance could not be recorded.'))}finally{setBusy(false)}}
  return <section className="rounded-[28px] border border-[var(--color-border)] bg-white p-4 shadow-sm sm:p-5"><h3 className="font-[var(--font-display)] text-xl font-bold">Student lookup</h3><p className="mt-1 text-sm text-slate-500">Search by student name or number, verify the person’s school ID, then record a manual gate event.</p><form onSubmit={(event)=>void lookup(event)} className="mt-4 grid gap-3 sm:grid-cols-[1fr_auto]"><label className="text-xs font-semibold">Student name or student number<input required value={displayId} onChange={event=>setDisplayId(event.target.value)} className="mt-1 block w-full rounded-xl border border-slate-200 px-3 py-3 text-sm"/></label><button disabled={busy||!deviceId} className="self-end rounded-xl bg-slate-900 px-4 py-3 text-sm font-semibold text-white disabled:opacity-50">{busy?'Please wait…':'Search students'}</button></form>{results.length>1&&<div className="mt-3 space-y-2">{results.map(row=><button key={row.student_id} onClick={()=>void choose(row)} className="flex w-full items-center justify-between rounded-xl border p-3 text-left hover:bg-emerald-50"><span><b>{row.full_name}</b><small className="block text-slate-500">{row.school_student_id} · Grade {row.grade_level} · {row.section_name??'Unassigned'}</small></span><span className="text-xs font-semibold">{row.enrollment_status}</span></button>)}</div>}{person&&<div className="mt-4 rounded-2xl border border-emerald-100 bg-emerald-50 p-4"><p className="font-semibold">{person.fullName} · {person.displayId}</p><p className="mt-1 text-sm text-slate-600">{person.personType} · Grade {person.gradeLevel??'—'} · {person.sectionName??'Unassigned'}</p>{details&&<div className="mt-3 grid gap-2 text-xs sm:grid-cols-3"><span>Enrollment: {String(details.enrollment_status??'—')}</span><span>Today: {String((details.today_attendance as Record<string,unknown>|null)?.status??'No record')}</span><span>Campus: {details.inside_campus===true?'Inside':details.inside_campus===false?'Outside':'Unknown'}</span></div>}<div className="mt-3 flex flex-wrap gap-2"><select value={eventType} onChange={event=>setEventType(event.target.value as GateEventType)} className="rounded-xl border bg-white px-3 py-2 text-sm"><option value="ENTRY">Entry</option><option value="EXIT">Exit</option><option value="TEMPORARY_EXIT">Temporary exit</option><option value="RETURN">Return</option></select><button disabled={busy} onClick={()=>void record()} className="rounded-xl bg-emerald-700 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">Confirm and record event</button></div></div>}{message&&<p role="status" className="mt-3 text-sm text-slate-600">{message}</p>}</section>
}

function GuardVisitorDesk() {
  const { confirmAction } = useFeedback()
  const [visitorName, setVisitorName] = useState('')
  const [contact, setContact] = useState('')
  const [relationship, setRelationship] = useState('')
  const [identification, setIdentification] = useState('')
  const [purpose, setPurpose] = useState('')
  const [visitorRemarks,setVisitorRemarks]=useState('')
  const [studentQuery,setStudentQuery]=useState('')
  const [studentMatches,setStudentMatches]=useState<Awaited<ReturnType<typeof searchGuardStudents>>>([])
  const [selectedStudent,setSelectedStudent]=useState<Awaited<ReturnType<typeof searchGuardStudents>>[number]|null>(null)
  const [records, setRecords] = useState<Record<string, unknown>[]>([])
  const [approvedRequests, setApprovedRequests] = useState<CachedVisitorApproval[]>([])
  const [message, setMessage] = useState('')

  const refresh = async () => {
    const [local, remote, approved] = await Promise.all([
      getRecentVisitors(),
      navigator.onLine && supabase
        ? supabase.from('visitor_logs').select('id,visitor_request_id,visitor_name,contact_number,identification_details,relationship_to_student,student_id,purpose,person_contacted,visitor_remarks,visit_date,authorization_status,requested_at,actual_entry_time,actual_departure_time,requester_guard_id,decision_remarks,students(student_id,grade_level,profiles(full_name),sections(name))').order('requested_at', { ascending: false }).limit(50)
        : Promise.resolve({ data: [], error: null }),
      refreshApprovedVisitorCache().catch((error) => { setMessage(friendlyError(error, 'Could not refresh visitor approvals.')); return [] }),
    ])
    setApprovedRequests(approved.map((item) => ({ ...item })))
    const serverRows = remote.data ?? []
    const seen = new Set(serverRows.map((item: { id: string }) => item.id))
    const localRows = local.filter((item) => !seen.has(item.id)).map((item) => ({
      id: item.id, visitor_name: item.visitorName, contact_number: item.contactNumber,
      identification_details: item.identificationDetails, purpose: item.purpose,
      person_contacted:item.personContacted,relationship_to_student:item.relationshipToStudent,
      visit_date: item.visitDate, authorization_status: item.authorizationStatus,
      actual_departure_time: item.actualDepartureTime, sync_status: item.syncStatus,
    }))
    setRecords([...localRows, ...serverRows])
    if (remote.error) setMessage(friendlyError(remote.error))
  }

  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => void refresh(), 30_000)
    window.addEventListener('online', refresh)
    return () => { window.clearInterval(timer); window.removeEventListener('online', refresh) }
  }, [])

  const registerVisitor = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const log: PendingVisitorLog = {
      id: crypto.randomUUID(), visitorRequestId: null, visitorName: visitorName.trim(),
      contactNumber: contact.trim() || null, identificationDetails: identification.trim() || null,
      relationshipToStudent: relationship.trim() || null, studentId: selectedStudent?.student_id ?? null, purpose: purpose.trim(),remarks:visitorRemarks.trim()||null,
      visitDate: new Date().toISOString(), personContacted: selectedStudent?.full_name??(studentQuery.trim()||null), authorizationStatus: 'PENDING',
      actualDepartureTime: null, syncStatus: 'PENDING', attemptCount: 0,
    }
    await addPendingVisitor(log)
    setVisitorName(''); setContact(''); setRelationship(''); setIdentification(''); setPurpose('');setVisitorRemarks('');setStudentQuery('');setSelectedStudent(null);setStudentMatches([])
    setMessage(navigator.onLine ? 'Walk-in request submitted for administrator authorization. Entry remains blocked while pending.' : 'Walk-in saved offline as unverified. It will be submitted for administrator authorization after synchronization; entry is not approved.')
    await syncPendingVisitors()
    await refresh()
  }

  const checkOut = async (id: string) => {
    if (!supabase || !navigator.onLine) return
    const { error } = await supabase.rpc('guard_record_visitor_exit', { p_log_id: id })
    setMessage(friendlyError(error, 'Visitor departure recorded.'))
    if(!error)void supabase.functions.invoke('dispatch-push',{body:{request_id:id}})
    await refresh()
  }

  const checkInWalkin=async(id:string)=>{if(!supabase||!navigator.onLine)throw new Error('Connect to the internet before recording visitor entry.');const {error}=await supabase.rpc('guard_checkin_walkin',{p_log_id:id});if(error)throw error;void supabase.functions.invoke('dispatch-push',{body:{request_id:id}});await refresh()}

  const checkInApproved = async (id: string) => {
    if (navigator.onLine && supabase) {
      const { error } = await supabase.rpc('check_in_authorized_visitor', { p_request_id: id, p_event_id: crypto.randomUUID() })
      if(error)throw error
      if(!error)void supabase.functions.invoke('dispatch-push',{body:{request_id:id}})
      if (!error) setApprovedRequests((current) => current.filter((request) => request.id !== id))
    } else {
      const approval = approvedRequests.find((request) => request.id === id)
      if (!approval) { setMessage('This visitor approval is not cached on this device.'); return }
      try {
        await queueApprovedVisitorCheckIn(approval)
        setApprovedRequests((current) => current.filter((request) => request.id !== id))
        setMessage('Visitor check-in saved offline. The server will revalidate the approval when this device reconnects.')
      } catch (error) { setMessage(friendlyError(error, 'Could not record offline visitor check-in.')); throw error }
    }
    await refresh()
  }

  return (
    <section className="rounded-[28px] border border-[var(--color-border)] bg-white p-4 shadow-sm sm:p-5">
      <div className="mb-4"><h3 className="font-[var(--font-display)] text-xl font-bold">Walk-in visitors</h3><p className="mt-1 text-sm text-slate-500">Unapproved visitors remain pending until a guard authorizes entry.</p></div>
      <form onSubmit={(event) => void registerVisitor(event)} className="grid gap-3 rounded-2xl bg-slate-50 p-3 sm:grid-cols-2">
        <label className="text-xs font-semibold">Visitor name<input required maxLength={120} value={visitorName} onChange={(event) => setVisitorName(event.target.value)} className="mt-1 block w-full rounded-xl border border-slate-200 bg-white p-2.5 text-sm" /></label>
        <label className="text-xs font-semibold">Contact number<input maxLength={40} value={contact} onChange={(event) => setContact(event.target.value)} className="mt-1 block w-full rounded-xl border border-slate-200 bg-white p-2.5 text-sm" /></label>
        <label className="text-xs font-semibold">Relationship / affiliation<input maxLength={100} value={relationship} onChange={(event) => setRelationship(event.target.value)} className="mt-1 block w-full rounded-xl border border-slate-200 bg-white p-2.5 text-sm" /></label>
        <label className="text-xs font-semibold">ID details<input maxLength={200} value={identification} onChange={(event) => setIdentification(event.target.value)} className="mt-1 block w-full rounded-xl border border-slate-200 bg-white p-2.5 text-sm" /></label>
        <div className="sm:col-span-2"><label className="text-xs font-semibold">Student / person to visit (optional)<span className="mt-1 flex gap-2"><input value={selectedStudent?`${selectedStudent.full_name} · ${selectedStudent.school_student_id}`:studentQuery} onChange={event=>{setStudentQuery(event.target.value);setSelectedStudent(null)}} className="min-w-0 flex-1 rounded-xl border bg-white p-2.5 text-sm" placeholder="Search student name or number"/><button type="button" disabled={!navigator.onLine||!studentQuery.trim()} onClick={()=>void searchGuardStudents(studentQuery).then(setStudentMatches).catch(error=>setMessage(friendlyError(error)))} className="rounded-xl border bg-white px-3 text-xs font-semibold">Find</button></span></label>{studentMatches.length>0&&<div className="mt-2 max-h-40 overflow-y-auto rounded-xl border bg-white">{studentMatches.map(item=><button type="button" key={item.student_id} onClick={()=>{setSelectedStudent(item);setStudentMatches([])}} className="block w-full border-b p-2 text-left text-xs hover:bg-emerald-50"><b>{item.full_name}</b><span className="block text-slate-500">{item.school_student_id} · Grade {item.grade_level} · {item.section_name??'Unassigned'}</span></button>)}</div>}</div>
        <label className="text-xs font-semibold sm:col-span-2">Purpose<input required maxLength={500} value={purpose} onChange={(event) => setPurpose(event.target.value)} className="mt-1 block w-full rounded-xl border border-slate-200 bg-white p-2.5 text-sm" /></label>
        <label className="text-xs font-semibold sm:col-span-2">Additional remarks<textarea maxLength={1000} rows={2} value={visitorRemarks} onChange={event=>setVisitorRemarks(event.target.value)} className="mt-1 block w-full rounded-xl border border-slate-200 bg-white p-2.5 text-sm"/></label>
        <button className="min-h-11 rounded-xl bg-[var(--color-brand-dark)] px-4 py-2 text-sm font-semibold text-white sm:col-span-2">Register walk-in</button>
      </form>
      {message && <p role="status" className="mt-3 text-sm text-slate-600">{message}</p>}
      <div className="mt-4 rounded-2xl border border-emerald-100 bg-emerald-50 p-3">
        <h4 className="font-semibold text-emerald-900">Approved visitors for today</h4>
        <div className="mt-2 space-y-2">
          {approvedRequests.map((request) => <div key={String(request.id)} className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-white p-3 text-sm">
            <span><strong>{request.visitorName}</strong><span className="block text-xs text-slate-500">Visiting {request.studentName??request.studentId??'—'} · {request.studentNumber??''} · Grade {request.gradeLevel??'—'} {request.sectionName??''}</span><span className="block text-xs text-slate-500">{request.purpose} · {request.expectedArrivalTime}</span></span>
            <button onClick={() => void confirmAction({title:'Record visitor arrival?',description:'Confirm that you checked the visitor’s identity against their ID.',itemName:request.visitorName,confirmLabel:'Verify and record entry',tone:'primary',onConfirm:()=>checkInApproved(String(request.id))})} className="rounded-lg bg-emerald-700 px-3 py-2 text-xs font-semibold text-white">Verify & record entry</button>
          </div>)}
          {!approvedRequests.length && <p className="text-sm text-emerald-900/70">No approved appointments for today.</p>}
        </div>
      </div>
      <div className="mt-4 space-y-2">
        {records.map((item) => {
          const isInside = item.authorization_status === 'APPROVED' && Boolean(item.actual_entry_time??(item.visitor_request_id?item.visit_date:null)) && !item.actual_departure_time
          return <div key={String(item.id)} className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-200 p-3">
            <div><p className="font-semibold">{String(item.visitor_name)}</p><p className="text-xs text-slate-500">{String(item.purpose ?? '')} · {item.requested_at?`Requested ${formatPhilippineDateTime(String(item.requested_at))}`:`Entry ${formatPhilippineDateTime(String(item.actual_entry_time??item.visit_date))}`}</p><p className="mt-1 text-xs text-slate-600">Contact {String(item.contact_number??'—')} · ID {String(item.identification_details??'not provided')} · Visiting {String(item.person_contacted??'unspecified')}</p>{Boolean(item.visitor_remarks)&&<p className="mt-1 text-xs text-slate-600">Remarks: {String(item.visitor_remarks)}</p>}{Boolean(item.decision_remarks)&&<p className="mt-1 text-xs text-slate-600">Decision note: {String(item.decision_remarks)}</p>}</div>
            <div className="flex items-center gap-2"><StatusBadge status={String(item.authorization_status)} />
              {Boolean(item.sync_status) && <StatusBadge status={String(item.sync_status)} />}
              {!item.sync_status && item.requester_guard_id===undefined&&item.authorization_status==='PENDING'&&<span className="text-xs text-amber-800">Awaiting administrator</span>}
              {!item.sync_status && Boolean(item.requester_guard_id)&&item.authorization_status==='APPROVED'&&!item.actual_entry_time&&<button disabled={!navigator.onLine} onClick={()=>void confirmAction({title:'Record visitor arrival?',description:'Confirm that you checked the visitor’s identity against their ID.',itemName:String(item.visitor_name),confirmLabel:'Verify and record entry',tone:'primary',onConfirm:()=>checkInWalkin(String(item.id))})} className="rounded-lg bg-emerald-700 px-3 py-2 text-xs font-semibold text-white disabled:opacity-50">Verify & record entry</button>}
              {!item.sync_status && isInside && <button disabled={!navigator.onLine} onClick={() => void checkOut(String(item.id))} className="rounded-lg border px-3 py-2 text-xs font-semibold disabled:opacity-50">Check out</button>}
            </div>
          </div>
        })}
        {!records.length && <p className="py-3 text-sm text-slate-500">No visitor logs found.</p>}
      </div>
    </section>
  )
}

function GuardDashboard({ profile }: { profile: ActiveProfile }) {
  const location = useLocation()
  const [pendingCount, setPendingCount] = useState<number>(0)
  const [isOnline, setIsOnline] = useState(() => navigator.onLine)
  const [scanCaptured, setScanCaptured] = useState(false)
  const [scanError, setScanError] = useState('')
  const [deviceId, setDeviceId] = useState('')
  const [deviceError, setDeviceError] = useState('')
  const [queuedEvents, setQueuedEvents] = useState<Awaited<ReturnType<typeof getRecentQueuedAttendance>>>([])
  const [snapshot, setSnapshot] = useState<{ inside_count: number; visitors_inside: number; recent_events: Record<string, unknown>[] } | null>(null)
  const [metrics,setMetrics]=useState<{entries_today:number;exits_today:number;early_outs_today:number;inside_count:number;visitors_inside:number;pending_visitors:number}|null>(null)
  const [lastScan, setLastScan] = useState<AttendanceScanResult | null>(null)

  useEffect(() => {
    let active = true
    const refreshLocalState = async () => {
      const [count, events] = await Promise.all([getPendingSyncCount(), getRecentQueuedAttendance()])
      if (active) {
        setPendingCount(count)
        setQueuedEvents(events)
      }
    }
    const updateConnection = () => setIsOnline(navigator.onLine)
    const loadSnapshot = async () => {
      if (!navigator.onLine || !supabase) return
      const [snap,counts] = await Promise.all([supabase.rpc('get_guard_dashboard_snapshot'),supabase.rpc('get_guard_dashboard_metrics')])
      if (active && snap.data) setSnapshot(snap.data as typeof snapshot)
      if (active && counts.data) setMetrics(counts.data as typeof metrics)
    }
    const handleOnline = () => {
      updateConnection()
      void refreshOfflineQrCache().catch((error) => setDeviceError(friendlyError(error)))
      void syncPendingAttendance().then(() => refreshLocalState())
      void syncPendingVisitors().then(() => refreshLocalState())
      void loadSnapshot()
    }
    const initialize = async () => {
      await recoverSyncingEvents()
      void refreshLocalState()
      try {
        const registeredId = await registerGuardDevice(profile.id)
        if (!active) return
        setDeviceId(registeredId)
        setDeviceError('')
      } catch (error) {
        if (active) setDeviceError(friendlyError(error, 'Could not register this guard device.'))
      }
      if (navigator.onLine) {
        try { await refreshOfflineQrCache() } catch (error) {
          if (active) setDeviceError(friendlyError(error, 'Could not load offline QR data.'))
        }
        await syncPendingAttendance()
        await syncPendingVisitors()
        await loadSnapshot()
        await refreshLocalState()
      }
    }
    void initialize()
    const timer = window.setInterval(() => {
      void refreshLocalState()
      void syncPendingAttendance().then(() => refreshLocalState())
      void syncPendingVisitors().then(() => refreshLocalState())
      void loadSnapshot()
    }, 15_000)
    window.addEventListener('online', updateConnection)
    window.addEventListener('online', handleOnline)
    window.addEventListener('offline', updateConnection)
    return () => {
      active = false
      window.clearInterval(timer)
      window.removeEventListener('online', updateConnection)
      window.removeEventListener('online', handleOnline)
      window.removeEventListener('offline', updateConnection)
    }
  }, [profile.id])

  const handleScan = async (qrToken: string, eventType: GateEventType) => {
    if (!deviceId) throw new Error(deviceError || 'This guard device is not registered yet.')
    const result = await recordQrScan(qrToken, eventType, deviceId, profile.id)
    setLastScan(result)
    setScanError('')
    await Promise.all([getPendingSyncCount().then(setPendingCount), getRecentQueuedAttendance().then(setQueuedEvents)])
    if (navigator.onLine) void syncPendingAttendance().then(() => getPendingSyncCount().then(setPendingCount))
    return result
  }

  const path = location.pathname.replace(/\/$/, '') || '/guard'
  const isDashboard = path === '/guard'
  const isScanner = path === '/guard/scanner'
  const isStudentLookup = path === '/guard/students'
  const isVisitors = path === '/guard/visitors'
  const isAnnouncements = path === '/guard/announcements'
  const isNotifications = path === '/guard/notifications'
  const isGateHistory = path === '/guard/activity'
  const isEarlyOuts = path === '/guard/early-outs'
  const pageTitle = isDashboard ? 'Guard dashboard' : isScanner ? 'QR scanner' : isEarlyOuts ? 'Early-Out Approvals' : isStudentLookup ? 'Student lookup' : isVisitors ? 'Visitor management' : isAnnouncements ? 'Announcements' : isNotifications ? 'Notifications' : 'Gate history'

  return (
    <DashboardShell title={pageTitle} subtitle={`Welcome, ${profile.full_name} · Gate operations`}>
      {isDashboard && <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">{[['Entries today',metrics?.entries_today??0],['Exits today',metrics?.exits_today??0],['Early-outs today',metrics?.early_outs_today??0],['Students currently inside',metrics?.inside_count??0],['Visitors inside',metrics?.visitors_inside??snapshot?.visitors_inside??0],['Pending visitor approvals',metrics?.pending_visitors??0]].map(([label,value])=><div key={String(label)} className="rounded-2xl border border-[var(--color-border)] bg-white p-4 shadow-sm"><p className="text-xs text-slate-500">{label}</p><p className="mt-2 text-2xl font-bold">{value}</p></div>)}</section>}
      {isScanner && <div className="grid min-w-0 gap-6 xl:grid-cols-[minmax(0,1.1fr)_minmax(20rem,0.9fr)]">
        <section className="min-w-0 rounded-[28px] border border-[var(--color-border)] bg-white p-4 shadow-sm sm:p-5">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-sm text-[var(--color-secondary-text)]">QR scanner</p>
              <h3 className="font-[var(--font-display)] text-xl font-bold">Scan student or teacher ID</h3>
            </div>
            <span className={`rounded-full px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] ${isOnline ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}`}>
              {isOnline ? 'Online' : 'Offline'}
            </span>
          </div>
          <GuardCameraScanner
            onScanStateChange={(captured, error) => { setScanCaptured(captured); setScanError(error ?? '') }}
            onPreview={async (token)=>{if(!deviceId)throw new Error(deviceError||'This guard device is not registered yet.');return previewGuardQr(token)}}
            onScan={handleScan}
            disabled={!deviceId}
          />
          {deviceError && <p role="status" className="mt-3 rounded-xl bg-amber-50 p-3 text-sm text-amber-800">{deviceError}</p>}
        </section>

        <section className="min-w-0 rounded-[28px] border border-[var(--color-border)] bg-white p-4 shadow-sm sm:p-5">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <h3 className="font-[var(--font-display)] text-xl font-bold">Scan result</h3>
            <span className={`rounded-full px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] ${scanCaptured ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-600'}`}>
              {scanCaptured ? 'QR captured' : 'Awaiting scan'}
            </span>
          </div>
          <div className="rounded-2xl border border-dashed border-[var(--color-border)] bg-slate-50 p-6 text-center text-sm text-[var(--color-secondary-text)]">
            {scanError ? <span className="text-red-700">{scanError}</span> : lastScan ? (
              <div>
                <p className="text-lg font-semibold text-[var(--color-main-text)]">{lastScan.fullName}</p>
                <p className="mt-1">{lastScan.displayId}{lastScan.gradeLevel ? ` · ${lastScan.gradeLevel}` : ''}</p>
                <p className="mt-3 font-semibold text-[var(--color-brand-dark)]">{lastScan.eventType.replace('_', ' ')} · {lastScan.syncStatus}</p>
                <p className="mt-1">{formatPhilippineDateTime(lastScan.scannedAt)}</p>
                <p className="mt-3 text-xs">{lastScan.message}</p>
              </div>
            ) : 'Scan a QR credential to validate it and record the selected gate event.'}
          </div>
          <div className="mt-5 space-y-3">
            <div className="flex items-center justify-between gap-3 rounded-2xl border border-[var(--color-border)] bg-white px-3 py-2">
              <span className="text-sm text-[var(--color-secondary-text)]">Connectivity</span>
              <span className={`inline-flex items-center gap-2 rounded-full px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] ${isOnline ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}`}>
                {isOnline ? <Wifi className="h-3 w-3" /> : <WifiOff className="h-3 w-3" />}{isOnline ? 'ONLINE' : 'OFFLINE'}
              </span>
            </div>
            <div className="flex items-center justify-between gap-3 rounded-2xl border border-[var(--color-border)] bg-white px-3 py-2">
              <span className="text-sm text-[var(--color-secondary-text)]">Pending sync</span>
              <span className="font-semibold text-[var(--color-brand-dark)]">{pendingCount} records</span>
            </div>
          </div>
        </section>
      </div>}

      {(isScanner || isDashboard) && <div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1.1fr)_minmax(18rem,0.9fr)]">{isScanner && <section className="min-w-0 rounded-[28px] border border-[var(--color-border)] bg-white p-4 shadow-sm sm:p-5">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3"><h3 className="font-[var(--font-display)] text-xl font-bold">Synchronization queue</h3><span className="rounded-full bg-amber-100 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-amber-700">{pendingCount} pending</span></div>
          <div className="space-y-3">{queuedEvents.length ? queuedEvents.map((item) => <div key={item.id} className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[var(--color-border)] bg-slate-50 px-3 py-3"><div><p className="font-semibold">{item.fullName}</p><p className="text-xs text-[var(--color-secondary-text)]">{item.displayId} · {item.eventType}</p></div><StatusBadge status={item.syncStatus} /></div>) : <p className="rounded-xl bg-slate-50 p-4 text-sm text-[var(--color-secondary-text)]">No attendance events are waiting to sync.</p>}</div>
        </section>}
        {(isDashboard || isGateHistory) && <section className="min-w-0 rounded-[28px] border border-[var(--color-border)] bg-white p-4 shadow-sm sm:p-5">
          <div className="mb-4 flex items-center justify-between gap-3"><h3 className="font-[var(--font-display)] text-xl font-bold">{isDashboard ? 'Recent gate activity' : 'Attendance and gate history'}</h3></div>
          <div className="space-y-3">{snapshot?.recent_events.length ? snapshot.recent_events.map((event) => <div key={String(event.id)} className="rounded-2xl border border-[var(--color-border)] bg-slate-50 p-3"><div className="flex flex-wrap items-center justify-between gap-3"><div><p className="font-semibold">{String(event.full_name ?? event.display_id ?? 'School member')}</p><p className="text-xs text-[var(--color-secondary-text)]">{String(event.event_type)} · {String(event.display_id ?? '')}</p></div><StatusBadge status={String(event.sync_status ?? event.verification_result)} /></div><p className="mt-2 text-xs text-[var(--color-secondary-text)]">{formatPhilippineDateTime(String(event.actual_scan_time))}</p></div>) : <p className="rounded-xl bg-slate-50 p-4 text-sm text-[var(--color-secondary-text)]">No synchronized gate activity is available.</p>}</div>
        </section>}
      </div>}
      {isStudentLookup && <ManualGuardLookup
        deviceId={deviceId}
        guardId={profile.id}
        onRecorded={(result) => { setLastScan(result); setScanCaptured(true); void getPendingSyncCount().then(setPendingCount); void getRecentQueuedAttendance().then(setQueuedEvents) }}
      />}
      {isEarlyOuts && <GuardEarlyOutApprovals />}
      {isVisitors && <GuardVisitorDesk />}
      {isNotifications && <GuardNotificationCenter profileId={profile.id}/>}
      {isAnnouncements && <GuardAnnouncementPanel profileId={profile.id}/>}
      {![isDashboard,isScanner,isEarlyOuts,isStudentLookup,isVisitors,isAnnouncements,isNotifications,isGateHistory].some(Boolean) && <Navigate to="/guard" replace />}
    </DashboardShell>
  )
}

function GuardNotificationCenter({profileId}:{profileId:string}) {
  const [items,setItems]=useState<Record<string,unknown>[]>([]);const [error,setError]=useState('')
  const refresh=useCallback(async()=>{if(!supabase)return;const {data,error:loadError}=await supabase.from('notifications').select('id,type,payload,is_read,created_at').eq('recipient_id',profileId).order('created_at',{ascending:false}).limit(50);if(loadError)setError(friendlyError(loadError));else setItems(data??[])},[profileId])
  useEffect(()=>{void refresh();if(!supabase)return;const client=supabase;const channel=client.channel(`guard-notifications-${profileId}`).on('postgres_changes',{event:'*',schema:'public',table:'notifications',filter:`recipient_id=eq.${profileId}`},()=>void refresh()).subscribe();return()=>{void client.removeChannel(channel)}},[profileId,refresh])
  const markRead=async(id:string)=>{if(!supabase)return;const {error:markError}=await supabase.from('notifications').update({is_read:true}).eq('id',id).eq('recipient_id',profileId);if(markError)setError(friendlyError(markError));else setItems(current=>current.map(item=>item.id===id?{...item,is_read:true}:item))}
  const unread=items.filter(item=>!item.is_read).length
  return <section className="rounded-[28px] border border-[var(--color-border)] bg-white p-5 shadow-sm"><div className="mb-4 flex items-center justify-between"><div><h3 className="font-[var(--font-display)] text-xl font-bold">Notifications</h3><p className="text-xs text-slate-500">Live gate and school updates</p></div><span className="rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-bold text-emerald-900">{unread} unread</span></div>{error&&<p role="alert" className="mb-3 text-xs text-rose-700">{error}</p>}<div className="max-h-[28rem] space-y-2 overflow-auto">{items.map(item=><article key={String(item.id)} className={`rounded-xl border p-3 ${item.is_read?'bg-white':'border-emerald-200 bg-emerald-50'}`}><div className="flex items-start justify-between gap-3"><div><p className="font-semibold">{String(item.type).replaceAll('_',' ')}</p><p className="mt-1 text-sm text-slate-600">{String((item.payload as Record<string,unknown>)?.message??(item.payload as Record<string,unknown>)?.visitor_name??'School operations update')}</p><time className="mt-1 block text-xs text-slate-500">{formatPhilippineDateTime(String(item.created_at))}</time></div>{!item.is_read&&<button onClick={()=>void markRead(String(item.id))} className="shrink-0 text-xs font-semibold text-emerald-900 underline">Mark read</button>}</div></article>)}{!items.length&&<p className="rounded-xl bg-slate-50 p-4 text-sm text-slate-500">No notifications yet.</p>}</div></section>
}

function GuardAnnouncementPanel({profileId}:{profileId:string}) {
  const [items, setItems] = useState<Record<string, unknown>[]>([])
  const [reads,setReads]=useState<Set<string>>(new Set());const [query,setQuery]=useState('');const [error,setError]=useState('')
  useEffect(() => {
    let active = true
    const load=()=>{if(supabase)void Promise.all([supabase.from('announcements').select('id,title,summary,body,audience,category,priority,status,content_format,published_at,expires_at,target_grade_level,target_section_id,attachments,created_at,updated_at').in('audience',['all','guard']).eq('status','published').order('published_at',{ascending:false}).limit(50),supabase.from('announcement_reads').select('announcement_id').eq('profile_id',profileId)]).then(([announcements,readRows])=>{if(!active)return;if(announcements.error)setError(friendlyError(announcements.error));else setItems(announcements.data??[]);if(readRows.error)setError(friendlyError(readRows.error));else setReads(new Set((readRows.data??[]).map(row=>row.announcement_id)))})}
    load()
    if(!supabase)return()=>{active=false}
    const client=supabase;const channel=client.channel(`guard-announcements-${profileId}`).on('postgres_changes',{event:'*',schema:'public',table:'announcements'},load).subscribe()
    return () => { active = false;void client.removeChannel(channel) }
  }, [profileId])
  const current=items.filter(row=>(!row.published_at||new Date(String(row.published_at))<=new Date())&&(!row.expires_at||new Date(String(row.expires_at))>new Date())&&`${row.title} ${row.summary??''} ${row.body}`.toLowerCase().includes(query.toLowerCase()))
  const markRead=async(id:string)=>{if(!supabase)return;const {error:markError}=await supabase.from('announcement_reads').upsert({profile_id:profileId,announcement_id:id},{onConflict:'profile_id,announcement_id'});if(markError)setError(friendlyError(markError));else setReads(old=>new Set(old).add(id))}
  return <section className="rounded-[28px] border border-[var(--color-border)] bg-white p-5 shadow-sm"><div className="mb-3 flex items-center justify-between"><h3 className="font-[var(--font-display)] text-xl font-bold">School announcements</h3><span className="rounded-full bg-slate-100 px-2 py-1 text-xs">{current.filter(item=>!reads.has(String(item.id))).length} unread</span></div><input value={query} onChange={event=>setQuery(event.target.value)} placeholder="Search announcements" className="mb-3 w-full rounded-xl border px-3 py-2 text-sm"/>{error&&<p role="alert" className="mb-2 text-xs text-rose-700">{error}</p>}<div className="max-h-[28rem] space-y-3 overflow-auto">{current.map(item=><article key={String(item.id)} className="rounded-xl border p-3"><div className="mb-2 flex items-center gap-2"><b className="text-sm">{String(item.title)}</b>{String(item.priority)==='urgent'&&<span className="rounded-full bg-rose-100 px-2 py-0.5 text-[10px] font-bold uppercase text-rose-800">Urgent</span>}{String(item.priority)==='high'&&<span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold uppercase text-amber-800">Important</span>}</div><AnnouncementFeed items={[item]}/><div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500"><span>Published {formatPhilippineDateTime(String(item.published_at))} · Expires {item.expires_at?formatPhilippineDateTime(String(item.expires_at)):'No expiry'}</span>{!reads.has(String(item.id))&&<button onClick={()=>void markRead(String(item.id))} className="font-semibold text-emerald-900 underline">Mark read</button>}</div></article>)}{!current.length&&<p className="text-sm text-slate-500">No announcements found.</p>}</div></section>
}

export default App

