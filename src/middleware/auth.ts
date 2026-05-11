import { Context, Next } from 'hono'
import jwt from 'jsonwebtoken'

export type AuthUser = {
  id: string
  email: string
  name: string
  role: 'employee' | 'manager' | 'admin'
}

declare module 'hono' {
  interface ContextVariableMap {
    user: AuthUser
  }
}

export async function authMiddleware(c: Context, next: Next) {
  const authHeader = c.req.header('Authorization')

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized: missing or malformed Authorization header' }, 401)
  }

  const token = authHeader.slice(7)
  const secret = process.env.JWT_SECRET

  if (!secret) {
    console.error('JWT_SECRET is not configured')
    return c.json({ error: 'Internal server error: auth not configured' }, 500)
  }

  try {
    const payload = jwt.verify(token, secret) as AuthUser
    c.set('user', payload)
    await next()
    return
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      return c.json({ error: 'Unauthorized: token expired' }, 401)
    }
    if (err instanceof jwt.JsonWebTokenError) {
      return c.json({ error: 'Unauthorized: invalid token' }, 401)
    }
    return c.json({ error: 'Unauthorized' }, 401)
  }
}
