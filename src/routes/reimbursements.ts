import { Hono } from 'hono'
import { z } from 'zod'
import { db } from '../lib/db.js'
import { authMiddleware } from '../middleware/auth.js'
import { requireRole } from '../middleware/roles.js'
import type { ReimbursementStatus } from '@prisma/client'

const reimbursements = new Hono()
reimbursements.use('*', authMiddleware)

// ─── Zod schemas ────────────────────────────────────────────────────────────

const SERVICE_TYPES = [
  'collections',
  'check_pickup',
  'check_drop',
  'facilitation_expenses',
  'invoice_facilitation',
  'banking_facilitation',
  'client_coordination',
  'courier_services',
  'government_processing',
  'transportation',
  'compliance_processing',
  'miscellaneous',
] as const

const createSchema = z.object({
  type: z.enum(SERVICE_TYPES),
  expenseCategory: z.string().min(1, 'Expense category is required').optional(),
  expenseDate: z.string().datetime().optional(),
  amount: z.number().positive('Amount must be positive'),
  currency: z.string().default('PHP'),
  description: z.string().min(1, 'Description is required'),
  clientIdRef: z.string().optional(),
  clientNameRef: z.string().optional(),
  relatedInvoiceId: z.string().optional(),
  receiptUrl: z.string().optional(),
  invoiceUrl: z.string().optional(),
  supportingDocUrl: z.string().optional(),
  notes: z.string().optional(),
})

