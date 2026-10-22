// Ausführen: node --test tests/api.test.js
// Startet den Server mit einer temporären SQLite-Datenbank und testet die API end-to-end über HTTP.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Database } from '../server/lib/db.js';
import { createServer } from '../server/app.js';

const SETUP_KEY = 'test-setup-key-1234567890';
const publicDir = fileURLToPath(new URL('../public', import.meta.url));
let tmp;
let db;
let server;
let base;

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'friendsplit-test-'));
  db = new Database(join(tmp, 'test.sqlite'));
  server = createServer({ db, publicDir, requireHttps: false, trustProxy: false, setupKey: SETUP_KEY, cookiePath: '/api' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

/**
 * @param {string|null} session Wert des Sitzungs-Cookies (angemeldet) oder null
 * @returns {Promise<{status: number, body: any, session: string|null|undefined}>}
 *   session: neu gesetztes Cookie, '' = gelöscht, undefined = unverändert
 */
async function call(action, body = null, code = null, person = null, session = null, url = base) {
  const headers = { Accept: 'application/json' };
  if (code !== null) headers['X-Event-Code'] = code;
  if (person !== null) headers['X-Person-Id'] = person;
  if (session !== null) headers.Cookie = `fs_session=${session}`;
  if (body !== null) {
    headers['Content-Type'] = 'application/json';
    headers['X-Requested-With'] = 'FriendSplit';
  }
  const response = await fetch(`${url}/api?action=${action}`, {
    method: body !== null ? 'POST' : 'GET',
    headers,
    body: body !== null ? JSON.stringify(body) : undefined,
  });
  let newSession;
  for (const cookie of response.headers.getSetCookie()) {
    const match = /^fs_session=([^;]*)/.exec(cookie);
    if (match) newSession = match[1];
  }
  return { status: response.status, body: await response.json(), session: newSession };
}

const byName = (state) => Object.fromEntries(state.participants.map((p) => [p.name, p.id]));
const names = (list) => list.map((p) => p.name);

let code;
let ids;

// ---------------------------------------------------------------- Events ohne Konto

test('Event erstellen – Validierung', async () => {
  let r = await call('create_event', { name: '', creator_name: '' });
  assert.equal(r.status, 422);
  assert.ok(r.body.error.fields.name && r.body.error.fields.creator_name);
  r = await call('create_event', { name: 'X', creator_name: 'Alex', participants: ['alex'] });
  assert.equal(r.status, 422, 'doppelte Namen');
  r = await call('create_event', { name: 'X', creator_name: 'Alex', date: '2026-02-30' });
  assert.equal(r.status, 422, 'ungültiges Datum');
});

test('Event erstellen und erneut öffnen', async () => {
  const r = await call('create_event', {
    name: 'Stuttgart Night', date: '2026-10-23', location: 'Stuttgart', creator_name: 'Alex', participants: ['Mathis', 'Sam', ''],
  });
  assert.equal(r.status, 201);
  code = r.body.data.code;
  assert.match(code, /^[2-9A-HJ-NP-Z]{12}$/);

  // Code mit Bindestrichen und in Kleinschreibung wird ebenfalls akzeptiert.
  const formatted = code.match(/.{4}/g).join('-').toLowerCase();
  const s = await call('event', null, formatted);
  assert.equal(s.status, 200);
  const state = s.body.data;
  assert.equal(state.event.name, 'Stuttgart Night');
  assert.equal(state.event.date, '2026-10-23');
  assert.deepEqual(names(state.participants), ['Alex', 'Mathis', 'Sam']);
  assert.equal(state.participants[0].role, 'organizer');
  ids = byName(state);
  assert.equal(state.event.created_by, ids.Alex);
});

test('Falscher Code liefert 404', async () => {
  assert.equal((await call('event', null, 'AAAA-BBBB-CCCC')).status, 404);
  assert.equal((await call('event')).status, 404);
  assert.equal((await call('event', null, "' OR 1=1 --")).status, 404);
});

test('Beispielrechnung aus dem Konzept über die API', async () => {
  let r = await call('save_expense', {
    amount_cents: 3000, description: 'Getränke', category: 'getraenke', paid_by: ids.Alex,
    participants: [ids.Alex, ids.Mathis, ids.Sam], spent_at: '2026-10-23T21:15', client_token: 'token-getraenke-1',
  }, code, ids.Alex);
  assert.equal(r.status, 200);
  r = await call('save_expense', {
    amount_cents: 2000, description: 'Essen', category: 'essen', paid_by: ids.Mathis,
    participants: [ids.Mathis, ids.Sam], spent_at: '2026-10-23T22:00',
  }, code, ids.Mathis);
  assert.equal(r.status, 200);
  const s = r.body.data.state.summary;
  assert.equal(s.total_cents, 5000);
  assert.equal(s.people[ids.Alex].balance, 2000);
  assert.equal(s.people[ids.Mathis].balance, 0);
  assert.equal(s.people[ids.Sam].balance, -2000);
  assert.deepEqual(s.plan, [{ from: ids.Sam, to: ids.Alex, amount_cents: 2000 }]);
  assert.equal(s.open_cents, 2000);

  const expenses = r.body.data.state.expenses;
  assert.equal(expenses[0].description, 'Essen', 'neueste zuerst');
  assert.equal(expenses[0].icon, '🍕');
  assert.ok(!expenses[0].shares.some((x) => x.person_id === ids.Alex), 'Alex nicht am Essen beteiligt');
});

test('Doppelt abgeschickte Ausgabe wird nur einmal gespeichert', async () => {
  const r = await call('save_expense', {
    amount_cents: 3000, description: 'Getränke', category: 'getraenke', paid_by: ids.Alex,
    participants: [ids.Alex, ids.Mathis, ids.Sam], spent_at: '2026-10-23T21:15', client_token: 'token-getraenke-1',
  }, code, ids.Alex);
  assert.equal(r.status, 200);
  assert.equal(r.body.data.state.expenses.length, 2);
});

test('Validierung von Ausgaben', async () => {
  let r = await call('save_expense', { amount_cents: 0, category: 'nope', paid_by: 'unknown', participants: [], spent_at: 'gestern' }, code);
  assert.equal(r.status, 422);
  for (const field of ['amount', 'category', 'paid_by', 'participants', 'spent_at']) {
    assert.ok(r.body.error.fields[field], `Fehler für ${field} erwartet`);
  }
  r = await call('save_expense', {
    amount_cents: 100, category: 'essen', paid_by: ids.Alex, participants: ['fremde-person-id'], spent_at: '2026-10-23T22:00',
  }, code);
  assert.equal(r.status, 422);
  assert.ok(r.body.error.fields.participants);
  r = await call('save_expense', { amount_cents: 100, category: '__proto__', paid_by: ids.Alex, participants: [ids.Alex], spent_at: '2026-10-23T25:00' }, code);
  assert.ok(r.body.error.fields.category && r.body.error.fields.spent_at);
});

test('Rundung: Summe der Anteile = Betrag', async () => {
  const r = await call('save_expense', {
    amount_cents: 1000, category: 'transport', paid_by: ids.Sam, participants: [ids.Alex, ids.Mathis, ids.Sam], spent_at: '2026-10-23T23:30',
  }, code, ids.Sam);
  const expense = r.body.data.state.expenses[0];
  assert.equal(expense.description, 'Transport', 'leere Beschreibung → Kategoriename');
  const shares = Object.fromEntries(expense.shares.map((s) => [s.person_id, s.share_cents]));
  assert.equal(Object.values(shares).reduce((a, b) => a + b, 0), 1000);
  assert.equal(shares[ids.Sam], 334, 'Rest-Cent an zahlende Person');
  assert.equal(shares[ids.Alex], 333);
});

test('Bearbeiten aktualisiert Salden; veraltete Version ergibt Konflikt', async () => {
  const taxi = (await call('event', null, code)).body.data.expenses[0];
  const payload = {
    id: taxi.id, version: taxi.version, amount_cents: 1200, category: 'transport', description: 'Taxi',
    paid_by: ids.Sam, participants: [ids.Mathis, ids.Sam], spent_at: taxi.spent_at,
  };
  let r = await call('save_expense', payload, code, ids.Sam);
  assert.equal(r.status, 200);
  const updated = r.body.data.state.expenses[0];
  assert.equal(updated.version, 2);
  assert.equal(updated.amount_cents, 1200);
  assert.equal(updated.updated_by, ids.Sam);

  // Zweiter Client mit alter Version
  r = await call('save_expense', { ...payload, amount_cents: 999 }, code, ids.Mathis);
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, 'conflict');
  assert.equal(r.body.error.data.expense.amount_cents, 1200);

  const s = (await call('event', null, code)).body.data.summary;
  // Alex: 3000 − 1000 = +2000 · Mathis: 2000 − 1000 − 1000 − 600 = −600 · Sam: 1200 − 1000 − 1000 − 600 = −1400
  assert.equal(s.people[ids.Alex].balance, 2000);
  assert.equal(s.people[ids.Mathis].balance, -600);
  assert.equal(s.people[ids.Sam].balance, -1400);
  assert.equal(Object.values(s.people).reduce((a, p) => a + p.balance, 0), 0);
});

test('Löschen mit veralteter Version scheitert, mit aktueller klappt es', async () => {
  const taxi = (await call('event', null, code)).body.data.expenses[0];
  assert.equal((await call('delete_expense', { id: taxi.id, version: 1 }, code)).status, 409);
  const r = await call('delete_expense', { id: taxi.id, version: taxi.version }, code, ids.Alex);
  assert.equal(r.status, 200);
  assert.equal(r.body.data.state.expenses.length, 2);
  assert.equal(r.body.data.state.summary.people[ids.Sam].balance, -2000);
  const again = await call('save_expense', {
    id: taxi.id, version: 2, amount_cents: 100, category: 'essen', paid_by: ids.Sam, participants: [ids.Sam], spent_at: '2026-10-23T22:00',
  }, code);
  assert.equal(again.status, 404);
});

test('Ausgleichszahlung als erledigt markieren und zurücknehmen', async () => {
  let r = await call('add_settlement', { from: ids.Sam, to: ids.Alex, amount_cents: 2000 }, code, ids.Sam);
  assert.equal(r.status, 200);
  const s = r.body.data.state;
  assert.deepEqual(s.summary.plan, []);
  assert.equal(s.summary.open_cents, 0);
  assert.equal(s.summary.people[ids.Sam].balance, 0);
  assert.equal((await call('add_settlement', { from: ids.Sam, to: ids.Sam, amount_cents: 5 }, code)).status, 422);
  r = await call('delete_settlement', { id: s.settlements[0].id }, code, ids.Alex);
  assert.equal(r.body.data.state.summary.plan.length, 1);
});

test('Teilnehmende verwalten', async () => {
  assert.equal((await call('add_participant', { name: 'mathis' }, code)).status, 422, 'Name doppelt');
  let r = await call('add_participant', { name: 'Kim' }, code, ids.Alex);
  assert.equal(r.status, 200);
  const kim = r.body.data.person_id;
  assert.equal(r.body.data.state.participants.at(-1).name, 'Kim');
  assert.equal((await call('rename_participant', { person_id: kim, name: 'Kimberly' }, code)).status, 200);
  assert.equal((await call('remove_participant', { person_id: ids.Sam }, code)).status, 409, 'Sam ist beteiligt');
  r = await call('remove_participant', { person_id: kim }, code, ids.Alex);
  assert.equal(r.status, 200);
  assert.equal(r.body.data.state.participants.length, 3);
});

test('Zugriff ist auf das eigene Event beschränkt', async () => {
  const other = (await call('create_event', { name: 'Anderes Event', creator_name: 'Eve' })).body.data;
  // Person aus Event A kann nicht in Event B zahlen
  const r = await call('save_expense', {
    amount_cents: 100, category: 'essen', paid_by: ids.Alex, participants: [ids.Alex], spent_at: '2026-10-23T22:00',
  }, other.code);
  assert.equal(r.status, 422);
  // Ausgabe aus Event A kann nicht über Event B gelöscht werden
  const expense = (await call('event', null, code)).body.data.expenses[0];
  assert.equal((await call('delete_expense', { id: expense.id, version: expense.version }, other.code)).status, 404);
  assert.equal((await call('event', null, code)).body.data.expenses.length, 2);
  // Alex kann nicht über Event B entfernt werden
  assert.equal((await call('remove_participant', { person_id: ids.Alex }, other.code)).status, 404);
});

test('Eventdaten bearbeiten und Verlauf', async () => {
  const r = await call('update_event', { name: 'Stuttgart Night 2026', date: '2026-10-24', location: '', notes: 'Treffpunkt Schlossplatz' }, code, ids.Mathis);
  assert.equal(r.status, 200);
  const state = r.body.data.state;
  assert.equal(state.event.name, 'Stuttgart Night 2026');
  assert.equal(state.event.location, null);
  assert.ok(state.activity.length >= 8);
  assert.ok(state.activity[0].summary.includes('Mathis'));
});

test('Methoden, Aktionen und Schutzmechanismen', async () => {
  let response = await fetch(`${base}/api?action=delete_expense`, { headers: { 'X-Event-Code': code } });
  assert.equal((await response.json()).error.code, 'method_not_allowed', 'Änderungen nur per POST');
  assert.equal((await call('gibt_es_nicht', {}, code)).status, 404);
  assert.equal((await call('health')).body.data.status, 'ok');

  // Schreibende Aufrufe ohne X-Requested-With (z. B. von einer fremden Seite) werden abgelehnt.
  response = await fetch(`${base}/api?action=create_event`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"name":"X","creator_name":"Y"}',
  });
  assert.equal((await response.json()).error.code, 'forbidden', 'CSRF-Schutz');
  // Kein JSON bzw. zu groß
  response = await fetch(`${base}/api?action=create_event`, {
    method: 'POST', headers: { 'Content-Type': 'text/plain', 'X-Requested-With': 'FriendSplit' }, body: 'name=X',
  });
  assert.equal(response.status, 415);
  response = await fetch(`${base}/api?action=create_event`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'FriendSplit' }, body: JSON.stringify({ name: 'x'.repeat(70_000) }),
  });
  assert.equal(response.status, 413);
});

