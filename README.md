# FriendSplit

Mobile-first Web-App, mit der eine Freundesgruppe gemeinsame Ausgaben für einen Ausflug, Abend oder ein Event erfasst und fair abrechnet.

- Events anlegen, Teilnehmende hinzufügen, per Link oder Code einladen
- Ausgaben mit Betrag, Beschreibung, Kategorie (🍹 🍕 🎟️ 🚕 🏨 🛍️), zahlender Person, Beteiligten, Datum und Notiz
- Automatische, centgenaue Aufteilung, Salden je Person und ein Ausgleichsplan („Sam zahlt Alex 20,00 €“)
- Zahlungen als erledigt markieren (und zurücknehmen), Verlauf aller Änderungen
- Änderungen anderer erscheinen automatisch (Aktualisierung alle 15 s und beim Zurückkehren in den Tab)
- **Benutzerkonten (optional):** Anmeldung mit Benutzername und Passwort, Registrierung nur per Einladung vom Admin. Mit Konto liegen „Meine Events“ auf dem Server und erscheinen auf jedem Gerät. Ohne Konto funktioniert alles weiter per Link/Code.
- **Admin-Bereich:** Freunde einladen, Passwort-Links erzeugen, Konten sperren, löschen oder zum Admin machen, alle Events sehen

## Technik

| Teil | Umsetzung |
|---|---|
| Server | **Node.js ≥ 22.13** (im Docker-Image Node 24) – **ohne ein einziges Zusatzpaket**: HTTP-Server, Datenbank (`node:sqlite`) und Passwort-Hashing (`scrypt`) sind Bordmittel von Node.js |
| Datenbank | SQLite in einer Datei (`/data/friendsplit.sqlite`), Schema-Updates automatisch beim Start |
| Frontend | HTML, CSS und reines JavaScript – kein Build-Schritt |
| Betrieb | Docker-Image (läuft als unprivilegierter Benutzer, schreibgeschütztes Dateisystem) und Caddy für automatisches HTTPS |

Warum ohne Zusatzpakete? Jedes npm-Paket ist fremder Code, der mit vollen Rechten läuft und aktualisiert werden muss. Ohne Abhängigkeiten gibt es keine Lieferketten-Risiken und nichts außer Node.js selbst zu patchen.

```
server/
├── main.js          Start (Konfiguration über Umgebungsvariablen)
├── app.js           HTTP-Server: Oberfläche ausliefern, API, Sicherheits-Header
├── cli.js           Kommandozeile: Sicherung, Notfall-Passwortlink, Import aus der alten PHP-Version
├── config.js
└── lib/
    ├── db.js        SQLite, Schema und Migrationen
    ├── store.js     Events, Ausgaben, Zahlungen, Verlauf
    ├── auth.js      Konten, Sitzungen, Einladungen, Admin
    └── split.js     Rechenlogik (Aufteilung, Salden, Ausgleichsplan)
public/              Oberfläche (index.html, assets/)
tests/               node --test: split, api (end-to-end über HTTP), cli
Dockerfile, compose.yaml, Caddyfile, .env.example
docs/                KONZEPT-Konten-und-Login.md
```

## Installation auf einem eigenen Server (empfohlen)

Klassisches Webhosting wie ALL-INKL führt nur PHP aus, kein Node.js. FriendSplit läuft deshalb auf einem kleinen eigenen Server (z. B. Hetzner Cloud CX22 oder netcup VPS, ca. 4–5 €/Monat, Rechenzentrum in Deutschland). Deine bestehende Webseite bleibt, wo sie ist, und verlinkt einfach auf FriendSplit.

1. **Server anlegen** mit Ubuntu 24.04 und Docker installieren: `curl -fsSL https://get.docker.com | sh`.
2. **Subdomain einrichten:** Beim Domain-Anbieter (bei ALL-INKL im KAS unter *Domain → DNS-Einstellungen*) einen A-Record anlegen, z. B. `friendsplit.deine-domain.de` → IP-Adresse des Servers.
3. **Dateien auf den Server holen:** `git clone https://github.com/TimEp97/Friendssplit.git && cd Friendssplit`
4. **Konfiguration:** `cp .env.example .env` und eintragen:
   - `DOMAIN=friendsplit.deine-domain.de`
   - `SETUP_KEY=` langer Zufallswert, z. B. Ausgabe von `openssl rand -hex 24`
