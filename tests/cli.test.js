// Ausführen: node --test tests/cli.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Database } from '../server/lib/db.js';
import { Store } from '../server/lib/store.js';
import { importPhpMyAdmin } from '../server/cli.js';

const cli = fileURLToPath(new URL('../server/cli.js', import.meta.url));

/** So sieht ein phpMyAdmin-Export („Exportieren“ → Format „JSON“) der alten PHP-Version aus. */
const EXPORT = `/**
 Export to JSON plugin for PHPMyAdmin
 @version 5.2.1
 */
[
{"type":"header","version":"5.2.1","comment":"Export to JSON plugin for PHPMyAdmin"},
{"type":"database","name":"d0123456"},
{"type":"table","name":"fs_users","database":"d0123456","data":[
  {"id":"u1aaaaaaaaaaaaaa","username":"tim","display_name":"Tim","email":null,"password_hash":"$2y$10$abcdefghijklmnopqrstuuJ8l3u2h4rZ9fK0lq5bXx3rPpWQe4mG","role":"admin","status":"active","created_at":"2026-10-01 10:00:00","last_login_at":"2026-10-20 18:00:00"}
]},
{"type":"table","name":"fs_sessions","database":"d0123456","data":[
  {"id":"s1aaaaaaaaaaaaaa","user_id":"u1aaaaaaaaaaaaaa","token_hash":"abc","remember":"1","created_at":"2026-10-01 10:00:00","last_seen_at":"2026-10-01 10:00:00","expires_at":"2027-01-01 10:00:00","user_agent":null}
]},
{"type":"table","name":"fs_events","database":"d0123456","data":[
  {"id":"e1aaaaaaaaaaaaaa","access_code":"K7Q2MX9P4HTR","name":"Stuttgart Night","event_date":"2026-10-23","location":"Stuttgart","notes":null,"created_by_person_id":"p1aaaaaaaaaaaaaa","created_at":"2026-10-01 10:00:00","updated_at":"2026-10-23 23:00:00","owner_user_id":"u1aaaaaaaaaaaaaa"}
]},
{"type":"table","name":"fs_persons","database":"d0123456","data":[
  {"id":"p1aaaaaaaaaaaaaa","display_name":"Tim","auth_user_id":null,"created_at":"2026-10-01 10:00:00"},
  {"id":"p2aaaaaaaaaaaaaa","display_name":"Sam","auth_user_id":null,"created_at":"2026-10-01 10:00:00"}
]},
{"type":"table","name":"fs_event_participants","database":"d0123456","data":[
  {"event_id":"e1aaaaaaaaaaaaaa","person_id":"p1aaaaaaaaaaaaaa","role":"organizer","position":"0","joined_at":"2026-10-01 10:00:00","user_id":"u1aaaaaaaaaaaaaa"},
  {"event_id":"e1aaaaaaaaaaaaaa","person_id":"p2aaaaaaaaaaaaaa","role":"member","position":"1","joined_at":"2026-10-01 10:00:00","user_id":null}
]},
{"type":"table","name":"fs_expenses","database":"d0123456","data":[
  {"id":"x1aaaaaaaaaaaaaa","event_id":"e1aaaaaaaaaaaaaa","description":"Pizza","amount_cents":"4250","category":"essen","icon":"🍕","paid_by_person_id":"p1aaaaaaaaaaaaaa","spent_at":"2026-10-23 21:00:00","notes":null,"client_token":"tok-12345678","version":"1","created_by_person_id":"p1aaaaaaaaaaaaaa","updated_by_person_id":"p1aaaaaaaaaaaaaa","created_at":"2026-10-23 21:00:00","updated_at":"2026-10-23 21:00:00"}
]},
{"type":"table","name":"fs_expense_shares","database":"d0123456","data":[
  {"expense_id":"x1aaaaaaaaaaaaaa","person_id":"p1aaaaaaaaaaaaaa","share_cents":"2125"},
  {"expense_id":"x1aaaaaaaaaaaaaa","person_id":"p2aaaaaaaaaaaaaa","share_cents":"2125"}
]},
{"type":"table","name":"fs_settlements","database":"d0123456","data":[]},
{"type":"table","name":"fs_activity","database":"d0123456","data":[
  {"id":"0000000000001abcde","event_id":"e1aaaaaaaaaaaaaa","person_id":"p1aaaaaaaaaaaaaa","action":"event_created","summary":"Tim hat das Event erstellt","created_at":"2026-10-01 10:00:00"}
]}
]`;

test('phpMyAdmin-Export der PHP-Version wird vollständig übernommen', () => {
  const db = new Database(':memory:');
  const { counts, users } = importPhpMyAdmin(db, EXPORT);
  assert.equal(counts.fs_events, 1);
  assert.equal(counts.fs_expenses, 1);
  assert.equal(counts.fs_expense_shares, 2);
  assert.deepEqual(users.map((u) => u.username), ['tim']);
  assert.equal(db.value('SELECT COUNT(*) AS n FROM fs_sessions'), 0, 'Sitzungen werden nicht übernommen');

  const store = new Store(db);
  const state = store.state(store.requireEvent('K7Q2-MX9P-4HTR'));
  assert.equal(state.expenses[0].amount_cents, 4250);
  assert.equal(typeof state.expenses[0].version, 'number');
  assert.equal(state.summary.people.p2aaaaaaaaaaaaaa.balance, -2125);
  assert.deepEqual(state.summary.plan, [{ from: 'p2aaaaaaaaaaaaaa', to: 'p1aaaaaaaaaaaaaa', amount_cents: 2125 }]);
  assert.equal(store.myEvents('u1aaaaaaaaaaaaaa')[0].name, 'Stuttgart Night');

  assert.throws(() => importPhpMyAdmin(db, EXPORT), /nicht leer/, 'nur in eine leere Datenbank');
  assert.throws(() => importPhpMyAdmin(new Database(':memory:'), '{}'), /JSON/);
  db.close();
});

test('Kommandozeile: Import, Notfall-Passwortlink und Sicherung', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'friendsplit-cli-'));
  try {
    const env = { ...process.env, DATABASE_FILE: join(tmp, 'app.sqlite'), NODE_NO_WARNINGS: '1' };
    const exportFile = join(tmp, 'export.json');
    writeFileSync(exportFile, EXPORT);

    let out = execFileSync(process.execPath, [cli, 'import-phpmyadmin', exportFile], { env, encoding: 'utf8' });
    assert.match(out, /fs_events: 1/);
    assert.match(out, /tim: https:\/\/DEINE-DOMAIN\/#\/passwort\/[2-9A-Z]{4}-[2-9A-Z]{4}-[2-9A-Z]{4}/, 'Reset-Link für alte Konten');

    out = execFileSync(process.execPath, [cli, 'reset-link', 'Tim'], { env, encoding: 'utf8' });
    assert.match(out, /#\/passwort\//);

    const backup = join(tmp, 'sicherung.sqlite');
    execFileSync(process.execPath, [cli, 'backup', backup], { env, encoding: 'utf8' });
    assert.ok(existsSync(backup));
    const copy = new Database(backup);
    assert.equal(copy.value('SELECT name FROM fs_events'), 'Stuttgart Night');
    copy.close();

    assert.throws(() => execFileSync(process.execPath, [cli, 'reset-link', 'niemand'], { env, stdio: 'pipe' }));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
