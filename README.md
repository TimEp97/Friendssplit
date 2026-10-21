# FriendSplit

Mobile-first Web-App, mit der eine Freundesgruppe gemeinsame Ausgaben für einen Ausflug, Abend oder ein Event erfasst und fair abrechnet – gedacht zur Einbindung in eine bestehende Webseite bei **ALL-INKL.COM** (oder jedem anderen Webhosting mit PHP und MySQL).

- Events anlegen, Teilnehmende hinzufügen, per Link oder Code einladen
- Ausgaben mit Betrag, Beschreibung, Kategorie (🍹 🍕 🎟️ 🚕 🏨 🛍️), zahlender Person, Beteiligten, Datum und Notiz
- Automatische, centgenaue Aufteilung, Salden je Person und ein Ausgleichsplan („Sam zahlt Alex 20,00 €“)
- Zahlungen als erledigt markieren (und zurücknehmen), Verlauf aller Änderungen
- Alle Daten zentral in MySQL; Änderungen anderer erscheinen automatisch (Aktualisierung alle 15 s und beim Zurückkehren in den Tab)
- **Benutzerkonten (optional):** Anmeldung mit Benutzername und Passwort, Registrierung nur per Einladung vom Admin. Mit Konto liegen „Meine Events“ auf dem Server und erscheinen auf jedem Gerät. Ohne Konto funktioniert alles weiter per Link/Code.
- **Admin-Bereich:** Freunde einladen, Passwort-Links erzeugen, Konten sperren, löschen oder zum Admin machen, alle Events sehen

## Technik – warum so?

ALL-INKL bietet klassisches Shared Hosting: Apache, PHP 8, MySQL/MariaDB, Upload per FTP, Verwaltung im KAS und per phpMyAdmin – aber kein Node.js. Deshalb:

| Teil | Umsetzung |
|---|---|
| Backend | PHP ≥ 8.1, PDO mit vorbereiteten Statements, keine Abhängigkeiten (kein Composer nötig) |
| Datenbank | MySQL/MariaDB (`utf8mb4`, InnoDB); SQLite für lokale Entwicklung und Tests |
| Frontend | HTML, CSS und reines JavaScript als ES-Module – kein Build-Schritt, einfach hochladen |
| Schriften | Systemschriften, keine externen Ressourcen (kein Google-Fonts-Thema für den Datenschutz) |

```
public/                  ← dieser Ordner kommt auf den Webspace
├── index.html
├── assets/              app.js, app.css, icon.svg
├── api/
│   ├── index.php        JSON-API (einziger öffentlicher PHP-Einstieg)
│   ├── config.sample.php
│   ├── lib/             Split.php (Berechnung), Store.php (Events), Auth.php (Konten), …  – per .htaccess gesperrt
│   └── schema/          mysql.sql, sqlite.sql, update-2.*.sql                          – per .htaccess gesperrt
└── data/                nur für SQLite in der Entwicklung                         – per .htaccess gesperrt
tests/                   SplitTest.php (Berechnung), ApiTest.php (API end-to-end), MigrationTest.php (DB-Update)
docs/                    KONZEPT-Konten-und-Login.md
```

## Installation bei ALL-INKL.COM

1. **Datenbank anlegen:** KAS → *Datenbanken* → *Neue Datenbank*. Datenbankname, Benutzer und Passwort notieren (z. B. `d0123456`).
2. **Dateien hochladen:** Den Inhalt von `public/` per FTP in einen Unterordner deiner Webseite laden, z. B. `/friendsplit/`.
3. **Konfiguration:** `api/config.sample.php` nach `api/config.php` kopieren und Zugangsdaten eintragen:
   ```php
   'dsn'      => 'mysql:host=localhost;dbname=d0123456;charset=utf8mb4',
   'user'     => 'd0123456',
   'password' => '…',
   ```
