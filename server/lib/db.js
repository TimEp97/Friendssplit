// Datenbank: SQLite über das in Node.js eingebaute Modul node:sqlite – keine Zusatzpakete.
// Alle Abfragen laufen mit vorbereiteten Statements (Platzhalter ?), nie mit zusammengesetztem SQL aus Eingaben.

import { DatabaseSync } from 'node:sqlite';
import { randomInt } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/** Schema-Versionen. Jede neue Version bekommt einen weiteren Eintrag; bestehende nie ändern. */
const MIGRATIONS = [
  // Version 1: Events, Ausgaben, Zahlungen, Verlauf und Benutzerkonten
  `
  CREATE TABLE fs_users (
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

  CREATE TABLE fs_sessions (
    id           TEXT    NOT NULL PRIMARY KEY,
    user_id      TEXT    NOT NULL REFERENCES fs_users (id) ON DELETE CASCADE,
    token_hash   TEXT    NOT NULL UNIQUE,
    remember     INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT    NOT NULL,
    last_seen_at TEXT    NOT NULL,
    expires_at   TEXT    NOT NULL,
    user_agent   TEXT    NULL
  );
  CREATE INDEX idx_sessions_user ON fs_sessions (user_id);

  -- Einladungen (kind = 'invite') und Links zum Zurücksetzen des Passworts (kind = 'reset')
  CREATE TABLE fs_tokens (
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

  CREATE TABLE fs_login_attempts (
    id           TEXT NOT NULL PRIMARY KEY,
    username     TEXT NOT NULL,
    ip_hash      TEXT NOT NULL,
    attempted_at TEXT NOT NULL
  );
  CREATE INDEX idx_attempts_user ON fs_login_attempts (username, attempted_at);
  CREATE INDEX idx_attempts_ip ON fs_login_attempts (ip_hash, attempted_at);

  CREATE TABLE fs_events (
    id                   TEXT NOT NULL PRIMARY KEY,
    access_code          TEXT NOT NULL UNIQUE,
    name                 TEXT NOT NULL,
    event_date           TEXT NULL,
    location             TEXT NULL,
    notes                TEXT NULL,
    created_by_person_id TEXT NULL,
    created_at           TEXT NOT NULL,
    updated_at           TEXT NOT NULL,
    owner_user_id        TEXT NULL
  );

  CREATE TABLE fs_persons (
    id           TEXT NOT NULL PRIMARY KEY,
    display_name TEXT NOT NULL,
    auth_user_id TEXT NULL,
    created_at   TEXT NOT NULL
  );

  CREATE TABLE fs_event_participants (
    event_id  TEXT    NOT NULL REFERENCES fs_events (id) ON DELETE CASCADE,
    person_id TEXT    NOT NULL REFERENCES fs_persons (id) ON DELETE CASCADE,
    role      TEXT    NOT NULL DEFAULT 'member',
    position  INTEGER NOT NULL DEFAULT 0,
    joined_at TEXT    NOT NULL,
    user_id   TEXT    NULL REFERENCES fs_users (id) ON DELETE SET NULL,
    PRIMARY KEY (event_id, person_id)
  );
  CREATE UNIQUE INDEX uq_participants_user ON fs_event_participants (event_id, user_id);

  CREATE TABLE fs_expenses (
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
  CREATE INDEX idx_expenses_event ON fs_expenses (event_id, spent_at);

  CREATE TABLE fs_expense_shares (
    expense_id  TEXT    NOT NULL REFERENCES fs_expenses (id) ON DELETE CASCADE,
    person_id   TEXT    NOT NULL REFERENCES fs_persons (id),
    share_cents INTEGER NOT NULL,
    PRIMARY KEY (expense_id, person_id)
  );

  CREATE TABLE fs_settlements (
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
  CREATE INDEX idx_settlements_event ON fs_settlements (event_id);

  CREATE TABLE fs_activity (
    id         TEXT NOT NULL PRIMARY KEY,
    event_id   TEXT NOT NULL REFERENCES fs_events (id) ON DELETE CASCADE,
    person_id  TEXT NULL,
    action     TEXT NOT NULL,
    summary    TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_activity_event ON fs_activity (event_id, created_at);
  `,
];

export const SCHEMA_VERSION = MIGRATIONS.length;

export class Database {
  /** @param {string} file Pfad zur SQLite-Datei oder ':memory:' */
  constructor(file) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.statements = new Map();
    this.depth = 0;
    this.migrate();
  }

  /** Vorbereitetes Statement (zwischengespeichert). */
  statement(sql) {
    let stmt = this.statements.get(sql);
    if (!stmt) {
      stmt = this.db.prepare(sql);
      this.statements.set(sql, stmt);
    }
    return stmt;
  }

  run(sql, ...params) { return this.statement(sql).run(...params.map(bind)); }
  get(sql, ...params) { return this.statement(sql).get(...params.map(bind)) ?? null; }
  all(sql, ...params) { return this.statement(sql).all(...params.map(bind)); }

  /** Erster Wert der ersten Zeile (oder null). */
  value(sql, ...params) {
    const row = this.get(sql, ...params);
    return row === null ? null : Object.values(row)[0];
  }

  /**
   * Führt fn in einer Transaktion aus. BEGIN IMMEDIATE sperrt die Datenbank zum Schreiben, sodass
   * Änderungen nacheinander ablaufen. Verschachtelte Aufrufe laufen in der äußeren Transaktion mit.
   */
  transaction(fn) {
    if (this.depth > 0) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    this.depth++;
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    } finally {
      this.depth--;
    }
  }

  version() {
    return this.get('PRAGMA user_version').user_version;
  }

  migrate() {
    for (let v = this.version(); v < MIGRATIONS.length; v++) {
      this.transaction(() => {
        this.db.exec(MIGRATIONS[v]);
        this.db.exec(`PRAGMA user_version = ${v + 1}`);
      });
    }
  }

  /** Konsistente Sicherungskopie der laufenden Datenbank in eine neue Datei. */
  backup(target) {
    this.statement('VACUUM INTO ?').run(target);
  }

  close() {
    this.db.close();
  }
}

/** node:sqlite kennt weder true/false noch undefined als Parameter. */
function bind(value) {
  if (value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value;
}

/** Aktueller Zeitpunkt in UTC als 'YYYY-MM-DD HH:MM:SS' (sortierbar). */
export function now() {
  return at(0);
}

/** UTC-Zeitpunkt relativ zu jetzt, z. B. at(14 * DAY). */
export function at(offsetMs) {
  return new Date(Date.now() + offsetMs).toISOString().slice(0, 19).replace('T', ' ');
}

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** 'YYYY-MM-DD HH:MM:SS' → 'YYYY-MM-DDTHH:MM:SSZ' */
export function isoUtc(dbValue) {
  return `${String(dbValue).slice(0, 19).replace(' ', 'T')}Z`;
}

/**
 * Zufällige ID aus 16 Zeichen [a-z0-9], beginnend mit einem Buchstaben (damit sie nie als Zahl
 * missverstanden wird).
 */
export function newId() {
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  const chars = `${letters}0123456789`;
  let id = letters[randomInt(26)];
  for (let i = 1; i < 16; i++) id += chars[randomInt(36)];
  return id;
}

let lastMicros = 0;
/** Zeitlich sortierbare ID (Mikrosekunden in Base36 + Zufall) für den Verlauf. */
export function sortableId() {
  lastMicros = Math.max(Date.now() * 1000, lastMicros + 1);
  return lastMicros.toString(36).padStart(11, '0') + newId().slice(0, 5);
}
