const maxEventsPerRequest = 50
const maxMetadataLength = 4000
const analyticsSchemaReady = new WeakSet()

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

async function getTableColumns(db, tableName) {
  const result = await db.prepare(`PRAGMA table_info(${tableName})`).all()
  return new Set((result.results ?? []).map((row) => row.name))
}

async function addColumnIfMissing(db, tableName, columnName, ddl) {
  const columns = await getTableColumns(db, tableName)
  if (columns.has(columnName)) return
  await db.prepare(`ALTER TABLE ${tableName} ADD COLUMN ${ddl}`).run()
}

async function ensureAnalyticsSchema(db) {
  if (!db || analyticsSchemaReady.has(db)) return

  await db.prepare(`
    CREATE TABLE IF NOT EXISTS analytics_events (
      id TEXT PRIMARY KEY,
      visitor_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      user_id TEXT,
      order_id TEXT,
      event_type TEXT NOT NULL,
      event_name TEXT NOT NULL,
      hostname TEXT,
      route_path TEXT NOT NULL,
      page_key TEXT,
      section_key TEXT,
      element_key TEXT,
      referrer_host TEXT,
      utm_source TEXT,
      utm_medium TEXT,
      utm_campaign TEXT,
      utm_term TEXT,
      utm_content TEXT,
      device_type TEXT,
      browser_language TEXT,
      metadata_json TEXT,
      occurred_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `).run()

  await db.prepare(`
    CREATE TABLE IF NOT EXISTS analytics_sessions (
      id TEXT PRIMARY KEY,
      visitor_id TEXT NOT NULL,
      user_id TEXT,
      hostname TEXT,
      landing_path TEXT,
      referrer_host TEXT,
      utm_source TEXT,
      utm_medium TEXT,
      utm_campaign TEXT,
      utm_term TEXT,
      utm_content TEXT,
      device_type TEXT,
      browser_language TEXT,
      event_count INTEGER NOT NULL DEFAULT 0,
      click_count INTEGER NOT NULL DEFAULT 0,
      section_view_count INTEGER NOT NULL DEFAULT 0,
      page_view_count INTEGER NOT NULL DEFAULT 0,
      last_event_name TEXT,
      last_route_path TEXT,
      last_stage TEXT,
      started_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `).run()

  await addColumnIfMissing(db, 'analytics_events', 'hostname', 'hostname TEXT')
  await addColumnIfMissing(db, 'analytics_events', 'utm_source', 'utm_source TEXT')
  await addColumnIfMissing(db, 'analytics_events', 'utm_medium', 'utm_medium TEXT')
  await addColumnIfMissing(db, 'analytics_events', 'utm_campaign', 'utm_campaign TEXT')
  await addColumnIfMissing(db, 'analytics_events', 'utm_term', 'utm_term TEXT')
  await addColumnIfMissing(db, 'analytics_events', 'utm_content', 'utm_content TEXT')
  await addColumnIfMissing(db, 'analytics_events', 'device_type', 'device_type TEXT')
  await addColumnIfMissing(db, 'analytics_events', 'browser_language', 'browser_language TEXT')
  await addColumnIfMissing(db, 'analytics_sessions', 'hostname', 'hostname TEXT')

  await db.prepare('CREATE INDEX IF NOT EXISTS analytics_events_session_idx ON analytics_events(session_id)').run()
  await db.prepare('CREATE INDEX IF NOT EXISTS analytics_events_name_idx ON analytics_events(event_name)').run()
  await db.prepare('CREATE INDEX IF NOT EXISTS analytics_events_route_idx ON analytics_events(route_path)').run()
  await db.prepare('CREATE INDEX IF NOT EXISTS analytics_events_hostname_idx ON analytics_events(hostname)').run()
  await db.prepare('CREATE INDEX IF NOT EXISTS analytics_events_occurred_idx ON analytics_events(occurred_at)').run()
  await db.prepare('CREATE INDEX IF NOT EXISTS analytics_sessions_visitor_idx ON analytics_sessions(visitor_id)').run()
  await db.prepare('CREATE INDEX IF NOT EXISTS analytics_sessions_stage_idx ON analytics_sessions(last_stage)').run()
  await db.prepare('CREATE INDEX IF NOT EXISTS analytics_sessions_hostname_idx ON analytics_sessions(hostname)').run()

  analyticsSchemaReady.add(db)
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
    id: sanitizeIdentifier(rawEvent?.id, 96) || crypto.randomUUID(),
    visitorId: sanitizeIdentifier(rawEvent?.visitorId, 96),
    sessionId: sanitizeIdentifier(rawEvent?.sessionId, 96),
    userId: sanitizeIdentifier(rawEvent?.userId, 96),
    orderId: sanitizeIdentifier(rawEvent?.orderId, 96),
    eventType,
    eventName,
    hostname: sanitizeString(rawEvent?.hostname, 180),
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
  const pathOnly = event.routePath.split('?')[0] || '/'
  if (event.eventName === 'page_view' && pathOnly === '/') return 'landing_viewed'
  if (event.eventName === 'page_view' && pathOnly.startsWith('/checkout')) return 'checkout_viewed'
  if (event.eventName === 'content_view' && event.sectionKey === 'pricing') return 'pricing_viewed'
  if (event.eventName === 'cta_click' || event.eventName === 'launch_clicked') return 'launch_clicked'
  if (event.eventName === 'plan_selected') return 'plan_selected'
  if (event.eventName === 'checkout_started') return 'checkout_started'
  if (event.eventName === 'checkout_redirected') return 'checkout_redirected'
  if (event.eventName === 'checkout_start_failed') return 'checkout_start_failed'
  if (event.eventName === 'payment_completed') return 'payment_completed'
  if (pathOnly.startsWith('/console') || pathOnly.startsWith('/dashboard')) return 'console_viewed'
  return 'unknown'
}

