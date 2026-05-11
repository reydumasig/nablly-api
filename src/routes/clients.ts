import { Hono } from 'hono'
import { z } from 'zod'
import { db } from '../lib/db.js'
import { authMiddleware } from '../middleware/auth.js'
import { requireRole } from '../middleware/roles.js'

const clients = new Hono()

// All client routes require authentication
clients.use('*', authMiddleware)

const createClientSchema = z.object({
  companyName: z.string().min(1, 'Company name is required'),
  type: z.enum(['saas', 'gmv', 'both']),
  birNumber: z.string().optional(),
  address: z.string().optional(),
  contactPerson: z.string().optional(),
  contactEmail: z.string().email().optional().or(z.literal('')),
  contactNumber: z.string().optional(),
  status: z.enum(['active', 'inactive', 'pending']).default('pending'),
})

const updateClientSchema = createClientSchema.partial()

// GET /clients — list all clients with optional search
clients.get('/', async (c) => {
  try {
    const search = c.req.query('search')
    const status = c.req.query('status') as 'active' | 'inactive' | 'pending' | undefined
    const type = c.req.query('type') as 'saas' | 'gmv' | 'both' | undefined
    const page = parseInt(c.req.query('page') ?? '1', 10)
    const limit = parseInt(c.req.query('limit') ?? '20', 10)
    const skip = (page - 1) * limit

    const where: Record<string, unknown> = {}

    if (search) {
      where.OR = [
        { companyName: { contains: search, mode: 'insensitive' } },
        { contactPerson: { contains: search, mode: 'insensitive' } },
        { contactEmail: { contains: search, mode: 'insensitive' } },
        { birNumber: { contains: search, mode: 'insensitive' } },
      ]
    }

    if (status) where.status = status
    if (type) where.type = type

    const [total, data] = await Promise.all([
      db.client.count({ where }),
      db.client.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          _count: {
            select: { invoices: true },
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
      message: 'Clients retrieved',
    })
  } catch (err) {
    console.error('List clients error:', err)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

// GET /clients/:id — client detail with invoice summary
clients.get('/:id', async (c) => {
  try {
    const { id } = c.req.param()

    const client = await db.client.findUnique({
      where: { id },
      include: {
        invoices: {
          select: {
            id: true,
            invoiceType: true,
            amount: true,
            status: true,
            invoiceNumber: true,
            createdAt: true,
            paidAt: true,
          },
          orderBy: { createdAt: 'desc' },
          take: 10,
        },
        _count: {
          select: { invoices: true },
        },
      },
    })

    if (!client) {
      return c.json({ error: 'Client not found' }, 404)
    }

    // Invoice summary aggregation
    const summary = await db.invoice.groupBy({
      by: ['status'],
      where: { clientId: id },
      _count: { id: true },
      _sum: { amount: true },
    })

    const totalRevenue = await db.invoice.aggregate({
      where: { clientId: id, status: 'paid' },
      _sum: { amount: true },
    })

    return c.json({
      data: {
        ...client,
        invoiceSummary: summary,
        totalRevenuePaid: totalRevenue._sum.amount ?? 0,
      },
      message: 'Client retrieved',
    })
  } catch (err) {
    console.error('Get client error:', err)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

// POST /clients — create new client (admin only)
clients.post('/', requireRole('admin'), async (c) => {
  try {
    const body = await c.req.json()
    const parsed = createClientSchema.safeParse(body)

    if (!parsed.success) {
      return c.json({ error: 'Validation error', details: parsed.error.flatten() }, 400)
    }

    const { companyName, type, birNumber, address, contactPerson, contactEmail, contactNumber, status } = parsed.data

    const client = await db.client.create({
      data: {
        companyName,
        type,
        birNumber: birNumber ?? null,
        address: address ?? null,
        contactPerson: contactPerson ?? null,
        contactEmail: contactEmail || null,
        contactNumber: contactNumber ?? null,
        status,
      },
    })

    return c.json({ data: client, message: 'Client created successfully' }, 201)
  } catch (err) {
    console.error('Create client error:', err)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

// PUT /clients/:id — update client (admin only)
clients.put('/:id', requireRole('admin'), async (c) => {
  try {
    const { id } = c.req.param()
    const body = await c.req.json()
    const parsed = updateClientSchema.safeParse(body)

    if (!parsed.success) {
      return c.json({ error: 'Validation error', details: parsed.error.flatten() }, 400)
    }

    const existing = await db.client.findUnique({ where: { id } })
    if (!existing) {
      return c.json({ error: 'Client not found' }, 404)
    }

    const updates: Record<string, unknown> = {}
    const d = parsed.data

    if (d.companyName !== undefined) updates.companyName = d.companyName
    if (d.type !== undefined) updates.type = d.type
    if (d.birNumber !== undefined) updates.birNumber = d.birNumber
    if (d.address !== undefined) updates.address = d.address
    if (d.contactPerson !== undefined) updates.contactPerson = d.contactPerson
    if (d.contactEmail !== undefined) updates.contactEmail = d.contactEmail || null
    if (d.contactNumber !== undefined) updates.contactNumber = d.contactNumber
    if (d.status !== undefined) updates.status = d.status

    const client = await db.client.update({
      where: { id },
      data: updates,
    })

    return c.json({ data: client, message: 'Client updated successfully' })
  } catch (err) {
    console.error('Update client error:', err)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

export default clients
