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
);

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
);

CREATE INDEX IF NOT EXISTS analytics_events_session_idx ON analytics_events(session_id);
CREATE INDEX IF NOT EXISTS analytics_events_name_idx ON analytics_events(event_name);
CREATE INDEX IF NOT EXISTS analytics_events_route_idx ON analytics_events(route_path);
CREATE INDEX IF NOT EXISTS analytics_events_hostname_idx ON analytics_events(hostname);
CREATE INDEX IF NOT EXISTS analytics_events_occurred_idx ON analytics_events(occurred_at);
CREATE INDEX IF NOT EXISTS analytics_sessions_visitor_idx ON analytics_sessions(visitor_id);
CREATE INDEX IF NOT EXISTS analytics_sessions_stage_idx ON analytics_sessions(last_stage);
CREATE INDEX IF NOT EXISTS analytics_sessions_hostname_idx ON analytics_sessions(hostname);
