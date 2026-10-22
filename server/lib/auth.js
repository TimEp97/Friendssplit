// Benutzerkonten: Anmeldung mit Benutzername und Passwort, Sitzungen per Cookie (in der Datenbank
// nur als Hash gespeichert), Registrierung nur mit Einladung, Admin-Funktionen.
// Konten sind optional – Events funktionieren weiterhin auch nur mit dem Zugangscode.

import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { ApiError } from './errors.js';
import { newId, now, at, isoUtc, MINUTE, HOUR, DAY } from './db.js';
import { normalizeCode, randomCode } from './store.js';

export const COOKIE = 'fs_session';
const REMEMBER_DAYS = 90;
const SHORT_HOURS = 12;
const MIN_PASSWORD = 10;
const MAX_FAILS_PER_USER = 5;
const MAX_FAILS_PER_IP = 20;
const FAIL_WINDOW = 15 * MINUTE;
const COMMON_PASSWORDS = new Set([
  '1234567890', '12345678910', '0123456789', '1111111111', 'passwort123', 'password123', 'passwort1234',
  'password1234', 'qwertzuiop', 'qwertyuiop', 'hallo12345', 'iloveyou12', 'friendsplit', 'friendsplit1',
]);

// scrypt: speicherintensives Passwort-Hashing aus dem Node-Kryptomodul (keine Zusatzpakete).
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEY_LENGTH = 32;

export function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password.normalize('NFC'), salt, KEY_LENGTH, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  const parts = String(stored).split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, salt, expected] = parts;
  const expectedBytes = Buffer.from(expected, 'base64');
  const actual = scryptSync(password.normalize('NFC'), Buffer.from(salt, 'base64'), expectedBytes.length, {
    N: Number(N), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem,
  });
  return timingSafeEqual(actual, expectedBytes);
}

const needsRehash = (stored) => !String(stored).startsWith(`scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$`);
// Wird bei unbekanntem Benutzernamen geprüft, damit die Antwortzeit nichts verrät.
const DUMMY_HASH = hashPassword(randomBytes(16).toString('hex'));
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

export function publicUser(user) {
  return user ? { id: user.id, username: user.username, display_name: user.display_name, role: user.role } : null;
}

/**
 * Konto-Funktionen für genau eine Anfrage.
 * @param {import('./db.js').Database} db
 * @param {{requireHttps: boolean, setupKey: string}} config
 * @param {{cookies: Record<string,string>, https: boolean, ip: string, userAgent: string, setCookie: Function}} request
 */
export class Auth {
  constructor(db, config, request) {
    this.db = db;
    this.config = config;
    this.request = request;
    this.user = null;
    this.sessionId = null;
  }

  // ------------------------------------------------------------------ Sitzung

  /** Ermittelt das angemeldete Konto aus dem Sitzungs-Cookie (oder null). */
  resolve() {
    const token = this.request.cookies[COOKIE];
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return null;
    const row = this.db.get(
      `SELECT s.id AS session_id, s.remember, s.last_seen_at, s.expires_at, u.*
       FROM fs_sessions s JOIN fs_users u ON u.id = s.user_id WHERE s.token_hash = ?`,
      sha256(token),
    );
    const timestamp = now();
    if (!row || row.expires_at <= timestamp || row.status !== 'active') {
      if (row) this.db.run('DELETE FROM fs_sessions WHERE id = ?', row.session_id);
      this.request.setCookie(COOKIE, null);
      return null;
    }
    // Gleitende Gültigkeit: höchstens einmal pro Stunde in die Datenbank schreiben.
    if (row.last_seen_at <= at(-HOUR)) {
      const remember = row.remember === 1;
      this.db.run('UPDATE fs_sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?', timestamp, sessionExpiry(remember), row.session_id);
      if (remember) this.request.setCookie(COOKIE, token, REMEMBER_DAYS * 86400);
    }
    this.sessionId = row.session_id;
    this.user = row;
    return row;
  }

  requireUser() {
    if (!this.user) throw new ApiError(401, 'login_required', 'Bitte melde dich an.');
    return this.user;
  }

  requireAdmin() {
    const user = this.requireUser();
    if (user.role !== 'admin') throw new ApiError(403, 'forbidden', 'Dafür brauchst du Admin-Rechte.');
    return user;
  }

  needsSetup() {
    return this.db.value('SELECT COUNT(*) AS n FROM fs_users') === 0;
  }

