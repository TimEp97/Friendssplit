# Konzept: Benutzerkonten, Login und „Meine Projekte“

Stand: 22.10.2026 · **umgesetzt** (siehe Abschnitt 11 für die getroffenen Entscheidungen)

> **Hinweis:** Das Konzept entstand für die erste Version in PHP + MySQL bei ALL-INKL. Am 22.10.2026 wurde die App komplett auf **Node.js ohne Zusatzpakete** umgestellt. Abläufe, Rollen, Datenmodell (Tabellen und Spalten) und API-Aktionen gelten unverändert; technisch umgesetzt ist es jetzt so:
>
> | Konzept (PHP-Version) | Umsetzung (Node.js) |
> |---|---|
> | MySQL bei ALL-INKL, Import per phpMyAdmin | SQLite (`node:sqlite`) in `/data`, Schema-Versionen über `PRAGMA user_version` (`server/lib/db.js`) |
> | `password_hash()` (bcrypt) | `scrypt` aus `node:crypto` (`server/lib/auth.js`) |
> | `api/index.php?action=…`, `config.php` | `/api?action=…`, Umgebungsvariablen (`SETUP_KEY`, `REQUIRE_HTTPS`, …) |
> | HTTPS über ALL-INKL (KAS) | Caddy vor dem Node-Server, automatisches Let's-Encrypt-Zertifikat (`compose.yaml`) |
> | `.htaccess`-Sperren und -Header | Server liefert nur Dateien aus `public/` aus und setzt die Sicherheits-Header selbst |
> | Tests `tests/*.php` | `npm test` (`node --test`) |
>
> Abschnitt 1 beschreibt die Diagnose an der PHP-Version und ist nur noch historisch. Betrieb und Umzug: siehe README.

In diesem Dokument heißen die bisherigen „Events“ auch **Projekte**. Gemeint ist dasselbe.

---

## 1. Warum die Projekte „verschwinden“: Diagnose

Die Projekte selbst werden **auf dem Server in MySQL gespeichert**: `create_event` schreibt in `fs_events`, die Tests (`tests/ApiTest.php`) laufen grün. Verloren geht etwas anderes:

| Was | Wo gespeichert | Folge |
|---|---|---|
| Projekt, Ausgaben, Zahlungen | MySQL auf dem Server | bleibt erhalten |
| Liste **„Meine Events“** auf der Startseite | `localStorage` des Browsers (`fs.events`, siehe `public/assets/app.js:123`) | gilt nur für **dieses eine Gerät in diesem einen Browser** |
| „Wer bin ich in diesem Projekt“ | `localStorage` (`fs.me.<code>`) | dasselbe |

Die Liste ist deshalb leer bzw. das Projekt „weg“, sobald jemand
- ein anderes Handy, einen anderen PC oder einen anderen Browser nimmt,
- den Link aus WhatsApp/Instagram öffnet (die haben einen eigenen, eingebauten Browser mit eigenem Speicher),
- im privaten Modus surft oder Verlauf und Websitedaten löscht (Safari macht das bei selten besuchten Seiten nach 7 Tagen automatisch).

Das Projekt existiert dann weiterhin. Man kommt aber nur mit dem **Zugangscode bzw. dem Link** wieder hinein, und den hat man meist nicht mehr. Genau das löst ein Benutzerkonto: Die Liste „Meine Projekte“ liegt dann auf dem Server und erscheint nach dem Login auf jedem Gerät.

### Zum Ausschließen: Fehler bei der Einrichtung

Falls beim Erstellen eine **Fehlermeldung** erscheint (z. B. „Deine Änderung wurde nicht gespeichert“ oder „noch nicht eingerichtet“), liegt zusätzlich ein Problem auf dem Server vor:

