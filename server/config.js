/** Liest die Konfiguration aus Umgebungsvariablen. */
export function loadConfig(env) {
  const flag = (name, fallback) => {
    const value = env[name];
    if (value === undefined || value === '') return fallback;
    return ['1', 'true', 'yes', 'ja'].includes(value.toLowerCase());
  };
  const publicPath = (env.PUBLIC_PATH || '/').replace(/\/?$/, '/');
  return {
    host: env.HOST || '127.0.0.1',
    port: Number(env.PORT || 3000),
    databaseFile: env.DATABASE_FILE || 'data/friendsplit.sqlite',
    // Einmalig zum Anlegen des ersten Admin-Kontos (mind. 16 Zeichen), danach wieder entfernen.
    setupKey: env.SETUP_KEY || '',
    // Anmelden nur über HTTPS (dringend empfohlen; nur lokal abschalten).
    requireHttps: flag('REQUIRE_HTTPS', true),
    // true, wenn ein Reverse Proxy (z. B. Caddy) davor läuft und X-Forwarded-Proto/-For setzt.
    trustProxy: flag('TRUST_PROXY', false),
    // Pfad, unter dem die App öffentlich erreichbar ist (z. B. /friendsplit/), für das Sitzungs-Cookie.
    cookiePath: `${publicPath}api`,
  };
}