function pickHigherStage(currentStage, nextStage) {
  const order = [
    'unknown', 'landing_viewed', 'pricing_viewed', 'launch_clicked',
    'plan_selected', 'checkout_viewed', 'checkout_started', 'checkout_redirected',
    'checkout_start_failed', 'payment_completed', 'console_viewed',
  ]
  return order.indexOf(nextStage) > order.indexOf(currentStage) ? nextStage : currentStage
}

async function upsertSession(db, event) {
  const stage = resolveStage(event)
  const now = new Date().toISOString()

  const existing = await db
    .prepare('SELECT last_stage FROM analytics_sessions WHERE id = ?')
    .bind(event.sessionId)
    .first()

  if (existing) {
    const higherStage = pickHigherStage(existing.last_stage || 'unknown', stage)
    await db
      .prepare(
        `UPDATE analytics_sessions
         SET event_count = event_count + 1,
             click_count = click_count + ?,
             section_view_count = section_view_count + ?,
             page_view_count = page_view_count + ?,
             last_event_name = ?,
             last_route_path = ?,
             last_stage = ?,
             last_seen_at = ?,
             updated_at = ?
         WHERE id = ?`,
      )
      .bind(
        event.eventType === 'click' ? 1 : 0,
        event.eventName === 'content_view' ? 1 : 0,
        event.eventName === 'page_view' ? 1 : 0,
        event.eventName,
        event.routePath,
        higherStage,
        event.occurredAt,
        now,
        event.sessionId,
      )
      .run()
    return
  }

  await db
    .prepare(
      `INSERT INTO analytics_sessions (
        id, visitor_id, user_id, hostname, landing_path, referrer_host, utm_source, utm_medium,
        utm_campaign, utm_term, utm_content, device_type, browser_language,
        event_count, click_count, section_view_count, page_view_count,
        last_event_name, last_route_path, last_stage, started_at, last_seen_at,
        created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        1, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?
      )`,
    )
    .bind(
      event.sessionId,
      event.visitorId,
      event.userId,
      event.hostname,
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
      now,
      now,
    )
    .run()
}

async function ingestEvents(db, rawEvents) {
  await ensureAnalyticsSchema(db)

  const events = rawEvents
    .slice(0, maxEventsPerRequest)
    .map(normalizeEvent)
    .filter((event) => event.visitorId && event.sessionId)

  let ingested = 0

  for (const event of events) {
    const result = await db
      .prepare(
        `INSERT OR IGNORE INTO analytics_events (
          id, visitor_id, session_id, user_id, order_id, event_type, event_name,
          hostname, route_path, page_key, section_key, element_key, referrer_host,
          utm_source, utm_medium, utm_campaign, utm_term, utm_content, device_type, browser_language,
          metadata_json, occurred_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        event.id,
        event.visitorId,
        event.sessionId,
        event.userId,
        event.orderId,
        event.eventType,
        event.eventName,
        event.hostname,
        event.routePath,
        event.pageKey,
        event.sectionKey,
        event.elementKey,
        event.referrerHost,
        event.utmSource,
        event.utmMedium,
        event.utmCampaign,
        event.utmTerm,
        event.utmContent,
        event.deviceType,
        event.browserLanguage,
        event.metadataJson,
        event.occurredAt,
        new Date().toISOString(),
      )
      .run()

    if ((result.meta?.changes ?? result.changes ?? 0) > 0) {
      await upsertSession(db, event)
      ingested++
    }
  }

  return ingested
}

export async function onRequest(context) {
  const { request, env } = context

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
    })
  }

  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ message: 'Method not allowed.' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json', Allow: 'POST' },
    })
  }

  try {
    const body = await request.json()
    const events = Array.isArray(body.events) ? body.events : []
    const ingested = await ingestEvents(env.DB, events)
    return new Response(JSON.stringify({ message: 'Analytics events accepted.', ingested }), {
      status: 202,
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (error) {
    return new Response(
      JSON.stringify({ message: error instanceof Error ? error.message : 'Invalid analytics request.' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    )
  }
}
