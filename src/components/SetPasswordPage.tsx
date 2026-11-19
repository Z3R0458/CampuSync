import { useEffect, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { friendlyError } from './UserFeedback'

export function SetPasswordPage() {
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [email, setEmail] = useState('')
  const [sessionReady, setSessionReady] = useState(false)
  const [hasRecoverySession, setHasRecoverySession] = useState(false)
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState(false)
  const [passwordUpdated, setPasswordUpdated] = useState(false)
  const [message, setMessage] = useState('')

  useEffect(() => {
    if (!supabase) { setSessionReady(true); return }
    const hash = new URLSearchParams(window.location.hash.slice(1))
    const error = hash.get('error_description')
    if (error) setMessage(error.replaceAll('+', ' '))
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'PASSWORD_RECOVERY' || session) setHasRecoverySession(Boolean(session))
      setSessionReady(true)
    })
    void supabase.auth.getSession().then(({ data }) => {
      setHasRecoverySession(Boolean(data.session))
      setSessionReady(true)
    })
    return () => subscription.unsubscribe()
  }, [])

  const setNewPassword = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!supabase) return
    if (password.length < 12) { setMessage('Use at least 12 characters.'); return }
    if (password !== confirmation) { setMessage('The passwords do not match.'); return }
    setBusy(true)
    setMessage('')
    const { error } = await supabase.auth.updateUser({ password })
    setBusy(false)
    if (error) setMessage(friendlyError(error))
    else {
      setHasRecoverySession(false)
      setSent(true)
      setPasswordUpdated(true)
      await supabase.auth.signOut()
    }
  }

  const requestLink = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!supabase) return
    setBusy(true)
    setMessage('')
    const { error } = await supabase.auth.resetPasswordForEmail(email.trim().toLowerCase(), {
      redirectTo: `${window.location.origin}/set-password`,
    })
    setBusy(false)
    if (error) setMessage(friendlyError(error))
    else setSent(true)
  }

  return <main className="flex min-h-screen items-center justify-center bg-slate-50 p-5">
    <section className="w-full max-w-md rounded-3xl border border-slate-200 bg-white p-7 shadow-lg">
      <div className="mb-5 flex items-center gap-3">
        <img src="/campusync-logo.png" alt="CampuSync" className="h-11 w-11 object-contain" />
        <div><p className="text-xs font-bold uppercase tracking-widest text-emerald-800">CampuSync · Valencia NHS</p><h1 className="text-2xl font-bold text-slate-900">Set your password</h1></div>
      </div>
      {!sessionReady ? <p role="status" className="text-sm text-slate-600">Verifying your secure password link…</p>
        : sent ? <div className="space-y-4"><p role="status" className="rounded-xl bg-emerald-50 p-4 text-sm text-emerald-900">{passwordUpdated ? 'Your password has been set. You can now sign in using your school account.' : 'If that account exists, a fresh password link has been emailed. Check your inbox.'}</p><Link to="/" className="inline-block font-semibold text-emerald-800 underline">Return to sign in</Link></div>
          : hasRecoverySession ? <form onSubmit={event => void setNewPassword(event)} className="space-y-4">
            <p className="text-sm text-slate-600">Choose a password for your school account. Use at least 12 characters.</p>
            <label className="block text-sm font-semibold">New password<input required minLength={12} type="password" autoComplete="new-password" value={password} onChange={event => setPassword(event.target.value)} className="mt-1 w-full rounded-xl border border-slate-300 p-3" /></label>
            <label className="block text-sm font-semibold">Confirm password<input required minLength={12} type="password" autoComplete="new-password" value={confirmation} onChange={event => setConfirmation(event.target.value)} className="mt-1 w-full rounded-xl border border-slate-300 p-3" /></label>
            {message && <p role="alert" className="rounded-xl bg-rose-50 p-3 text-sm text-rose-800">{message}</p>}
            <button disabled={busy} className="w-full rounded-xl bg-[var(--color-brand-dark)] p-3 font-semibold text-white disabled:opacity-60">{busy ? 'Saving password…' : 'Set password'}</button>
          </form> : <div className="space-y-4">
            <p className="text-sm text-slate-600">{sent ? 'If that account exists, a fresh password link has been emailed.' : 'This password link is invalid or expired. Request a fresh link below, then open it on this website.'}</p>
            {!sent && <form onSubmit={event => void requestLink(event)} className="space-y-3">
              <label className="block text-sm font-semibold">School email<input required type="email" autoComplete="email" value={email} onChange={event => setEmail(event.target.value)} className="mt-1 w-full rounded-xl border border-slate-300 p-3" /></label>
              {message && <p role="alert" className="rounded-xl bg-rose-50 p-3 text-sm text-rose-800">{message}</p>}
              <button disabled={busy} className="w-full rounded-xl bg-[var(--color-brand-dark)] p-3 font-semibold text-white disabled:opacity-60">{busy ? 'Sending…' : 'Email me a fresh link'}</button>
            </form>}
            <Link to="/" className="inline-block text-sm font-semibold text-emerald-800 underline">Return to sign in</Link>
          </div>}
    </section>
  </main>
}
