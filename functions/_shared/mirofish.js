export class HttpError extends Error {
  constructor(statusCode, message) {
    super(message)
    this.statusCode = statusCode
  }
}

const sessionCookieName = 'mf_session'
const guestCookieName = 'mf_guest'
const passwordHashIterations = 100000
const schemaReady = new WeakSet()

export function jsonResponse(payload, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extraHeaders,
    },
  })
}

export function normalizeEmail(value) {
  return String(value ?? '').trim().toLowerCase()
}

export function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}

export function nowIso() {
  return new Date().toISOString()
}

export function createToken(byteLength = 32) {
  const bytes = new Uint8Array(byteLength)
  crypto.getRandomValues(bytes)
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function toBase64Url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function fromBase64Url(value) {
  const normalized = String(value ?? '').replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0))
}

function getAuthSecret(env) {
  return String(env.MIROFISH_AUTH_SECRET ?? env.AUTH_SECRET ?? env.MIROFISH_RUNTIME_API_TOKEN ?? env.RUNTIME_API_TOKEN ?? 'mirofish-dev-auth-secret')
}

export async function hashSecret(value, env) {
  const encoder = new TextEncoder()
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(`${getAuthSecret(env)}:${value}`))
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

export function getConfiguredOrigin(env) {
  return String(env.APP_ORIGIN ?? '')
    .split(',')
    .map((item) => item.trim().replace(/\/+$/, ''))
    .find(Boolean)
}

export function getRequestOrigin(request, env) {
  const configured = getConfiguredOrigin(env)
  if (configured) return configured
  return new URL(request.url).origin
}

function parseCookieHeader(value) {
  const cookies = {}
  for (const part of String(value ?? '').split(';')) {
    const index = part.indexOf('=')
    if (index <= 0) continue
    const key = part.slice(0, index).trim()
    const rawValue = part.slice(index + 1).trim()
    if (key) cookies[key] = decodeURIComponent(rawValue)
  }
  return cookies
}

export function getCookie(request, name) {
  return parseCookieHeader(request.headers.get('cookie') ?? '')[name] ?? ''
}

function secureCookiePart(request) {
  try {
    return new URL(request.url).protocol === 'https:' ? '; Secure' : ''
  } catch {
    return ''
  }
}

export function buildSessionCookie(token, request) {
  return `${sessionCookieName}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}${secureCookiePart(request)}`
}

export function buildGuestCookie(guestId, request) {
  return `${guestCookieName}=${encodeURIComponent(guestId)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 365}${secureCookiePart(request)}`
}

export function buildExpiredSessionCookie(request) {
  return `${sessionCookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secureCookiePart(request)}`
}

export function getGuestId(request) {
  const cookieGuestToken = getCookie(request, guestCookieName)
  if (cookieGuestToken) return cookieGuestToken

  const headerGuestToken =
    request.headers.get('x-mirofish-guest-token') ||
    request.headers.get('x-openclaw-guest-token') ||
    ''
  if (headerGuestToken.trim()) return headerGuestToken.trim()

  try {
    const url = new URL(request.url)
    return url.searchParams.get('guest_token') || url.searchParams.get('guest') || ''
  } catch {
    return ''
  }
}

export function getOrCreateGuestId(request) {
  return getGuestId(request) || crypto.randomUUID().replace(/-/g, '')
}

async function getTableColumns(env, tableName) {
  const result = await env.DB.prepare(`PRAGMA table_info(${tableName})`).all()
  return new Set((result.results ?? []).map((row) => row.name))
}

async function addColumnIfMissing(env, tableName, columnName, ddl) {
  const columns = await getTableColumns(env, tableName)
  if (columns.has(columnName)) return
  await env.DB.prepare(`ALTER TABLE ${tableName} ADD COLUMN ${ddl}`).run()
}