5. **Starten:** `docker compose up -d`. Caddy holt automatisch ein Let's-Encrypt-Zertifikat und leitet `http://` auf `https://` um.
6. **Admin-Konto:** `https://friendsplit.deine-domain.de` öffnen → *„Admin-Konto einrichten“* → Setup-Schlüssel, Name, Benutzername und Passwort eingeben. Danach `SETUP_KEY` in `.env` leeren und `docker compose up -d` erneut ausführen.
7. **Freunde einladen:** *Konto → Admin-Bereich → Einladungslink erstellen* und den Link verschicken.
8. **Einbinden:** Auf deiner Webseite einen Link auf `https://friendsplit.deine-domain.de` setzen.

Andere Plattformen, die ein Docker-Image mit dauerhaftem Speicher betreiben (z. B. Fly.io mit Volume), funktionieren ebenfalls: Das Volume unter `/data` einhängen, `TRUST_PROXY=true` setzen, wenn die Plattform HTTPS übernimmt.

### Konfiguration (Umgebungsvariablen)

| Variable | Standard | Bedeutung |
|---|---|---|
| `PORT` / `HOST` | `3000` / `127.0.0.1` (Docker: `0.0.0.0`) | Adresse des Servers |
| `DATABASE_FILE` | `data/friendsplit.sqlite` (Docker: `/data/friendsplit.sqlite`) | SQLite-Datei |
| `SETUP_KEY` | – | Einmalig zum Anlegen des ersten Admin-Kontos (mind. 16 Zeichen), danach entfernen |
| `REQUIRE_HTTPS` | `true` | Anmelden nur über HTTPS. Nur lokal auf `false` setzen |
| `TRUST_PROXY` | `false` (Compose: `true`) | `X-Forwarded-Proto`/`-For` des vorgeschalteten Proxys auswerten |
| `PUBLIC_PATH` | `/` | Falls die App unter einem Unterpfad läuft (z. B. `/friendsplit/`), für den Cookie-Pfad |

### Betrieb

```bash
docker compose exec app node server/cli.js backup /data/sicherung-$(date +%F).sqlite   # Sicherung im laufenden Betrieb
docker compose cp app:/data/sicherung-2026-10-22.sqlite .                            # Sicherung herunterladen
docker compose exec app node server/cli.js reset-link tim                            # Admin hat Passwort vergessen
git pull && docker compose up -d --build                                             # Update
```

Für automatische Sicherungen den ersten Befehl z. B. täglich per `crontab -e` ausführen. Ubuntu-Sicherheitsupdates mit `unattended-upgrades` automatisch einspielen lassen.

### Umzug von der alten PHP-Version

1. In phpMyAdmin (bei ALL-INKL: *KAS → Datenbanken → phpMyAdmin*) die Datenbank wählen → *Exportieren* → Methode *Angepasst* → alle `fs_`-Tabellen markieren → Format **JSON** → Datei herunterladen.
2. Datei auf den Server kopieren und in die (noch leere) Datenbank übernehmen:
   ```bash
   docker compose cp export.json app:/tmp/export.json
   docker compose exec app node server/cli.js import-phpmyadmin /tmp/export.json
   ```
3. Events, Ausgaben, Zahlungen, Verlauf, Konten und offene Einladungen werden übernommen. Passwörter der PHP-Version (bcrypt) kann Node.js ohne Zusatzpaket nicht prüfen; der Import gibt deshalb für jedes Konto einen Link zum Setzen eines neuen Passworts aus (24 Stunden gültig, `DEINE-DOMAIN` ersetzen). Gibt es noch keine Konten, entfällt dieser Schritt – dann wie oben das Admin-Konto einrichten.
4. Danach die PHP-Dateien (`/friendsplit/` bzw. `api/`) per FTP vom Webspace löschen und die Datenbank in phpMyAdmin leeren oder löschen.

Alte Links (`https://deine-domain.de/friendsplit/#/e/CODE`) zeigen danach ins Leere – die Codes selbst bleiben gültig: In der neuen App unter *„Mit Code beitreten“* eingeben. Wer möchte, ersetzt `/friendsplit/index.html` auf dem Webspace durch eine Weiterleitung auf die neue Adresse.

## Lokale Entwicklung und Tests

```bash
npm run dev     # http://127.0.0.1:3000, ohne HTTPS-Pflicht, Setup-Schlüssel: lokaler-entwicklungs-schluessel
npm test        # alle Tests (node --test): Rechenlogik, API end-to-end über HTTP, Kommandozeile
```

Es gibt kein `npm install` – das Projekt hat keine Abhängigkeiten.

## Berechnungsregeln

