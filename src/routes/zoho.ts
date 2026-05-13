import { Hono } from 'hono'
import { exchangeCodeForTokens, isZohoConfigured } from '../lib/zoho.js'

const zoho = new Hono()

// ─── GET /zoho/callback ──────────────────────────────────────────────────────
// Receives the one-time auth code from Zoho after the user approves the OAuth
// consent screen. Exchanges it for access + refresh tokens and displays the
// refresh token so it can be saved as ZOHO_REFRESH_TOKEN in Railway.

zoho.get('/callback', async (c) => {
  const code  = c.req.query('code')
  const error = c.req.query('error')

  if (error) {
    return c.html(errorPage(`Zoho OAuth error: ${error}`))
  }

  if (!code) {
    return c.json({ error: 'No authorization code received from Zoho' }, 400)
  }

  if (!process.env.ZOHO_CLIENT_ID || !process.env.ZOHO_CLIENT_SECRET) {
    return c.html(errorPage('ZOHO_CLIENT_ID or ZOHO_CLIENT_SECRET is not set in Railway env vars.'))
  }

  try {
    const redirectUri =
      process.env.ZOHO_REDIRECT_URI ??
      'https://nablly-api-production.up.railway.app/zoho/callback'

    const data = await exchangeCodeForTokens(code, redirectUri)

    if (typeof data.access_token !== 'string') {
      return c.html(errorPage(`Token exchange failed:\n${JSON.stringify(data, null, 2)}`))
    }

    const refreshToken = data.refresh_token as string | undefined
    const accessToken  = data.access_token

    return c.html(successPage(refreshToken, accessToken))
  } catch (err) {
    return c.html(errorPage(String(err)))
  }
})

// ─── GET /zoho/status ────────────────────────────────────────────────────────
// Quick health check — confirms which env vars are present.

zoho.get('/status', (c) => {
  return c.json({
    configured:       isZohoConfigured(),
    orgId:            process.env.ZOHO_ORG_ID ?? '924032879',
    hasClientId:      !!process.env.ZOHO_CLIENT_ID,
    hasClientSecret:  !!process.env.ZOHO_CLIENT_SECRET,
    hasRefreshToken:  !!process.env.ZOHO_REFRESH_TOKEN,
  })
})

export default zoho

// ─── HTML helpers ────────────────────────────────────────────────────────────

function successPage(refreshToken: string | undefined, accessToken: string): string {
  const styles = `
    body { font-family: system-ui, sans-serif; max-width: 640px; margin: 60px auto; padding: 0 24px; background: #F9FAFB; }
    .card { background: #fff; border-radius: 14px; box-shadow: 0 2px 12px rgba(0,0,0,.08); padding: 32px; }
    h2 { color: #065F46; margin: 0 0 8px; font-size: 20px; }
    p  { color: #374151; font-size: 14px; line-height: 1.6; margin: 0 0 16px; }
    .token { background: #1E293B; color: #86EFAC; padding: 14px 18px; border-radius: 8px; font-family: monospace; font-size: 13px; word-break: break-all; margin: 12px 0 20px; }
    .steps { background: #F0FDF4; border: 1px solid #BBF7D0; border-radius: 10px; padding: 16px 20px; }
    .steps ol { margin: 8px 0 0; padding-left: 20px; color: #065F46; font-size: 14px; line-height: 2; }
    .note { font-size: 12px; color: #9CA3AF; margin-top: 20px; }
  `

  const refreshSection = refreshToken
    ? `
        <p>✅ <strong>Refresh token received.</strong> Copy it below and add it to Railway as <code>ZOHO_REFRESH_TOKEN</code>:</p>
        <div class="token">${refreshToken}</div>
        <div class="steps">
          <strong>Next steps:</strong>
          <ol>
            <li>Copy the token above</li>
            <li>Open your <a href="https://railway.app" target="_blank">Railway project</a> → <strong>Variables</strong></li>
            <li>Add variable: <code>ZOHO_REFRESH_TOKEN</code> = (paste token)</li>
            <li>Railway redeploys automatically — Zoho integration will be live</li>
          </ol>
        </div>
      `
    : `<p>⚠️ No refresh token returned. Make sure <code>access_type=offline</code> was included in the auth URL.</p>`

  return `<!DOCTYPE html><html><head><title>Zoho Connected</title><style>${styles}</style></head>
    <body><div class="card">
      <h2>🎉 Zoho Books Authorization Successful</h2>
      ${refreshSection}
      <p class="note">Access token (expires in 1 hour — you don't need to save this):<br/>
        <code style="font-size:11px; color:#CBD5E1">${accessToken.slice(0, 40)}…</code>
      </p>
    </div></body></html>`
}

function errorPage(message: string): string {
  return `<!DOCTYPE html><html><head><title>Zoho Error</title><style>
    body { font-family: system-ui; max-width: 560px; margin: 60px auto; padding: 0 24px; }
    .card { background: #FEF2F2; border: 1px solid #FECACA; border-radius: 12px; padding: 28px; }
    h2 { color: #B91C1C; margin: 0 0 12px; } pre { font-size: 13px; color: #7F1D1D; white-space: pre-wrap; }
  </style></head>
  <body><div class="card"><h2>❌ Zoho OAuth Error</h2><pre>${message}</pre></div></body></html>`
}