export async function ensureSchema(env) {
  if (!env.DB || schemaReady.has(env.DB)) return

  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS mf_orders (
      id TEXT PRIMARY KEY,
      order_number TEXT NOT NULL,
      plan_id TEXT NOT NULL,
      amount_cents INTEGER NOT NULL,
      currency TEXT NOT NULL DEFAULT 'USD',
      creem_checkout_id TEXT,
      payment_status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `).run()

  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS mf_instances (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL,
      status TEXT NOT NULL,
      console_url TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `).run()

  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS mf_users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      name TEXT,
      password_hash TEXT,
      role TEXT NOT NULL DEFAULT 'operator',
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_login_at TEXT
    )
  `).run()

  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS mf_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_seen_at TEXT
    )
  `).run()

  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS mf_magic_links (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      email TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      redirect_path TEXT,
      expires_at TEXT NOT NULL,
      consumed_at TEXT,
      created_at TEXT NOT NULL
    )
  `).run()

  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS mf_instance_claims (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL,
      instance_id TEXT,
      claim_token_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT,
      revoked_at TEXT,
      created_at TEXT NOT NULL
    )
  `).run()

  await addColumnIfMissing(env, 'mf_orders', 'user_id', 'user_id TEXT')
  await addColumnIfMissing(env, 'mf_orders', 'guest_id', 'guest_id TEXT')
  await addColumnIfMissing(env, 'mf_orders', 'customer_email', 'customer_email TEXT')
  await addColumnIfMissing(env, 'mf_orders', 'creem_customer_id', 'creem_customer_id TEXT')
  await addColumnIfMissing(env, 'mf_orders', 'claim_token_hash', 'claim_token_hash TEXT')
  await addColumnIfMissing(env, 'mf_orders', 'claim_expires_at', 'claim_expires_at TEXT')
  await addColumnIfMissing(env, 'mf_orders', 'paid_at', 'paid_at TEXT')
  await addColumnIfMissing(env, 'mf_users', 'name', 'name TEXT')
  await addColumnIfMissing(env, 'mf_users', 'password_hash', 'password_hash TEXT')
  await addColumnIfMissing(env, 'mf_users', 'role', "role TEXT NOT NULL DEFAULT 'operator'")
  await addColumnIfMissing(env, 'mf_users', 'status', "status TEXT NOT NULL DEFAULT 'active'")
  await addColumnIfMissing(env, 'mf_instances', 'host', 'host TEXT')
  await addColumnIfMissing(env, 'mf_instances', 'backend_port', 'backend_port INTEGER')
  await addColumnIfMissing(env, 'mf_instances', 'frontend_port', 'frontend_port INTEGER')
  await addColumnIfMissing(env, 'mf_instances', 'service_name', 'service_name TEXT')
  await addColumnIfMissing(env, 'mf_instances', 'workspace_path', 'workspace_path TEXT')
  await addColumnIfMissing(env, 'mf_instances', 'runtime_instance_id', 'runtime_instance_id TEXT')
  await addColumnIfMissing(env, 'mf_instances', 'template_version', 'template_version TEXT')
  await addColumnIfMissing(env, 'mf_instances', 'user_id', 'user_id TEXT')
  await addColumnIfMissing(env, 'mf_instances', 'guest_id', 'guest_id TEXT')

  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS mf_orders_user_id_idx ON mf_orders(user_id)`).run()
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS mf_orders_guest_id_idx ON mf_orders(guest_id)`).run()
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS mf_orders_customer_email_idx ON mf_orders(customer_email)`).run()
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS mf_orders_claim_token_hash_idx ON mf_orders(claim_token_hash)`).run()
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS mf_instances_order_id_idx ON mf_instances(order_id)`).run()
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS mf_sessions_user_id_idx ON mf_sessions(user_id)`).run()

  schemaReady.add(env.DB)
}

export async function findOrCreateUser(env, email) {
  await ensureSchema(env)
  const normalizedEmail = normalizeEmail(email)
  if (!isValidEmail(normalizedEmail)) throw new HttpError(400, 'A valid email address is required.')

  const existing = await env.DB.prepare(`SELECT * FROM mf_users WHERE email = ?`)
    .bind(normalizedEmail)
    .first()
  if (existing) return existing

  const timestamp = nowIso()
  const userId = crypto.randomUUID().replace(/-/g, '')
  await env.DB.prepare(`INSERT INTO mf_users (id, email, name, role, status, created_at, updated_at) VALUES (?, ?, ?, 'operator', 'active', ?, ?)`)
    .bind(userId, normalizedEmail, normalizedEmail.split('@')[0] || 'MiroFish User', timestamp, timestamp)
    .run()
  return await env.DB.prepare(`SELECT * FROM mf_users WHERE id = ?`)
    .bind(userId)
    .first()
}

export function normalizeName(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ')
}