test('Statische Dateien und Sicherheits-Header', async () => {
  let response = await fetch(`${base}/`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/html/);
  assert.match(response.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(response.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.equal((await fetch(`${base}/assets/app.js`)).status, 200);
  for (const path of ['/package.json', '/server/app.js', '/assets/../../package.json', '/%2e%2e/package.json', '/data/']) {
    response = await fetch(`${base}${path}`);
    assert.equal(response.status, 404, path);
  }
  assert.equal((await fetch(`${base}/`, { method: 'POST' })).status, 405);
});

// ---------------------------------------------------------------- Benutzerkonten

let admin;
let alex;
let alexUserId;

test('Erstes Admin-Konto einrichten', async () => {
  let me = (await call('me')).body.data;
  assert.equal(me.user, null);
  assert.equal(me.needs_setup, true);

  let r = await call('setup_admin', { setup_key: 'falsch', username: 'tim', display_name: 'Tim', password: 'sehr-geheimes-pw' });
  assert.equal(r.status, 422);
  assert.ok(r.body.error.fields.setup_key);
  r = await call('setup_admin', { setup_key: SETUP_KEY, username: 'Tim Ä', display_name: '', password: 'kurz' });
  assert.equal(r.status, 422);
  assert.deepEqual(Object.keys(r.body.error.fields), ['username', 'display_name', 'password']);

  r = await call('setup_admin', { setup_key: SETUP_KEY, username: 'Tim', display_name: 'Tim', password: 'sehr-geheimes-pw' });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.user.role, 'admin');
  assert.equal(r.body.data.user.username, 'tim', 'Benutzername klein geschrieben');
  admin = r.session;
  assert.match(admin, /^[a-f0-9]{64}$/, 'Sitzungs-Cookie gesetzt');

  me = (await call('me', null, null, null, admin)).body.data;
  assert.equal(me.user.display_name, 'Tim');
  assert.equal(me.needs_setup, false);
  r = await call('setup_admin', { setup_key: SETUP_KEY, username: 'zweiter', display_name: 'X', password: 'sehr-geheimes-pw' });
  assert.equal(r.status, 409, 'nur einmal möglich');

  const stored = db.value('SELECT password_hash FROM fs_users WHERE username = ?', 'tim');
  assert.match(stored, /^scrypt\$/, 'Passwort nur als scrypt-Hash gespeichert');
  assert.ok(!stored.includes('sehr-geheimes-pw'));
  assert.equal(db.value('SELECT COUNT(*) AS n FROM fs_sessions WHERE token_hash = ?', admin), 0, 'Sitzung nur als Hash gespeichert');
});

test('Registrierung nur mit gültiger Einladung', async () => {
  assert.equal((await call('admin_create_invite', {})).status, 401, 'ohne Anmeldung');
  let r = await call('register', { invite: 'AAAA-BBBB-CCCC', username: 'alex', display_name: 'Alex', password: 'alex-passwort-1' });
  assert.equal(r.status, 422);
  assert.ok(r.body.error.fields.invite);

  r = await call('admin_create_invite', { note: 'für Alex', max_uses: 1, days: 7 }, null, null, admin);
  assert.equal(r.status, 200);
  const invite = r.body.data.code;
  assert.equal((await call(`check_invite&code=${invite.toLowerCase()}`)).body.data.valid, true);

  r = await call('register', { invite, username: 'tim', display_name: 'Noch ein Tim', password: 'alex-passwort-1' });
  assert.equal(r.status, 422, 'Benutzername vergeben');
  assert.ok(r.body.error.fields.username);

  r = await call('register', { invite, username: 'alex', display_name: 'Alex', password: 'alex-passwort-1' });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.user.role, 'member');
  alex = r.session;
  alexUserId = r.body.data.user.id;

  // Einladung ist verbraucht
  assert.equal((await call(`check_invite&code=${invite}`)).body.data.valid, false);
  r = await call('register', { invite, username: 'sam', display_name: 'Sam', password: 'sam-passwort-12' });
  assert.equal(r.status, 422);
  // Mitglieder dürfen nicht in den Admin-Bereich
  assert.equal((await call('admin_overview', null, null, null, alex)).status, 403);
});

