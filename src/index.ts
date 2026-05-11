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

console.log(`🚀 nablly-api starting on port ${port}`)

export default {
  port,
  fetch: app.fetch,
}