export function validatePassword(password) {
  const raw = String(password ?? '')
  if (raw.length < 12 || raw.length > 128) {
    throw new HttpError(400, 'Password must be between 12 and 128 characters.')
  }
  if (!/[a-z]/.test(raw) || !/[A-Z]/.test(raw) || !/\d/.test(raw)) {
    throw new HttpError(400, 'Password must include uppercase, lowercase, and numeric characters.')
  }
}

async function derivePasswordHash(password, salt, iterations) {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    key,
    256,
  )
  return toBase64Url(new Uint8Array(bits))
}

export async function hashPassword(password) {
  validatePassword(password)
  const salt = new Uint8Array(16)
  crypto.getRandomValues(salt)
  const iterations = passwordHashIterations
  return `pbkdf2-sha256:${iterations}:${toBase64Url(salt)}:${await derivePasswordHash(password, salt, iterations)}`
}

export async function verifyPassword(password, storedHash) {
  const parts = String(storedHash ?? '').split(':')
  if (parts.length !== 4 || parts[0] !== 'pbkdf2-sha256') return false
  const iterations = Number.parseInt(parts[1], 10)
  if (!Number.isInteger(iterations) || iterations <= 0) return false
  const salt = fromBase64Url(parts[2])
  const expected = parts[3]
  const actual = await derivePasswordHash(String(password ?? ''), salt, iterations)
  if (expected.length !== actual.length) return false
  let diff = 0
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ actual.charCodeAt(i)
  }
  return diff === 0
}

export async function registerPasswordUser(env, { name, email, password }) {
  await ensureSchema(env)
  const normalizedEmail = normalizeEmail(email)
  const normalizedName = normalizeName(name)
  if (!isValidEmail(normalizedEmail)) throw new HttpError(400, 'Enter a valid email address.')
  if (normalizedName.length < 2 || normalizedName.length > 80) {
    throw new HttpError(400, 'Name must be between 2 and 80 characters.')
  }

  const passwordHash = await hashPassword(password)
  const timestamp = nowIso()
  const existing = await env.DB.prepare(`SELECT * FROM mf_users WHERE email = ?`).bind(normalizedEmail).first()

  if (existing?.password_hash) {
    throw new HttpError(409, 'An account with this email already exists.')
  }

  if (existing) {
    await env.DB.prepare(
      `UPDATE mf_users SET name = ?, password_hash = ?, status = COALESCE(NULLIF(status, ''), 'active'), role = COALESCE(NULLIF(role, ''), 'operator'), updated_at = ? WHERE id = ?`,
    )
      .bind(normalizedName, passwordHash, timestamp, existing.id)
      .run()
    return await env.DB.prepare(`SELECT * FROM mf_users WHERE id = ?`).bind(existing.id).first()
  }

  const userId = crypto.randomUUID().replace(/-/g, '')
  await env.DB.prepare(
    `INSERT INTO mf_users (id, email, name, password_hash, role, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'operator', 'active', ?, ?)`,
  )
    .bind(userId, normalizedEmail, normalizedName, passwordHash, timestamp, timestamp)
    .run()
  return await env.DB.prepare(`SELECT * FROM mf_users WHERE id = ?`).bind(userId).first()
}

export async function loginPasswordUser(env, { email, password }) {
  await ensureSchema(env)
  const normalizedEmail = normalizeEmail(email)
  const user = await env.DB.prepare(`SELECT * FROM mf_users WHERE email = ?`).bind(normalizedEmail).first()
  if (!user?.password_hash || !(await verifyPassword(password, user.password_hash))) {
    throw new HttpError(401, 'Email or password is incorrect.')
  }
  if (user.status && user.status !== 'active') {
    throw new HttpError(403, 'This account is disabled.')
  }
  return user
}

