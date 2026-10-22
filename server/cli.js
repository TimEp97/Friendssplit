// Kommandozeile für den Betrieb. Nutzt dieselbe Datenbank wie der Server (DATABASE_FILE).
//
//   node server/cli.js backup <ziel.sqlite>          Sicherungskopie (auch im laufenden Betrieb)
//   node server/cli.js reset-link <benutzername>      Passwort-Link, z. B. wenn der Admin sein Passwort vergessen hat
//   node server/cli.js import-phpmyadmin <datei.json> Daten der alten PHP-Version übernehmen (phpMyAdmin-Export als JSON)

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Database } from './lib/db.js';
import { Auth } from './lib/auth.js';
import { loadConfig } from './config.js';

/** Reihenfolge berücksichtigt Fremdschlüssel. Sitzungen und Login-Versuche werden nicht übernommen. */
const IMPORT_TABLES = [
  'fs_users', 'fs_events', 'fs_persons', 'fs_event_participants', 'fs_expenses',
  'fs_expense_shares', 'fs_settlements', 'fs_activity', 'fs_tokens',
];

/**
 * Übernimmt einen phpMyAdmin-JSON-Export der alten PHP/MySQL-Version in eine leere Datenbank.
 * Spalten werden nur übernommen, wenn es sie in der Zieltabelle gibt.
 * @returns {{counts: Record<string, number>, users: {id: string, username: string}[]}}
 */
export function importPhpMyAdmin(db, text) {
  if (db.value('SELECT COUNT(*) AS n FROM fs_events') > 0 || db.value('SELECT COUNT(*) AS n FROM fs_users') > 0) {
    throw new Error('Die Datenbank ist nicht leer. Der Import ist nur in eine neue, leere Datenbank möglich.');
  }
  // Ältere phpMyAdmin-Versionen schreiben einen Kommentar vor das JSON-Array.
  const start = text.indexOf('[');
  if (start < 0) throw new Error('Keine JSON-Daten gefunden. Bitte in phpMyAdmin als Format „JSON“ exportieren.');
  const blocks = JSON.parse(text.slice(start));
  const tables = new Map(blocks.filter((b) => b?.type === 'table' && Array.isArray(b.data)).map((b) => [b.name, b.data]));
  if (!tables.has('fs_events')) throw new Error('Im Export fehlt die Tabelle fs_events. Bitte alle fs_-Tabellen exportieren.');

  const counts = {};
  db.transaction(() => {
    for (const table of IMPORT_TABLES) {
      const rows = tables.get(table) ?? [];
      const columns = new Map(db.all(`PRAGMA table_info(${table})`).map((c) => [c.name, c.type.toUpperCase()]));
      for (const row of rows) {
        const names = Object.keys(row).filter((name) => columns.has(name));
        const values = names.map((name) => {
          const value = row[name];
          if (value === null || value === undefined) return null;
          return columns.get(name) === 'INTEGER' ? Number(value) : String(value);
        });
        const placeholders = names.map(() => '?').join(', ');
        db.run(`INSERT INTO ${table} (${names.join(', ')}) VALUES (${placeholders})`, ...values);
      }
      counts[table] = rows.length;
    }
  });
  return { counts, users: db.all('SELECT id, username FROM fs_users ORDER BY username') };
}

function main(argv) {
  const [command, arg] = argv;
  const config = loadConfig(process.env);
  if (!command || !arg) {
    console.log('Aufruf: node server/cli.js backup <ziel.sqlite> | reset-link <benutzername> | import-phpmyadmin <export.json>');
    return 1;
  }
  const db = new Database(config.databaseFile);
  try {
    if (command === 'backup') {
      db.backup(arg);
      console.log(`Sicherung gespeichert: ${arg}`);
    } else if (command === 'reset-link') {
      const user = db.get('SELECT id FROM fs_users WHERE username = ?', arg.trim().toLowerCase());
      if (!user) throw new Error(`Kein Konto mit dem Benutzernamen „${arg}“.`);
      printResetLink(db, user.id, arg);
    } else if (command === 'import-phpmyadmin') {
      const { counts, users } = importPhpMyAdmin(db, readFileSync(arg, 'utf8'));
      console.log('Übernommen:');
      for (const [table, n] of Object.entries(counts)) console.log(`  ${table}: ${n}`);
      if (users.length) {
        console.log('\nPasswörter der alten Version können nicht übernommen werden. Links zum Setzen eines neuen Passworts (24 Stunden gültig):');
        for (const user of users) printResetLink(db, user.id, user.username);
      }
    } else {
      throw new Error(`Unbekannter Befehl: ${command}`);
    }
    return 0;
  } catch (error) {
    console.error(`Fehler: ${error.message}`);
    return 1;
  } finally {
    db.close();
  }
}

function printResetLink(db, userId, username) {
  const auth = new Auth(db, {}, {});
  const { code } = auth.issueResetLink(userId, null);
  const formatted = code.match(/.{4}/g).join('-');
  console.log(`  ${username}: https://DEINE-DOMAIN/#/passwort/${formatted}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exitCode = main(process.argv.slice(2));
}