test('Anmelden, Abmelden und Schutz vor Passwort-Raten', async () => {
  let r = await call('login', { username: 'ALEX', password: 'alex-passwort-1', remember: true });
  assert.equal(r.status, 200, 'Groß-/Kleinschreibung egal');
  const second = r.session;
  assert.equal((await call('me', null, null, null, second)).body.data.user.display_name, 'Alex');
  r = await call('logout', {}, null, null, second);
  assert.equal(r.session, '', 'Cookie gelöscht');
  assert.equal((await call('me', null, null, null, second)).body.data.user, null, 'Sitzung beendet');
  assert.equal((await call('me', null, null, null, alex)).body.data.user.display_name, 'Alex', 'andere Sitzung bleibt');
  assert.equal((await call('me', null, null, null, 'f'.repeat(64))).body.data.user, null, 'erfundenes Cookie');

  assert.equal((await call('login', { username: 'niemand', password: 'irgendwas-langes' })).status, 401);
  for (let i = 0; i < 5; i++) {
    assert.equal((await call('login', { username: 'sam-gibts-nicht', password: 'falsches-passwort' })).status, 401);
  }
  assert.equal((await call('login', { username: 'sam-gibts-nicht', password: 'falsches-passwort' })).status, 429, 'gesperrt nach 5 Fehlversuchen');
  assert.equal((await call('login', { username: 'alex', password: 'alex-passwort-1' })).status, 200, 'andere Konten nicht betroffen');
});