export function isAdminEmail(env, email) {
  if (!email) return false
  const allowed = String(env?.ADMIN_ALLOWED_EMAILS ?? '')
  return allowed
    .split(/[\s,;]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .includes(String(email).trim().toLowerCase())
}

export function serializeUser(user, env) {
  if (!user) return null
  return {
    id: user.id,
    email: user.email,
    name: user.name || user.email,
    role: user.role || 'operator',
    status: user.status || 'active',
    isAdmin: env ? isAdminEmail(env, user.email) : false,
    created_at: user.created_at,
    updated_at: user.updated_at,
    last_login_at: user.last_login_at,
  }
}

export async function getCurrentUser(request, env) {
  await ensureSchema(env)
  const token = getCookie(request, sessionCookieName)
  if (!token) return null

  const tokenHash = await hashSecret(token, env)
  const session = await env.DB.prepare(
    `SELECT s.id, s.user_id, s.expires_at, u.email, u.name, u.role, u.status, u.created_at, u.updated_at, u.last_login_at
     FROM mf_sessions s
     JOIN mf_users u ON u.id = s.user_id
     WHERE s.token_hash = ?`,
  )
    .bind(tokenHash)
    .first()

  if (!session) return null
  if (Date.parse(session.expires_at) <= Date.now()) return null
  if (session.status && session.status !== 'active') return null

  await env.DB.prepare(`UPDATE mf_sessions SET last_seen_at = ? WHERE id = ?`)
    .bind(nowIso(), session.id)
    .run()

  return serializeUser({
    id: session.user_id,
    email: session.email,
    name: session.name,
    role: session.role,
    status: session.status,
    created_at: session.created_at,
    updated_at: session.updated_at,
    last_login_at: session.last_login_at,
  }, env)
}

export async function createSession(env, userId) {
  await ensureSchema(env)
  const token = createToken(36)
  const tokenHash = await hashSecret(token, env)
  const timestamp = nowIso()
  const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30).toISOString()
  const sessionId = crypto.randomUUID().replace(/-/g, '')

  await env.DB.prepare(`INSERT INTO mf_sessions (id, user_id, token_hash, expires_at, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(sessionId, userId, tokenHash, expiresAt, timestamp, timestamp)
    .run()
  await env.DB.prepare(`UPDATE mf_users SET last_login_at = ?, updated_at = ? WHERE id = ?`)
    .bind(timestamp, timestamp, userId)
    .run()

  return token
}

export async function bindGuestOrdersToUser(env, { guestToken, userId }) {
  const token = String(guestToken ?? '').trim()
  if (!token || !userId) return 0
  const timestamp = nowIso()
  const result = await env.DB.prepare(
    `UPDATE mf_orders SET user_id = ?, updated_at = ? WHERE guest_id = ? AND (user_id IS NULL OR user_id = '')`,
  )
    .bind(userId, timestamp, token)
    .run()
  await env.DB.prepare(
    `UPDATE mf_instances SET user_id = ?, updated_at = ? WHERE guest_id = ? AND (user_id IS NULL OR user_id = '')`,
  )
    .bind(userId, timestamp, token)
    .run()
  return result.meta?.changes ?? result.changes ?? 0
}

export function normalizeRedirectPath(value) {
  const raw = String(value ?? '').trim()
  if (!raw || !raw.startsWith('/') || raw.startsWith('//')) return '/dashboard/'
  try {
    const url = new URL(raw, 'https://example.invalid')
    return `${url.pathname}${url.search}${url.hash}`
  } catch {
    return '/dashboard/'
  }
}

export function getCreemSettings(env) {
  const mode = String(env.CREEM_ENV ?? env.CREEM_MODE ?? '').trim().toLowerCase()
  const testApiKey = env.API_TEST_KEY ?? env.CREEM_TEST_KEY ?? ''
  const liveApiKey = env.API_PROD_KEY ?? env.CREEM_API_KEY ?? env.CREEM_KEY ?? ''
  const isTestMode =
    mode === 'test' ? true : mode === 'live' || mode === 'production' ? false : Boolean(testApiKey)
  const apiKey = isTestMode ? testApiKey : liveApiKey || testApiKey
  const baseUrl = env.CREEM_BASE_URL ?? (isTestMode ? 'https://test-api.creem.io' : 'https://api.creem.io')
  return { apiKey, baseUrl, isTestMode }
}

export async function requestJson(url, { method = 'GET', headers = {}, body } = {}) {
  const hdrs = { 'Content-Type': 'application/json', ...headers }
  const response = await fetch(url, { method, headers: hdrs, body: body ? JSON.stringify(body) : undefined })
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    const message =
      payload?.message ?? payload?.error ?? payload?.error_description ??
      payload?.details?.[0]?.description ?? `Request failed with status ${response.status}.`
    throw new HttpError(502, message)
  }
  return payload
}

export async function getCreemCheckoutSession(env, checkoutId) {
  const { apiKey, baseUrl } = getCreemSettings(env)
  if (!apiKey) throw new HttpError(503, 'Creem payment is not configured on this deployment.')
  return await requestJson(`${baseUrl}/v1/checkouts?checkout_id=${encodeURIComponent(checkoutId)}`, {
    headers: { 'x-api-key': apiKey },
  })
}

function firstString(candidates) {
  for (const candidate of candidates) {
    const value = String(candidate ?? '').trim()
    if (value) return value
  }
  return ''
}

export function getCheckoutId(payload) {
  return firstString([payload?.id, payload?.checkout_id, payload?.checkoutId])
}

export function getCheckoutUrl(payload) {
  const direct = firstString([payload?.checkout_url, payload?.checkoutUrl, payload?.url])
  if (direct) return direct
  const link = (payload?.links ?? []).find((l) => {
    const rel = String(l?.rel ?? '').toLowerCase()
    return rel === 'checkout' || rel === 'payment' || rel === 'payer-action' || rel === 'approve'
  })
  return link?.href?.trim() || null
}

export function getCheckoutRequestId(checkout) {
  return firstString([
    checkout?.request_id,
    checkout?.requestId,
    checkout?.metadata?.orderId,
    checkout?.metadata?.order_id,
    checkout?.order?.request_id,
    checkout?.order?.requestId,
  ])
}

export function getCheckoutCustomer(checkout) {
  const customer = checkout?.customer ?? checkout?.order?.customer ?? {}
  return {
    email: normalizeEmail(firstString([
      customer?.email,
      checkout?.customer_email,
      checkout?.customerEmail,
      checkout?.email,
      checkout?.metadata?.customerEmail,
    ])),
    id: firstString([
      customer?.id,
      checkout?.customer_id,
      checkout?.customerId,
      checkout?.order?.customer_id,
    ]),
  }
}

export function isCheckoutPaid(checkout) {
  const statuses = [
    checkout?.status,
    checkout?.order?.status,
    checkout?.payment?.status,
  ].map((value) => String(value ?? '').trim().toLowerCase())

  return statuses.some((status) => ['completed', 'paid', 'succeeded', 'success'].includes(status))
}

export function normalizeRuntimeBaseUrl(env) {
  return String(env.MIROFISH_RUNTIME_URL ?? env.RUNTIME_SERVER_URL ?? '').trim().replace(/\/+$/, '')
}

export function getRuntimeToken(env) {
  return String(env.MIROFISH_RUNTIME_API_TOKEN ?? env.RUNTIME_API_TOKEN ?? '').trim()
}

export function truncateError(error) {
  const message = error instanceof Error ? error.message : String(error)
  return message.length > 900 ? `${message.slice(0, 897)}...` : message
}

export async function callRuntimeCreateInstance({ env, instanceId, order, testMode = false }) {
  const runtimeUrl = normalizeRuntimeBaseUrl(env)
  const runtimeToken = getRuntimeToken(env)
  if (!runtimeUrl || !runtimeToken) throw new Error('Runtime Server is not configured.')

  const response = await fetch(`${runtimeUrl}/instances`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${runtimeToken}`,
    },
    body: JSON.stringify({
      instanceId,
      orderId: order.id,
      planId: order.plan_id,
      env: 'prod',
      testMode,
    }),
  })

  const payload = await response.json().catch(() => null)
  if (!response.ok) throw new Error(payload?.message || `Runtime Server returned HTTP ${response.status}.`)
  if (!payload?.instance) throw new Error('Runtime Server response did not include an instance.')
  return payload.instance
}