  // ------------------------------------------------------------------ Anmelden, Registrieren

  login(input) {
    this.assertHttps();
    const username = normalizeUsername(input.username);
    const password = typeof input.password === 'string' ? input.password : '';
    if (username === '' || password === '') {
      const fields = {};
      if (username === '') fields.username = 'Bitte gib deinen Benutzernamen ein.';
      if (password === '') fields.password = 'Bitte gib dein Passwort ein.';
      throw ApiError.validation(fields);
    }

    const ipHash = sha256(this.request.ip);
    this.db.run('DELETE FROM fs_login_attempts WHERE attempted_at < ?', at(-DAY));
    const since = at(-FAIL_WINDOW);
    const byUser = this.db.value('SELECT COUNT(*) AS n FROM fs_login_attempts WHERE username = ? AND attempted_at > ?', username, since);
    const byIp = this.db.value('SELECT COUNT(*) AS n FROM fs_login_attempts WHERE ip_hash = ? AND attempted_at > ?', ipHash, since);
    if (byUser >= MAX_FAILS_PER_USER || byIp >= MAX_FAILS_PER_IP) {
      throw new ApiError(429, 'too_many_attempts', 'Zu viele fehlgeschlagene Anmeldungen. Bitte warte 15 Minuten und versuche es dann erneut.');
    }

    const user = this.findUser('username', username);
    const valid = verifyPassword(password, user?.password_hash ?? DUMMY_HASH);
    if (!user || !valid) {
      this.db.run('INSERT INTO fs_login_attempts (id, username, ip_hash, attempted_at) VALUES (?, ?, ?, ?)', newId(), username, ipHash, now());
      throw new ApiError(401, 'invalid_login', 'Benutzername oder Passwort ist falsch.');
    }
    if (user.status !== 'active') throw new ApiError(403, 'account_disabled', 'Dein Konto ist gesperrt. Wende dich an den Admin.');
    this.db.run('DELETE FROM fs_login_attempts WHERE username = ?', username);
    if (needsRehash(user.password_hash)) {
      this.db.run('UPDATE fs_users SET password_hash = ? WHERE id = ?', hashPassword(password), user.id);
    }
    this.db.run('UPDATE fs_users SET last_login_at = ? WHERE id = ?', now(), user.id);
    this.startSession(user, !!input.remember);
    return { user: publicUser(user) };
  }

  logout() {
    if (this.sessionId !== null) this.db.run('DELETE FROM fs_sessions WHERE id = ?', this.sessionId);
    this.request.setCookie(COOKIE, null);
    this.user = null;
    this.sessionId = null;
  }

  /**
   * Legt das erste Admin-Konto an. Nur möglich, solange es noch kein Konto gibt, und nur mit
   * dem SETUP_KEY aus der Server-Konfiguration.
   */
  setupAdmin(input) {
    this.assertHttps();
    const setupKey = this.config.setupKey ?? '';
    const given = typeof input.setup_key === 'string' ? input.setup_key.trim() : '';
    if (setupKey.length < 16 || !safeEqual(setupKey, given)) {
      throw ApiError.validation({ setup_key: 'Der Setup-Schlüssel ist falsch oder in der Server-Konfiguration (SETUP_KEY) nicht gesetzt (mindestens 16 Zeichen).' });
    }
    const fields = this.validateAccount(input);
    if (!this.needsSetup()) throw new ApiError(409, 'already_setup', 'Es gibt bereits ein Admin-Konto. Bitte melde dich an.');
    const user = this.createUser(fields, 'admin');
    this.startSession(user, true);
    return { user: publicUser(user) };
  }

  register(input) {
    this.assertHttps();
    const invalid = 'Diese Einladung ist ungültig, abgelaufen oder wurde schon benutzt. Frag nach einer neuen.';
    const code = normalizeCode(input.invite);
    const token = code !== null ? this.findToken('invite', code) : null;
    if (!token) throw ApiError.validation({ invite: invalid });
    const fields = this.validateAccount(input);

    const user = this.db.transaction(() => {
      const result = this.db.run('UPDATE fs_tokens SET uses = uses + 1 WHERE id = ? AND uses < max_uses AND expires_at > ?', token.id, now());
      if (result.changes === 0) throw ApiError.validation({ invite: invalid });
      return this.createUser(fields, 'member');
    });
    this.startSession(user, true);
    return { user: publicUser(user) };
  }

