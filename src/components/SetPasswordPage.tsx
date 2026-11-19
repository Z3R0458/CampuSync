import { useState, type FormEvent } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
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
        try {
          const responseData = await context.clone().json() as { error?: unknown }
          if (typeof responseData.error === 'string') serverMessage = responseData.error
        } catch { /* Use the client-safe fallback below if the response isn't JSON. */ }
        if (serverMessage) throw new Error(serverMessage)
      }
      throw new Error(friendlyError(error))
    }
    if (data?.error) throw new Error(String(data.error))
    return data as Record<string, unknown>
  }

  const start = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setBusy(true); setMessage('')
    try {
      const data = await invoke({ action: 'password-reset-start', email: email.trim().toLowerCase() })
      setChallengeId(String(data.challengeId ?? ''))
      setCode('')
      setStage('verify')
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Could not send the verification code.') }
    finally { setBusy(false) }
  }

  const verify = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setBusy(true); setMessage('')
    try {
      const data = await invoke({ action: 'password-reset-verify', challengeId, code: code.replace(/\s/g, '') })
      setResetToken(String(data.resetToken ?? ''))
      setStage('password')
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
      setChallengeId(String(data.challengeId ?? ''))
      setCode('')
      setMessage('A new verification code was sent. The previous code is no longer valid.')
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Could not resend the code.') }
    finally { setBusy(false) }
  }

  return <main className="flex min-h-screen items-center justify-center bg-slate-50 p-5">
    <section className="w-full max-w-md rounded-3xl border border-slate-200 bg-white p-7 shadow-lg">
      <div className="mb-5 flex items-center gap-3"><img src="/campusync-logo.png" alt="CampuSync" className="h-11 w-11 object-contain"/><div><p className="text-xs font-bold uppercase tracking-widest text-emerald-800">CampuSync · Valencia NHS</p><h1 className="text-2xl font-bold text-slate-900">Reset your password</h1></div></div>
      {stage === 'request' && <form onSubmit={event => void start(event)} className="space-y-4"><p className="text-sm text-slate-600">We’ll email a six-digit verification code. You must verify it before choosing a new password.</p><label className="block text-sm font-semibold">School email<input required type="email" autoComplete="email" value={email} onChange={event => setEmail(event.target.value)} className="mt-1 w-full rounded-xl border border-slate-300 p-3"/></label>{message&&<p role="alert" className="rounded-xl bg-rose-50 p-3 text-sm text-rose-800">{message}</p>}<button disabled={busy} className="w-full rounded-xl bg-[var(--color-brand-dark)] p-3 font-semibold text-white disabled:opacity-60">{busy?'Sending code…':'Send verification code'}</button></form>}
      {stage === 'verify' && <form onSubmit={event => void verify(event)} className="space-y-4"><p className="text-sm text-slate-600">Enter the code sent to <b>{email}</b>. It expires in five minutes.</p><label className="block text-sm font-semibold">Six-digit email code<input required inputMode="numeric" pattern="[0-9]{6}" maxLength={6} autoComplete="one-time-code" value={code} onChange={event => setCode(event.target.value.replace(/\D/g,'').slice(0,6))} className="mt-1 w-full rounded-xl border border-slate-300 p-3 text-center font-mono text-2xl tracking-[.4em]"/></label>{message&&<p role="alert" className="rounded-xl bg-rose-50 p-3 text-sm text-rose-800">{message}</p>}<button disabled={busy||code.length!==6} className="w-full rounded-xl bg-[var(--color-brand-dark)] p-3 font-semibold text-white disabled:opacity-60">{busy?'Verifying…':'Verify code'}</button><button type="button" disabled={busy} onClick={()=>void resend()} className="w-full text-sm font-semibold text-emerald-800 underline disabled:opacity-60">Send a new code</button></form>}
      {stage === 'password' && <form onSubmit={event => void finish(event)} className="space-y-4"><p className="text-sm text-slate-600">Email verified. Choose your new password.</p><label className="block text-sm font-semibold">New password<input required minLength={12} maxLength={72} type="password" autoComplete="new-password" value={password} onChange={event=>setPassword(event.target.value)} className="mt-1 w-full rounded-xl border border-slate-300 p-3"/></label><label className="block text-sm font-semibold">Confirm new password<input required minLength={12} maxLength={72} type="password" autoComplete="new-password" value={confirmation} onChange={event=>setConfirmation(event.target.value)} className="mt-1 w-full rounded-xl border border-slate-300 p-3"/></label>{message&&<p role="alert" className="rounded-xl bg-rose-50 p-3 text-sm text-rose-800">{message}</p>}<button disabled={busy} className="w-full rounded-xl bg-[var(--color-brand-dark)] p-3 font-semibold text-white disabled:opacity-60">{busy?'Updating password…':'Set new password'}</button></form>}
      {stage === 'done' && <div className="space-y-4"><p role="status" className="rounded-xl bg-emerald-50 p-4 text-sm text-emerald-900">Your password has been updated. You can now sign in with your school account.</p><Link to="/" className="inline-block font-semibold text-emerald-800 underline">Return to sign in</Link></div>}
      {stage!=='done'&&<Link to="/" className="mt-5 inline-block text-sm font-semibold text-emerald-800 underline">Return to sign in</Link>}
    </section>
  </main>
}
