-- FriendSplit – Update auf Version 2 (Benutzerkonten) für SQLite. Siehe update-2.mysql.sql.

CREATE TABLE IF NOT EXISTS fs_users (
  id            TEXT NOT NULL PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL,
  email         TEXT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'member',
  status        TEXT NOT NULL DEFAULT 'active',
  created_at    TEXT NOT NULL,
  last_login_at TEXT NULL
);

CREATE TABLE IF NOT EXISTS fs_sessions (
  id           TEXT    NOT NULL PRIMARY KEY,
  user_id      TEXT    NOT NULL REFERENCES fs_users (id) ON DELETE CASCADE,
  token_hash   TEXT    NOT NULL UNIQUE,
  remember     INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT    NOT NULL,
  last_seen_at TEXT    NOT NULL,
  expires_at   TEXT    NOT NULL,
  user_agent   TEXT    NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON fs_sessions (user_id);

CREATE TABLE IF NOT EXISTS fs_tokens (
  id         TEXT    NOT NULL PRIMARY KEY,
  kind       TEXT    NOT NULL,
  token_hash TEXT    NOT NULL UNIQUE,
  user_id    TEXT    NULL REFERENCES fs_users (id) ON DELETE CASCADE,
  created_by TEXT    NULL,
  note       TEXT    NULL,
  max_uses   INTEGER NOT NULL DEFAULT 1,
  uses       INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT    NOT NULL,
  created_at TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS fs_login_attempts (
  id           TEXT NOT NULL PRIMARY KEY,
  username     TEXT NOT NULL,
  ip_hash      TEXT NOT NULL,
  attempted_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attempts_user ON fs_login_attempts (username, attempted_at);
CREATE INDEX IF NOT EXISTS idx_attempts_ip ON fs_login_attempts (ip_hash, attempted_at);

ALTER TABLE fs_event_participants ADD COLUMN user_id TEXT NULL REFERENCES fs_users (id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_participants_user ON fs_event_participants (event_id, user_id);

ALTER TABLE fs_events ADD COLUMN owner_user_id TEXT NULL;
