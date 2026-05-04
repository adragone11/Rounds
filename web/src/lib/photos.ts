/**
 * Job photos — web mirror of mobile's photoService.
 * Same bucket (`job-photos`), same table (`job_photos`), same path shape
 * (`{user_id}/{job_id}/{uuid}.jpg`), so uploads round-trip to mobile.
 */

import { supabase } from './supabase'

export type PhotoType = 'before' | 'after' | 'general'

export type JobPhoto = {
  id: string
  jobId: string
  userId: string
  type: PhotoType
  storagePath: string
  createdAt: string
  url?: string
}

const BUCKET = 'job-photos'
const MAX_WIDTH = 1200
const COMPRESS_QUALITY = 0.7
export const MAX_PHOTOS_PER_JOB = 8

function mapRow(row: Record<string, unknown>): JobPhoto {
  return {
    id: String(row.id),
    jobId: String(row.job_id),
    userId: String(row.user_id),
    type: (row.type as PhotoType) ?? 'general',
    storagePath: String(row.storage_path),
    createdAt: String(row.created_at),
  }
}

// Resize + re-encode to JPEG via canvas. Keeps uploads small and matches
// mobile's 1200px / 0.7 quality so photos render the same across platforms.
// Returns null if the browser can't decode the file (e.g. HEIC on some
// browsers) — callers should fall back to uploading the original.
async function compressImage(file: File): Promise<Blob | null> {
  try {
    const bitmap = await createImageBitmap(file)
    const scale = Math.min(1, MAX_WIDTH / bitmap.width)
    const width = Math.round(bitmap.width * scale)
    const height = Math.round(bitmap.height * scale)

    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(bitmap, 0, 0, width, height)
    bitmap.close?.()

    return await new Promise<Blob | null>(resolve => {
      canvas.toBlob(blob => resolve(blob), 'image/jpeg', COMPRESS_QUALITY)
    })
  } catch (err) {
    console.warn('[photos] compress failed, uploading original', err)
    return null
  }
}

export async function uploadJobPhoto(
  jobId: string,
  file: File,
  type: PhotoType = 'general',
): Promise<JobPhoto> {
  const { data: auth } = await supabase.auth.getUser()
  const user = auth.user
  if (!user) throw new Error('Not authenticated')

  // Compressed JPEG when possible, else the original (handles HEIC and
  // other formats browsers can't decode in canvas).
  const compressed = await compressImage(file)
  const blob: Blob = compressed ?? file
  const contentType = compressed ? 'image/jpeg' : (file.type || 'application/octet-stream')
  const ext = compressed ? 'jpg' : (file.name.split('.').pop() || 'bin').toLowerCase()

  const fileId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const storagePath = `${user.id}/${jobId}/${fileId}.${ext}`

  const { error: uploadError } = await supabase.storage
    .from(BUCKET)
    .upload(storagePath, blob, { contentType, upsert: false })
  if (uploadError) {
    console.error('[photos] storage upload failed', uploadError)
    throw new Error(`Upload failed: ${uploadError.message}`)
  }

  const { data, error: insertError } = await supabase
    .from('job_photos')
    .insert({
      job_id: jobId,
      user_id: user.id,
      type,
      storage_path: storagePath,
    })
    .select()
    .single()

  if (insertError) {
    console.error('[photos] db insert failed', insertError)
    // Roll back the uploaded blob so we don't leave orphans.
    await supabase.storage.from(BUCKET).remove([storagePath])
    throw new Error(`Upload failed: ${insertError.message}`)
  }

  return withUrl(mapRow(data))
}

function withUrl(photo: JobPhoto): JobPhoto {
  const { data } = supabase.storage.from(BUCKET).getPublicUrl(photo.storagePath)
  return { ...photo, url: data.publicUrl }
}

export async function getJobPhotos(jobId: string): Promise<JobPhoto[]> {
  const { data, error } = await supabase
    .from('job_photos')
    .select('*')
    .eq('job_id', jobId)
    .order('created_at', { ascending: true })
  if (error) throw error
  return (data ?? []).map(r => withUrl(mapRow(r as Record<string, unknown>)))
}

export async function deleteJobPhoto(photoId: string): Promise<void> {
  const { data, error: fetchError } = await supabase
    .from('job_photos')
    .select('storage_path')
    .eq('id', photoId)
    .single()
  if (fetchError || !data) throw fetchError ?? new Error('Photo not found')

  await supabase.storage.from(BUCKET).remove([data.storage_path as string])

  const { error: deleteError } = await supabase
    .from('job_photos')
    .delete()
    .eq('id', photoId)
  if (deleteError) throw deleteError
}