1. `https://deine-domain.de/friendsplit/api/index.php?action=event` im Browser aufrufen.
   - `not_configured` → `api/config.php` fehlt. Sie ist absichtlich nicht im Git-Repository (`.gitignore`) und muss per FTP angelegt werden.
   - `db_unavailable` → Zugangsdaten in `config.php` prüfen.
   - `server_error` → Tabellen fehlen: `api/schema/mysql.sql` in phpMyAdmin importieren.
   - `event_not_found` → **alles in Ordnung**, Server und Datenbank funktionieren.
2. In phpMyAdmin in die Tabelle `fs_events` schauen: Stehen dort die angelegten Projekte, ist der Server in Ordnung und die Ursache ist die oben beschriebene Geräte-Liste.

---

## 2. Ziele

1. **Jede Person hat ein Konto** (du als Admin und alle Freunde) und meldet sich mit Benutzername und Passwort an.
2. **„Meine Projekte“ wird pro Konto auf dem Server gespeichert** und ist auf jedem Gerät gleich.
3. **Teilen per Code bleibt**: Wer den Code oder Link bekommt, tritt nach dem Login bei, und ab dann steht das Projekt dauerhaft in seiner Liste.
4. **Echte Zuordnung**: Wer eine Ausgabe einträgt oder ändert, ist eindeutig die angemeldete Person. Die unsichere Namensauswahl („Wer bist du?“) entfällt.
5. **Admin-Bereich** für dich: Freunde einladen, Passwörter zurücksetzen, Konten sperren, alle Projekte sehen.
6. **Bestehende Projekte gehen nicht verloren** und lassen sich ins Konto übernehmen.
7. Weiterhin **ohne Composer, Node.js oder externe Dienste** auf ALL-INKL lauffähig.

Nicht Ziel der ersten Ausbaustufe: Login mit Google/Apple, Zwei-Faktor-Anmeldung, E-Mail-Versand (alles später möglich, siehe Abschnitt 10).

---

## 3. Rollen und Rechte

| Rolle | Wer | Darf |
|---|---|---|
| **Admin** | du | alles, was Mitglieder dürfen; außerdem Einladungen erstellen, Konten sperren/entsperren, Passwörter zurücksetzen, alle Projekte sehen und löschen |
| **Mitglied** | deine Freunde | Projekte anlegen, Projekten per Code beitreten, in eigenen Projekten Ausgaben/Zahlungen erfassen |

Innerhalb eines Projekts:

| Projekt-Rolle | Darf |
|---|---|
| **Ersteller/in** (Owner) | zusätzlich: Code erneuern, Konto-Verknüpfungen lösen, Projekt löschen |
| **Teilnehmende** (mit oder ohne Konto) | wie bisher alles andere: Ausgaben anlegen, ändern, löschen; Zahlungen markieren; Projektdaten und Teilnehmende bearbeiten (Transparenz über Verlauf statt Verbote) |

Der Admin hat in jedem Projekt dieselben Rechte wie der Owner.

---

## 4. So fühlt es sich an (Abläufe)

### 4.1 Erstes Einrichten (einmalig, durch dich)

1. Neue Dateien hochladen, Datenbank-Update ausführen (wie bisher über `setup_key` oder phpMyAdmin).
2. Die App erkennt, dass es noch **kein Konto** gibt, und zeigt die Seite **„Admin-Konto anlegen“**. Diese Seite ist nur mit dem `setup_key` aus `config.php` nutzbar.
3. Du vergibst Benutzername, Anzeigename und Passwort. Danach ist die Seite gesperrt.

### 4.2 Freunde einladen

1. Admin-Bereich → **„Einladung erstellen“** (optional mit Notiz „für Alex“, Gültigkeit z. B. 14 Tage, einmalig oder mehrfach nutzbar).
2. Die App zeigt einen Link, z. B. `https://deine-domain.de/friendsplit/#/registrieren/QX7M-4KPT-9HWA`, zum Teilen per WhatsApp.
3. Alex öffnet den Link, wählt Benutzername, Anzeigename und Passwort und ist sofort angemeldet.

