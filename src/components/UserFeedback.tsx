import { createContext, useCallback, useContext, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react'

export type NoticeKind = 'success' | 'error' | 'warning' | 'info'
type NoticeInput = { type: NoticeKind; message: string }
type Notice = NoticeInput & { id: number }
export class UserActionError extends Error {
  constructor(message: string) { super(message); this.name = 'UserActionError' }
}
type ConfirmationOptions = {
  title: string
  description: string
  itemName?: string
  confirmLabel?: string
  cancelLabel?: string
  tone?: 'danger' | 'primary'
  successMessage?: string
  onConfirm: () => Promise<void> | void
}
type Confirmation = ConfirmationOptions & { id: number; error?: string }
type FeedbackContextValue = {
  notify: (notice: NoticeInput) => void
  confirmAction: (options: ConfirmationOptions) => Promise<boolean>
}

const FeedbackContext = createContext<FeedbackContextValue | null>(null)
let nextId = 1

const styles: Record<NoticeKind, { icon: typeof CheckCircle2; className: string; role: 'status' | 'alert' }> = {
  success: { icon: CheckCircle2, className: 'border-emerald-200 bg-white text-emerald-950', role: 'status' },
  error: { icon: XCircle, className: 'border-rose-200 bg-white text-rose-950', role: 'alert' },
  warning: { icon: AlertTriangle, className: 'border-amber-200 bg-white text-amber-950', role: 'status' },
  info: { icon: Info, className: 'border-sky-200 bg-white text-sky-950', role: 'status' },
}

export function FeedbackProvider({ children }: { children: ReactNode }) {
  const [notices, setNotices] = useState<Notice[]>([])
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null)
  const [confirming, setConfirming] = useState(false)
  const resolver = useRef<((confirmed: boolean) => void) | null>(null)
  const activeElement = useRef<HTMLElement | null>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const confirmRef = useRef<HTMLButtonElement>(null)

  const notify = useCallback((notice: NoticeInput) => {
    const message = notice.message.trim()
    if (!message) return
    setNotices(current => {
      if (current.some(item => item.type === notice.type && item.message === message)) return current
      return [...current.slice(-3), { ...notice, message, id: nextId++ }]
    })
  }, [])

  const dismiss = useCallback((id: number) => setNotices(current => current.filter(item => item.id !== id)), [])
  useEffect(() => {
    const timers = notices.map(notice => window.setTimeout(() => dismiss(notice.id), notice.type === 'error' ? 9000 : notice.type === 'warning' ? 7000 : notice.type === 'info' ? 6000 : 4000))
    return () => timers.forEach(window.clearTimeout)
  }, [notices, dismiss])

  const confirmAction = useCallback((options: ConfirmationOptions) => new Promise<boolean>(resolve => {
    if (resolver.current) resolver.current(false)
    resolver.current = resolve
    activeElement.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setConfirmation({ ...options, id: nextId++ })
    setConfirming(false)
  }), [])

  const finishConfirmation = useCallback((confirmed: boolean) => {
    resolver.current?.(confirmed)
    resolver.current = null
    setConfirmation(null)
    setConfirming(false)
    window.setTimeout(() => activeElement.current?.focus(), 0)
  }, [])

  const runConfirmation = async () => {
    if (!confirmation || confirming) return
    setConfirming(true)
    setConfirmation(current => current ? { ...current, error: undefined } : current)
    try {
      await confirmation.onConfirm()
      if (confirmation.successMessage) notify({ type: 'success', message: confirmation.successMessage })
      finishConfirmation(true)
    } catch (error) {
      const message = error instanceof UserActionError ? error.message : friendlyError(error)
      setConfirmation(current => current ? { ...current, error: message } : current)
      setConfirming(false)
    }
  }

  const handleDialogKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape' && !confirming) { event.preventDefault(); finishConfirmation(false); return }
    if (event.key !== 'Tab') return
    const first = cancelRef.current
    const last = confirmRef.current
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
  }

  useEffect(() => {
    const confirmationId = confirmation?.id
    if (!confirmationId) return
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const timer = window.setTimeout(() => cancelRef.current?.focus(), 0)
    return () => { window.clearTimeout(timer); document.body.style.overflow = previousOverflow }
  }, [confirmation?.id])

  return <FeedbackContext.Provider value={{ notify, confirmAction }}>
    {children}
    <div className="pointer-events-none fixed inset-x-0 top-3 z-[120] flex flex-col items-center gap-2 px-3 sm:inset-x-auto sm:right-4 sm:top-4 sm:w-[min(26rem,calc(100vw-2rem))] sm:items-stretch" aria-label="Notifications">
      {notices.map(notice => {
        const style = styles[notice.type]
        const Icon = style.icon
        return <div key={notice.id} role={style.role} aria-live={style.role === 'alert' ? 'assertive' : 'polite'} className={`pointer-events-auto flex w-full items-start gap-3 rounded-2xl border p-3.5 shadow-lg shadow-slate-950/10 ${style.className}`}>
          <Icon aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0" />
          <p className="min-w-0 flex-1 text-sm leading-5">{notice.message}</p>
          <button type="button" onClick={() => dismiss(notice.id)} aria-label="Dismiss notification" className="-mr-1 -mt-1 rounded-lg p-1.5 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500"><X className="h-4 w-4" /></button>
        </div>
      })}
    </div>
    {confirmation && <div className="fixed inset-0 z-[110] flex items-end justify-center bg-slate-950/50 p-3 backdrop-blur-[2px] sm:items-center sm:p-5">
      <div role={confirmation.tone === 'danger' ? 'alertdialog' : 'dialog'} aria-modal="true" aria-labelledby="confirmation-title" aria-describedby="confirmation-description" onKeyDown={handleDialogKeyDown} className="w-full max-w-lg rounded-3xl bg-white p-5 shadow-2xl sm:p-6">
        <div className="flex items-start gap-3"><span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl ${confirmation.tone === 'danger' ? 'bg-rose-50 text-rose-700' : 'bg-emerald-50 text-emerald-800'}`}>{confirmation.tone === 'danger' ? <AlertTriangle aria-hidden="true" className="h-5 w-5" /> : <Info aria-hidden="true" className="h-5 w-5" />}</span><div className="min-w-0 flex-1"><h2 id="confirmation-title" className="text-lg font-bold text-slate-950">{confirmation.title}</h2><p id="confirmation-description" className="mt-1 text-sm leading-6 text-slate-600">{confirmation.description}</p>{confirmation.itemName && <p className="mt-3 break-words rounded-xl bg-slate-50 p-3 text-sm font-semibold text-slate-800">{confirmation.itemName}</p>}</div><button type="button" disabled={confirming} onClick={() => finishConfirmation(false)} aria-label="Close confirmation" className="rounded-lg p-2 text-slate-500 hover:bg-slate-100 disabled:opacity-40"><X className="h-4 w-4" /></button></div>
        {confirmation.error && <p role="alert" className="mt-4 rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm leading-5 text-rose-900">{confirmation.error}</p>}
        <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end"><button ref={cancelRef} type="button" disabled={confirming} onClick={() => finishConfirmation(false)} className="rounded-xl border border-slate-200 px-4 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50">{confirmation.cancelLabel ?? 'Cancel'}</button><button ref={confirmRef} type="button" disabled={confirming} onClick={() => void runConfirmation()} className={`inline-flex items-center justify-center rounded-xl px-4 py-2.5 text-sm font-semibold text-white disabled:cursor-wait disabled:opacity-60 ${confirmation.tone === 'danger' ? 'bg-rose-700 hover:bg-rose-800' : 'bg-emerald-800 hover:bg-emerald-900'}`}>{confirming ? 'Please wait…' : confirmation.confirmLabel ?? 'Confirm'}</button></div>
      </div>
    </div>}
  </FeedbackContext.Provider>
}

export function useFeedback() {
  const value = useContext(FeedbackContext)
  if (!value) throw new Error('useFeedback must be used inside FeedbackProvider')
  return value
}

export function friendlyError(error: unknown, fallback = 'We could not complete your request. Please try again.') {
  reportTechnicalError('Request failed', error)
  const value = error && typeof error === 'object' ? error as { code?: unknown; status?: unknown; message?: unknown; name?: unknown } : {}
  const code = String(value.code ?? value.status ?? '')
  const message = String(value.message ?? '').toLowerCase()
  if (['401', 'PGRST301', 'session_not_found', 'refresh_token_not_found'].includes(code) || message.includes('jwt expired') || message.includes('session expired')) return 'Your session has expired. Please log in again.'
  if (['403', '42501'].includes(code) || message.includes('permission denied') || message.includes('not authorized')) return 'You do not have permission to perform this action.'
  if (['404', 'PGRST116'].includes(code) || message.includes('not found')) return 'We could not find the requested information.'
  if (['23505', '23503', '23514', '23P01'].includes(code) || message.includes('duplicate key') || message.includes('already exists') || message.includes('unique constraint')) return 'This information conflicts with an existing record. Please review it and try again.'
  if (String(value.name ?? '') === 'TypeError' || message.includes('network') || message.includes('failed to fetch') || message.includes('fetch failed') || message.includes('load failed')) return 'Something went wrong. Check your internet connection and try again.'
  if (code.startsWith('22') || code === 'P0001' || message.includes('invalid input') || message.includes('must be between')) return 'Please check the information you entered.'
  return fallback
}

export function reportTechnicalError(context: string, error: unknown) {
  if (import.meta.env.DEV) console.error(`[CampuSync] ${context}`, error)
}