4. **Tabellen:** werden beim ersten Aufruf der App automatisch angelegt. Alternativ in phpMyAdmin (KAS → Datenbanken → phpMyAdmin) *Importieren* → `api/schema/mysql.sql`.
5. **HTTPS:** Im KAS ein (kostenloses Let's-Encrypt-)Zertifikat für die Domain aktivieren. Anmelden ist aus Sicherheitsgründen nur über `https://` möglich (`require_https` in `config.php`); auch Kopieren und Teilen von Links funktionieren nur so zuverlässig.
6. **Admin-Konto:** In `config.php` einen langen Zufallswert (mind. 16 Zeichen) als `setup_key` eintragen. Die App zeigt dann auf der Startseite *„Admin-Konto einrichten“* – dort Schlüssel, Name, Benutzername und Passwort eingeben. Danach `setup_key` wieder leeren.
7. **Freunde einladen:** *Konto → Admin-Bereich → Einladungslink erstellen* und den Link verschicken.
8. **Einbinden:** Auf der bestehenden Webseite einen Link auf `/friendsplit/` setzen. Alle Pfade sind relativ, der Ordnername ist frei wählbar.

### Update einer bestehenden Installation

Einfach die neuen Dateien hochladen (`api/config.php` bleibt). Beim ersten Aufruf ergänzt die App die Datenbank automatisch um die Tabellen für Konten – vorhandene Events, Ausgaben und Zahlungen bleiben unverändert. Wer das lieber selbst macht: `api/schema/update-2.mysql.sql` in phpMyAdmin importieren. Danach `setup_key` setzen und das Admin-Konto einrichten (Schritt 6).

Beim ersten Anmelden auf einem Gerät bietet die App an, die dort bisher ohne Konto genutzten Events ins Konto zu übernehmen.

Alle Tabellen haben das Präfix `fs_`, damit sie neben bestehenden Tabellen in derselben Datenbank liegen können.

## Lokale Entwicklung und Tests

```bash
cp public/api/config.sample.php public/api/config.php
# in config.php die SQLite-Zeile aktivieren, 'require_https' => false und einen setup_key setzen
php -S localhost:8000 -t public
# → http://localhost:8000

php tests/SplitTest.php   # Rechenlogik inkl. Beispiel aus dem Konzept und Zufallstests
php tests/ApiTest.php     # startet einen Testserver mit temporärer SQLite-DB
php tests/MigrationTest.php  # Update einer alten Datenbank (Version 1) samt Daten
```

## Berechnungsregeln

- **Aufteilung:** Jede Ausgabe wird gleichmäßig auf die ausgewählten Beteiligten verteilt; nicht Beteiligte erhalten keinen Anteil.
- **Rundung:** Jede Person bekommt `floor(Betrag / Anzahl)` Cent. Die übrigen Rest-Cents (höchstens Anzahl − 1) werden einzeln vergeben – **zuerst an die zahlende Person, sofern sie beteiligt ist, danach in der Reihenfolge der Teilnehmendenliste**. Die Summe der Anteile ist dadurch immer exakt der Rechnungsbetrag. Beispiel: 10,00 € auf Alex, Mathis, Sam, bezahlt von Sam → Sam 3,34 €, Alex 3,33 €, Mathis 3,33 €.
- **Saldo** = selbst bezahlt − eigener Anteil + geleistete Ausgleichszahlungen − erhaltene Ausgleichszahlungen.
- **Ausgleichsplan:** Die Person mit der größten Schuld zahlt an die Person mit dem größten Guthaben, bis alles ausgeglichen ist – höchstens *n − 1* Zahlungen. Vorschläge verändern keine Ausgaben.
- Beträge werden ausschließlich als ganze Cent (`INT`) gespeichert und berechnet. Die Anteile werden pro Ausgabe gespeichert (`fs_expense_shares`), damit später auch ungleiche Aufteilungen möglich sind.

## Zugriff, Berechtigungen und Datenschutz

- **Event-Zugang:** Jedes Event hat einen zufälligen Zugangscode aus 12 Zeichen (≈ 60 Bit, ohne verwechselbare Zeichen wie 0/O, 1/I), z. B. `K7Q2-MX9P-4HTR`. Er steht nur im `#`-Teil des Links und landet dadurch nicht in Server-Logs oder Referrern. Jeder Datenbankzugriff ist auf das Event dieses Codes beschränkt.
- **Konten (optional):** Registrierung nur mit Einladungslink vom Admin. Passwörter werden mit `password_hash()` gespeichert (mind. 10 Zeichen). Die Sitzung ist ein HttpOnly-/Secure-/SameSite-Cookie, dessen Wert in der Datenbank nur als SHA-256-Hash liegt; „Angemeldet bleiben“ gilt 90 Tage, sonst 12 Stunden. Nach 5 Fehlversuchen pro Benutzername (20 pro IP) ist die Anmeldung 15 Minuten gesperrt. Schreibende Aufrufe brauchen den Header `X-Requested-With: FriendSplit` (CSRF-Schutz).
- **Personen:** Angemeldet ist man im Event fest mit „seiner“ Person verknüpft – niemand sonst kann sie wählen, und Einträge laufen sicher auf diesen Namen. Ohne Konto ist die Namensauswahl **keine sichere Anmeldung** (darauf weist die App hin); Personen mit Konto sind dann nicht wählbar.
- **Rechte:** Alle Teilnehmenden – mit oder ohne Konto – dürfen Ausgaben anlegen, ändern und löschen. Dafür gibt es Transparenz: Jede Ausgabe zeigt, wer sie eingetragen und zuletzt geändert hat, und der **Verlauf** protokolliert jede Änderung. Nur wer das Event mit Konto erstellt hat, und Admins können den Zugangscode erneuern, Konto-Verknüpfungen lösen und das Event löschen.
- **Gespeichert** werden Anzeigenamen in Events und – nur für Konten – Benutzername, Anzeigename, Passwort-Hash, Sitzungen (inkl. Browser-Kennung) und für 24 Stunden gehashte IP-Adressen fehlgeschlagener Anmeldungen. Keine E-Mail-Adressen oder Telefonnummern. Beim Löschen eines Kontos bleibt der Name im Event mit allen Ausgaben erhalten.

## Zuverlässigkeit

- **Speichern:** Die App meldet Erfolg erst nach der Bestätigung durch den Server. Bei Fehlern bleibt das Formular ausgefüllt, es erscheint eine verständliche Meldung und die Möglichkeit, erneut zu speichern.
- **Doppelte Einträge:** Jedes geöffnete Formular hat ein Einmal-Token. Ein wiederholtes Absenden (z. B. nach einem Verbindungsabbruch) legt die Ausgabe nicht doppelt an. Zusätzlich warnt die App, wenn eine sehr ähnliche Ausgabe schon existiert.
- **Gleichzeitige Änderungen:** Ausgaben haben eine Versionsnummer (optimistisches Sperren). Wer eine inzwischen geänderte Ausgabe speichern oder löschen will, sieht den aktuellen Stand und entscheidet: „Aktuelle Version laden“ oder „Meine Version trotzdem speichern“. Schreibvorgänge laufen pro Event in einer Transaktion nacheinander ab.
- **Validierung** auf Server und Client: Betrag > 0,00 € (max. 100.000 €), mindestens eine beteiligte Person, zahlende Person muss teilnehmen, gültiges Datum, Längenbegrenzungen.
- Personen, die an Ausgaben oder Zahlungen beteiligt sind, können nicht entfernt werden, damit keine Abrechnung kaputtgeht.

## API (Kurzüberblick)

`api/index.php?action=…`, JSON. Event-Zugriff über den Header `X-Event-Code`; angemeldet über das Cookie `fs_session`, ohne Konto die gewählte Person über `X-Person-Id`. POST-Aufrufe brauchen `X-Requested-With: FriendSplit`.

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
| `me` | GET | angemeldetes Konto und ob die Ersteinrichtung fehlt |
| `setup_admin` / `register` / `login` / `logout` | POST | erstes Admin-Konto, Registrierung mit Einladung, An- und Abmelden |
| `check_invite` / `check_reset` / `reset_password` | GET/POST | Einladungs- und Reset-Links prüfen, neues Passwort setzen |
| `update_profile` / `change_password` | POST | eigenes Konto |
| `my_events` / `import_local` | GET/POST | „Meine Events“; auf dem Gerät gespeicherte Events ins Konto übernehmen |
| `admin_overview`, `admin_create_invite`, `admin_revoke_invite`, `admin_reset_link`, `admin_update_user`, `admin_delete_user` | GET/POST | Admin-Bereich |

Jede Änderung antwortet mit dem neuen Gesamtzustand. Fehler kommen als `{ ok: false, error: { code, message, fields? } }` mit passendem HTTP-Status (404, 409, 422, …).

## Mögliche Erweiterungen

Individuelle bzw. ungleiche Anteile (das Datenmodell ist vorbereitet), Export als CSV/PDF, mehrere Währungen, Belegfotos, Passwort-Reset per E-Mail, Zwei-Faktor-Anmeldung für Admins, Echtzeit-Updates per Server-Sent Events. Hintergrund zu den Konten: [Konzept](docs/KONZEPT-Konten-und-Login.md).
