// FriendSplit – HTTP-Server ohne Zusatzpakete (nur Node.js-Bordmittel).
//
// /            Oberfläche (Dateien aus public/, beim Start in den Speicher geladen)
// /api?action= JSON-API
//   Event-Zugriff:        Header "X-Event-Code" (geheimer Zugangscode aus dem Event-Link)
//   Konto:                HttpOnly-Cookie "fs_session" (optional)
//   Person ohne Konto:    Header "X-Person-Id" (keine sichere Anmeldung)
//   Schreibende Aufrufe:  POST mit "X-Requested-With: FriendSplit" (Schutz vor CSRF)

import { createServer as createHttpServer } from 'node:http';
import { readdirSync, readFileSync } from 'node:fs';
import { join, extname, relative, sep } from 'node:path';
import { ApiError } from './lib/errors.js';
import { Store } from './lib/store.js';
import { Auth, publicUser } from './lib/auth.js';

const MAX_BODY_BYTES = 64 * 1024;

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'SAMEORIGIN',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'",
};

/**
 * Lädt alle auslieferbaren Dateien aus public/ in den Speicher. Ausgeliefert wird nur, was hier
 * steht – Pfade aus der Anfrage werden nie direkt auf das Dateisystem angewendet.
 */
function loadStaticFiles(publicDir) {
  const files = new Map();
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (CONTENT_TYPES[extname(entry.name)]) {
        const urlPath = `/${relative(publicDir, full).split(sep).join('/')}`;
        files.set(urlPath, { body: readFileSync(full), type: CONTENT_TYPES[extname(entry.name)] });
      }
    }
  };
  walk(publicDir);
  if (files.has('/index.html')) files.set('/', files.get('/index.html'));
  return files;
}

/**
 * @param {{db: import('./lib/db.js').Database, publicDir: string, requireHttps: boolean,
 *          trustProxy: boolean, setupKey: string, cookiePath: string}} config
 */
