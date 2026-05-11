import { Hono } from 'hono'
import { z } from 'zod'
import { db } from '../lib/db.js'
import { authMiddleware } from '../middleware/auth.js'
import { requireRole } from '../middleware/roles.js'
import type { ReimbursementStatus } from '@prisma/client'

const reimbursements = new Hono()

// All reimbursement routes require authentication
reimbursements.use('*', authMiddleware)

const createReimbursementSchema = z.object({
  type: z.enum(['collections', 'check_pickup', 'check_drop', 'facilitation_expenses']),
  amount: z.number().positive('Amount must be positive'),
  description: z.string().min(1, 'Description is required'),
  receiptUrl: z.string().url().optional(),
  notes: z.string().optional(),
})

const reviewSchema = z.object({
  comment: z.string().optional(),
})

const rejectSchema = z.object({
  comment: z.string().min(1, 'Comment is required when rejecting a reimbursement'),
})

// GET /reimbursements — role-scoped list
reimbursements.get('/', async (c) => {
  try {
    const user = c.get('user')
    const status = c.req.query('status') as ReimbursementStatus | undefined
    const type = c.req.query('type')
    const employeeId = c.req.query('employeeId')
    const page = parseInt(c.req.query('page') ?? '1', 10)
    const limit = parseInt(c.req.query('limit') ?? '20', 10)
    const skip = (page - 1) * limit

    const where: Record<string, unknown> = {}

    // Employees only see their own reimbursements
    if (user.role === 'employee') {
      where.requestorId = user.id
    } else if (employeeId) {
      // Managers/admins can filter by specific employee
      where.requestorId = employeeId
    }

    if (status) where.status = status
    if (type) where.type = type

    const [total, data] = await Promise.all([
      db.reimbursement.count({ where }),
      db.reimbursement.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          requestor: { select: { id: true, name: true, email: true } },
          reviewer: { select: { id: true, name: true, email: true } },
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
      message: 'Reimbursements retrieved',
    })
  } catch (err) {
    console.error('List reimbursements error:', err)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

// GET /reimbursements/:id — single reimbursement detail
reimbursements.get('/:id', async (c) => {
  try {
    const user = c.get('user')
    const { id } = c.req.param()

    const reimbursement = await db.reimbursement.findUnique({
      where: { id },
      include: {
        requestor: { select: { id: true, name: true, email: true, role: true } },
        reviewer: { select: { id: true, name: true, email: true, role: true } },
      },
    })

    if (!reimbursement) {
      return c.json({ error: 'Reimbursement not found' }, 404)
    }

    // Employees can only view their own reimbursements
    if (user.role === 'employee' && reimbursement.requestorId !== user.id) {
      return c.json({ error: 'Forbidden: you do not have access to this reimbursement' }, 403)
    }

    return c.json({ data: reimbursement, message: 'Reimbursement retrieved' })
  } catch (err) {
    console.error('Get reimbursement error:', err)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

// POST /reimbursements — submit new reimbursement (employee)
reimbursements.post('/', requireRole('employee'), async (c) => {
  try {
    const user = c.get('user')
    const body = await c.req.json()
    const parsed = createReimbursementSchema.safeParse(body)

    if (!parsed.success) {
      return c.json({ error: 'Validation error', details: parsed.error.flatten() }, 400)
    }

    const { type, amount, description, receiptUrl, notes } = parsed.data

    const reimbursement = await db.reimbursement.create({
      data: {
        requestorId: user.id,
        type,
        amount,
        description,
        receiptUrl: receiptUrl ?? null,
        notes: notes ?? null,
        status: 'pending',
      },
      include: {
        requestor: { select: { id: true, name: true, email: true } },
      },
    })

    return c.json({ data: reimbursement, message: 'Reimbursement submitted successfully' }, 201)
  } catch (err) {
    console.error('Create reimbursement error:', err)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

// PUT /reimbursements/:id/approve — manager or admin approves
reimbursements.put('/:id/approve', requireRole('manager', 'admin'), async (c) => {
  try {
    const user = c.get('user')
    const { id } = c.req.param()
    const body = await c.req.json().catch(() => ({}))
    const parsed = reviewSchema.safeParse(body)

    if (!parsed.success) {
      return c.json({ error: 'Validation error', details: parsed.error.flatten() }, 400)
    }

    const reimbursement = await db.reimbursement.findUnique({ where: { id } })
    if (!reimbursement) {
      return c.json({ error: 'Reimbursement not found' }, 404)
    }

    if (reimbursement.status !== 'pending') {
      return c.json(
        { error: `Cannot approve reimbursement in status '${reimbursement.status}'. Expected: pending` },
        422,
      )
    }

    const updated = await db.reimbursement.update({
      where: { id },
      data: {
        status: 'approved',
        reviewerId: user.id,
        reviewedAt: new Date(),
        notes: parsed.data.comment
          ? reimbursement.notes
            ? `${reimbursement.notes}\n[Approval note]: ${parsed.data.comment}`
            : `[Approval note]: ${parsed.data.comment}`
          : reimbursement.notes,
      },
      include: {
        requestor: { select: { id: true, name: true, email: true } },
        reviewer: { select: { id: true, name: true, email: true } },
      },
    })

    return c.json({ data: updated, message: 'Reimbursement approved' })
  } catch (err) {
    console.error('Approve reimbursement error:', err)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

// PUT /reimbursements/:id/reject — manager or admin rejects (requires comment)
reimbursements.put('/:id/reject', requireRole('manager', 'admin'), async (c) => {
  try {
    const user = c.get('user')
    const { id } = c.req.param()
    const body = await c.req.json()
    const parsed = rejectSchema.safeParse(body)

    if (!parsed.success) {
      return c.json({ error: 'A comment is required when rejecting a reimbursement', details: parsed.error.flatten() }, 400)
    }

    const reimbursement = await db.reimbursement.findUnique({ where: { id } })
    if (!reimbursement) {
      return c.json({ error: 'Reimbursement not found' }, 404)
    }

    if (reimbursement.status !== 'pending') {
      return c.json(
        { error: `Cannot reject reimbursement in status '${reimbursement.status}'. Expected: pending` },
        422,
      )
    }

    const updated = await db.reimbursement.update({
      where: { id },
      data: {
        status: 'rejected',
        reviewerId: user.id,
        reviewedAt: new Date(),
        notes: reimbursement.notes
          ? `${reimbursement.notes}\n[Rejection reason]: ${parsed.data.comment}`
          : `[Rejection reason]: ${parsed.data.comment}`,
      },
      include: {
        requestor: { select: { id: true, name: true, email: true } },
        reviewer: { select: { id: true, name: true, email: true } },
      },
    })

    return c.json({ data: updated, message: 'Reimbursement rejected' })
  } catch (err) {
    console.error('Reject reimbursement error:', err)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

export default reimbursements
