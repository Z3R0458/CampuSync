const MAX_INPUT_BYTES = 5 * 1024 * 1024
const TARGET_BYTES = 150 * 1024
const MAX_OUTPUT_BYTES = 256 * 1024
const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'])
const ALLOWED_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif'])

function canvasBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    if (typeof canvas.toBlob === 'function') {
      canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Your browser could not encode this image as WebP.')), 'image/webp', quality)
      return
    }
    try {
      const dataUrl = canvas.toDataURL('image/webp', quality)
      if (!dataUrl.startsWith('data:image/webp;base64,')) throw new Error('This browser cannot create WebP profile images.')
      const binary = atob(dataUrl.slice(dataUrl.indexOf(',') + 1))
      const bytes = Uint8Array.from(binary, character => character.charCodeAt(0))
      resolve(new Blob([bytes], { type: 'image/webp' }))
    } catch (error) { reject(error) }
  })
}

type ImageSource = { image: CanvasImageSource; width: number; height: number; close: () => void }

async function loadImageSource(file: File): Promise<ImageSource> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
      return { image: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() }
    } catch { /* Use the Safari-compatible HTMLImageElement decoder below. */ }
  }

  const url = URL.createObjectURL(file)
  try {
    const image = new Image()
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve()
      image.onerror = () => reject(new Error('Your device could not read this image. Try a JPG or PNG.'))
      image.src = url
    })
    if (!image.naturalWidth || !image.naturalHeight) throw new Error('Your device could not read this image. Try a JPG or PNG.')
    return { image, width: image.naturalWidth, height: image.naturalHeight, close: () => URL.revokeObjectURL(url) }
  } catch (error) {
    URL.revokeObjectURL(url)
    throw error
  }
}

export async function readProfileImageDimensions(file: File): Promise<{ width: number; height: number }> {
  const source = await loadImageSource(file)
  try { return { width: source.width, height: source.height } } finally { source.close() }
}

/** Center-crops to square, bounds dimensions, and compresses in-browser without upscaling. */
export async function compressProfileImage(file: File): Promise<File> {
  const extension = file.name.split('.').pop()?.toLowerCase() ?? ''
  if (!ALLOWED_TYPES.has(file.type.toLowerCase()) && !ALLOWED_EXTENSIONS.has(extension)) throw new Error('Choose a JPG, PNG, WebP, or HEIC photo.')
  if (file.size > MAX_INPUT_BYTES) throw new Error('The original image must be 5 MB or smaller.')
  if (!file.size) throw new Error('The selected image is empty.')

  let source: ImageSource | undefined
  try {
    source = await loadImageSource(file)
    if (!source.width || !source.height || source.width > 16000 || source.height > 16000) throw new Error('This image has unsupported dimensions.')
    const sourceSide = Math.min(source.width, source.height)
    const cropX = Math.floor((source.width - sourceSide) / 2)
    const cropY = Math.floor((source.height - sourceSide) / 2)
    const maximumSide = Math.min(400, sourceSide)
    const sizes = [...new Set([maximumSide, Math.floor(maximumSide * 0.85), Math.floor(maximumSide * 0.7), Math.floor(maximumSide * 0.55), Math.floor(maximumSide * 0.4)])].filter(size => size >= 1)
    let best: Blob | null = null

    for (const size of sizes) {
      const canvas = document.createElement('canvas')
      canvas.width = size; canvas.height = size
      const context = canvas.getContext('2d', { alpha: false })
      if (!context) throw new Error('Image compression is unavailable in this browser.')
      context.drawImage(source.image, cropX, cropY, sourceSide, sourceSide, 0, 0, size, size)
      for (const quality of [0.8, 0.75, 0.7, 0.65, 0.6, 0.55, 0.5, 0.45, 0.4]) {
        const blob = await canvasBlob(canvas, quality)
        if (blob.type !== 'image/webp') throw new Error('This browser cannot create WebP profile images.')
        if (blob.size <= file.size && (!best || blob.size < best.size)) best = blob
        if (blob.size <= TARGET_BYTES && blob.size <= file.size) break
      }
      if (best && best.size <= TARGET_BYTES) break
    }
    if (!best) throw new Error('Could not compress this image below its original size. Try another image.')
    if (best.size > MAX_OUTPUT_BYTES) throw new Error('The compressed image is still too large. Try a simpler or smaller image.')
    const stem = file.name.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 60) || 'profile-photo'
    return new File([best], `${stem}.webp`, { type: 'image/webp', lastModified: Date.now() })
  } catch (error) {
    if (error instanceof Error) throw error
    throw new Error('Could not read or compress this image. Try a JPG, PNG, or WebP file.')
  } finally {
    source?.close()
  }
}