export async function updateInstanceFromRuntime(env, instanceId, runtimeInstance, timestamp = nowIso()) {
  await env.DB.prepare(
    `UPDATE mf_instances
      SET status = ?,
          console_url = ?,
          error_message = NULL,
          host = ?,
          backend_port = ?,
          frontend_port = ?,
          service_name = ?,
          workspace_path = ?,
          runtime_instance_id = ?,
          template_version = COALESCE(?, template_version),
          updated_at = ?
      WHERE id = ?`,
  )
    .bind(
      runtimeInstance.status || 'running',
      runtimeInstance.console_url || null,
      runtimeInstance.host || null,
      runtimeInstance.backend_port ?? null,
      runtimeInstance.frontend_port ?? null,
      runtimeInstance.service_name || null,
      runtimeInstance.workspace_path || null,
      runtimeInstance.id || instanceId,
      runtimeInstance.template_version || null,
      timestamp,
      instanceId,
    )
    .run()
}

async function findLatestInstance(env, orderId) {
  return await env.DB.prepare(`SELECT * FROM mf_instances WHERE order_id = ? ORDER BY created_at DESC LIMIT 1`)
    .bind(orderId)
    .first()
}

export async function provisionPaidOrder(env, order, payment = {}) {
  await ensureSchema(env)
  if (!order) throw new HttpError(404, 'Order not found.')

  const timestamp = nowIso()
  const customerEmail = normalizeEmail(payment.customerEmail || order.customer_email)
  const customerId = String(payment.customerId || order.creem_customer_id || '').trim()
  const checkoutId = String(payment.checkoutId || order.creem_checkout_id || '').trim()

  await env.DB.prepare(
    `UPDATE mf_orders
      SET payment_status = 'paid',
          creem_checkout_id = COALESCE(NULLIF(?, ''), creem_checkout_id),
          customer_email = COALESCE(NULLIF(?, ''), customer_email),
          creem_customer_id = COALESCE(NULLIF(?, ''), creem_customer_id),
          paid_at = COALESCE(paid_at, ?),
          updated_at = ?
      WHERE id = ?`,
  )
    .bind(checkoutId, customerEmail, customerId, timestamp, timestamp, order.id)
    .run()

  const freshOrder = await env.DB.prepare(`SELECT * FROM mf_orders WHERE id = ?`)
    .bind(order.id)
    .first()

  let instance = await findLatestInstance(env, order.id)
  if (instance && ['running', 'creating', 'queued'].includes(String(instance.status ?? '').toLowerCase())) {
    if (freshOrder.claim_token_hash) {
      await env.DB.prepare(`UPDATE mf_instance_claims SET instance_id = ? WHERE order_id = ? AND claim_token_hash = ?`)
        .bind(instance.id, order.id, freshOrder.claim_token_hash)
        .run()
    }
    return { order: freshOrder, instance }
  }

  const instanceId = instance?.id || crypto.randomUUID().replace(/-/g, '')
  if (instance) {
    await env.DB.prepare(
      `UPDATE mf_instances SET status = 'creating', error_message = NULL, user_id = COALESCE(user_id, ?), guest_id = COALESCE(guest_id, ?), updated_at = ? WHERE id = ?`,
    )
      .bind(freshOrder.user_id || null, freshOrder.guest_id || null, timestamp, instanceId)
      .run()
  } else {
    await env.DB.prepare(
      `INSERT INTO mf_instances (id, order_id, user_id, guest_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'creating', ?, ?)`,
    )
      .bind(instanceId, order.id, freshOrder.user_id || null, freshOrder.guest_id || null, timestamp, timestamp)
      .run()
  }

  try {
    if (freshOrder.claim_token_hash) {
      await env.DB.prepare(`UPDATE mf_instance_claims SET instance_id = ? WHERE order_id = ? AND claim_token_hash = ?`)
        .bind(instanceId, order.id, freshOrder.claim_token_hash)
        .run()
    }
    const testMode = isAdminEmail(env, freshOrder.customer_email)
    const runtimeInstance = await callRuntimeCreateInstance({ env, instanceId, order: freshOrder, testMode })
    await updateInstanceFromRuntime(env, instanceId, runtimeInstance, nowIso())
  } catch (error) {
    await env.DB.prepare(`UPDATE mf_instances SET status = 'failed', error_message = ?, updated_at = ? WHERE id = ?`)
      .bind(truncateError(error), nowIso(), instanceId)
      .run()
  }

  instance = await findLatestInstance(env, order.id)
  return { order: await env.DB.prepare(`SELECT * FROM mf_orders WHERE id = ?`).bind(order.id).first(), instance }
}

