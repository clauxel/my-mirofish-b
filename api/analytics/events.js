import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'

const maxEventsPerRequest = 50
const maxMetadataLength = 4000

let pool = null
let schemaReady = false

function firstDefined(...values) {
  for (const value of values) {
    const normalized = String(value ?? '').trim()
    if (normalized) return normalized
  }

  return ''
}

function normalizeSslConfig(sslMode = '') {
  const normalized = String(sslMode ?? '').trim().toLowerCase()
  if (!normalized || normalized === 'disable') return undefined
  if (normalized === 'require' || normalized === 'prefer') return { rejectUnauthorized: false }
  return undefined
}

function buildPoolConfig(environment = process.env) {
  const rawUrl = firstDefined(
    environment.MIROFISH_ANALYTICS_DATABASE_URL,
    environment.DATABASE_URL,
    environment.POSTGRES_URL,
    environment.POSTGRES_PRISMA_URL,
  )

  if (rawUrl) {
    const parsedUrl = new URL(rawUrl)
    return {
      host: parsedUrl.hostname,
      port: Number.parseInt(parsedUrl.port || '5432', 10),
      database: decodeURIComponent(parsedUrl.pathname.replace(/^\/+/, '') || 'postgres'),
      user: decodeURIComponent(parsedUrl.username || 'postgres'),
      password: decodeURIComponent(parsedUrl.password || ''),
      ssl: normalizeSslConfig(parsedUrl.searchParams.get('sslmode') ?? ''),
      ...(parsedUrl.searchParams.get('channel_binding') === 'require' ? { enableChannelBinding: true } : {}),
    }
  }

  const host = firstDefined(environment.MIROFISH_ANALYTICS_DB_HOST, environment.PGHOST, environment.POSTGRES_HOST)
  const database = firstDefined(environment.MIROFISH_ANALYTICS_DB_NAME, environment.PGDATABASE, environment.POSTGRES_DATABASE)
  const user = firstDefined(environment.MIROFISH_ANALYTICS_DB_USER, environment.PGUSER, environment.POSTGRES_USER)
  const password = firstDefined(environment.MIROFISH_ANALYTICS_DB_PASSWORD, environment.PGPASSWORD, environment.POSTGRES_PASSWORD)

  if (!host || !database || !user || !password) {
    throw new Error('MiroFish analytics database is not configured.')
  }

  return {
    host,
    port: Number.parseInt(firstDefined(environment.MIROFISH_ANALYTICS_DB_PORT, environment.PGPORT, environment.POSTGRES_PORT, '5432'), 10),
    database,
    user,
    password,
    ssl: normalizeSslConfig(firstDefined(environment.MIROFISH_ANALYTICS_DB_SSLMODE, environment.PGSSLMODE, environment.POSTGRES_SSLMODE, 'require')),
  }
}

function getPool() {
  if (!pool) {
    pool = new Pool({
      ...buildPoolConfig(),
      max: 2,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 15_000,
    })
  }

  return pool
}

async function ensureAnalyticsSchema(client) {
  if (schemaReady) return

  await client.query(`
    CREATE TABLE IF NOT EXISTS analytics_sessions (
      id TEXT PRIMARY KEY,
      visitor_id TEXT NOT NULL,
      user_id TEXT,
      landing_path TEXT NOT NULL,
      referrer_host TEXT,
      utm_source TEXT,
      utm_medium TEXT,
      utm_campaign TEXT,
      utm_term TEXT,
      utm_content TEXT,
      device_type TEXT NOT NULL,
      browser_language TEXT,
      event_count INTEGER NOT NULL DEFAULT 0,
      click_count INTEGER NOT NULL DEFAULT 0,
      section_view_count INTEGER NOT NULL DEFAULT 0,
      page_view_count INTEGER NOT NULL DEFAULT 0,
      last_event_name TEXT,
      last_route_path TEXT,
      last_stage TEXT NOT NULL DEFAULT 'unknown',
      started_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS analytics_events (
      id TEXT PRIMARY KEY,
      visitor_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      user_id TEXT,
      order_id TEXT,
      event_type TEXT NOT NULL,
      event_name TEXT NOT NULL,
      route_path TEXT NOT NULL,
      page_key TEXT,
      section_key TEXT,
      element_key TEXT,
      referrer_host TEXT,
      metadata_json TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS analytics_sessions_started_at_idx ON analytics_sessions(started_at);
    CREATE INDEX IF NOT EXISTS analytics_sessions_last_seen_at_idx ON analytics_sessions(last_seen_at);
    CREATE INDEX IF NOT EXISTS analytics_sessions_visitor_id_idx ON analytics_sessions(visitor_id);
    CREATE INDEX IF NOT EXISTS analytics_events_session_id_idx ON analytics_events(session_id);
    CREATE INDEX IF NOT EXISTS analytics_events_occurred_at_idx ON analytics_events(occurred_at);
    CREATE INDEX IF NOT EXISTS analytics_events_event_name_idx ON analytics_events(event_name);
    CREATE INDEX IF NOT EXISTS analytics_events_route_path_idx ON analytics_events(route_path);
    CREATE INDEX IF NOT EXISTS analytics_events_element_key_idx ON analytics_events(element_key);
  `)

  schemaReady = true
}