  /** Prüft einen Einladungs- oder Reset-Code, bevor das Formular ausgefüllt wird. */
  checkToken(kind, raw) {
    const code = normalizeCode(raw);
    const token = code !== null ? this.findToken(kind, code) : null;
    if (!token) return { valid: false };
    const out = { valid: true, expires_at: isoUtc(token.expires_at) };
    if (kind === 'reset') out.username = this.findUser('id', token.user_id)?.username ?? null;
    return out;
  }

  /** Neues Passwort mit einem Reset-Link vom Admin setzen. Beendet alle bisherigen Sitzungen. */
  resetPassword(input) {
    this.assertHttps();
    const code = normalizeCode(input.code);
    const token = code !== null ? this.findToken('reset', code) : null;
    const user = token ? this.findUser('id', token.user_id) : null;
    if (!user) throw new ApiError(422, 'invalid_token', 'Dieser Link ist ungültig, abgelaufen oder wurde schon benutzt. Bitte frag den Admin nach einem neuen.');
    if (user.status !== 'active') throw new ApiError(403, 'account_disabled', 'Dein Konto ist gesperrt. Wende dich an den Admin.');
    const errors = {};
    const password = validatePassword(input.password, user.username, errors);
    if (Object.keys(errors).length) throw ApiError.validation(errors);
    const hash = hashPassword(password);
    this.db.transaction(() => {
      this.db.run('UPDATE fs_tokens SET uses = max_uses WHERE id = ?', token.id);
      this.db.run('UPDATE fs_users SET password_hash = ? WHERE id = ?', hash, user.id);
      this.db.run('DELETE FROM fs_sessions WHERE user_id = ?', user.id);
    });
    this.startSession(user, true);
    return { user: publicUser(user) };
  }

  // ------------------------------------------------------------------ Eigenes Konto

  updateProfile(input) {
    const user = this.requireUser();
    const errors = {};
    const name = displayName(input.display_name, errors);
    if (Object.keys(errors).length) throw ApiError.validation(errors);
    this.db.run('UPDATE fs_users SET display_name = ? WHERE id = ?', name, user.id);
    user.display_name = name;
    return { user: publicUser(user) };
  }

  /** Passwort ändern; meldet alle anderen Geräte ab. */
  changePassword(input) {
    const user = this.requireUser();
    const current = typeof input.current_password === 'string' ? input.current_password : '';
    if (!verifyPassword(current, user.password_hash)) throw ApiError.validation({ current_password: 'Das aktuelle Passwort stimmt nicht.' });
    const errors = {};
    const password = validatePassword(input.password, user.username, errors);
    if (Object.keys(errors).length) throw ApiError.validation(errors);
    this.db.run('UPDATE fs_users SET password_hash = ? WHERE id = ?', hashPassword(password), user.id);
    this.db.run('DELETE FROM fs_sessions WHERE user_id = ? AND id <> ?', user.id, this.sessionId);
  }

  // ------------------------------------------------------------------ Admin

  adminOverview() {
    this.requireAdmin();
    const users = this.db.all(
      `SELECT u.id, u.username, u.display_name, u.role, u.status, u.created_at, u.last_login_at,
         (SELECT COUNT(*) FROM fs_event_participants p WHERE p.user_id = u.id) AS events
       FROM fs_users u ORDER BY u.display_name, u.username`,
    );
    const invites = this.db.all(
      `SELECT t.id, t.note, t.uses, t.max_uses, t.expires_at, t.created_at, u.display_name AS created_by
       FROM fs_tokens t LEFT JOIN fs_users u ON u.id = t.created_by
       WHERE t.kind = 'invite' AND t.uses < t.max_uses AND t.expires_at > ? ORDER BY t.created_at DESC`,
      now(),
    );
    return {
      users: users.map((u) => ({
        id: u.id,
        username: u.username,
        display_name: u.display_name,
        role: u.role,
        status: u.status,
        events: u.events,
        created_at: isoUtc(u.created_at),
        last_login_at: u.last_login_at !== null ? isoUtc(u.last_login_at) : null,
      })),
      invites: invites.map((t) => ({
        id: t.id,
        note: t.note,
        uses: t.uses,
        max_uses: t.max_uses,
        created_by: t.created_by,
        expires_at: isoUtc(t.expires_at),
        created_at: isoUtc(t.created_at),
      })),
    };
  }