export async function findOrderByClaim(env, claimToken) {
  const claim = String(claimToken ?? '').trim()
  if (!claim) return null
  const claimHash = await hashSecret(claim, env)
  return await env.DB.prepare(`SELECT * FROM mf_orders WHERE claim_token_hash = ?`)
    .bind(claimHash)
    .first()
}

export async function assertOrderAccess({ env, request, order, claimToken = '', guestToken = '' }) {
  if (!order) throw new HttpError(404, 'Order not found.')

  const claim = String(claimToken ?? '').trim()
  if (claim && order.claim_token_hash && await hashSecret(claim, env) === order.claim_token_hash) {
    return
  }

  const user = await getCurrentUser(request, env)
  if (user && (order.user_id === user.id || normalizeEmail(order.customer_email) === user.email)) {
    return
  }

  const guestId = String(guestToken || getGuestId(request) || '').trim()
  if (guestId && order.guest_id && guestId === order.guest_id) {
    return
  }

  if (!order.user_id && !order.guest_id && !order.claim_token_hash) {
    return
  }

  throw new HttpError(403, 'Order access denied.')
}

export async function confirmCreemCheckoutAndProvision({ env, request, orderId, claimToken, guestToken, checkoutId, redirectParams = {} }) {
  await ensureSchema(env)

  let order = orderId
    ? await env.DB.prepare(`SELECT * FROM mf_orders WHERE id = ?`).bind(orderId).first()
    : null
  if (!order && claimToken) order = await findOrderByClaim(env, claimToken)
  if (!order) throw new HttpError(404, 'Order not found.')

  await assertOrderAccess({ env, request, order, claimToken, guestToken })

  const normalizedCheckoutId = firstString([
    checkoutId,
    redirectParams.checkout_id,
    redirectParams.checkoutId,
    order.creem_checkout_id,
  ])
  if (!normalizedCheckoutId) throw new HttpError(400, 'Creem checkout ID is required.')
  if (order.creem_checkout_id && order.creem_checkout_id !== normalizedCheckoutId) {
    throw new HttpError(400, 'Creem checkout does not belong to this order.')
  }

  const checkout = await getCreemCheckoutSession(env, normalizedCheckoutId)
  const checkoutRequestId = getCheckoutRequestId(checkout)
  if (checkoutRequestId && checkoutRequestId !== order.id) {
    throw new HttpError(400, 'Creem request ID does not match this order.')
  }
  if (!isCheckoutPaid(checkout)) {
    throw new HttpError(400, 'Creem checkout is not completed yet.')
  }

  const customer = getCheckoutCustomer(checkout)
  return await provisionPaidOrder(env, order, {
    checkoutId: normalizedCheckoutId,
    customerEmail: customer.email,
    customerId: customer.id,
  })
}

