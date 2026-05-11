import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { HTTPException } from 'hono/http-exception'

import authRoutes from './routes/auth.js'
import clientRoutes from './routes/clients.js'
import invoiceRoutes from './routes/invoices.js'
import commissionRoutes from './routes/commissions.js'
import reimbursementRoutes from './routes/reimbursements.js'

const app = new Hono()

// ─── Global Middleware ────────────────────────────────────────────────────────

app.use(
  '*',
  cors({
    origin: process.env.ALLOWED_ORIGINS?.split(',') ?? ['http://localhost:5173', 'http://localhost:3000'],
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
  }),
)

app.use('*', logger())

// ─── Health check ─────────────────────────────────────────────────────────────

app.get('/health', (c) =>
  c.json({
    status: 'ok',
    service: 'nablly-api',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
  }),
)

// ─── Debug endpoint (remove after confirming env is healthy) ─────────────────

app.get('/debug/env', async (c) => {
  const dbUrl = process.env.DATABASE_URL ?? ''
  const { db } = await import('./lib/db.js')
  let dbStatus = 'unknown'
  try {
    await db.$queryRaw`SELECT 1`
    dbStatus = 'connected'
  } catch (e: unknown) {
    dbStatus = e instanceof Error ? e.message.slice(0, 120) : 'error'
  }
  return c.json({
    DATABASE_URL_SET: !!dbUrl,
    DATABASE_URL_PREFIX: dbUrl ? dbUrl.slice(0, 30) + '...' : 'NOT SET',
    JWT_SECRET_SET: !!process.env.JWT_SECRET,
    PORT: process.env.PORT,
    NODE_ENV: process.env.NODE_ENV,
    db: dbStatus,
  })
})

// ─── Routes ──────────────────────────────────────────────────────────────────

app.route('/api/v1/auth', authRoutes)
app.route('/api/v1/clients', clientRoutes)
app.route('/api/v1/invoices', invoiceRoutes)
app.route('/api/v1/commissions', commissionRoutes)
app.route('/api/v1/reimbursements', reimbursementRoutes)

// ─── 404 Handler ─────────────────────────────────────────────────────────────

app.notFound((c) =>
  c.json(
    {
      error: `Route not found: ${c.req.method} ${c.req.path}`,
    },
    404,
  ),
)

// ─── Global Error Handler ─────────────────────────────────────────────────────

app.onError((err, c) => {
  console.error('[Unhandled Error]', err)

  if (err instanceof HTTPException) {
    return c.json({ error: err.message }, err.status)
  }

  return c.json({ error: 'Internal server error' }, 500)
})

// ─── Server bootstrap ────────────────────────────────────────────────────────

const port = parseInt(process.env.PORT ?? '3001', 10)

serve({ fetch: app.fetch, port }, () => {
  console.log(`🚀 nablly-api running on port ${port}`)
})
