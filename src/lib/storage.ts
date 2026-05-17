/**
 * Supabase Storage helper — reimbursement documents
 *
 * Bucket: `reimbursements` (private)
 * Path:   reimbursements/{reimbursementId}/{slot}-{originalName}
 * URLs:   signed, 7-day expiry (re-generated on each fetch)
 */
import { createClient } from '@supabase/supabase-js'
import ws from 'ws'

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SUPABASE_KEY) {
  throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set')
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false },
  // Node 20 has no native WebSocket — provide the ws polyfill
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  realtime: { transport: ws as any },
})

export const BUCKET = 'reimbursements'

/** Signed URL TTL in seconds (7 days) */
const SIGNED_URL_TTL = 60 * 60 * 24 * 7

export type DocumentSlot = 'invoice' | 'receipt' | 'supporting'

/**
 * Upload a file buffer to Supabase Storage.
 * Returns the storage path (not a URL — use getSignedUrl to make a URL).
 */
export async function uploadDocument(
  reimbursementId: string,
  slot: DocumentSlot,
  fileName: string,
  buffer: Buffer,
  mimeType: string,
): Promise<string> {
  // Sanitize filename — keep extension, strip path chars
  const safe = fileName.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100)
  const path = `${reimbursementId}/${slot}-${safe}`

  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(path, buffer, {
      contentType: mimeType,
      upsert: true,          // overwrite if re-uploaded
    })

  if (error) throw new Error(`Storage upload failed [${slot}]: ${error.message}`)
  return path
}

/**
 * Generate a signed URL for a stored path.
 * Returns null if path is falsy.
 */
export async function getSignedUrl(storagePath: string | null | undefined): Promise<string | null> {
  if (!storagePath) return null
  // If it's already a full https URL (legacy record), return as-is
  if (storagePath.startsWith('http')) return storagePath

  const { data, error } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(storagePath, SIGNED_URL_TTL)

  if (error || !data?.signedUrl) return null
  return data.signedUrl
}

/**
 * Delete all documents for a reimbursement (e.g. on hard delete).
 */
export async function deleteDocuments(reimbursementId: string): Promise<void> {
  const { data, error } = await supabase.storage
    .from(BUCKET)
    .list(reimbursementId)

  if (error || !data?.length) return

  const paths = data.map((f) => `${reimbursementId}/${f.name}`)
  await supabase.storage.from(BUCKET).remove(paths)
}
