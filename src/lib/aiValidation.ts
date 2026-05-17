/**
 * Sprint 3 — AI Validation Engine
 *
 * Uses Claude claude-3-5-haiku-20241022 to:
 *  1. Extract vendor name, invoice number, date, and amount from uploaded documents
 *  2. Cross-check extracted amount vs the amount typed on the form (flag >5% diff)
 *  3. Detect duplicate invoices (same invoice number already in the system)
 *  4. Check required documents are present
 *
 * Validation runs asynchronously after POST /:id/upload so the upload endpoint
 * responds immediately. Finance sees the badge after the next page load / refresh.
 */
import Anthropic from '@anthropic-ai/sdk'
import { db } from './db.js'
import { supabase, BUCKET } from './storage.js'

// ── Types ────────────────────────────────────────────────────────────────────

export interface ExtractedDocData {
  vendorName:    string | null
  invoiceNumber: string | null
  invoiceDate:   string | null
  amount:        number | null
  currency:      string | null
  confidence:    'high' | 'medium' | 'low'
}

export interface AiValidationData {
  invoice:  ExtractedDocData | null
  receipt:  ExtractedDocData | null
  checks: {
    amountMatch: {
      passed:          boolean
      formAmount:      number
      extractedAmount: number | null
      diffPercent:     number | null
    }
    duplicate: {
      passed:            boolean
      duplicateId:       string | null
      duplicateDisplayId: string | null
    }
    documentsPresent: {
      passed:  boolean
      missing: string[]
    }
  }
  overrideNote:  string | null
  validatedAt:   string
  modelUsed:     string
}

export type AiValidationStatus = 'pending' | 'passed' | 'warning' | 'failed' | 'skipped'

// ── Helpers ──────────────────────────────────────────────────────────────────

const MODEL = 'claude-3-5-haiku-20241022'

function getClient(): Anthropic | null {
  const key = process.env.ANTHROPIC_API_KEY
  if (!key) return null
  return new Anthropic({ apiKey: key })
}

function mimeFromPath(path: string): string {
  const lower = path.toLowerCase()
  if (lower.endsWith('.pdf'))  return 'application/pdf'
  if (lower.endsWith('.png'))  return 'image/png'
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  return 'application/octet-stream'
}

async function downloadStoragePath(storagePath: string): Promise<{ buffer: Buffer; mimeType: string } | null> {
  try {
    const { data, error } = await supabase.storage.from(BUCKET).download(storagePath)
    if (error || !data) return null
    const buffer = Buffer.from(await data.arrayBuffer())
    const mimeType = mimeFromPath(storagePath)
    return { buffer, mimeType }
  } catch {
    return null
  }
}

/** Build message content for Claude from a file buffer + MIME type */
function buildDocContent(
  buffer: Buffer,
  mimeType: string,
  docLabel: string,
): Anthropic.MessageParam['content'] {
  const base64 = buffer.toString('base64')
  const prompt = `Extract structured data from this ${docLabel} and return ONLY a JSON object with these fields:
{
  "vendorName": "vendor or company name on the document",
  "invoiceNumber": "invoice or receipt number if visible, else null",
  "invoiceDate": "date on document in YYYY-MM-DD format, else null",
  "amount": numeric total amount due or paid (digits only, no currency symbols),
  "currency": "3-letter currency code e.g. PHP, USD, EUR",
  "confidence": "high if all fields clearly readable, medium if some fields unclear, low if document is unreadable or has poor quality"
}
Return ONLY valid JSON. No explanation, no markdown.`

  if (mimeType === 'application/pdf') {
    return [
      {
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf' as const, data: base64 },
      } as unknown as Anthropic.TextBlockParam,
      { type: 'text', text: prompt },
    ]
  }

  const imgMime = (mimeType === 'image/png' ? 'image/png' : 'image/jpeg') as 'image/png' | 'image/jpeg'
  return [
    {
      type: 'image',
      source: { type: 'base64', media_type: imgMime, data: base64 },
    } as Anthropic.ImageBlockParam,
    { type: 'text', text: prompt },
  ]
}