- **Aufteilung:** Jede Ausgabe wird gleichmäßig auf die ausgewählten Beteiligten verteilt; nicht Beteiligte erhalten keinen Anteil.
- **Rundung:** Jede Person bekommt `floor(Betrag / Anzahl)` Cent. Die übrigen Rest-Cents (höchstens Anzahl − 1) werden einzeln vergeben – **zuerst an die zahlende Person, sofern sie beteiligt ist, danach in der Reihenfolge der Teilnehmendenliste**. Die Summe der Anteile ist dadurch immer exakt der Rechnungsbetrag. Beispiel: 10,00 € auf Alex, Mathis, Sam, bezahlt von Sam → Sam 3,34 €, Alex 3,33 €, Mathis 3,33 €.
- **Saldo** = selbst bezahlt − eigener Anteil + geleistete Ausgleichszahlungen − erhaltene Ausgleichszahlungen.
- **Ausgleichsplan:** Die Person mit der größten Schuld zahlt an die Person mit dem größten Guthaben, bis alles ausgeglichen ist – höchstens *n − 1* Zahlungen. Vorschläge verändern keine Ausgaben.
- Beträge werden ausschließlich als ganze Cent (Integer) gespeichert und berechnet. Die Anteile werden pro Ausgabe gespeichert (`fs_expense_shares`), damit später auch ungleiche Aufteilungen möglich sind.

## Sicherheit und Datenschutz

- **Kein fremder Code auf dem Server:** keine npm-Pakete; der Container läuft als Benutzer `node` ohne Root-Rechte, mit schreibgeschütztem Dateisystem (nur `/data` ist beschreibbar), ohne Linux-Capabilities und mit `no-new-privileges`.
- **Datenbank:** ausschließlich vorbereitete Statements mit Platzhaltern – Eingaben werden nie in SQL eingesetzt.
- **Auslieferung:** Nur die Dateien aus `public/` werden ausgeliefert; sie werden beim Start in den Speicher geladen, Pfade aus Anfragen werden nie auf das Dateisystem angewendet. Strenge Content-Security-Policy (nur eigene Skripte, keine Inline-Skripte), `X-Frame-Options`, `nosniff`, `Referrer-Policy: no-referrer`, HSTS. Anfragen sind auf 64 KB und 30 Sekunden begrenzt.
- **Event-Zugang:** Jedes Event hat einen zufälligen Zugangscode aus 12 Zeichen (≈ 60 Bit, ohne verwechselbare Zeichen wie 0/O, 1/I), z. B. `K7Q2-MX9P-4HTR`. Er steht nur im `#`-Teil des Links und landet dadurch nicht in Server-Logs oder Referrern. Jeder Datenbankzugriff ist auf das Event dieses Codes beschränkt.
- **Konten (optional):** Registrierung nur mit Einladungslink vom Admin. Passwörter werden mit `scrypt` (N = 2¹⁵, eigenes Salt) gespeichert, mindestens 10 Zeichen. Die Sitzung ist ein `HttpOnly`-/`Secure`-/`SameSite=Lax`-Cookie, das nur an `/api` geht; in der Datenbank liegt nur sein SHA-256-Hash. „Angemeldet bleiben“ gilt 90 Tage, sonst 12 Stunden. Nach 5 Fehlversuchen pro Benutzername (20 pro IP) ist die Anmeldung 15 Minuten gesperrt. Schreibende Aufrufe brauchen den Header `X-Requested-With: FriendSplit` (CSRF-Schutz). Anmelden ist nur über HTTPS möglich.
- **Personen:** Angemeldet ist man im Event fest mit „seiner“ Person verknüpft – niemand sonst kann sie wählen, und Einträge laufen sicher auf diesen Namen. Ohne Konto ist die Namensauswahl **keine sichere Anmeldung** (darauf weist die App hin); Personen mit Konto sind dann nicht wählbar.
- **Rechte:** Alle Teilnehmenden – mit oder ohne Konto – dürfen Ausgaben anlegen, ändern und löschen. Dafür gibt es Transparenz: Jede Ausgabe zeigt, wer sie eingetragen und zuletzt geändert hat, und der **Verlauf** protokolliert jede Änderung. Nur wer das Event mit Konto erstellt hat, und Admins können den Zugangscode erneuern, Konto-Verknüpfungen lösen und das Event löschen.
- **Gespeichert** werden Anzeigenamen in Events und – nur für Konten – Benutzername, Anzeigename, Passwort-Hash, Sitzungen (inkl. Browser-Kennung) und für 24 Stunden gehashte IP-Adressen fehlgeschlagener Anmeldungen. Keine E-Mail-Adressen oder Telefonnummern. Beim Löschen eines Kontos bleibt der Name im Event mit allen Ausgaben erhalten.