  createInvite(input) {
    const admin = this.requireAdmin();
    const errors = {};
    const note = typeof input.note === 'string' ? input.note.trim() : '';
    if ([...note].length > 120) errors.note = 'Höchstens 120 Zeichen erlaubt.';
    const maxUses = input.max_uses ?? 1;
    if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 50) errors.max_uses = 'Bitte eine Zahl zwischen 1 und 50 angeben.';
    const days = input.days ?? 14;
    if (!Number.isInteger(days) || days < 1 || days > 90) errors.days = 'Bitte eine Zahl zwischen 1 und 90 angeben.';
    if (Object.keys(errors).length) throw ApiError.validation(errors);
    const code = this.insertToken('invite', null, admin.id, note !== '' ? note : null, maxUses, days * DAY);
    return { code };
  }

  revokeInvite(input) {
    this.requireAdmin();
    this.db.run("DELETE FROM fs_tokens WHERE id = ? AND kind = 'invite'", String(input.id ?? ''));
  }

  /** Link zum Zurücksetzen des Passworts (24 Stunden gültig, einmalig). */
  createResetLink(input) {
    const admin = this.requireAdmin();
    return this.issueResetLink(String(input.user_id ?? ''), admin.id);
  }

  /** Auch für die Kommandozeile (z. B. wenn der Admin sein eigenes Passwort vergessen hat). */
  issueResetLink(userId, createdBy) {
    const user = this.findUser('id', userId);
    if (!user) throw new ApiError(404, 'user_not_found', 'Dieses Konto gibt es nicht (mehr).');
    this.db.run("DELETE FROM fs_tokens WHERE kind = 'reset' AND user_id = ?", user.id);
    const code = this.insertToken('reset', user.id, createdBy, null, 1, 24 * HOUR);
    return { code, username: user.username };
  }

  /** Konto sperren/entsperren oder Rolle ändern. */
  updateUser(input) {
    const admin = this.requireAdmin();
    const target = this.findUser('id', String(input.user_id ?? ''));
    if (!target) throw new ApiError(404, 'user_not_found', 'Dieses Konto gibt es nicht (mehr).');
    if (target.id === admin.id) throw new ApiError(422, 'self', 'Dein eigenes Konto kannst du hier nicht sperren oder herabstufen.');
    const { status, role } = input;
    if (status !== undefined && status !== null) {
      if (!['active', 'disabled'].includes(status)) throw new ApiError(422, 'validation', 'Ungültiger Status.');
      this.db.run('UPDATE fs_users SET status = ? WHERE id = ?', status, target.id);
      if (status === 'disabled') this.db.run('DELETE FROM fs_sessions WHERE user_id = ?', target.id);
    }
    if (role !== undefined && role !== null) {
      if (!['admin', 'member'].includes(role)) throw new ApiError(422, 'validation', 'Ungültige Rolle.');
      this.db.run('UPDATE fs_users SET role = ? WHERE id = ?', role, target.id);
    }
  }

  /**
   * Konto löschen. Die Person bleibt in den Events als Name erhalten (sonst gingen Abrechnungen
   * kaputt), nur die Verknüpfung zum Konto wird gelöst.
   */
  deleteUser(input) {
    const admin = this.requireAdmin();
    const target = this.findUser('id', String(input.user_id ?? ''));
    if (!target) throw new ApiError(404, 'user_not_found', 'Dieses Konto gibt es nicht (mehr).');
    if (target.id === admin.id) throw new ApiError(422, 'self', 'Dein eigenes Konto kannst du nicht löschen.');
    this.db.transaction(() => {
      this.db.run('UPDATE fs_event_participants SET user_id = NULL WHERE user_id = ?', target.id);
      this.db.run('UPDATE fs_events SET owner_user_id = NULL WHERE owner_user_id = ?', target.id);
      this.db.run('DELETE FROM fs_users WHERE id = ?', target.id);
    });
  }

  // ------------------------------------------------------------------ Hilfsfunktionen

  assertHttps() {
    if (this.config.requireHttps && !this.request.https) {
      throw new ApiError(403, 'https_required', 'Anmelden ist nur über eine verschlüsselte Verbindung (https://) möglich. Bitte rufe die Seite mit https:// auf.');
    }
  }

  startSession(user, remember) {
    const token = randomBytes(32).toString('hex');
    const timestamp = now();
    const id = newId();
    const agent = [...this.request.userAgent].slice(0, 190).join('');
    this.db.run(
      'INSERT INTO fs_sessions (id, user_id, token_hash, remember, created_at, last_seen_at, expires_at, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      id, user.id, sha256(token), remember, timestamp, timestamp, sessionExpiry(remember), agent || null,
    );
    // Abgelaufene Sitzungen bei Gelegenheit aufräumen (kein Cronjob nötig).
    this.db.run('DELETE FROM fs_sessions WHERE expires_at < ?', timestamp);
    this.request.setCookie(COOKIE, token, remember ? REMEMBER_DAYS * 86400 : 0);
    this.sessionId = id;
    this.user = user;
  }

  createUser(fields, role) {
    if (this.findUser('username', fields.username)) throw ApiError.validation({ username: 'Dieser Benutzername ist schon vergeben.' });
    const timestamp = now();
    const user = {
      id: newId(),
      username: fields.username,
      display_name: fields.display_name,
      password_hash: hashPassword(fields.password),
      role,
      status: 'active',
      created_at: timestamp,
    };
    this.db.run(
      'INSERT INTO fs_users (id, username, display_name, password_hash, role, status, created_at, last_login_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      user.id, user.username, user.display_name, user.password_hash, role, 'active', timestamp, timestamp,
    );
    return user;
  }

  validateAccount(input) {
    const errors = {};
    const username = normalizeUsername(input.username);
    if (!/^[a-z0-9][a-z0-9._-]{2,39}$/.test(username)) {
      errors.username = '3 bis 40 Zeichen: Buchstaben a–z, Ziffern, Punkt, Unterstrich oder Bindestrich (keine Umlaute, keine Leerzeichen).';
    }
    const name = displayName(input.display_name, errors);
    const password = validatePassword(input.password, username, errors);
    if (Object.keys(errors).length) throw ApiError.validation(errors);
    return { username, display_name: name, password };
  }

  findUser(column, value) {
    const sql = column === 'id' ? 'SELECT * FROM fs_users WHERE id = ?' : 'SELECT * FROM fs_users WHERE username = ?';
    return this.db.get(sql, value);
  }

  /** Gültiges (nicht abgelaufenes, nicht aufgebrauchtes) Token oder null. */
  findToken(kind, code) {
    return this.db.get('SELECT * FROM fs_tokens WHERE token_hash = ? AND kind = ? AND uses < max_uses AND expires_at > ?', sha256(code), kind, now());
  }

  insertToken(kind, userId, createdBy, note, maxUses, validForMs) {
    const code = randomCode();
    this.db.run(
      'INSERT INTO fs_tokens (id, kind, token_hash, user_id, created_by, note, max_uses, uses, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)',
      newId(), kind, sha256(code), userId, createdBy, note, maxUses, at(validForMs), now(),
    );
    return code;
  }
}