async function extractFromDocument(
  buffer: Buffer,
  mimeType: string,
  docLabel: string,
  client: Anthropic,
): Promise<ExtractedDocData> {
  const empty: ExtractedDocData = {
    vendorName: null, invoiceNumber: null, invoiceDate: null,
    amount: null, currency: null, confidence: 'low',
  }

  // Skip DOCX — Claude can't read binary DOCX
  if (mimeType === 'application/octet-stream' || mimeType.includes('wordprocessing')) return empty

  try {
    const content = buildDocContent(buffer, mimeType, docLabel)

    const msg = await client.messages.create({
      model: MODEL,
      max_tokens: 512,
      messages: [{ role: 'user', content }],
    })

    const text = msg.content[0].type === 'text' ? msg.content[0].text : ''
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (!jsonMatch) return empty

    const parsed = JSON.parse(jsonMatch[0])
    return {
      vendorName:    parsed.vendorName    ?? null,
      invoiceNumber: parsed.invoiceNumber ?? null,
      invoiceDate:   parsed.invoiceDate   ?? null,
      amount:        parsed.amount !== undefined && parsed.amount !== null ? Number(parsed.amount) : null,
      currency:      parsed.currency      ?? null,
      confidence:    ['high', 'medium', 'low'].includes(parsed.confidence) ? parsed.confidence : 'medium',
    }
  } catch (err) {
    console.error(`AI extraction failed for ${docLabel}:`, err)
    return empty
  }
}