const commentOptionalSchema = z.object({ comment: z.string().optional() })
const commentRequiredSchema = z.object({ comment: z.string().min(1, 'Comment is required') })

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Generate a human-readable display ID like REIMB-202505-0042 */
async function generateDisplayId(): Promise<string> {
  const now = new Date()
  const ym = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`
  // Count existing reimbursements this month (by display_id prefix)
  const count = await db.reimbursement.count({
    where: { displayId: { startsWith: `REIMB-${ym}-` } },
  })
  const seq = String(count + 1).padStart(4, '0')
  return `REIMB-${ym}-${seq}`
}

const REIMBURSEMENT_INCLUDE = {
  requestor:       { select: { id: true, name: true, email: true, role: true } },
  financeReviewer: { select: { id: true, name: true, email: true, role: true } },
  reviewer:        { select: { id: true, name: true, email: true, role: true } },
  auditLogs: {
    orderBy: { createdAt: 'asc' as const },
    include: { actor: { select: { id: true, name: true, email: true, role: true } } },
  },
}

async function writeAudit(
  reimbursementId: string,
  actorId: string,
  action: string,
  comment?: string,
) {
  await db.reimbursementAuditLog.create({
    data: { reimbursementId, actorId, action, comment },
  })
}

// ─── GET / — role-scoped list ────────────────────────────────────────────────
reimbursements.get('/', async (c) => {
  try {
    const user = c.get('user')
    const status = c.req.query('status') as ReimbursementStatus | undefined
    const type   = c.req.query('type')
    const employeeId = c.req.query('employeeId')
    const clientId   = c.req.query('clientId')
    const page  = parseInt(c.req.query('page')  ?? '1',  10)
    const limit = parseInt(c.req.query('limit') ?? '20', 10)
    const skip  = (page - 1) * limit

    const where: Record<string, unknown> = {}
    if (user.role === 'employee') {
      where.requestorId = user.id
    } else if (employeeId) {
      where.requestorId = employeeId
    }
    if (status)   where.status = status
    if (type)     where.type = type
    if (clientId) where.clientIdRef = clientId

    const [total, data] = await Promise.all([
      db.reimbursement.count({ where }),
      db.reimbursement.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: REIMBURSEMENT_INCLUDE,
      }),
    ])

    return c.json({ data, meta: { total, page, limit, totalPages: Math.ceil(total / limit) }, message: 'Reimbursements retrieved' })
  } catch (err) {
    console.error('List reimbursements error:', err)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

// ─── GET /:id ────────────────────────────────────────────────────────────────
reimbursements.get('/:id', async (c) => {
  try {
    const user = c.get('user')
    const { id } = c.req.param()

    const reimbursement = await db.reimbursement.findUnique({
      where: { id },
      include: REIMBURSEMENT_INCLUDE,
    })

    if (!reimbursement) return c.json({ error: 'Reimbursement not found' }, 404)
    if (user.role === 'employee' && reimbursement.requestorId !== user.id) {
      return c.json({ error: 'Forbidden' }, 403)
    }

    return c.json({ data: reimbursement, message: 'Reimbursement retrieved' })
  } catch (err) {
    console.error('Get reimbursement error:', err)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

// ─── POST / — create as draft ────────────────────────────────────────────────
reimbursements.post('/', async (c) => {
  try {
    const user   = c.get('user')
    const body   = await c.req.json()
    const parsed = createSchema.safeParse(body)
    if (!parsed.success) return c.json({ error: 'Validation error', details: parsed.error.flatten() }, 400)

    const { type, expenseCategory, expenseDate, amount, currency, description,
            clientIdRef, clientNameRef, relatedInvoiceId,
            receiptUrl, invoiceUrl, supportingDocUrl, notes } = parsed.data

    const displayId = await generateDisplayId()

    const reimbursement = await db.reimbursement.create({
      data: {
        displayId,
        requestorId:      user.id,
        type,
        expenseCategory:  expenseCategory ?? null,
        expenseDate:      expenseDate ? new Date(expenseDate) : null,
        amount,
        currency,
        description,
        clientIdRef:      clientIdRef      ?? null,
        clientNameRef:    clientNameRef    ?? null,
        relatedInvoiceId: relatedInvoiceId ?? null,
        receiptUrl:       receiptUrl       ?? null,
        invoiceUrl:       invoiceUrl       ?? null,
        supportingDocUrl: supportingDocUrl ?? null,
        notes:            notes            ?? null,
        status:           'draft',
      },
      include: REIMBURSEMENT_INCLUDE,
    })

    await writeAudit(reimbursement.id, user.id, 'created', 'Draft created')

    return c.json({ data: reimbursement, message: 'Reimbursement draft created' }, 201)
  } catch (err) {
    console.error('Create reimbursement error:', err)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

// ─── PUT /:id/submit — draft → submitted ─────────────────────────────────────
reimbursements.put('/:id/submit', async (c) => {
  try {
    const user = c.get('user')
    const { id } = c.req.param()

    const r = await db.reimbursement.findUnique({ where: { id } })
    if (!r) return c.json({ error: 'Not found' }, 404)
    if (r.requestorId !== user.id && user.role !== 'admin') {
      return c.json({ error: 'Forbidden' }, 403)
    }
    if (!['draft', 'clarification_needed'].includes(r.status)) {
      return c.json({ error: `Cannot submit from status '${r.status}'` }, 422)
    }

    const updated = await db.reimbursement.update({
      where: { id },
      data: { status: 'submitted' },
      include: REIMBURSEMENT_INCLUDE,
    })
    await writeAudit(id, user.id, 'submitted', 'Submitted for finance review')

    return c.json({ data: updated, message: 'Reimbursement submitted' })
  } catch (err) {
    console.error('Submit reimbursement error:', err)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

// ─── PUT /:id/start-review — submitted → under_review ────────────────────────
reimbursements.put('/:id/start-review', requireRole('manager', 'admin'), async (c) => {
  try {
    const user = c.get('user')
    const { id } = c.req.param()

    const r = await db.reimbursement.findUnique({ where: { id } })
    if (!r) return c.json({ error: 'Not found' }, 404)
    if (r.status !== 'submitted') {
      return c.json({ error: `Cannot start review from status '${r.status}'` }, 422)
    }

    const updated = await db.reimbursement.update({
      where: { id },
      data: { status: 'under_review', financeReviewerId: user.id },
      include: REIMBURSEMENT_INCLUDE,
    })
    await writeAudit(id, user.id, 'review_started', 'Finance review started')

    return c.json({ data: updated, message: 'Review started' })
  } catch (err) {
    console.error('Start review error:', err)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

// ─── PUT /:id/request-clarification — under_review → clarification_needed ────
reimbursements.put('/:id/request-clarification', requireRole('manager', 'admin'), async (c) => {
  try {
    const user   = c.get('user')
    const { id } = c.req.param()
    const body   = await c.req.json()
    const parsed = commentRequiredSchema.safeParse(body)
    if (!parsed.success) return c.json({ error: 'Comment is required', details: parsed.error.flatten() }, 400)

    const r = await db.reimbursement.findUnique({ where: { id } })
    if (!r) return c.json({ error: 'Not found' }, 404)
    if (!['submitted', 'under_review'].includes(r.status)) {
      return c.json({ error: `Cannot request clarification from status '${r.status}'` }, 422)
    }

    const updated = await db.reimbursement.update({
      where: { id },
      data: { status: 'clarification_needed', financeReviewerId: user.id },
      include: REIMBURSEMENT_INCLUDE,
    })
    await writeAudit(id, user.id, 'clarification_requested', parsed.data.comment)

    return c.json({ data: updated, message: 'Clarification requested' })
  } catch (err) {
    console.error('Request clarification error:', err)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

// ─── PUT /:id/finance-approve — under_review → pending_final ─────────────────
reimbursements.put('/:id/finance-approve', requireRole('manager', 'admin'), async (c) => {
  try {
    const user   = c.get('user')
    const { id } = c.req.param()
    const body   = await c.req.json().catch(() => ({}))
    const parsed = commentOptionalSchema.safeParse(body)
    if (!parsed.success) return c.json({ error: 'Validation error', details: parsed.error.flatten() }, 400)

    const r = await db.reimbursement.findUnique({ where: { id } })
    if (!r) return c.json({ error: 'Not found' }, 404)
    if (!['submitted', 'under_review'].includes(r.status)) {
      return c.json({ error: `Cannot finance-approve from status '${r.status}'` }, 422)
    }

    const updated = await db.reimbursement.update({
      where: { id },
      data: {
        status:             'pending_final',
        financeReviewerId:  user.id,
        financeReviewedAt:  new Date(),
      },
      include: REIMBURSEMENT_INCLUDE,
    })
    await writeAudit(id, user.id, 'finance_approved', parsed.data.comment ?? 'Finance verification passed')

    return c.json({ data: updated, message: 'Finance approval recorded — awaiting final approval' })
  } catch (err) {
    console.error('Finance approve error:', err)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

// ─── PUT /:id/final-approve — pending_final → approved ───────────────────────
reimbursements.put('/:id/final-approve', requireRole('admin'), async (c) => {
  try {
    const user   = c.get('user')
    const { id } = c.req.param()
    const body   = await c.req.json().catch(() => ({}))
    const parsed = commentOptionalSchema.safeParse(body)
    if (!parsed.success) return c.json({ error: 'Validation error', details: parsed.error.flatten() }, 400)

    const r = await db.reimbursement.findUnique({ where: { id } })
    if (!r) return c.json({ error: 'Not found' }, 404)
    // Allow approving from finance-approved or legacy pending states
    if (!['pending_final', 'pending'].includes(r.status)) {
      return c.json({ error: `Cannot final-approve from status '${r.status}'` }, 422)
    }

    const updated = await db.reimbursement.update({
      where: { id },
      data: { status: 'approved', reviewerId: user.id, reviewedAt: new Date() },
      include: REIMBURSEMENT_INCLUDE,
    })
    await writeAudit(id, user.id, 'final_approved', parsed.data.comment ?? 'Final approval granted')

    return c.json({ data: updated, message: 'Reimbursement approved' })
  } catch (err) {
    console.error('Final approve error:', err)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

// ─── PUT /:id/reject — any in-flight status → rejected ───────────────────────
reimbursements.put('/:id/reject', requireRole('manager', 'admin'), async (c) => {
  try {
    const user   = c.get('user')
    const { id } = c.req.param()
    const body   = await c.req.json()
    const parsed = commentRequiredSchema.safeParse(body)
    if (!parsed.success) return c.json({ error: 'Comment is required when rejecting', details: parsed.error.flatten() }, 400)

    const r = await db.reimbursement.findUnique({ where: { id } })
    if (!r) return c.json({ error: 'Not found' }, 404)

    const REJECTABLE = ['submitted', 'under_review', 'pending_final', 'pending', 'clarification_needed']
    if (!REJECTABLE.includes(r.status)) {
      return c.json({ error: `Cannot reject from status '${r.status}'` }, 422)
    }

    const updated = await db.reimbursement.update({
      where: { id },
      data: { status: 'rejected', reviewerId: user.id, reviewedAt: new Date() },
      include: REIMBURSEMENT_INCLUDE,
    })
    await writeAudit(id, user.id, 'rejected', parsed.data.comment)

    return c.json({ data: updated, message: 'Reimbursement rejected' })
  } catch (err) {
    console.error('Reject reimbursement error:', err)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

// ─── PUT /:id/publish — approved → published_to_xoxoday ──────────────────────
reimbursements.put('/:id/publish', requireRole('admin'), async (c) => {
  try {
    const user   = c.get('user')
    const { id } = c.req.param()

    const r = await db.reimbursement.findUnique({ where: { id } })
    if (!r) return c.json({ error: 'Not found' }, 404)
    if (r.status !== 'approved') {
      return c.json({ error: `Cannot publish from status '${r.status}'` }, 422)
    }

    const updated = await db.reimbursement.update({
      where: { id },
      data: { status: 'published_to_xoxoday' },
      include: REIMBURSEMENT_INCLUDE,
    })
    await writeAudit(id, user.id, 'published', 'Published to XOXODAY dashboard')

    return c.json({ data: updated, message: 'Reimbursement published to XOXODAY' })
  } catch (err) {
    console.error('Publish error:', err)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

// ─── PUT /:id/reconcile — published_to_xoxoday → in_reconciliation ───────────
reimbursements.put('/:id/reconcile', requireRole('admin'), async (c) => {
  try {
    const user   = c.get('user')
    const { id } = c.req.param()

    const r = await db.reimbursement.findUnique({ where: { id } })
    if (!r) return c.json({ error: 'Not found' }, 404)
    if (r.status !== 'published_to_xoxoday') {
      return c.json({ error: `Cannot reconcile from status '${r.status}'` }, 422)
    }

    const updated = await db.reimbursement.update({
      where: { id },
      data: { status: 'in_reconciliation' },
      include: REIMBURSEMENT_INCLUDE,
    })
    await writeAudit(id, user.id, 'reconciled', 'Added to monthly reconciliation')

    return c.json({ data: updated, message: 'Reimbursement added to reconciliation' })
  } catch (err) {
    console.error('Reconcile error:', err)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

// ─── PUT /:id/close — in_reconciliation → closed ─────────────────────────────
reimbursements.put('/:id/close', requireRole('admin'), async (c) => {
  try {
    const user   = c.get('user')
    const { id } = c.req.param()
    const body   = await c.req.json().catch(() => ({}))
    const parsed = commentOptionalSchema.safeParse(body)

    const r = await db.reimbursement.findUnique({ where: { id } })
    if (!r) return c.json({ error: 'Not found' }, 404)
    if (r.status !== 'in_reconciliation') {
      return c.json({ error: `Cannot close from status '${r.status}'` }, 422)
    }

    const updated = await db.reimbursement.update({
      where: { id },
      data: { status: 'closed' },
      include: REIMBURSEMENT_INCLUDE,
    })
    await writeAudit(id, user.id, 'closed', parsed.success ? parsed.data.comment ?? 'Fully settled' : 'Fully settled')

    return c.json({ data: updated, message: 'Reimbursement closed' })
  } catch (err) {
    console.error('Close error:', err)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

// ─── Legacy: PUT /:id/approve (kept for backward compat) ─────────────────────
// Maps to finance-approve for existing callers
reimbursements.put('/:id/approve', requireRole('manager', 'admin'), async (c) => {
  try {
    const user   = c.get('user')
    const { id } = c.req.param()
    const body   = await c.req.json().catch(() => ({}))
    const parsed = commentOptionalSchema.safeParse(body)

    const r = await db.reimbursement.findUnique({ where: { id } })
    if (!r) return c.json({ error: 'Not found' }, 404)

    // If pending_final, do final approval (if admin); else do finance approval
    const isFinalApprover = user.role === 'admin' && r.status === 'pending_final'
    const newStatus = isFinalApprover ? 'approved' : 'pending_final'
    const APPROVABLE = ['pending', 'submitted', 'under_review', 'pending_final']
    if (!APPROVABLE.includes(r.status)) {
      return c.json({ error: `Cannot approve from status '${r.status}'` }, 422)
    }

    const updated = await db.reimbursement.update({
      where: { id },
      data: {
        status:             newStatus,
        reviewerId:         isFinalApprover ? user.id : r.reviewerId,
        reviewedAt:         isFinalApprover ? new Date() : r.reviewedAt,
        financeReviewerId:  !isFinalApprover ? user.id : r.financeReviewerId,
        financeReviewedAt:  !isFinalApprover ? new Date() : r.financeReviewedAt,
      },
      include: REIMBURSEMENT_INCLUDE,
    })
    await writeAudit(id, user.id, isFinalApprover ? 'final_approved' : 'finance_approved',
      (parsed.success ? parsed.data.comment : undefined) ?? undefined)

    return c.json({ data: updated, message: isFinalApprover ? 'Reimbursement approved' : 'Finance approval recorded' })
  } catch (err) {
    console.error('Approve reimbursement error:', err)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

export default reimbursements
