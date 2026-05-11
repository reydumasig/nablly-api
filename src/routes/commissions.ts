import { Hono } from 'hono'
import { db } from '../lib/db.js'
import { authMiddleware } from '../middleware/auth.js'
import { requireRole } from '../middleware/roles.js'
import type { CommissionStatus } from '@prisma/client'

const commissions = new Hono()

// All commission routes require authentication
commissions.use('*', authMiddleware)

// GET /commissions/summary — must be registered before /:id to avoid route conflict
commissions.get('/summary', async (c) => {
  try {
    // Total pending vs released
    const [pendingAgg, releasedAgg, byType] = await Promise.all([
      db.commission.aggregate({
        where: { status: 'pending' },
        _sum: { amount: true },
        _count: { id: true },
      }),
      db.commission.aggregate({
        where: { status: 'released' },
        _sum: { amount: true },
        _count: { id: true },
      }),
      db.commission.groupBy({
        by: ['type'],
        _sum: { amount: true },
        _count: { id: true },
      }),
    ])

    return c.json({
      data: {
        pending: {
          count: pendingAgg._count.id,
          total: pendingAgg._sum.amount ?? 0,
        },
        released: {
          count: releasedAgg._count.id,
          total: releasedAgg._sum.amount ?? 0,
        },
        byType: byType.map((row) => ({
          type: row.type,
          count: row._count.id,
          total: row._sum.amount ?? 0,
        })),
      },
      message: 'Commission summary retrieved',
    })
  } catch (err) {
    console.error('Commission summary error:', err)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

// GET /commissions — ledger with filters (status, month)
commissions.get('/', async (c) => {
  try {
    const status = c.req.query('status') as CommissionStatus | undefined
    const month = c.req.query('month') // format: YYYY-MM
    const type = c.req.query('type')
    const page = parseInt(c.req.query('page') ?? '1', 10)
    const limit = parseInt(c.req.query('limit') ?? '20', 10)
    const skip = (page - 1) * limit

    const where: Record<string, unknown> = {}

    if (status) where.status = status
    if (type) where.type = type

    if (month) {
      const [year, mon] = month.split('-').map(Number)
      const start = new Date(year, mon - 1, 1)
      const end = new Date(year, mon, 1)
      where.createdAt = { gte: start, lt: end }
    }

    const [total, data] = await Promise.all([
      db.commission.count({ where }),
      db.commission.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          invoice: {
            select: {
              id: true,
              invoiceNumber: true,
              invoiceType: true,
              amount: true,
              status: true,
              client: { select: { id: true, companyName: true } },
              requestor: { select: { id: true, name: true } },
            },
          },
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
      message: 'Commission ledger retrieved',
    })
  } catch (err) {
    console.error('List commissions error:', err)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

// PUT /commissions/:id/release — admin marks commission as released
commissions.put('/:id/release', requireRole('admin'), async (c) => {
  try {
    const { id } = c.req.param()

    const commission = await db.commission.findUnique({
      where: { id },
      include: {
        invoice: { select: { invoiceNumber: true, status: true } },
      },
    })

    if (!commission) {
      return c.json({ error: 'Commission not found' }, 404)
    }

    if (commission.status === 'released') {
      return c.json({ error: 'Commission has already been released' }, 422)
    }

    // Commission can only be released after invoice is paid
    if (commission.invoice.status !== 'paid') {
      return c.json(
        { error: 'Commission can only be released after the invoice is marked as paid' },
        422,
      )
    }

    const updated = await db.commission.update({
      where: { id },
      data: { status: 'released' },
      include: {
        invoice: {
          select: {
            id: true,
            invoiceNumber: true,
            invoiceType: true,
            amount: true,
            client: { select: { id: true, companyName: true } },
          },
        },
      },
    })

    return c.json({ data: updated, message: 'Commission marked as released' })
  } catch (err) {
    console.error('Release commission error:', err)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

export default commissions