export function createApp(config) {
  const files = loadStaticFiles(config.publicDir);
  const store = new Store(config.db);

  return async function handle(req, res) {
    const https = config.trustProxy ? String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim() === 'https' : !!req.socket.encrypted;
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
    if (https) res.setHeader('Strict-Transport-Security', 'max-age=31536000');

    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      return sendText(res, 400, 'Ungültige Anfrage');
    }

    if (url.pathname === '/api' || url.pathname === '/api/') {
      return handleApi(req, res, url, https);
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') return sendText(res, 405, 'Methode nicht erlaubt');
    const file = files.get(url.pathname);
    if (!file) return sendText(res, 404, 'Nicht gefunden');
    res.writeHead(200, { 'Content-Type': file.type, 'Content-Length': file.body.length, 'Cache-Control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : file.body);
  };

  async function handleApi(req, res, url, https) {
    const cookies = [];
    const request = {
      https,
      ip: clientIp(req, config.trustProxy),
      userAgent: String(req.headers['user-agent'] ?? ''),
      cookies: parseCookies(req.headers.cookie),
      setCookie(name, value, maxAgeSeconds = 0) {
        const parts = [`${name}=${value ?? ''}`, `Path=${config.cookiePath}`, 'HttpOnly', 'SameSite=Lax'];
        if (https) parts.push('Secure');
        if (value === null) parts.push('Max-Age=0');
        else if (maxAgeSeconds > 0) parts.push(`Max-Age=${maxAgeSeconds}`);
        cookies.push(parts.join('; '));
      },
    };

    let status = 200;
    let payload;
    try {
      const method = req.method;
      if (method !== 'GET' && method !== 'POST') throw new ApiError(405, 'method_not_allowed', 'Methode nicht erlaubt.');
      if (method === 'POST' && req.headers['x-requested-with'] !== 'FriendSplit') {
        throw new ApiError(403, 'forbidden', 'Ungültige Anfrage. Bitte lade die Seite neu.');
      }
      const body = method === 'POST' ? await readJson(req) : {};
      const result = route(url.searchParams.get('action') ?? '', method, body, url, req, request);
      ({ status = 200, data: payload } = result);
      payload = { ok: true, data: payload ?? {} };
    } catch (error) {
      if (error instanceof ApiError) {
        status = error.status;
        payload = error.toJSON();
      } else {
        console.error('FriendSplit-Fehler:', error);
        status = 500;
        payload = new ApiError(500, 'server_error', 'Auf dem Server ist ein Fehler aufgetreten. Deine Änderung wurde nicht gespeichert.').toJSON();
      }
    }
    const json = JSON.stringify(payload);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(json),
      'Cache-Control': 'no-store',
      ...(cookies.length ? { 'Set-Cookie': cookies } : {}),
    });
    res.end(json);
  }

  /** Verteilt einen API-Aufruf auf Konto-, Event- und Admin-Funktionen. */
  function route(action, method, body, url, req, request) {
    const auth = new Auth(config.db, config, request);
    const user = auth.resolve();
    const requirePost = () => {
      if (method !== 'POST') throw new ApiError(405, 'method_not_allowed', 'Diese Aktion erfordert POST.');
    };
    const query = (name) => url.searchParams.get(name);

    // ---------------------------------------------------------------- Konto (ohne Event)
    const accountActions = {
      health: ['GET', () => ({ status: 'ok' })],
      me: ['GET', () => ({ user: publicUser(auth.user), needs_setup: auth.needsSetup() })],
      login: ['POST', () => auth.login(body)],
      logout: ['POST', () => auth.logout()],
      setup_admin: ['POST', () => auth.setupAdmin(body)],
      check_invite: ['GET', () => auth.checkToken('invite', query('code'))],
      register: ['POST', () => auth.register(body)],
      check_reset: ['GET', () => auth.checkToken('reset', query('code'))],
      reset_password: ['POST', () => auth.resetPassword(body)],
      update_profile: ['POST', () => auth.updateProfile(body)],
      change_password: ['POST', () => auth.changePassword(body)],
      my_events: ['GET', () => ({ events: store.myEvents(auth.requireUser().id) })],
      import_local: ['POST', () => store.importLocal(body, auth.requireUser())],
      admin_overview: ['GET', () => ({ ...auth.adminOverview(), events: store.allEvents() })],
      admin_create_invite: ['POST', () => auth.createInvite(body)],
      admin_revoke_invite: ['POST', () => auth.revokeInvite(body)],
      admin_reset_link: ['POST', () => auth.createResetLink(body)],
      admin_update_user: ['POST', () => auth.updateUser(body)],
      admin_delete_user: ['POST', () => auth.deleteUser(body)],
    };
    if (Object.hasOwn(accountActions, action)) {
      const [expected, handler] = accountActions[action];
      if (expected === 'POST') requirePost();
      return { data: handler() };
    }

    if (action === 'create_event') {
      requirePost();
      return { status: 201, data: store.createEvent(body, user) };
    }

    // ---------------------------------------------------------------- Event (über Zugangscode)
    let event = store.requireEvent(header(req, 'x-event-code'));
    const actor = store.actor(event, user, header(req, 'x-person-id'));

    if (action === 'event') return { data: store.state(event, user) };
    if (action === 'delete_event') {
      requirePost();
      store.deleteEvent(event, user);
      return { data: { deleted: true } };
    }

    const mutations = {
      update_event: () => store.updateEvent(event, body, actor),
      add_participant: () => ({ person_id: store.addParticipant(event, body, actor) }),
      rename_participant: () => store.renameParticipant(event, body, actor),
      remove_participant: () => store.removeParticipant(event, body, actor),
      save_expense: () => ({ expense_id: store.saveExpense(event, body, actor) }),
      delete_expense: () => store.deleteExpense(event, body, actor),
      add_settlement: () => store.addSettlement(event, body, actor),
      delete_settlement: () => store.deleteSettlement(event, body, actor),
      join_event: () => ({ person_id: store.joinEvent(event, body, auth.requireUser()) }),
      leave_event: () => store.leaveEvent(event, auth.requireUser()),
      unlink_participant: () => store.unlinkParticipant(event, body, user, actor),
      regenerate_code: () => ({ code: store.regenerateCode(event, user, actor) }),
    };
    if (!Object.hasOwn(mutations, action)) throw new ApiError(404, 'unknown_action', 'Unbekannte Aktion.');
    requirePost();
    const result = mutations[action]() ?? {};
    event = store.requireEventById(event.id);
    return { data: { ...result, state: store.state(event, user) } };
  }
}

/** HTTP-Server mit vernünftigen Zeitlimits. */
export function createServer(config) {
  const server = createHttpServer({ requestTimeout: 30_000, headersTimeout: 15_000 }, createApp(config));
  server.keepAliveTimeout = 5_000;
  return server;
}

function header(req, name) {
  const value = req.headers[name];
  return typeof value === 'string' && value !== '' ? value : null;
}

function parseCookies(headerValue) {
  const cookies = {};
  for (const part of String(headerValue ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index > 0) cookies[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }
  return cookies;
}

function clientIp(req, trustProxy) {
  if (trustProxy) {
    // Der vorgeschaltete Proxy (z. B. Caddy) hängt die echte Adresse als letzten Eintrag an.
    const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    if (forwarded.length) return forwarded[forwarded.length - 1];
  }
  return req.socket.remoteAddress ?? '';
}

async function readJson(req) {
  const type = String(req.headers['content-type'] ?? '');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new ApiError(413, 'too_large', 'Die Anfrage ist zu groß.');
    chunks.push(chunk);
  }
  if (size === 0) return {};
  if (!type.startsWith('application/json')) throw new ApiError(415, 'bad_content_type', 'Die Anfrage muss JSON sein.');
  let data;
  try {
    data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ApiError(400, 'bad_json', 'Die Anfrage konnte nicht gelesen werden.');
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new ApiError(400, 'bad_json', 'Die Anfrage konnte nicht gelesen werden.');
  return data;
}

function sendText(res, status, text) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(text);
}
