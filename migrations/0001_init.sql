-- telegram-nft-gate :: initial schema
-- NOTE: this database never stores private keys, seed phrases or signing secrets.
-- Signatures are verified in-flight and discarded; only public wallet addresses persist.

CREATE TABLE users (
  id                        TEXT PRIMARY KEY,
  telegram_user_id          TEXT NOT NULL UNIQUE,
  telegram_username         TEXT,
  wallet_address            TEXT,
  -- unverified | eligible | grace | revoked
  status                    TEXT NOT NULL DEFAULT 'unverified',
  -- true when the row was seeded by migration mode from a pre-existing group member
  is_legacy_member          INTEGER NOT NULL DEFAULT 0,
  verified_at               TEXT,
  last_ownership_check_at   TEXT,
  grace_period_started_at   TEXT,
  revoked_at                TEXT,
  created_at                TEXT NOT NULL,
  updated_at                TEXT NOT NULL
);

CREATE INDEX idx_users_status ON users (status);
CREATE INDEX idx_users_wallet ON users (wallet_address);
CREATE INDEX idx_users_recheck ON users (status, last_ownership_check_at);

-- A wallet may only be bound to one Telegram account at a time (anti-sharing).
CREATE UNIQUE INDEX idx_users_wallet_unique
  ON users (wallet_address) WHERE wallet_address IS NOT NULL;

CREATE TABLE verification_nonces (
  id                 TEXT PRIMARY KEY,
  telegram_user_id   TEXT NOT NULL,
  wallet_address     TEXT NOT NULL,
  nonce              TEXT NOT NULL UNIQUE,
  challenge          TEXT NOT NULL,
  expires_at         TEXT NOT NULL,
  used_at            TEXT,
  created_at         TEXT NOT NULL
);

CREATE INDEX idx_nonces_telegram ON verification_nonces (telegram_user_id);
CREATE INDEX idx_nonces_expires ON verification_nonces (expires_at);

CREATE TABLE verification_events (
  id                 TEXT PRIMARY KEY,
  telegram_user_id   TEXT NOT NULL,
  wallet_address     TEXT,
  event_type         TEXT NOT NULL,
  result             TEXT NOT NULL,
  reason             TEXT,
  created_at         TEXT NOT NULL
);

CREATE INDEX idx_verification_events_user ON verification_events (telegram_user_id, created_at DESC);

CREATE TABLE access_events (
  id                 TEXT PRIMARY KEY,
  telegram_user_id   TEXT NOT NULL,
  action             TEXT NOT NULL,
  previous_state     TEXT,
  new_state          TEXT,
  reason             TEXT,
  created_at         TEXT NOT NULL
);

CREATE INDEX idx_access_events_user ON access_events (telegram_user_id, created_at DESC);

CREATE TABLE admin_audit_log (
  id                    TEXT PRIMARY KEY,
  admin_telegram_id     TEXT NOT NULL,
  action                TEXT NOT NULL,
  target_telegram_id    TEXT,
  details               TEXT,
  created_at            TEXT NOT NULL
);

CREATE INDEX idx_admin_audit_created ON admin_audit_log (created_at DESC);