## Zuverlässigkeit

- **Speichern:** Die App meldet Erfolg erst nach der Bestätigung durch den Server. Bei Fehlern bleibt das Formular ausgefüllt, es erscheint eine verständliche Meldung und die Möglichkeit, erneut zu speichern.
- **Doppelte Einträge:** Jedes geöffnete Formular hat ein Einmal-Token. Ein wiederholtes Absenden (z. B. nach einem Verbindungsabbruch) legt die Ausgabe nicht doppelt an. Zusätzlich warnt die App, wenn eine sehr ähnliche Ausgabe schon existiert.
- **Gleichzeitige Änderungen:** Ausgaben haben eine Versionsnummer (optimistisches Sperren). Wer eine inzwischen geänderte Ausgabe speichern oder löschen will, sieht den aktuellen Stand und entscheidet: „Aktuelle Version laden“ oder „Meine Version trotzdem speichern“. Schreibvorgänge laufen in Transaktionen nacheinander ab.
- **Validierung** auf Server und Client: Betrag > 0,00 € (max. 100.000 €), mindestens eine beteiligte Person, zahlende Person muss teilnehmen, gültiges Datum, Längenbegrenzungen.
- Personen, die an Ausgaben oder Zahlungen beteiligt sind, können nicht entfernt werden, damit keine Abrechnung kaputtgeht.

## API (Kurzüberblick)

`/api?action=…`, JSON. Event-Zugriff über den Header `X-Event-Code`; angemeldet über das Cookie `fs_session`, ohne Konto die gewählte Person über `X-Person-Id`. POST-Aufrufe brauchen `X-Requested-With: FriendSplit` und `Content-Type: application/json`.

| Aktion | Methode | Zweck |
|---|---|---|
| `create_event` | POST | Event mit Teilnehmenden anlegen → `code`, `person_id` |
| `event` | GET | Gesamtzustand: Event, Teilnehmende, Ausgaben mit Anteilen, Zahlungen, Salden, Plan, Verlauf |
| `update_event` | POST | Name, Datum, Ort, Notiz ändern |
| `add_participant` / `rename_participant` / `remove_participant` | POST | Teilnehmende verwalten |
| `save_expense` | POST | Ausgabe anlegen (`client_token`) oder ändern (`id` + `version`) |
| `delete_expense` | POST | Ausgabe löschen (`id` + `version`) |
| `add_settlement` / `delete_settlement` | POST | Ausgleichszahlung als erledigt markieren bzw. zurücknehmen |
| `join_event` / `leave_event` | POST | Konto mit einer Person im Event verknüpfen (`person_id` oder neuer `name`) bzw. Verknüpfung lösen |
| `unlink_participant` / `regenerate_code` / `delete_event` | POST | nur Ersteller:in und Admins |
| `me` / `health` | GET | angemeldetes Konto und ob die Ersteinrichtung fehlt / Statusprüfung |
| `setup_admin` / `register` / `login` / `logout` | POST | erstes Admin-Konto, Registrierung mit Einladung, An- und Abmelden |
| `check_invite` / `check_reset` / `reset_password` | GET/POST | Einladungs- und Reset-Links prüfen, neues Passwort setzen |
| `update_profile` / `change_password` | POST | eigenes Konto |
| `my_events` / `import_local` | GET/POST | „Meine Events“; auf dem Gerät gespeicherte Events ins Konto übernehmen |
| `admin_overview`, `admin_create_invite`, `admin_revoke_invite`, `admin_reset_link`, `admin_update_user`, `admin_delete_user` | GET/POST | Admin-Bereich |

Jede Änderung an einem Event antwortet mit dem neuen Gesamtzustand. Fehler kommen als `{ ok: false, error: { code, message, fields? } }` mit passendem HTTP-Status (401, 403, 404, 409, 422, 429, …).

## Mögliche Erweiterungen

Individuelle bzw. ungleiche Anteile (das Datenmodell ist vorbereitet), Export als CSV/PDF, mehrere Währungen, Belegfotos, Passwort-Reset per E-Mail, Zwei-Faktor-Anmeldung für Admins, Echtzeit-Updates per Server-Sent Events. Hintergrund zu den Konten: [Konzept](docs/KONZEPT-Konten-und-Login.md).
