import { Context, Next } from 'hono'
import type { AuthUser } from './auth.js'

/**
 * Middleware factory that restricts access to users with one of the specified roles.
 * Must be used after authMiddleware since it reads `c.get('user')`.
 *
 * Usage:
 *   app.post('/clients', authMiddleware, requireRole('admin'), createClient)
 */
export function requireRole(...roles: AuthUser['role'][]) {
  return async (c: Context, next: Next) => {
    const user = c.get('user')

    if (!user) {
      return c.json({ error: 'Unauthorized: authentication required' }, 401)
    }

    if (!roles.includes(user.role)) {
      return c.json(
        {
          error: `Forbidden: requires one of [${roles.join(', ')}] role`,
        },
        403,
      )
    }

    await next()
    return
  }
}
