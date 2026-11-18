import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { compressProfileImage } from '../lib/profileImages'
import { friendlyError } from './UserFeedback'

const bucket = 'profile-photos'

export function ProfileAvatar({ path, name, size = 40, className = '' }: { path?: string | null; name: string; size?: number; className?: string }) {
  const [resolved, setResolved] = useState<{ path: string; url: string } | null>(null)
  const [failedPath, setFailedPath] = useState('')
  useEffect(() => {
    let active = true
    if (!path) return () => { active = false }
    if (/^(https?:\/\/|blob:)/i.test(path)) return () => { active = false }
    if (!supabase) return () => { active = false }
    void supabase.storage.from(bucket).createSignedUrl(path, 3600).then(({ data, error }) => {
      if (active && !error && data?.signedUrl) setResolved({ path, url: data.signedUrl })
      else if (active) setFailedPath(path)
    })
    return () => { active = false }
  }, [path])
  const initials = name.trim().split(/\s+/).map(part => part[0]).join('').slice(0, 2).toUpperCase() || '?'
  const url = path && /^(https?:\/\/|blob:)/i.test(path) ? path : path && resolved?.path === path ? resolved.url : ''
  const failed = Boolean(path && failedPath === path)
  return <span className={`inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-emerald-100 font-bold text-emerald-900 ${className}`} style={{ width: size, height: size }} aria-label={name}>
    {url && !failed ? <img src={url} alt="" loading="lazy" onError={() => path && setFailedPath(path)} className="h-full w-full object-cover" /> : <span aria-hidden="true" style={{ fontSize: Math.max(11, Math.round(size * 0.32)) }}>{initials}</span>}
  </span>
}

export function ProfilePhotoManager({ currentPath, name, onSaved }: { currentPath?: string | null; name: string; onSaved: (path: string | null) => void }) {
  const [compressed, setCompressed] = useState<File | null>(null)
  const [preview, setPreview] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview) }, [preview])

  const choose = async (file?: File) => {
    if (!file) return
    setError(''); setMessage(''); setCompressed(null); setPreview('')
    try {
      const image = await compressProfileImage(file)
      setCompressed(image); setPreview(URL.createObjectURL(image))
      const side = await imageDimension(image)
      setMessage(`Preview ready: ${(file.size / 1024).toFixed(0)} KB → ${(image.size / 1024).toFixed(0)} KB WebP (${side} × ${side} px).`)
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not compress this image.') }
  }

  const upload = async () => {
    if (!supabase || !compressed || busy) return
    setBusy(true); setError(''); setMessage('')
    const { data: authData, error: authError } = await supabase.auth.getUser()
    const user = authData.user
    if (authError || !user) { setBusy(false); setError(authError?.message ?? 'Sign in again before updating your profile photo.'); return }
    const path = `${user.id}/${crypto.randomUUID()}.webp`
    const { error: uploadError } = await supabase.storage.from(bucket).upload(path, compressed, { contentType: 'image/webp', cacheControl: '31536000', upsert: false })
    if (uploadError) { setBusy(false); setError(friendlyError(uploadError)); return }
    const { error: updateError } = await supabase.rpc('set_own_profile_photo_path', { p_path: path })
    if (updateError) {
      const { error: cleanupError } = await supabase.storage.from(bucket).remove([path])
      setBusy(false); setError(`Profile update failed. Your existing photo remains in place. ${friendlyError(updateError)}${cleanupError ? ` The unused new file could not be removed: ${friendlyError(cleanupError)}` : ''}`); return
    }
    onSaved(path)
    let cleanupWarning = ''
    if (currentPath && !/^https?:\/\//i.test(currentPath) && currentPath.startsWith(`${user.id}/`) && currentPath !== path) {
      const { error: deleteError } = await supabase.storage.from(bucket).remove([currentPath])
      if (deleteError) cleanupWarning = ` The previous file could not be removed: ${friendlyError(deleteError)}`
    }
    setBusy(false); setCompressed(null); setPreview(''); setMessage(`Profile photo updated.${cleanupWarning}`)
  }

  const remove = async () => {
    if (!supabase || !currentPath || busy) return
    setBusy(true); setError(''); setMessage('')
    const { data: authData, error: authError } = await supabase.auth.getUser()
    const user = authData.user
    if (authError || !user) { setBusy(false); setError('Sign in again before updating your profile photo.'); return }
    const { error: updateError } = await supabase.rpc('set_own_profile_photo_path', { p_path: null })
    if (updateError) { setBusy(false); setError(friendlyError(updateError)); return }
    onSaved(null)
    let warning = ''
    if (!/^https?:\/\//i.test(currentPath) && currentPath.startsWith(`${user.id}/`)) {
      const { error: deleteError } = await supabase.storage.from(bucket).remove([currentPath])
      if (deleteError) warning = ` Storage cleanup failed: ${friendlyError(deleteError)}`
    }
    setBusy(false); setMessage(`Profile photo removed.${warning}`)
  }

  return <section className="mt-3 rounded-xl border bg-white p-3">
    <div className="flex flex-wrap items-center gap-3"><ProfileAvatar path={preview || currentPath} name={name} size={48}/><label className="cursor-pointer rounded-lg border px-3 py-2 text-sm font-semibold">Choose photo<input type="file" accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp" className="sr-only" onChange={event=>{const file=event.currentTarget.files?.[0];event.currentTarget.value='';void choose(file)}}/></label>{compressed&&<button type="button" disabled={busy} onClick={()=>void upload()} className="rounded-lg bg-emerald-800 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">{busy?'Uploading…':'Upload photo'}</button>}{currentPath&&<button type="button" disabled={busy} onClick={()=>void remove()} className="rounded-lg border border-rose-200 px-3 py-2 text-sm font-semibold text-rose-700 disabled:opacity-50">Remove photo</button>}</div>
    <p className="mt-2 text-xs text-slate-500">JPG, PNG, or WebP · up to 5 MB · center-cropped to at most 400 × 400. The preview is compressed WebP; the original is not uploaded.</p>
    {message&&<p role="status" className="mt-2 text-xs text-emerald-800">{message}</p>}{error&&<p role="alert" className="mt-2 text-xs text-rose-700">{error}</p>}
  </section>
}

async function imageDimension(file: File): Promise<number> {
  const bitmap = await createImageBitmap(file)
  const side = bitmap.width
  bitmap.close()
  return side
}
