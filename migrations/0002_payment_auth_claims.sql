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
);

CREATE TABLE IF NOT EXISTS mf_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT
);

CREATE TABLE IF NOT EXISTS mf_magic_links (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  email TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  redirect_path TEXT,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mf_instance_claims (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  instance_id TEXT,
  claim_token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);

ALTER TABLE mf_orders ADD COLUMN user_id TEXT;
ALTER TABLE mf_orders ADD COLUMN guest_id TEXT;
ALTER TABLE mf_orders ADD COLUMN customer_email TEXT;
ALTER TABLE mf_orders ADD COLUMN creem_customer_id TEXT;
ALTER TABLE mf_orders ADD COLUMN claim_token_hash TEXT;
ALTER TABLE mf_orders ADD COLUMN claim_expires_at TEXT;
ALTER TABLE mf_orders ADD COLUMN paid_at TEXT;
ALTER TABLE mf_instances ADD COLUMN user_id TEXT;
ALTER TABLE mf_instances ADD COLUMN guest_id TEXT;

CREATE INDEX IF NOT EXISTS mf_orders_user_id_idx ON mf_orders(user_id);
CREATE INDEX IF NOT EXISTS mf_orders_guest_id_idx ON mf_orders(guest_id);
CREATE INDEX IF NOT EXISTS mf_orders_customer_email_idx ON mf_orders(customer_email);
CREATE INDEX IF NOT EXISTS mf_orders_claim_token_hash_idx ON mf_orders(claim_token_hash);
CREATE INDEX IF NOT EXISTS mf_instances_order_id_idx ON mf_instances(order_id);
CREATE INDEX IF NOT EXISTS mf_sessions_user_id_idx ON mf_sessions(user_id);