async function detectDuplicate(
  reimbursementId: string,
  invoiceNumber: string | null,
): Promise<{ passed: boolean; duplicateId: string | null; duplicateDisplayId: string | null }> {
  const none = { passed: true, duplicateId: null, duplicateDisplayId: null }
  if (!invoiceNumber) return none

  // Find any other reimbursement that has the same extracted invoice number
  const candidates = await db.reimbursement.findMany({
    where: {
      id: { not: reimbursementId },
      status: { notIn: ['draft', 'rejected', 'closed'] },
      aiValidationData: { not: undefined },
    },
    select: { id: true, displayId: true, aiValidationData: true },
    take: 500,
  })

  for (const c of candidates) {
    const data = c.aiValidationData as AiValidationData | null
    const extractedInvNum = data?.invoice?.invoiceNumber
    if (extractedInvNum && extractedInvNum.toLowerCase() === invoiceNumber.toLowerCase()) {
      return { passed: false, duplicateId: c.id, duplicateDisplayId: c.displayId }
    }
  }
  return none
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Run AI validation for a reimbursement.
 * Downloads stored documents, extracts data, checks for duplicates,
 * persists results to DB, and returns the final status + data.
 */
export async function runAiValidation(reimbursementId: string): Promise<{
  status: AiValidationStatus
  data: AiValidationData
}> {
  const r = await db.reimbursement.findUnique({ where: { id: reimbursementId } })
  if (!r) throw new Error('Reimbursement not found')

  const formAmount = Number(r.amount)
  const client = getClient()

  // ── 1. Documents-present check ────────────────────────────────────────────
  const missing: string[] = []
  if (!r.invoiceUrl)  missing.push('invoice')
  if (!r.receiptUrl)  missing.push('receipt')
  const documentsPresent = { passed: missing.length === 0, missing }

  // Skip AI if no files stored yet
  if (!r.invoiceUrl && !r.receiptUrl) {
    const data: AiValidationData = {
      invoice: null, receipt: null,
      checks: {
        amountMatch:      { passed: false, formAmount, extractedAmount: null, diffPercent: null },
        duplicate:        { passed: true,  duplicateId: null, duplicateDisplayId: null },
        documentsPresent,
      },
      overrideNote: null,
      validatedAt: new Date().toISOString(),
      modelUsed: 'none',
    }
    await persistResult(reimbursementId, 'skipped', data)
    return { status: 'skipped', data }
  }

  // ── 2. Extract from invoice (only if file is in storage, not legacy URL) ──
  let invoiceExtracted: ExtractedDocData | null = null
  if (client && r.invoiceUrl && !r.invoiceUrl.startsWith('http')) {
    const file = await downloadStoragePath(r.invoiceUrl)
    if (file) {
      invoiceExtracted = await extractFromDocument(file.buffer, file.mimeType, 'invoice', client)
    }
  }

  // ── 3. Extract from receipt ───────────────────────────────────────────────
  let receiptExtracted: ExtractedDocData | null = null
  if (client && r.receiptUrl && !r.receiptUrl.startsWith('http')) {
    const file = await downloadStoragePath(r.receiptUrl)
    if (file) {
      receiptExtracted = await extractFromDocument(file.buffer, file.mimeType, 'receipt', client)
    }
  }

  // ── 4. Amount cross-check ─────────────────────────────────────────────────
  const extractedAmount = invoiceExtracted?.amount ?? receiptExtracted?.amount ?? null
  let diffPercent: number | null = null
  let amountMatchPassed = true

  if (extractedAmount !== null && formAmount > 0) {
    diffPercent = Math.round(
      Math.abs((extractedAmount - formAmount) / formAmount) * 1000,
    ) / 10   // 1 decimal place
    amountMatchPassed = diffPercent <= 5
  }

  // ── 5. Duplicate detection ────────────────────────────────────────────────
  const duplicate = await detectDuplicate(
    reimbursementId,
    invoiceExtracted?.invoiceNumber ?? null,
  )

  // ── 6. Determine overall status ───────────────────────────────────────────
  let status: AiValidationStatus

  if (!client) {
    // No API key — run rule-based checks only
    status = duplicate.passed ? (documentsPresent.passed ? 'passed' : 'warning') : 'failed'
  } else if (!duplicate.passed) {
    status = 'failed'  // Duplicate is always a hard fail
  } else if (diffPercent !== null && diffPercent > 10) {
    status = 'failed'  // Large amount mismatch
  } else if (!documentsPresent.passed || (diffPercent !== null && diffPercent > 5)) {
    status = 'warning' // Minor mismatch or missing supporting doc
  } else if (invoiceExtracted?.confidence === 'low' || receiptExtracted?.confidence === 'low') {
    status = 'warning' // Document unreadable / poor quality
  } else {
    status = 'passed'
  }

  const data: AiValidationData = {
    invoice:  invoiceExtracted,
    receipt:  receiptExtracted,
    checks: {
      amountMatch:      { passed: amountMatchPassed, formAmount, extractedAmount, diffPercent },
      duplicate,
      documentsPresent,
    },
    overrideNote: null,
    validatedAt:  new Date().toISOString(),
    modelUsed:    client ? MODEL : 'none (no API key)',
  }

  await persistResult(reimbursementId, status, data)
  return { status, data }
}

async function persistResult(
  id: string,
  status: AiValidationStatus,
  data: AiValidationData,
) {
  await db.reimbursement.update({
    where: { id },
    data: {
      aiValidationStatus: status,
      aiValidationData:   data as object,
      aiValidatedAt:      new Date(),
    },
  })
}

/**
 * Allow Finance to override a failed/warning validation with a note.
 * Sets status to 'passed' and records the override note in aiValidationData.
 */
export async function overrideValidation(id: string, note: string): Promise<void> {
  const r = await db.reimbursement.findUnique({ where: { id } })
  if (!r) return

  const existing = (r.aiValidationData ?? {}) as unknown as AiValidationData
  await db.reimbursement.update({
    where: { id },
    data: {
      aiValidationStatus: 'passed',
      aiValidationData:   { ...existing, overrideNote: note } as object,
    },
  })
}
