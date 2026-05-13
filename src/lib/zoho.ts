/**
 * Zoho Books service
 * Handles token refresh, contact sync, and invoice creation/sending.
 * Credentials read from env: ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET,
 * ZOHO_REFRESH_TOKEN, ZOHO_ORG_ID
 */

const ZOHO_AUTH_BASE = 'https://accounts.zoho.com'
const ZOHO_API_BASE  = 'https://www.zohoapis.com/books/v3'
const ORG_ID = process.env.ZOHO_ORG_ID ?? '924032879'

// In-memory access token cache (refreshed automatically when near expiry)
let cachedToken: { token: string; expiresAt: number } | null = null

export function isZohoConfigured(): boolean {
  return !!(
    process.env.ZOHO_CLIENT_ID &&
    process.env.ZOHO_CLIENT_SECRET &&
    process.env.ZOHO_REFRESH_TOKEN
  )
}

async function getAccessToken(): Promise<string> {
  // Return cached token if still valid (with 60s buffer)
  if (cachedToken && Date.now() < cachedToken.expiresAt - 60_000) {
    return cachedToken.token
  }

  const clientId     = process.env.ZOHO_CLIENT_ID
  const clientSecret = process.env.ZOHO_CLIENT_SECRET
  const refreshToken = process.env.ZOHO_REFRESH_TOKEN

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('Zoho credentials not configured. Set ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN in Railway.')
  }

  const res = await fetch(`${ZOHO_AUTH_BASE}/oauth/v2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'refresh_token',
      refresh_token: refreshToken,
      client_id:     clientId,
      client_secret: clientSecret,
    }),
  })

  const data = await res.json() as Record<string, unknown>
  if (typeof data.access_token !== 'string') {
    throw new Error(`Zoho token refresh failed: ${JSON.stringify(data)}`)
  }

  cachedToken = {
    token:     data.access_token,
    expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000,
  }

  return cachedToken.token
}

/** Exchange a one-time auth code for access + refresh tokens */
export async function exchangeCodeForTokens(code: string, redirectUri: string) {
  const res = await fetch(`${ZOHO_AUTH_BASE}/oauth/v2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      grant_type:    'authorization_code',
      client_id:     process.env.ZOHO_CLIENT_ID ?? '',
      client_secret: process.env.ZOHO_CLIENT_SECRET ?? '',
      redirect_uri:  redirectUri,
    }),
  })
  return res.json() as Promise<Record<string, unknown>>
}

// ─── HTTP helpers ────────────────────────────────────────────────────────────

async function zohoFetch(
  method: 'GET' | 'POST' | 'PUT',
  path: string,
  body?: unknown,
): Promise<Record<string, unknown>> {
  const token = await getAccessToken()
  const sep   = path.includes('?') ? '&' : '?'
  const url   = `${ZOHO_API_BASE}${path}${sep}organization_id=${ORG_ID}`

  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Zoho-oauthtoken ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })

  return res.json() as Promise<Record<string, unknown>>
}

// ─── Contacts ───────────────────────────────────────────────────────────────

export async function findOrCreateContact(client: {
  companyName:   string
  contactPerson?: string | null
  contactEmail?:  string | null
  contactNumber?: string | null
  address?:       string | null
}): Promise<string> {
  // Search for existing contact first
  const search = await zohoFetch('GET', `/contacts?search_text=${encodeURIComponent(client.companyName)}&contact_type=customer`)
  const contacts = search.contacts as Array<Record<string, unknown>> | undefined
  if (contacts && contacts.length > 0) {
    return contacts[0].contact_id as string
  }

  // Build new contact payload
  const payload: Record<string, unknown> = {
    contact_name: client.companyName,
    contact_type: 'customer',
  }

  if (client.contactPerson || client.contactEmail) {
    payload.contact_persons = [{
      first_name:           client.contactPerson ?? '',
      email:                client.contactEmail ?? '',
      phone:                client.contactNumber ?? '',
      is_primary_contact:   true,
    }]
  }

  if (client.address) {
    payload.billing_address = { address: client.address }
  }

  const result = await zohoFetch('POST', '/contacts', payload)
  const contact = result.contact as Record<string, unknown> | undefined
  if (!contact?.contact_id) {
    const message = (result.message as string) ?? JSON.stringify(result)
    const code    = result.code as number | undefined
    throw new Error(`Zoho contact creation failed [code ${code ?? '?'}]: ${message}`)
  }

  return contact.contact_id as string
}

// ─── Invoices ────────────────────────────────────────────────────────────────

export interface ZohoLineItem {
  name:        string
  description?: string
  quantity:    number
  rate:        number
}

export interface CreateZohoInvoiceResult {
  zohoInvoiceId:  string
  zohoInvoiceUrl: string
}

export async function createZohoInvoice(params: {
  contactId:    string
  invoiceNumber: string
  dueDate:      Date | null
  lineItems:    ZohoLineItem[]
  notes?:       string
}): Promise<CreateZohoInvoiceResult> {
  const body: Record<string, unknown> = {
    customer_id:    params.contactId,
    invoice_number: params.invoiceNumber,
    line_items:     params.lineItems.map(li => ({
      name:        li.name,
      description: li.description ?? '',
      quantity:    li.quantity,
      rate:        li.rate,
    })),
  }

  if (params.dueDate) {
    body.due_date = params.dueDate.toISOString().split('T')[0]
  }

  if (params.notes) body.notes = params.notes

  // ignore_auto_number_generation=true lets us supply our own invoice number
  // even when Zoho Books has auto-numbering enabled on the org.
  const result  = await zohoFetch('POST', '/invoices?ignore_auto_number_generation=true', body)
  const invoice = result.invoice as Record<string, unknown> | undefined

  if (!invoice?.invoice_id) {
    const message = (result.message as string) ?? JSON.stringify(result)
    const code    = result.code as number | undefined
    throw new Error(`Zoho invoice creation failed [code ${code ?? '?'}]: ${message}`)
  }

  return {
    zohoInvoiceId:  invoice.invoice_id as string,
    zohoInvoiceUrl: `https://books.zoho.com/app/${ORG_ID}#/invoices/${invoice.invoice_id}`,
  }
}

export async function sendZohoInvoice(
  zohoInvoiceId: string,
  toEmail:       string,
  ccEmails?:     string[],
): Promise<void> {
  const result = await zohoFetch('POST', `/invoices/${zohoInvoiceId}/email`, {
    send_from_org_email_id: false,
    to_mail_ids:            [toEmail],
    cc_mail_ids:            ccEmails ?? [],
    subject:                'Invoice from Storm Learning',
    body:                   'Please find your invoice attached.',
    send_attachment:        true,
  })

  const code = result.code as number | undefined
  if (code !== 0) {
    throw new Error(`Failed to send Zoho invoice: ${JSON.stringify(result)}`)
  }
}
