const MAX_INPUT_BYTES = 5 * 1024 * 1024
const TARGET_BYTES = 150 * 1024
const MAX_OUTPUT_BYTES = 256 * 1024
const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp'])

function canvasBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Your browser could not encode this image as WebP.')), 'image/webp', quality))
}

/** Center-crops to square, bounds dimensions, and compresses in-browser without upscaling. */
export async function compressProfileImage(file: File): Promise<File> {
  if (!ALLOWED_TYPES.has(file.type.toLowerCase())) throw new Error('Choose a JPG, PNG, or WebP image.')
  if (file.size > MAX_INPUT_BYTES) throw new Error('The original image must be 5 MB or smaller.')
  if (!file.size) throw new Error('The selected image is empty.')

  let bitmap: ImageBitmap | undefined
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
    if (!bitmap.width || !bitmap.height || bitmap.width > 16000 || bitmap.height > 16000) throw new Error('This image has unsupported dimensions.')
    const sourceSide = Math.min(bitmap.width, bitmap.height)
    const cropX = Math.floor((bitmap.width - sourceSide) / 2)
    const cropY = Math.floor((bitmap.height - sourceSide) / 2)
    const maximumSide = Math.min(400, sourceSide)
    const sizes = [...new Set([maximumSide, Math.floor(maximumSide * 0.85), Math.floor(maximumSide * 0.7), Math.floor(maximumSide * 0.55), Math.floor(maximumSide * 0.4)])].filter(size => size >= 1)
    let best: Blob | null = null

    for (const size of sizes) {
      const canvas = document.createElement('canvas')
      canvas.width = size; canvas.height = size
      const context = canvas.getContext('2d', { alpha: false })
      if (!context) throw new Error('Image compression is unavailable in this browser.')
      context.drawImage(bitmap, cropX, cropY, sourceSide, sourceSide, 0, 0, size, size)
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
    bitmap?.close()
  }
}