Ohne Einladung kann sich niemand registrieren. So bleibt die App unter euch, auch wenn jemand die Adresse kennt.

### 4.3 Anmelden

- Benutzername + Passwort, Häkchen **„Angemeldet bleiben“** (90 Tage, verlängert sich bei Nutzung).
- Danach erscheint die Startseite mit **„Meine Projekte“**, auf allen Geräten gleich.

### 4.4 Projekt anlegen und teilen

1. „Neues Projekt“ → Name, Datum, Ort. Du bist automatisch Teilnehmer und Owner. Weitere Namen kannst du schon vorab eintragen (z. B. für Freunde ohne Konto).
2. **Teilen**: Link oder Code (`K7Q2-MX9P-4HTR`) wie bisher kopieren und verschicken.

### 4.5 Per Code beitreten

1. Freund/in öffnet den Link oder tippt den Code unter „Mit Code beitreten“ ein (ggf. erst Login).
2. Die App zeigt eine Vorschau: Projektname, Datum, Teilnehmende.
3. **„Wer bist du?“**, aber jetzt verbindlich:
   - einen vorab eingetragenen Namen wählen, der noch **keinem Konto gehört** („Das bin ich“), **oder**
   - „Mich neu hinzufügen“ (Anzeigename aus dem Konto).
4. Ab jetzt steht das Projekt dauerhaft in „Meine Projekte“, auf jedem Gerät. Der Code wird für diese Person nicht mehr gebraucht.

Ein Name, der schon einem Konto gehört, kann nicht mehr von jemand anderem übernommen werden. Wurde versehentlich der falsche Name gewählt, kann der Owner oder Admin die Zuordnung lösen.

### 4.6 Alte Projekte übernehmen

Beim **ersten Login auf einem Gerät** schaut die App in den alten lokalen Speicher (`fs.events`, `fs.me.*`). Findet sie Projekte, fragt sie: *„Auf diesem Gerät sind 3 Projekte gespeichert. In dein Konto übernehmen?“* Bei Ja werden die Namen, die auf diesem Gerät als „ich“ gewählt waren, deinem Konto zugeordnet (sofern noch frei). Projekte ohne Namenswahl werden nur beigetreten, die Person wählst du dann beim Öffnen.

Für Projekte, deren Code niemand mehr hat, kann der Admin sie im Admin-Bereich (Liste aller Projekte) finden und den Code weitergeben.

### 4.7 Passwort vergessen

Da die App bewusst keine E-Mails verschickt: Der Admin klickt beim Konto auf **„Passwort zurücksetzen“** und bekommt einen einmaligen Link (24 h gültig), den er per WhatsApp weitergibt. Dort setzt die Person ein neues Passwort; alle alten Anmeldungen werden dabei beendet.

### 4.8 Code erneuern

Ist ein Code in die falsche Gruppe geraten, erzeugt der Owner einen neuen. **Wer schon beigetreten ist, behält den Zugang**, denn der hängt jetzt am Konto, nicht mehr am Code. Nur der alte Link funktioniert nicht mehr.

---

## 5. Datenmodell

Alle neuen Tabellen mit Präfix `fs_`, InnoDB, `utf8mb4`. IDs wie bisher 16 Zeichen aus `Db::id()`. Alle Änderungen sind **rein ergänzend**, keine bestehende Spalte wird gelöscht.

### 5.1 Neue Tabellen

