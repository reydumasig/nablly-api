import { Hono } from 'hono'
import { z } from 'zod'
import { db } from '../lib/db.js'
import { calcCommission } from '../lib/commission.js'
import { authMiddleware } from '../middleware/auth.js'
import { requireRole } from '../middleware/roles.js'
import type { InvoiceStatus, CommissionType } from '@prisma/client'

const invoices = new Hono()

// All invoice routes require authentication
invoices.use('*', authMiddleware)

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Generate an invoice number in the format INV-YYYYMM-XXXX
 * Sequence is derived by counting existing invoices for the current month.
 */
async function generateInvoiceNumber(): Promise<string> {
  const now = new Date()
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const prefix = `INV-${year}${month}-`

  const count = await db.invoice.count({
    where: {
      invoiceNumber: {
        startsWith: prefix,
      },
    },
  })

  const seq = String(count + 1).padStart(4, '0')
  return `${prefix}${seq}`
}

/**
 * Create an audit log entry and update invoice status atomically.
 */
async function transitionInvoice(
  invoiceId: string,
  actorId: string,
  newStatus: InvoiceStatus,
  action: string,
  comment?: string,
  extraData?: Record<string, unknown>,
) {
  return db.$transaction(async (tx) => {
    const updated = await tx.invoice.update({
      where: { id: invoiceId },
      data: { status: newStatus, ...extraData },
      include: {
        requestor: { select: { id: true, name: true, email: true, role: true } },
        client: true,
        auditLogs: {
          include: { actor: { select: { id: true, name: true, role: true } } },
          orderBy: { createdAt: 'desc' },
        },
      },
    })

    await tx.invoiceAuditLog.create({
      data: {
        invoiceId,
        actorId,
        action,
        comment: comment ?? null,
      },
    })

    return updated
  })
}

// ─── Schemas ─────────────────────────────────────────────────────────────────

const createInvoiceSchema = z.object({
  clientId: z.string().min(1, 'Client ID is required'),
  invoiceType: z.enum(['saas', 'setup', 'saas_setup', 'gmv_recharge']),
  amount: z.number().positive('Amount must be positive'),
  dueDate: z.string().datetime().optional(),
  notes: z.string().optional(),
})

const commentSchema = z.object({
  comment: z.string().min(1, 'Comment is required'),
})

// ─── Valid transitions map ────────────────────────────────────────────────────

const VALID_TRANSITIONS: Partial<Record<InvoiceStatus, InvoiceStatus[]>> = {
  draft: ['submitted'],
  submitted: ['maker_review'],
  // sent_back allows going back to maker_review directly on re-submit (skips submitted step)
  maker_review: ['checker_review', 'sent_back'],
  sent_back: ['maker_review'],
  checker_review: ['approved', 'rejected'],
  approved: ['invoice_generated'],
  invoice_generated: ['sent'],
  sent: ['paid'],
}

export function canTransition(current: InvoiceStatus, next: InvoiceStatus): boolean {
  return VALID_TRANSITIONS[current]?.includes(next) ?? false
}

// ─── Routes ──────────────────────────────────────────────────────────────────