function sanitizeIdentifier(value, maxLength = 96) {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_:/?.#-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, maxLength)

  return normalized || null
}

function sanitizePath(value) {
  const raw = String(value ?? '/').trim()
  if (!raw || raw[0] !== '/') return '/'
  return raw.slice(0, 240)
}

function sanitizeString(value, maxLength = 240) {
  const normalized = String(value ?? '').trim()
  return normalized ? normalized.slice(0, maxLength) : null
}

function sanitizeIso(value) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString()
}

function normalizeEvent(rawEvent) {
  const eventType = sanitizeIdentifier(rawEvent?.eventType, 32) || 'unknown'
  const eventName = sanitizeIdentifier(rawEvent?.eventName, 64) || 'unknown_event'
  const occurredAt = sanitizeIso(rawEvent?.occurredAt)
  let metadataJson = '{}'

  try {
    metadataJson = JSON.stringify(rawEvent?.metadata ?? {})
  } catch {}

  if (metadataJson.length > maxMetadataLength) {
    metadataJson = metadataJson.slice(0, maxMetadataLength)
  }

  return {
    id: sanitizeIdentifier(rawEvent?.id, 96) || randomUUID(),
    visitorId: sanitizeIdentifier(rawEvent?.visitorId, 96),
    sessionId: sanitizeIdentifier(rawEvent?.sessionId, 96),
    userId: sanitizeIdentifier(rawEvent?.userId, 96),
    orderId: sanitizeIdentifier(rawEvent?.orderId, 96),
    eventType,
    eventName,
    routePath: sanitizePath(rawEvent?.routePath),
    pageKey: sanitizeIdentifier(rawEvent?.pageKey, 96),
    sectionKey: sanitizeIdentifier(rawEvent?.sectionKey, 96),
    elementKey: sanitizeIdentifier(rawEvent?.elementKey, 96),
    referrerHost: sanitizeString(rawEvent?.referrerHost, 180),
    utmSource: sanitizeString(rawEvent?.utmSource, 120),
    utmMedium: sanitizeString(rawEvent?.utmMedium, 120),
    utmCampaign: sanitizeString(rawEvent?.utmCampaign, 160),
    utmTerm: sanitizeString(rawEvent?.utmTerm, 160),
    utmContent: sanitizeString(rawEvent?.utmContent, 160),
    deviceType: sanitizeIdentifier(rawEvent?.deviceType, 32) || 'desktop',
    browserLanguage: sanitizeString(rawEvent?.browserLanguage, 64),
    metadataJson,
    occurredAt,
  }
}

function resolveStage(event) {
  if (event.eventName === 'page_view' && event.routePath === '/') return 'landing_viewed'
  if (event.eventName === 'content_view' && event.sectionKey === 'pricing') return 'pricing_viewed'
  if (event.eventName === 'cta_click') return 'launch_clicked'
  if (event.eventName === 'launch_clicked') return 'launch_clicked'
  if (event.eventName === 'plan_selected') return 'plan_selected'
  if (event.eventName === 'checkout_started') return 'checkout_started'
  if (event.eventName === 'checkout_redirected') return 'checkout_redirected'
  if (event.eventName === 'payment_completed') return 'payment_completed'
  if (event.routePath.startsWith('/demo') || event.routePath.startsWith('/app')) return 'console_viewed'
  return 'unknown'
}