```sql
CREATE TABLE IF NOT EXISTS fs_users (
  id                   CHAR(16)     NOT NULL,
  username             VARCHAR(40)  NOT NULL,          -- klein geschrieben gespeichert, a–z 0–9 . _ -
  display_name         VARCHAR(60)  NOT NULL,
  email                VARCHAR(190) NULL,              -- optional, für spätere Passwort-Mails
  password_hash        VARCHAR(255) NOT NULL,          -- password_hash(..., PASSWORD_DEFAULT)
  role                 VARCHAR(10)  NOT NULL DEFAULT 'member',  -- 'admin' | 'member'
  status               VARCHAR(10)  NOT NULL DEFAULT 'active',  -- 'active' | 'disabled'
  created_at           DATETIME     NOT NULL,
  last_login_at        DATETIME     NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_username (username)
);

-- Eigene Sitzungen in der Datenbank statt PHP-Sessions (siehe 7.2)
CREATE TABLE IF NOT EXISTS fs_sessions (
  id           CHAR(16)     NOT NULL,
  user_id      CHAR(16)     NOT NULL,
  token_hash   CHAR(64)     NOT NULL,                  -- SHA-256 des Cookie-Werts, nie der Klartext
  created_at   DATETIME     NOT NULL,
  last_seen_at DATETIME     NOT NULL,
  expires_at   DATETIME     NOT NULL,
  user_agent   VARCHAR(190) NULL,                      -- nur zur Anzeige „Angemeldete Geräte“
  PRIMARY KEY (id),
  UNIQUE KEY uq_sessions_token (token_hash),
  KEY idx_sessions_user (user_id),
  CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES fs_users (id) ON DELETE CASCADE
);

-- Einladungen und Passwort-Reset-Links (gleiches Prinzip: einmaliger, gehashter Code)
CREATE TABLE IF NOT EXISTS fs_tokens (
  id          CHAR(16)     NOT NULL,
  kind        VARCHAR(10)  NOT NULL,                   -- 'invite' | 'reset'
  token_hash  CHAR(64)     NOT NULL,
  user_id     CHAR(16)     NULL,                       -- bei 'reset': betroffenes Konto
  created_by  CHAR(16)     NOT NULL,                   -- Admin
  note        VARCHAR(120) NULL,                       -- z. B. „für Alex“
  max_uses    INT          NOT NULL DEFAULT 1,
  uses        INT          NOT NULL DEFAULT 0,
  expires_at  DATETIME     NOT NULL,
  created_at  DATETIME     NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_tokens_hash (token_hash),
  CONSTRAINT fk_tokens_user FOREIGN KEY (user_id) REFERENCES fs_users (id) ON DELETE CASCADE
);

-- Schutz gegen Passwort-Raten
CREATE TABLE IF NOT EXISTS fs_login_attempts (
  id           CHAR(16)    NOT NULL,
  username     VARCHAR(40) NOT NULL,
  ip_hash      CHAR(64)    NOT NULL,                   -- gehashte IP, wird nach 24 h gelöscht
  attempted_at DATETIME    NOT NULL,
  PRIMARY KEY (id),
  KEY idx_attempts_user (username, attempted_at),
  KEY idx_attempts_ip (ip_hash, attempted_at)
);
```

### 5.2 Erweiterungen bestehender Tabellen

```sql
-- Wer hat das Projekt angelegt (Owner)
ALTER TABLE fs_events ADD COLUMN owner_user_id CHAR(16) NULL;

-- Verknüpfung „Konto ↔ Person in einem Projekt“. Genau das ist „Meine Projekte“.
ALTER TABLE fs_event_participants ADD COLUMN user_id CHAR(16) NULL;
ALTER TABLE fs_event_participants ADD UNIQUE KEY uq_participants_user (event_id, user_id);
ALTER TABLE fs_event_participants
  ADD CONSTRAINT fk_participants_user FOREIGN KEY (user_id) REFERENCES fs_users (id) ON DELETE SET NULL;
```

**Warum an `fs_event_participants` und nicht an `fs_persons.auth_user_id`?** Die Verknüpfung gehört zum Projekt: Mit dem eindeutigen Schlüssel `(event_id, user_id)` stellt die Datenbank selbst sicher, dass ein Konto in einem Projekt höchstens eine Person ist. MySQL erlaubt in einem UNIQUE-Schlüssel beliebig viele `NULL`, Personen ohne Konto bleiben also möglich. `fs_persons.auth_user_id` bleibt ungenutzt stehen.

