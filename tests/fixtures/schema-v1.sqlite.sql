-- FriendSplit – Datenbankschema für SQLite (lokale Entwicklung und Tests).
-- Inhaltlich identisch zu mysql.sql.

CREATE TABLE IF NOT EXISTS fs_events (
  id                   TEXT    NOT NULL PRIMARY KEY,
  access_code          TEXT    NOT NULL UNIQUE,
  name                 TEXT    NOT NULL,
  event_date           TEXT    NULL,
  location             TEXT    NULL,
  notes                TEXT    NULL,
  created_by_person_id TEXT    NULL,
  created_at           TEXT    NOT NULL,
  updated_at           TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS fs_persons (
  id           TEXT NOT NULL PRIMARY KEY,
  display_name TEXT NOT NULL,
  auth_user_id TEXT NULL,
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS fs_event_participants (
  event_id  TEXT    NOT NULL REFERENCES fs_events (id) ON DELETE CASCADE,
  person_id TEXT    NOT NULL REFERENCES fs_persons (id) ON DELETE CASCADE,
  role      TEXT    NOT NULL DEFAULT 'member',
  position  INTEGER NOT NULL DEFAULT 0,
  joined_at TEXT    NOT NULL,
  PRIMARY KEY (event_id, person_id)
);

CREATE TABLE IF NOT EXISTS fs_expenses (
  id                   TEXT    NOT NULL PRIMARY KEY,
  event_id             TEXT    NOT NULL REFERENCES fs_events (id) ON DELETE CASCADE,
  description          TEXT    NOT NULL,
  amount_cents         INTEGER NOT NULL CHECK (amount_cents > 0),
  category             TEXT    NOT NULL,
  icon                 TEXT    NOT NULL,
  paid_by_person_id    TEXT    NOT NULL REFERENCES fs_persons (id),
  spent_at             TEXT    NOT NULL,
  notes                TEXT    NULL,
  client_token         TEXT    NULL,
  version              INTEGER NOT NULL DEFAULT 1,
  created_by_person_id TEXT    NULL,
  updated_by_person_id TEXT    NULL,
  created_at           TEXT    NOT NULL,
  updated_at           TEXT    NOT NULL,
  UNIQUE (event_id, client_token)
);
CREATE INDEX IF NOT EXISTS idx_expenses_event ON fs_expenses (event_id, spent_at);

CREATE TABLE IF NOT EXISTS fs_expense_shares (
  expense_id  TEXT    NOT NULL REFERENCES fs_expenses (id) ON DELETE CASCADE,
  person_id   TEXT    NOT NULL REFERENCES fs_persons (id),
  share_cents INTEGER NOT NULL,
  PRIMARY KEY (expense_id, person_id)
);

CREATE TABLE IF NOT EXISTS fs_settlements (
  id                   TEXT    NOT NULL PRIMARY KEY,
  event_id             TEXT    NOT NULL REFERENCES fs_events (id) ON DELETE CASCADE,
  from_person_id       TEXT    NOT NULL REFERENCES fs_persons (id),
  to_person_id         TEXT    NOT NULL REFERENCES fs_persons (id),
  amount_cents         INTEGER NOT NULL CHECK (amount_cents > 0),
  status               TEXT    NOT NULL DEFAULT 'erledigt',
  paid_at              TEXT    NULL,
  created_by_person_id TEXT    NULL,
  created_at           TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_settlements_event ON fs_settlements (event_id);

CREATE TABLE IF NOT EXISTS fs_activity (
  id         TEXT NOT NULL PRIMARY KEY,
  event_id   TEXT NOT NULL REFERENCES fs_events (id) ON DELETE CASCADE,
  person_id  TEXT NULL,
  action     TEXT NOT NULL,
  summary    TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_activity_event ON fs_activity (event_id, created_at);
