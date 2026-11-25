import { useState, type FormEvent } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Mail, ShieldCheck } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { friendlyError } from './UserFeedback'

type ResetStage = 'request' | 'verify' | 'password' | 'done'

export function SetPasswordPage() {
  const [searchParams] = useSearchParams()
  const [email, setEmail] = useState(searchParams.get('email') ?? '')
  const [challengeId, setChallengeId] = useState('')
  const [code, setCode] = useState('')
  const [resetToken, setResetToken] = useState('')
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [stage, setStage] = useState<ResetStage>('request')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')

  const invoke = async (body: Record<string, string>) => {
    if (!supabase) throw new Error('Password reset is unavailable. Please try again later.')
    const { data, error } = await supabase.functions.invoke('login-otp', { body })
    if (error) {
      const context = (error as { context?: unknown }).context
      if (context instanceof Response) {
        let serverMessage = ''
        try { const responseData = await context.clone().json() as { error?: unknown }; if (typeof responseData.error === 'string') serverMessage = responseData.error } catch { /* Use the safe client message if the response is not JSON. */ }
        if (serverMessage) throw new Error(serverMessage)
      }
      throw new Error(friendlyError(error))
    }
    if (data?.error) throw new Error(String(data.error))
    return data as Record<string, unknown>
  }

  const start = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setBusy(true); setMessage('')
    try {
      const data = await invoke({ action: 'password-reset-start', email: email.trim().toLowerCase() })
      setChallengeId(String(data.challengeId ?? '')); setCode(''); setStage('verify')
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Could not send the verification code.') }
    finally { setBusy(false) }
  }

  const verify = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setBusy(true); setMessage('')
    try {
      const data = await invoke({ action: 'password-reset-verify', challengeId, code: code.replace(/\s/g, '') })
      setResetToken(String(data.resetToken ?? '')); setStage('password')
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Could not verify the code.') }
    finally { setBusy(false) }
  }

  const finish = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (password !== confirmation) { setMessage('The passwords do not match.'); return }
    if (new TextEncoder().encode(password).length > 72) { setMessage('Password must be 72 bytes or fewer.'); return }
    setBusy(true); setMessage('')
    try {
      await invoke({ action: 'password-reset-complete', resetToken, password })
      setStage('done')
      await supabase?.auth.signOut()
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Could not update the password.') }
    finally { setBusy(false) }
  }

  const resend = async () => {
    setBusy(true); setMessage('')
    try {
      const data = await invoke({ action: 'password-reset-start', email: email.trim().toLowerCase() })
      setChallengeId(String(data.challengeId ?? '')); setCode('')
      setMessage('A new verification code was sent. The previous code is no longer valid.')
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Could not resend the code.') }
    finally { setBusy(false) }
  }

  const stageTitle = stage === 'request' ? 'Reset your password' : stage === 'verify' ? 'Verify your email' : stage === 'password' ? 'Set a new password' : 'Password updated'
  const stageDescription = stage === 'request' ? 'Enter your school email to receive a secure verification code.' : stage === 'verify' ? 'Enter the six-digit code sent to your email to continue.' : stage === 'password' ? 'Your email is verified. Choose a strong new password.' : 'Your account is ready for secure sign-in.'

  return <main className="login-page min-h-screen lg:grid lg:grid-cols-[minmax(0,1.08fr)_minmax(420px,0.92fr)]">
    <section className="login-campus relative flex min-h-[260px] flex-col justify-between overflow-hidden px-6 py-7 text-white sm:min-h-[340px] sm:px-10 sm:py-9 lg:min-h-screen lg:px-14 lg:py-12 xl:px-20">
      <img src="/valencia-nhs-campus.jpg" alt="Valencia National High School campus sign and grounds" className="absolute inset-0 h-full w-full object-cover" />
      <div className="absolute inset-0 bg-[linear-gradient(120deg,rgba(6,30,69,.84)_0%,rgba(8,70,128,.62)_48%,rgba(10,82,92,.24)_100%)]" />
      <div className="relative z-10 flex items-center gap-3"><span className="flex h-14 w-14 items-center justify-center overflow-hidden rounded-2xl border border-white/30 bg-white/95 shadow-lg backdrop-blur"><img src="/campusync-logo.png?v=campusync-3" alt="CampuSync" className="h-full w-full object-contain" /></span><span><span className="block font-[var(--font-display)] text-lg font-extrabold tracking-tight">CampuSync</span><span className="block text-xs text-white/75">Valencia NHS portal</span></span></div>
      <div className="login-brand-content relative z-10 max-w-2xl py-8 lg:pb-14 lg:pt-16"><p className="mb-4 inline-flex items-center gap-2 rounded-full border border-white/25 bg-white/10 px-3 py-1.5 text-[11px] font-bold uppercase tracking-[0.18em] text-white/90 backdrop-blur"><span className="h-1.5 w-1.5 rounded-full bg-cyan-300" /> Secure account recovery</p><h2 className="max-w-xl font-[var(--font-display)] text-3xl font-extrabold leading-[1.12] tracking-tight sm:text-4xl lg:text-[3.25rem]">One connected campus. A safer school day.</h2><p className="mt-4 max-w-lg text-sm leading-6 text-white/80 sm:text-base sm:leading-7">Verify your school email before changing your CampuSync password.</p></div>
      <p className="relative z-10 hidden text-xs text-white/70 lg:block">Valencia National High School <span className="mx-2 text-white/40">·</span> Secure school access</p><div className="absolute bottom-5 right-5 z-10 rounded-full border border-white/20 bg-black/25 px-3 py-1 text-[10px] font-medium tracking-wide text-white/85 backdrop-blur sm:bottom-7 sm:right-8">VALENCIA NATIONAL HIGH SCHOOL</div>
    </section>
    <section className="login-panel flex min-h-[calc(100vh-260px)] items-center justify-center bg-[#f7f9f8] px-5 py-10 sm:min-h-[calc(100vh-340px)] sm:px-10 lg:min-h-screen lg:px-12 xl:px-20">
      <div className="login-form-card w-full max-w-[430px]">
        <div className="mb-8 flex items-center gap-3 lg:hidden"><img src="/campusync-logo.png?v=campusync-3" alt="CampuSync" className="h-14 w-14 rounded-xl bg-white object-contain"/><span><p className="font-[var(--font-display)] text-xl font-extrabold tracking-tight text-[var(--color-main-text)]">CampuSync</p><p className="mt-1 text-sm text-[var(--color-secondary-text)]">Valencia NHS portal</p></span></div>
        <div className="login-form-content mb-8"><p className="text-xs font-bold uppercase tracking-[0.18em] text-[var(--color-brand-dark)]">Account security</p><h1 className="mt-2 font-[var(--font-display)] text-3xl font-extrabold tracking-tight text-slate-900 sm:text-[2.1rem]">{stageTitle}</h1><p className="mt-2 text-sm leading-6 text-slate-500">{stageDescription}</p></div>
        {stage === 'request' && <form onSubmit={event => void start(event)} className="space-y-5"><label className="block text-sm font-semibold text-slate-700">School email<span className="mt-2 flex h-12 items-center gap-3 rounded-xl border border-slate-200 bg-white px-3.5 transition focus-within:border-emerald-600 focus-within:ring-4 focus-within:ring-emerald-600/10"><Mail className="h-4 w-4 shrink-0 text-slate-400"/><input required type="email" autoComplete="email" placeholder="you@school.edu.ph" value={email} onChange={event=>setEmail(event.target.value)} className="h-full min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-slate-400"/></span></label>{message&&<p role="alert" className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{message}</p>}<button disabled={busy} className="flex h-12 w-full items-center justify-center rounded-xl bg-[#16794f] px-4 font-semibold text-white shadow-[0_8px_18px_rgba(22,121,79,.18)] disabled:opacity-60">{busy?'Sending code…':'Send verification code'}</button></form>}
        {stage === 'verify' && <form onSubmit={event=>void verify(event)} className="space-y-5"><p className="rounded-xl bg-emerald-50 p-4 text-sm leading-6 text-emerald-950">A six-digit code was sent to <b>{email}</b>. It expires in five minutes.</p><label className="block text-sm font-semibold text-slate-700">Six-digit verification code<span className="mt-2 flex h-12 items-center rounded-xl border border-slate-200 bg-white px-3.5 focus-within:border-emerald-600 focus-within:ring-4 focus-within:ring-emerald-600/10"><input required inputMode="numeric" pattern="[0-9]{6}" maxLength={6} autoComplete="one-time-code" value={code} onChange={event=>setCode(event.target.value.replace(/\D/g,'').slice(0,6))} className="h-full w-full bg-transparent text-center font-mono text-xl tracking-[.5em] outline-none"/></span></label>{message&&<p role="alert" className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{message}</p>}<button disabled={busy||code.length!==6} className="h-12 w-full rounded-xl bg-[#16794f] font-semibold text-white disabled:opacity-60">{busy?'Verifying…':'Verify code'}</button><button type="button" disabled={busy} onClick={()=>void resend()} className="w-full text-sm font-semibold text-emerald-800 underline disabled:opacity-60">Send a new code</button></form>}
        {stage === 'password' && <form onSubmit={event=>void finish(event)} className="space-y-5"><p className="rounded-xl bg-emerald-50 p-4 text-sm leading-6 text-emerald-950">Email verified. Choose a new password with at least 12 characters.</p><label className="block text-sm font-semibold text-slate-700">New password<span className="mt-2 flex h-12 items-center rounded-xl border border-slate-200 bg-white px-3.5"><input required minLength={12} maxLength={72} type="password" autoComplete="new-password" value={password} onChange={event=>setPassword(event.target.value)} className="h-full w-full bg-transparent text-sm outline-none"/></span></label><label className="block text-sm font-semibold text-slate-700">Confirm new password<span className="mt-2 flex h-12 items-center rounded-xl border border-slate-200 bg-white px-3.5"><input required minLength={12} maxLength={72} type="password" autoComplete="new-password" value={confirmation} onChange={event=>setConfirmation(event.target.value)} className="h-full w-full bg-transparent text-sm outline-none"/></span></label>{message&&<p role="alert" className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{message}</p>}<button disabled={busy} className="h-12 w-full rounded-xl bg-[#16794f] font-semibold text-white disabled:opacity-60">{busy?'Updating password…':'Set new password'}</button></form>}
        {stage === 'done' && <div className="space-y-4"><p role="status" className="rounded-xl bg-emerald-50 p-4 text-sm leading-6 text-emerald-950">Your password has been updated. You can now sign in with your school account.</p><Link to="/" className="block text-right font-semibold text-[var(--brand-primary)] underline">Return to sign in</Link></div>}
        {stage !== 'done' && <Link to="/" className="mt-5 block text-right text-sm font-semibold text-[var(--brand-primary)] underline">Return to sign in</Link>}
        <div className="mt-6 flex items-start gap-3 rounded-xl border border-slate-200/80 bg-white/70 p-4"><ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-700"/><p className="text-xs leading-5 text-slate-500">A verification code is required before your password can be changed.</p></div>
        <p className="mt-8 text-center text-[11px] text-slate-400">© {new Date().getFullYear()} Valencia National High School</p>
      </div>
    </section>
  </main>
}