**„Meine Projekte“** ist damit eine einzige Abfrage:

```sql
SELECT e.id, e.access_code, e.name, e.event_date, e.updated_at, p.person_id
FROM fs_event_participants p
JOIN fs_events e ON e.id = p.event_id
WHERE p.user_id = ?
ORDER BY e.updated_at DESC;
```

Da `CREATE TABLE IF NOT EXISTS` keine neuen Spalten anlegt, bekommt `Db::migrate()` eine kleine **Versionsverwaltung**: Tabelle `fs_meta (k, v)` mit `schema_version`, und nummerierte Dateien `schema/mysql/002_konten.sql`, `…/003_….sql`, die genau einmal ausgeführt werden (für SQLite entsprechend).

---

## 6. API

Gleiches Format wie bisher (`api/index.php?action=…`, JSON, Fehler als `{ ok: false, error }`).

### 6.1 Neu: Konto

| Aktion | Methode | Login nötig | Zweck |
|---|---|---|---|
| `setup_admin` | POST | nein, aber `setup_key` | erstes Admin-Konto anlegen; nur möglich, solange `fs_users` leer ist |
| `register` | POST | nein | Konto mit Einladungscode anlegen, danach angemeldet |
| `login` | POST | nein | Benutzername, Passwort, `remember` → setzt Cookie |
| `logout` | POST | ja | aktuelle Sitzung beenden |
| `me` | GET | – | eigenes Konto oder `null`; außerdem `needs_setup: true`, solange es kein Konto gibt |
| `update_profile` / `change_password` | POST | ja | Anzeigename bzw. Passwort ändern (altes Passwort nötig; beendet andere Sitzungen) |
| `reset_password` | POST | nein | neues Passwort mit Reset-Code setzen |
| `my_events` | GET | ja | Liste „Meine Projekte“ (Abfrage oben) |
| `import_local` | POST | ja | alte Geräte-Liste übernehmen: `[{ code, person_id? }]` |

### 6.2 Neu: Projekte beitreten

| Aktion | Methode | Zweck |
|---|---|---|
| `preview_event` | GET | mit `X-Event-Code`: Name, Datum, Teilnehmende inkl. „vergeben ja/nein“, aber noch **keine** Ausgaben |
| `join_event` | POST | mit `X-Event-Code` und `{ person_id }` (freie Person übernehmen) oder `{ new: true }` (sich neu hinzufügen) |
| `regenerate_code` | POST | Owner/Admin: neuen Zugangscode erzeugen |
| `unlink_participant` | POST | Owner/Admin: Konto-Zuordnung einer Person lösen |
| `delete_event` | POST | Owner/Admin: Projekt löschen (mit Bestätigung) |

### 6.3 Neu: Admin

| Aktion | Zweck |
|---|---|
| `admin_users` | alle Konten mit Rolle, Status, letzter Anmeldung, Anzahl Projekte |
| `admin_create_invite` | Einladung erzeugen → Link (der Klartext-Code wird nur dieses eine Mal angezeigt) |
| `admin_invites` / `admin_revoke_invite` | offene Einladungen ansehen bzw. widerrufen |
| `admin_reset_link` | Passwort-Reset-Link für ein Konto erzeugen |
| `admin_set_status` | Konto sperren/entsperren (Sperren beendet alle Sitzungen) |
| `admin_set_role` | Mitglied ↔ Admin (der letzte Admin kann sich nicht selbst herabstufen) |
| `admin_events` | alle Projekte inkl. Code, Owner, Teilnehmerzahl, letzter Änderung |

Alle `admin_*`-Aktionen prüfen serverseitig `role = 'admin'`.

### 6.4 Geänderte bestehende Aktionen