// GET /invoices — list with filters, role-scoped
invoices.get('/', async (c) => {
  try {
    const user = c.get('user')
    const status = c.req.query('status') as InvoiceStatus | undefined
    const type = c.req.query('type') as string | undefined
    const clientId = c.req.query('clientId')
    const page = parseInt(c.req.query('page') ?? '1', 10)
    const limit = parseInt(c.req.query('limit') ?? '20', 10)
    const skip = (page - 1) * limit

    const where: Record<string, unknown> = {}

    // Employees only see their own invoices
    if (user.role === 'employee') {
      where.requestorId = user.id
    }

    if (status) where.status = status
    if (type) where.invoiceType = type
    if (clientId) where.clientId = clientId

    const [total, data] = await Promise.all([
      db.invoice.count({ where }),
      db.invoice.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          requestor: { select: { id: true, name: true, email: true } },
          client: { select: { id: true, companyName: true, type: true } },
          commission: true,
        },
      }),
    ])

    return c.json({
      data,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
      message: 'Invoices retrieved',
    })
  } catch (err) {
    console.error('List invoices error:', err)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

// GET /invoices/:id — detail with audit log
invoices.get('/:id', async (c) => {
  try {
    const user = c.get('user')
    const { id } = c.req.param()

    const invoice = await db.invoice.findUnique({
      where: { id },
      include: {
        requestor: { select: { id: true, name: true, email: true, role: true } },
        client: true,
        commission: true,
        auditLogs: {
          include: {
            actor: { select: { id: true, name: true, role: true } },
          },
          orderBy: { createdAt: 'asc' },
        },
      },
    })

    if (!invoice) {
      return c.json({ error: 'Invoice not found' }, 404)
    }

    // Employees can only view their own invoices
    if (user.role === 'employee' && invoice.requestorId !== user.id) {
      return c.json({ error: 'Forbidden: you do not have access to this invoice' }, 403)
    }

    return c.json({ data: invoice, message: 'Invoice retrieved' })
  } catch (err) {
    console.error('Get invoice error:', err)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

// POST /invoices — create draft (employee only)
invoices.post('/', requireRole('employee'), async (c) => {
  try {
    const user = c.get('user')
    const body = await c.req.json()
    const parsed = createInvoiceSchema.safeParse(body)

    if (!parsed.success) {
      return c.json({ error: 'Validation error', details: parsed.error.flatten() }, 400)
    }

    const { clientId, invoiceType, amount, dueDate, notes } = parsed.data

    // Verify client exists
    const client = await db.client.findUnique({ where: { id: clientId } })
    if (!client) {
      return c.json({ error: 'Client not found' }, 404)
    }

    const invoice = await db.$transaction(async (tx) => {
      const created = await tx.invoice.create({
        data: {
          requestorId: user.id,
          clientId,
          invoiceType,
          amount,
          dueDate: dueDate ? new Date(dueDate) : null,
          notes: notes ?? null,
          status: 'draft',
        },
        include: {
          requestor: { select: { id: true, name: true, email: true } },
          client: { select: { id: true, companyName: true } },
        },
      })

      await tx.invoiceAuditLog.create({
        data: {
          invoiceId: created.id,
          actorId: user.id,
          action: 'created',
          comment: 'Invoice draft created',
        },
      })

      return created
    })

    return c.json({ data: invoice, message: 'Invoice draft created' }, 201)
  } catch (err) {
    console.error('Create invoice error:', err)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

// POST /invoices/:id/submit — employee submits draft
invoices.post('/:id/submit', requireRole('employee'), async (c) => {
  try {
    const user = c.get('user')
    const { id } = c.req.param()

    const invoice = await db.invoice.findUnique({ where: { id } })
    if (!invoice) return c.json({ error: 'Invoice not found' }, 404)

    if (invoice.requestorId !== user.id) {
      return c.json({ error: 'Forbidden: you can only submit your own invoices' }, 403)
    }

    const submittableStatuses: InvoiceStatus[] = ['draft', 'sent_back']
    if (!submittableStatuses.includes(invoice.status)) {
      return c.json(
        { error: `Cannot submit invoice in status '${invoice.status}'. Expected: draft or sent_back` },
        422,
      )
    }

    // Drafts go to 'submitted' (awaiting maker pickup).
    // Re-submissions from 'sent_back' skip straight to 'maker_review' since
    // the maker already knows the request and just needs to review the fix.
    const targetStatus: InvoiceStatus = invoice.status === 'sent_back' ? 'maker_review' : 'submitted'

    const updated = await transitionInvoice(
      id,
      user.id,
      targetStatus,
      invoice.status === 'sent_back' ? 'resubmitted' : 'submitted',
      undefined,
    )

    return c.json({ data: updated, message: 'Invoice submitted for review' })
  } catch (err) {
    console.error('Submit invoice error:', err)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

// POST /invoices/:id/approve-to-checker — manager approves, calculates commission
invoices.post('/:id/approve-to-checker', requireRole('manager'), async (c) => {
  try {
    const user = c.get('user')
    const { id } = c.req.param()

    const invoice = await db.invoice.findUnique({ where: { id } })
    if (!invoice) return c.json({ error: 'Invoice not found' }, 404)

    const allowedStatuses: InvoiceStatus[] = ['submitted', 'maker_review']
    if (!allowedStatuses.includes(invoice.status)) {
      return c.json(
        { error: `Cannot approve invoice in status '${invoice.status}'. Expected: submitted or maker_review` },
        422,
      )
    }

    // Calculate commission
    const { amount: commissionAmt, type: commissionType } = calcCommission(
      invoice.invoiceType,
      Number(invoice.amount),
    )

    const updated = await db.$transaction(async (tx) => {
      const inv = await tx.invoice.update({
        where: { id },
        data: {
          status: 'checker_review',
          commissionAmount: commissionAmt,
        },
        include: {
          requestor: { select: { id: true, name: true, email: true, role: true } },
          client: true,
          auditLogs: {
            include: { actor: { select: { id: true, name: true, role: true } } },
            orderBy: { createdAt: 'desc' },
          },
        },
      })

      await tx.invoiceAuditLog.create({
        data: {
          invoiceId: id,
          actorId: user.id,
          action: 'approved_to_checker',
          comment: `Commission calculated: ₱${commissionAmt} (${commissionType})`,
        },
      })

      // Create or update commission record
      await tx.commission.upsert({
        where: { invoiceId: id },
        create: {
          invoiceId: id,
          amount: commissionAmt,
          type: commissionType as CommissionType,
          status: 'pending',
        },
        update: {
          amount: commissionAmt,
          type: commissionType as CommissionType,
        },
      })

      return inv
    })

    return c.json({ data: updated, message: 'Invoice approved and forwarded to checker' })
  } catch (err) {
    console.error('Approve to checker error:', err)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

// POST /invoices/:id/send-back — manager sends back to employee (requires comment)
invoices.post('/:id/send-back', requireRole('manager'), async (c) => {
  try {
    const user = c.get('user')
    const { id } = c.req.param()
    const body = await c.req.json()
    const parsed = commentSchema.safeParse(body)

    if (!parsed.success) {
      return c.json({ error: 'A comment is required when sending back an invoice', details: parsed.error.flatten() }, 400)
    }

    const invoice = await db.invoice.findUnique({ where: { id } })
    if (!invoice) return c.json({ error: 'Invoice not found' }, 404)

    const allowedStatuses: InvoiceStatus[] = ['submitted', 'maker_review']
    if (!allowedStatuses.includes(invoice.status)) {
      return c.json(
        { error: `Cannot send back invoice in status '${invoice.status}'` },
        422,
      )
    }

    const updated = await transitionInvoice(id, user.id, 'sent_back', 'sent_back', parsed.data.comment)

    return c.json({ data: updated, message: 'Invoice sent back to requestor' })
  } catch (err) {
    console.error('Send back error:', err)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

// POST /invoices/:id/final-approve — admin final approval
invoices.post('/:id/final-approve', requireRole('admin'), async (c) => {
  try {
    const user = c.get('user')
    const { id } = c.req.param()

    const invoice = await db.invoice.findUnique({ where: { id } })
    if (!invoice) return c.json({ error: 'Invoice not found' }, 404)

    if (invoice.status !== 'checker_review') {
      return c.json(
        { error: `Cannot final-approve invoice in status '${invoice.status}'. Expected: checker_review` },
        422,
      )
    }

    const updated = await transitionInvoice(id, user.id, 'approved', 'final_approved')

    return c.json({ data: updated, message: 'Invoice approved by checker' })
  } catch (err) {
    console.error('Final approve error:', err)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

// POST /invoices/:id/generate-pdf — admin generates PDF
invoices.post('/:id/generate-pdf', requireRole('admin'), async (c) => {
  try {
    const user = c.get('user')
    const { id } = c.req.param()

    const invoice = await db.invoice.findUnique({ where: { id } })
    if (!invoice) return c.json({ error: 'Invoice not found' }, 404)

    if (invoice.status !== 'approved') {
      return c.json(
        { error: `Cannot generate PDF for invoice in status '${invoice.status}'. Expected: approved` },
        422,
      )
    }

    const invoiceNumber = await generateInvoiceNumber()
    // Placeholder PDF URL — replace with actual PDF generation service (e.g. Puppeteer, PDFKit)
    const pdfUrl = `/pdfs/${invoiceNumber}.pdf`

    const updated = await transitionInvoice(
      id,
      user.id,
      'invoice_generated',
      'pdf_generated',
      `Invoice number ${invoiceNumber} generated`,
      { invoiceNumber, pdfUrl },
    )

    return c.json({ data: updated, message: `PDF generated: ${invoiceNumber}` })
  } catch (err) {
    console.error('Generate PDF error:', err)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

// POST /invoices/:id/send — admin marks invoice as sent
invoices.post('/:id/send', requireRole('admin'), async (c) => {
  try {
    const user = c.get('user')
    const { id } = c.req.param()

    const invoice = await db.invoice.findUnique({ where: { id } })
    if (!invoice) return c.json({ error: 'Invoice not found' }, 404)

    if (invoice.status !== 'invoice_generated') {
      return c.json(
        { error: `Cannot mark invoice as sent in status '${invoice.status}'. Expected: invoice_generated` },
        422,
      )
    }

    const updated = await transitionInvoice(
      id,
      user.id,
      'sent',
      'sent_to_client',
      undefined,
      { sentAt: new Date() },
    )

    return c.json({ data: updated, message: 'Invoice marked as sent' })
  } catch (err) {
    console.error('Send invoice error:', err)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

// POST /invoices/:id/mark-paid — admin marks invoice as paid
invoices.post('/:id/mark-paid', requireRole('admin'), async (c) => {
  try {
    const user = c.get('user')
    const { id } = c.req.param()

    const invoice = await db.invoice.findUnique({ where: { id } })
    if (!invoice) return c.json({ error: 'Invoice not found' }, 404)

    if (invoice.status !== 'sent') {
      return c.json(
        { error: `Cannot mark invoice as paid in status '${invoice.status}'. Expected: sent` },
        422,
      )
    }

    const updated = await transitionInvoice(
      id,
      user.id,
      'paid',
      'marked_paid',
      undefined,
      { paidAt: new Date() },
    )

    return c.json({ data: updated, message: 'Invoice marked as paid' })
  } catch (err) {
    console.error('Mark paid error:', err)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

// POST /invoices/:id/reject — admin rejects invoice (requires comment)
invoices.post('/:id/reject', requireRole('admin'), async (c) => {
  try {
    const user = c.get('user')
    const { id } = c.req.param()
    const body = await c.req.json()
    const parsed = commentSchema.safeParse(body)

    if (!parsed.success) {
      return c.json({ error: 'A comment is required when rejecting an invoice', details: parsed.error.flatten() }, 400)
    }

    const invoice = await db.invoice.findUnique({ where: { id } })
    if (!invoice) return c.json({ error: 'Invoice not found' }, 404)

    const rejectableStatuses: InvoiceStatus[] = ['checker_review', 'approved', 'submitted', 'maker_review']
    if (!rejectableStatuses.includes(invoice.status)) {
      return c.json(
        { error: `Cannot reject invoice in status '${invoice.status}'` },
        422,
      )
    }

    const updated = await transitionInvoice(id, user.id, 'rejected', 'rejected', parsed.data.comment)

    return c.json({ data: updated, message: 'Invoice rejected' })
  } catch (err) {
    console.error('Reject invoice error:', err)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

export default invoices