function pickHigherStage(currentStage, nextStage) {
  const order = [
    'unknown',
    'landing_viewed',
    'pricing_viewed',
    'launch_clicked',
    'plan_selected',
    'checkout_started',
    'checkout_redirected',
    'payment_completed',
    'console_viewed',
  ]
  return order.indexOf(nextStage) > order.indexOf(currentStage) ? nextStage : currentStage
}

async function upsertSession(client, event) {
  const stage = resolveStage(event)
  const existing = await client.query('SELECT * FROM analytics_sessions WHERE id = $1', [event.sessionId])

  if (existing.rows[0]) {
    const currentStage = existing.rows[0].last_stage || 'unknown'
    await client.query(
      `UPDATE analytics_sessions
       SET event_count = event_count + 1,
           click_count = click_count + $2,
           section_view_count = section_view_count + $3,
           page_view_count = page_view_count + $4,
           last_event_name = $5,
           last_route_path = $6,
           last_stage = $7,
           last_seen_at = $8,
           updated_at = $9
       WHERE id = $1`,
      [
        event.sessionId,
        event.eventType === 'click' ? 1 : 0,
        event.eventName === 'content_view' ? 1 : 0,
        event.eventName === 'page_view' ? 1 : 0,
        event.eventName,
        event.routePath,
        pickHigherStage(currentStage, stage),
        event.occurredAt,
        new Date().toISOString(),
      ],
    )
    return
  }

  await client.query(
    `INSERT INTO analytics_sessions (
      id, visitor_id, user_id, landing_path, referrer_host, utm_source, utm_medium,
      utm_campaign, utm_term, utm_content, device_type, browser_language,
      event_count, click_count, section_view_count, page_view_count,
      last_event_name, last_route_path, last_stage, started_at, last_seen_at,
      created_at, updated_at
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7,
      $8, $9, $10, $11, $12,
      1, $13, $14, $15,
      $16, $17, $18, $19, $20,
      $21, $22
    )`,
    [
      event.sessionId,
      event.visitorId,
      event.userId,
      event.routePath,
      event.referrerHost,
      event.utmSource,
      event.utmMedium,
      event.utmCampaign,
      event.utmTerm,
      event.utmContent,
      event.deviceType,
      event.browserLanguage,
      event.eventType === 'click' ? 1 : 0,
      event.eventName === 'content_view' ? 1 : 0,
      event.eventName === 'page_view' ? 1 : 0,
      event.eventName,
      event.routePath,
      stage,
      event.occurredAt,
      event.occurredAt,
      new Date().toISOString(),
      new Date().toISOString(),
    ],
  )
}

async function ingestEvents(rawEvents) {
  const events = rawEvents
    .slice(0, maxEventsPerRequest)
    .map(normalizeEvent)
    .filter((event) => event.visitorId && event.sessionId)

  const client = await getPool().connect()
  try {
    await ensureAnalyticsSchema(client)
    await client.query('BEGIN')

    for (const event of events) {
      const inserted = await client.query(
        `INSERT INTO analytics_events (
          id, visitor_id, session_id, user_id, order_id, event_type, event_name,
          route_path, page_key, section_key, element_key, referrer_host,
          metadata_json, occurred_at, created_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7,
          $8, $9, $10, $11, $12,
          $13, $14, $15
        )
        ON CONFLICT (id) DO NOTHING`,
        [
          event.id,
          event.visitorId,
          event.sessionId,
          event.userId,
          event.orderId,
          event.eventType,
          event.eventName,
          event.routePath,
          event.pageKey,
          event.sectionKey,
          event.elementKey,
          event.referrerHost,
          event.metadataJson,
          event.occurredAt,
          new Date().toISOString(),
        ],
      )
      if (inserted.rowCount > 0) {
        await upsertSession(client, event)
      }
    }

    await client.query('COMMIT')
    return events.length
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

export default async function handler(request, response) {
  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST')
    response.status(405).json({ message: 'Method not allowed.' })
    return
  }

  try {
    const body = typeof request.body === 'string' ? JSON.parse(request.body || '{}') : request.body || {}
    const events = Array.isArray(body.events) ? body.events : []
    const ingested = await ingestEvents(events)
    response.status(202).json({ message: 'Analytics events accepted.', ingested })
  } catch (error) {
    response.status(400).json({
      message: error instanceof Error ? error.message : 'Invalid analytics request.',
    })
  }
}
