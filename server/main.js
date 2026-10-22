// Start: node server/main.js – Konfiguration über Umgebungsvariablen (siehe README bzw. .env.example).

import { fileURLToPath } from 'node:url';
import { Database } from './lib/db.js';
import { createServer } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig(process.env);
const db = new Database(config.databaseFile);
const server = createServer({ ...config, db, publicDir: fileURLToPath(new URL('../public', import.meta.url)) });

server.listen(config.port, config.host, () => {
  console.log(`FriendSplit läuft auf http://${config.host}:${config.port} (Datenbank: ${config.databaseFile})`);
  if (!config.requireHttps) console.warn('Achtung: REQUIRE_HTTPS=false – Anmelden ist auch ohne HTTPS möglich. Nur für die lokale Entwicklung!');
  if (config.setupKey && config.setupKey.length < 16) console.warn('Achtung: SETUP_KEY ist kürzer als 16 Zeichen und wird ignoriert.');
});

function shutdown() {
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