function sessionExpiry(remember) {
  return at(remember ? REMEMBER_DAYS * DAY : SHORT_HOURS * HOUR);
}

function normalizeUsername(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function displayName(value, errors) {
  const name = typeof value === 'string' ? value.replace(/[\x00-\x1F\x7F]/g, '').trim() : '';
  if (name === '') errors.display_name = 'Bitte gib einen Anzeigenamen ein.';
  else if ([...name].length > 60) errors.display_name = 'Höchstens 60 Zeichen erlaubt.';
  return name;
}

function validatePassword(value, username, errors) {
  const password = typeof value === 'string' ? value : '';
  if ([...password].length < MIN_PASSWORD) errors.password = `Das Passwort muss mindestens ${MIN_PASSWORD} Zeichen lang sein.`;
  else if (Buffer.byteLength(password) > 200) errors.password = 'Das Passwort ist zu lang (höchstens 200 Zeichen).';
  else if (COMMON_PASSWORDS.has(password.toLowerCase()) || password.toLowerCase() === username) {
    errors.password = 'Dieses Passwort ist zu leicht zu erraten. Bitte wähle ein anderes.';
  }
  return password;
}

/** Vergleich in konstanter Zeit (für den Setup-Schlüssel). */
function safeEqual(a, b) {
  const x = createHash('sha256').update(a).digest();
  const y = createHash('sha256').update(b).digest();
  return timingSafeEqual(x, y);
}