export async function reconcileOrderPayment(env, order) {
  if (!order || order.payment_status === 'paid' || !order.creem_checkout_id) {
    return { order, instance: order ? await findLatestInstance(env, order.id) : null }
  }

  try {
    const checkout = await getCreemCheckoutSession(env, order.creem_checkout_id)
    const checkoutRequestId = getCheckoutRequestId(checkout)
    if (checkoutRequestId && checkoutRequestId !== order.id) {
      return { order, instance: await findLatestInstance(env, order.id) }
    }
    if (!isCheckoutPaid(checkout)) {
      return { order, instance: await findLatestInstance(env, order.id) }
    }
    const customer = getCheckoutCustomer(checkout)
    return await provisionPaidOrder(env, order, {
      checkoutId: order.creem_checkout_id,
      customerEmail: customer.email,
      customerId: customer.id,
    })
  } catch {
    return { order, instance: await findLatestInstance(env, order.id) }
  }
}

export async function sendMagicLinkEmail(env, { email, magicLink, subject = 'Sign in to MiroFish', text, html }) {
  const apiKey = String(env.RESEND_API_KEY ?? env.MIROFISH_RESEND_API_KEY ?? '').trim()
  if (!apiKey) return false

  const from = String(env.MIROFISH_EMAIL_FROM ?? env.AUTH_EMAIL_FROM ?? 'MiroFish <no-reply@mirofish.best>').trim()
  const replyTo = String(env.MIROFISH_EMAIL_REPLY_TO ?? env.AUTH_EMAIL_REPLY_TO ?? '').trim()
  const payload = {
    from,
    to: [email],
    subject,
    text: text || `Open this link to sign in to MiroFish:\n\n${magicLink}\n\nThis link expires in 20 minutes.`,
    html: html || `<p>Open this link to sign in to MiroFish:</p><p><a href="${magicLink}">Sign in to MiroFish</a></p><p>This link expires in 20 minutes.</p>`,
  }
  if (replyTo) payload.reply_to = replyTo

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  })

  return response.ok
}