- Da Login **nicht Pflicht** ist (Entscheidung 3), reicht `X-Event-Code` weiterhin für alle Projekt-Aktionen.
- **Angemeldet** ermittelt der Server die handelnde Person aus Konto + Projekt; `X-Person-Id` wird dann ignoriert.
- **Ohne Anmeldung** gilt `X-Person-Id` wie bisher, aber nur für Personen, die mit keinem Konto verknüpft sind. Damit kann niemand im Namen eines Kontos eintragen.
- `create_event`: Mit Konto ist „Dein Name“ mit dem Anzeigenamen vorbelegt; Owner und `user_id` werden gesetzt.
- Wer die Organisator-Person eines (ohne Konto erstellten) Projekts übernimmt, wird dessen Owner.

---

## 7. Sicherheit

### 7.1 Passwörter
- `password_hash()` / `password_verify()` mit `PASSWORD_DEFAULT` (bcrypt, später automatisch stärker), `password_needs_rehash()` beim Login.
- Mindestens 10 Zeichen, keine weiteren Zwangsregeln. Prüfung gegen eine kleine Liste sehr häufiger Passwörter.
- Gleiche Fehlermeldung für „Benutzer unbekannt“ und „Passwort falsch“.

### 7.2 Sitzungen (Cookie)
- Eigene Sitzungen in `fs_sessions` statt PHP-Sessions. Grund: Auf Shared Hosting räumt PHP Sessions oft schon nach 24 Minuten Inaktivität ab (`session.gc_maxlifetime`), „angemeldet bleiben“ wäre dann unzuverlässig.
- Cookie `fs_session` = 32 Zufallsbytes (`random_bytes`), in der DB nur als SHA-256-Hash.
- Cookie-Attribute: `HttpOnly`, `Secure`, `SameSite=Lax`, `Path` = App-Ordner. Ohne „Angemeldet bleiben“ als Sitzungs-Cookie, sonst 90 Tage, verlängert bei Nutzung (höchstens einmal pro Tag in die DB schreiben).
- Neue Sitzung bei jedem Login, Löschung bei Logout, Passwortwechsel und Sperrung.
- **HTTPS ist Pflicht** (Let's-Encrypt im KAS). Ohne HTTPS verweigert der Server den Login mit einer klaren Meldung.

### 7.3 CSRF (fremde Seiten lösen Aktionen aus)
- `SameSite=Lax` blockiert das Mitschicken des Cookies bei fremden POST-Anfragen.
- Zusätzlich verlangt der Server bei jedem POST den Header `X-FriendSplit: 1` und `Content-Type: application/json`. Fremde Seiten können solche Anfragen ohne CORS-Freigabe nicht senden, und die API gibt keine CORS-Freigabe.

### 7.4 Passwort-Raten
- Höchstens **5 Fehlversuche pro Benutzername** und **20 pro IP** in 15 Minuten, danach `429` mit Wartezeit. Einträge älter als 24 h werden bei Gelegenheit gelöscht (kein Cronjob nötig).

### 7.5 Codes und Einladungen
- Projekt-Codes bleiben 12 Zeichen (≈ 60 Bit) und stehen weiter nur im `#`-Teil der URL.
- Einladungs- und Reset-Codes: ebenfalls zufällig, in der DB nur gehasht, mit Ablaufdatum und Nutzungszähler.

### 7.6 Datenschutz
- Neu gespeichert: Benutzername, Anzeigename, optional E-Mail, Passwort-Hash, Sitzungen (inkl. Browser-Kennung), Fehlversuche mit gehashter IP (24 h).
- README und ein kurzer Hinweis in der App („Was wird gespeichert?“) werden ergänzt.
- **Konto löschen**: durch Admin oder selbst. Die Person bleibt in Projekten als Name erhalten (sonst gingen Abrechnungen kaputt), die Zuordnung wird gelöst und das Konto samt Sitzungen gelöscht.

---

## 8. Oberfläche (neue und geänderte Seiten)

| Route | Inhalt |
|---|---|
| `#/login` | Benutzername, Passwort, „Angemeldet bleiben“; Hinweis „Kein Konto? Frag nach einer Einladung.“ |
| `#/registrieren/<code>` | Registrierung mit Einladung |
| `#/passwort/<code>` | neues Passwort setzen (Reset-Link) |
| `#/einrichten` | erstes Admin-Konto (nur solange keines existiert) |
| `#/` Start | **„Meine Projekte“ vom Server**, „Neues Projekt“, „Mit Code beitreten“ |
| `#/e/<code>/beitreten` | Vorschau + „Das bin ich“ / „Mich hinzufügen“ (ersetzt `#/e/<code>/wer`) |
| `#/konto` | Anzeigename, Passwort ändern, angemeldete Geräte abmelden, Abmelden |
| `#/admin` | Tabs: **Konten**, **Einladungen**, **Alle Projekte** |

Die bisherigen Projekt-Ansichten (Ausgaben, Abrechnung, Personen) bleiben gleich. In „Personen“ steht neben jedem Namen, ob ein Konto verknüpft ist („✓ hat Konto“ / „noch nicht beigetreten“).

---

## 9. Umsetzung in Schritten

Jeder Schritt ist für sich lauffähig und wird mit `tests/ApiTest.php` abgesichert.

| # | Schritt | Inhalt | Aufwand (grob) |
|---|---|---|---|
| 0 | **Sofort-Check** | Server prüfen wie in Abschnitt 1; bis Schritt 2 fertig ist: Projekt-Links in einer WhatsApp-Gruppe sammeln | 10 min |
| 1 | **Konten & Login** | Migrationssystem, `fs_users`, `fs_sessions`, `fs_tokens`, `fs_login_attempts`; `setup_admin`, `register`, `login`, `logout`, `me`; Login-/Registrier-Seiten | 1–2 Tage |
| 2 | **Projekte am Konto** | Spalten `owner_user_id`, `user_id`; Zugriffsprüfung in allen Projekt-Aktionen; `my_events`, `preview_event`, `join_event`, `import_local`; Startseite und Beitreten-Seite | 1–2 Tage |
| 3 | **Admin-Bereich** | Konten, Einladungen, Reset-Links, Sperren, alle Projekte | 1 Tag |
| 4 | **Feinschliff** | Code erneuern, Zuordnung lösen, Projekt löschen, Geräteliste, Konto löschen, README/Datenschutzhinweis | 1 Tag |

**Übergang ohne Bruch:** Zwischen Schritt 1 und 2 funktionieren alte Links weiter. Mit Schritt 2 ist für Projekte ein Login nötig; beim ersten Login greift die Übernahme aus Abschnitt 4.6.

---

## 10. Später möglich

- Passwort-Reset per E-Mail (ALL-INKL kann über PHP `mail()` bzw. SMTP versenden), dann wird die E-Mail-Adresse bei der Registrierung Pflicht.
- Gäste-Ansicht nur zum Lesen per Code ohne Konto.
- Zwei-Faktor-Anmeldung (TOTP) für das Admin-Konto.
- Passkeys (Anmeldung per Fingerabdruck/Face-ID über WebAuthn).
- Ungleiche Aufteilungen, Export, Belegfotos (siehe README).

---

## 11. Entscheidungen

1. **Registrierung:** nur mit Einladung vom Admin.
2. **Anmeldename:** Benutzername + Passwort (keine E-Mail).
3. **Zugang ohne Konto:** erlaubt – Login ist nicht Pflicht. Projekte funktionieren weiter per Link/Code; ein Konto sorgt dafür, dass „Meine Projekte“ auf jedem Gerät erscheint und der eigene Name geschützt ist.
4. **Ausgaben bearbeiten:** alle Teilnehmenden (wie bisher, mit Verlauf).
5. **Projekte anlegen:** jede/r – mit oder ohne Konto.

Abweichend von Abschnitt 4.5 gilt deshalb: Wer ohne Konto per Code kommt, wählt wie bisher einen Namen – aber nur einen, der noch keinem Konto gehört.
