import { Hono } from 'hono'
import { z } from 'zod'
import jwt from 'jsonwebtoken'
import { db } from '../lib/db.js'
import { authMiddleware } from '../middleware/auth.js'
import crypto from 'node:crypto'

const auth = new Hono()

// Simple password hashing using Node.js built-in crypto (no bcrypt dependency needed)
function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex')
  const hash = crypto.scryptSync(password, salt, 64).toString('hex')
  return `${salt}:${hash}`
}

function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(':')
  const candidateHash = crypto.scryptSync(password, salt, 64).toString('hex')
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(candidateHash, 'hex'))
}

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
})

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  name: z.string().min(1),
  role: z.enum(['employee', 'manager', 'admin']).default('employee'),
  employeeId: z.string().optional(),
})

// POST /auth/login
auth.post('/login', async (c) => {
  try {
    const body = await c.req.json()
    const parsed = loginSchema.safeParse(body)

    if (!parsed.success) {
      return c.json({ error: 'Validation error', details: parsed.error.flatten() }, 400)
    }

    const { email, password } = parsed.data

    const user = await db.user.findUnique({ where: { email } })

    if (!user) {
      return c.json({ error: 'Invalid credentials' }, 401)
    }

    const valid = verifyPassword(password, user.password)
    if (!valid) {
      return c.json({ error: 'Invalid credentials' }, 401)
    }

    const secret = process.env.JWT_SECRET
    if (!secret) {
      return c.json({ error: 'Internal server error: auth not configured' }, 500)
    }

    const payload = {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
    }

    const token = jwt.sign(payload, secret, { expiresIn: '8h' })

    return c.json({
      data: {
        token,
        user: payload,
      },
      message: 'Login successful',
    })
  } catch (err) {
    console.error('Login error:', err)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

// POST /auth/register — for bootstrapping users (admin use only in production)
auth.post('/register', async (c) => {
  try {
    const body = await c.req.json()
    const parsed = registerSchema.safeParse(body)

    if (!parsed.success) {
      return c.json({ error: 'Validation error', details: parsed.error.flatten() }, 400)
    }

    const { email, password, name, role, employeeId } = parsed.data

    const existing = await db.user.findUnique({ where: { email } })
    if (existing) {
      return c.json({ error: 'Email already registered' }, 409)
    }

    if (employeeId) {
      const existingEmpId = await db.user.findUnique({ where: { employeeId } })
      if (existingEmpId) {
        return c.json({ error: 'Employee ID already in use' }, 409)
      }
    }

    const hashedPassword = hashPassword(password)

    const user = await db.user.create({
      data: {
        email,
        password: hashedPassword,
        name,
        role,
        employeeId: employeeId ?? null,
      },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        employeeId: true,
        createdAt: true,
      },
    })

    return c.json({ data: user, message: 'User registered successfully' }, 201)
  } catch (err) {
    console.error('Register error:', err)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

// GET /auth/me — get current authenticated user
auth.get('/me', authMiddleware, async (c) => {
  try {
    const authUser = c.get('user')

    const user = await db.user.findUnique({
      where: { id: authUser.id },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        employeeId: true,
        createdAt: true,
      },
    })

    if (!user) {
      return c.json({ error: 'User not found' }, 404)
    }

    return c.json({ data: user, message: 'User profile retrieved' })
  } catch (err) {
    console.error('Me error:', err)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

export default auth