test('Sitzungs-Cookie ist HttpOnly, SameSite und auf die API beschränkt', async () => {
  const response = await fetch(`${base}/api?action=login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'FriendSplit' },
    body: JSON.stringify({ username: 'alex', password: 'alex-passwort-1', remember: true }),
  });
  const cookie = response.headers.getSetCookie()[0];
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Path=\/api/);
  assert.match(cookie, /Max-Age=7776000/);
});

test('Event mit Konto erstellen erscheint in „Meine Events“', async () => {
  const r = await call('create_event', { name: 'Skiausflug', creator_name: 'Alex', participants: ['Mathis', 'Sam'] }, null, null, alex);
  assert.equal(r.status, 201);
  const eventCode = r.body.data.code;
  const events = (await call('my_events', null, null, null, alex)).body.data.events;
  assert.deepEqual(names(events), ['Skiausflug']);
  assert.equal(events[0].is_owner, true);
  assert.equal(events[0].person_name, 'Alex');

  const state = (await call('event', null, eventCode, null, alex)).body.data;
  assert.equal(state.viewer.person_id, r.body.data.person_id);
  assert.equal(state.viewer.can_manage, true);
  assert.deepEqual(state.participants.map((p) => p.linked), [true, false, false]);
  assert.equal((await call('my_events')).status, 401, 'nur angemeldet');
});

test('Per Code beitreten, Person verknüpfen und wechseln', async () => {
  const eventCode = (await call('my_events', null, null, null, alex)).body.data.events[0].code;
  const state = (await call('event', null, eventCode, null, admin)).body.data;
  const people = byName(state);
  assert.equal(state.viewer.person_id, null, 'noch nicht beigetreten');
  assert.equal(state.viewer.can_manage, true, 'Admin darf verwalten');

  assert.equal((await call('join_event', { person_id: people.Mathis }, eventCode)).status, 401, 'Beitreten nur mit Konto');
  assert.equal((await call('join_event', { person_id: people.Alex }, eventCode, null, admin)).status, 409, 'Alex gehört schon einem anderen Konto');

  let r = await call('join_event', { person_id: people.Mathis }, eventCode, null, admin);
  assert.equal(r.status, 200);
  assert.equal(r.body.data.state.viewer.person_id, people.Mathis);
  // Wechsel auf Sam: Mathis wird wieder frei
  r = await call('join_event', { person_id: people.Sam }, eventCode, null, admin);
  assert.deepEqual(r.body.data.state.participants.map((p) => p.linked), [true, false, true]);
  assert.deepEqual(names((await call('my_events', null, null, null, admin)).body.data.events), ['Skiausflug']);

  // Neu hinzufügen mit eigenem Namen – Namen müssen eindeutig sein
  assert.equal((await call('join_event', { name: 'alex' }, eventCode, null, admin)).status, 422);
  r = await call('join_event', { name: 'Tim' }, eventCode, null, admin);
  assert.equal(r.status, 200);
  assert.deepEqual(names(r.body.data.state.participants), ['Alex', 'Mathis', 'Sam', 'Tim']);
  assert.deepEqual(r.body.data.state.participants.map((p) => p.linked), [true, false, false, true]);
});

test('Angemeldet zählt das Konto, nicht X-Person-Id', async () => {
  const eventCode = (await call('my_events', null, null, null, alex)).body.data.events[0].code;
  const people = byName((await call('event', null, eventCode)).body.data);
  const expense = { amount_cents: 3000, category: 'essen', paid_by: people.Alex, participants: [people.Alex, people.Mathis], spent_at: '2026-12-01T12:00' };
  const createdBy = (r, description) => r.body.data.state.expenses.find((e) => e.description === description).created_by;
  // Gast gibt sich als Alex (mit Konto) aus → wird nicht als Alex eingetragen
  let r = await call('save_expense', { ...expense, description: 'Gast' }, eventCode, people.Alex);
  assert.equal(r.status, 200);
  assert.equal(createdBy(r, 'Gast'), null);
  // Gast als Mathis (ohne Konto) → wie bisher erlaubt
  r = await call('save_expense', { ...expense, description: 'Mathis' }, eventCode, people.Mathis);
  assert.equal(createdBy(r, 'Mathis'), people.Mathis);
  // Alex angemeldet, schickt aber Mathis' ID → zählt trotzdem als Alex
  r = await call('save_expense', { ...expense, description: 'Alex' }, eventCode, people.Mathis, alex);
  assert.equal(createdBy(r, 'Alex'), people.Alex);
  assert.ok(r.body.data.state.activity[0].summary.startsWith('Alex hat'));
});

test('Geräte-Events ins Konto übernehmen', async () => {
  const guest = (await call('create_event', { name: 'Altes Event', creator_name: 'Tim', participants: ['Jo'] })).body.data;
  const r = await call('import_local', { items: [
    { code: guest.code, person_id: guest.person_id },
    { code: 'AAAABBBBCCCC', person_id: 'x' },
    { code: guest.code },
  ] }, null, null, admin);
  assert.equal(r.body.data.imported, 1);
  const events = (await call('my_events', null, null, null, admin)).body.data.events;
  assert.deepEqual(names(events).sort(), ['Altes Event', 'Skiausflug']);
  // Organisator-Person übernommen → Owner des bisher besitzerlosen Events
  assert.equal(events.find((e) => e.name === 'Altes Event').is_owner, true);
});

test('Code erneuern, Verknüpfung lösen, Event verlassen und löschen', async () => {
  const eventCode = (await call('my_events', null, null, null, alex)).body.data.events[0].code;
  const people = byName((await call('event', null, eventCode)).body.data);
  assert.equal((await call('regenerate_code', {}, eventCode)).status, 403, 'Gäste dürfen nicht');

  let r = await call('regenerate_code', {}, eventCode, null, alex);
  assert.equal(r.status, 200);
  const newCode = r.body.data.code;
  assert.notEqual(newCode, eventCode);
  assert.equal(r.body.data.state.event.code, newCode);
  assert.equal((await call('event', null, eventCode)).status, 404, 'alter Code ungültig');
  const adminEvents = (await call('my_events', null, null, null, admin)).body.data.events;
  assert.equal(adminEvents.find((e) => e.name === 'Skiausflug').code, newCode, 'Mitglieder behalten Zugang');

  r = await call('unlink_participant', { person_id: people.Tim }, newCode, null, alex);
  assert.equal(r.status, 200);
  assert.deepEqual(names((await call('my_events', null, null, null, admin)).body.data.events), ['Altes Event']);

  r = await call('leave_event', {}, newCode, null, alex);
  assert.equal(r.body.data.state.viewer.person_id, null);
  assert.deepEqual((await call('my_events', null, null, null, alex)).body.data.events, []);

  assert.equal((await call('delete_event', {}, newCode)).status, 403);
  assert.equal((await call('delete_event', {}, newCode, null, admin)).status, 200);
  assert.equal((await call('event', null, newCode)).status, 404);
});

test('Admin: Konten verwalten und Passwort zurücksetzen', async () => {
  const overview = (await call('admin_overview', null, null, null, admin)).body.data;
  assert.deepEqual(overview.users.map((u) => u.display_name), ['Alex', 'Tim']);
  assert.ok(overview.events.length >= 3);
  const tim = overview.users[1].id;
  assert.equal((await call('admin_update_user', { user_id: tim, status: 'disabled' }, null, null, admin)).status, 422, 'nicht sich selbst sperren');

  // Reset-Link
  const reset = (await call('admin_reset_link', { user_id: alexUserId }, null, null, admin)).body.data.code;
  assert.equal((await call(`check_reset&code=${reset}`)).body.data.username, 'alex');
  assert.equal((await call('reset_password', { code: reset, password: 'kurz' })).status, 422);
  let r = await call('reset_password', { code: reset, password: 'neues-alex-passwort' });
  assert.equal(r.status, 200);
  const fresh = r.session;
  assert.equal((await call('me', null, null, null, alex)).body.data.user, null, 'alte Sitzungen beendet');
  assert.equal((await call('reset_password', { code: reset, password: 'noch-ein-passwort' })).status, 422, 'Link nur einmal gültig');
  assert.equal((await call('login', { username: 'alex', password: 'alex-passwort-1' })).status, 401);

  // Passwort ändern
  assert.equal((await call('change_password', { current_password: 'falsch', password: 'drittes-passwort-1' }, null, null, fresh)).status, 422);
  assert.equal((await call('change_password', { current_password: 'neues-alex-passwort', password: 'drittes-passwort-1' }, null, null, fresh)).status, 200);
  alex = (await call('login', { username: 'alex', password: 'drittes-passwort-1' })).session;

  // Sperren beendet Sitzungen und verhindert Anmeldung
  assert.equal((await call('admin_update_user', { user_id: alexUserId, status: 'disabled' }, null, null, admin)).status, 200);
  assert.equal((await call('me', null, null, null, alex)).body.data.user, null);
  assert.equal((await call('login', { username: 'alex', password: 'drittes-passwort-1' })).status, 403);
  await call('admin_update_user', { user_id: alexUserId, status: 'active', role: 'admin' }, null, null, admin);
  alex = (await call('login', { username: 'alex', password: 'drittes-passwort-1' })).session;
  assert.equal((await call('admin_overview', null, null, null, alex)).status, 200, 'Alex ist jetzt Admin');

  // Konto löschen: Person bleibt im Event erhalten, nur die Verknüpfung verschwindet
  const kino = (await call('create_event', { name: 'Kino', creator_name: 'Alex' }, null, null, alex)).body.data;
  assert.equal((await call('admin_delete_user', { user_id: alexUserId }, null, null, admin)).status, 200);
  const state = (await call('event', null, kino.code)).body.data;
  assert.deepEqual(state.participants, [{ id: kino.person_id, name: 'Alex', role: 'organizer', linked: false }]);
  assert.equal((await call('me', null, null, null, alex)).body.data.user, null);
});

test('Ohne HTTPS ist Anmelden gesperrt, wenn REQUIRE_HTTPS aktiv ist', async () => {
  const strict = createServer({ db, publicDir, requireHttps: true, trustProxy: false, setupKey: SETUP_KEY, cookiePath: '/api' });
  await new Promise((resolve) => strict.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${strict.address().port}`;
  try {
    const r = await call('login', { username: 'tim', password: 'sehr-geheimes-pw' }, null, null, null, url);
    assert.equal(r.body.error.code, 'https_required');
  } finally {
    await new Promise((resolve) => strict.close(resolve));
  }
});

test('Hinter einem Proxy zählen X-Forwarded-Proto und -For', async () => {
  const proxied = createServer({ db, publicDir, requireHttps: true, trustProxy: true, setupKey: SETUP_KEY, cookiePath: '/friendsplit/api' });
  await new Promise((resolve) => proxied.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${proxied.address().port}/api?action=login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'FriendSplit', 'X-Forwarded-Proto': 'https', 'X-Forwarded-For': '203.0.113.7' },
      body: JSON.stringify({ username: 'tim', password: 'sehr-geheimes-pw' }),
    });
    assert.equal(response.status, 200);
    const cookie = response.headers.getSetCookie()[0];
    assert.match(cookie, /; Secure/);
    assert.match(cookie, /Path=\/friendsplit\/api/);
    assert.match(response.headers.get('strict-transport-security'), /max-age=/);
  } finally {
    await new Promise((resolve) => proxied.close(resolve));
  }
});
