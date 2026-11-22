# FriendSplit

Mobile-first Web-App, mit der eine Freundesgruppe gemeinsame Ausgaben für einen Ausflug, Abend oder ein Event erfasst und fair abrechnet – gedacht zur Einbindung in eine bestehende Webseite bei **ALL-INKL.COM** (oder jedem anderen Webhosting mit PHP und MySQL).

- **Konten wie in der Reiseapp:** nur mit Einladung, Anmelden mit Name oder E-Mail, 6-stelliger Code per E-Mail auf neuen Geräten, „Passwort vergessen“. Im Profil: Name, PayPal.me-Link, E-Mail-Adresse und Passwort ändern, Konto löschen. Alle eigenen Events auf jedem Gerät
- **Freunde:** Einladungslinks (einzeln oder für eine Gruppe), Suche nach Namen, Anfragen annehmen/ablehnen. Freunde lassen sich direkt ins Event holen – ohne Link
- **Admin-Seite:** alle Konten sehen, sperren, löschen, Passwort-Link erzeugen
- Events anlegen, Teilnehmende hinzufügen, per Link oder Code einladen. Wer den Link öffnet, meldet sich an und wählt seinen Namen (oder tritt neu bei)
- Ausgaben mit Betrag, Beschreibung, Kategorie (🍹 🍕 🎟️ 🚕 🏨 🛍️), zahlender Person, Beteiligten, Datum und Notiz
- Automatische, centgenaue Aufteilung, Salden je Person und ein Ausgleichsplan („Sam zahlt Alex 20,00 €“)
- **PayPal:** Jede Person hinterlegt ihren PayPal.me-Link einmal im Profil (eintippen, einfügen oder den PayPal-QR-Code scannen). In der Abrechnung öffnet ein Button PayPal direkt mit dem richtigen Betrag
- Zahlungen als erledigt markieren (und zurücknehmen), Verlauf aller Änderungen
- Alle Daten zentral in MySQL; Änderungen anderer erscheinen automatisch (Aktualisierung alle 15 s und beim Zurückkehren in den Tab)

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
│   ├── lib/             Split.php (Berechnung), Store.php (Events), Auth.php (Konten), Mailer.php  – per .htaccess gesperrt
│   └── schema/          mysql.sql, sqlite.sql                                   – per .htaccess gesperrt
└── data/                nur für SQLite in der Entwicklung                         – per .htaccess gesperrt
tests/                   SplitTest.php (Berechnung), ApiTest.php (API end-to-end)
```

## Online: friendssplitt.stuttgartapps.de (ALL-INKL)

Eingerichtet wie die Reiseapp: Bei jedem Push auf den Haupt-Branch testet GitHub die App, schreibt `api/config.php` aus den Secrets und lädt `public/` per FTPS hoch (`.github/workflows/deploy-all-inkl.yml`). Die Datenbanktabellen (Präfix `fs_`) legt die App selbst an.

**Einmalig im KAS:**

1. **Subdomain** `friendssplitt.stuttgartapps.de` anlegen und SSL (Let's Encrypt) aktivieren.
2. **FTP-Benutzer** anlegen, beschränkt auf den Ordner der Subdomain (wie `f0193aef` bei der Reiseapp).
3. **Datenbank** anlegen (KAS → Datenbanken). Name und Benutzer sind gleich, z. B. `d0xxxxxx`. Am einfachsten dasselbe Passwort wie beim FTP-Benutzer vergeben.
4. **Absenderadresse** `noreply@stuttgartapps.de` als Postfach oder Weiterleitung anlegen, damit die Codes nicht im Spam landen.

**Einmalig in GitHub** unter *Settings → Secrets and variables → Actions*:

| Secret | Wert |
| --- | --- |
| `KEY_FRIENDSPLIT` | Passwort des FTP-Benutzers |
| `DB_PASSWORD` | optional, nur wenn das Datenbank-Passwort anders ist als `KEY_FRIENDSPLIT` |
| `SETUP_CODE` | optional, Code für das erste Konto (mind. 12 Zeichen). Ohne ihn gilt das Datenbank-Passwort |

Server (`w0222c40.kasserver.com`), FTP-Benutzer (`f018eadd`, im KAS auf `/friendssplitt.stuttgartapps.de/` beschränkt), Datenbank (`d0488808`) und Zielordner (`./`) stehen im Workflow und lassen sich per Secret `FTP_SERVER`, `FTP_USERNAME` bzw. `FTP_DIR` überschreiben. Fehlen Secrets, laufen nur die Tests und der Upload wird übersprungen.

**Hochladen:** passiert automatisch bei jedem Push auf den Haupt-Branch. Von Hand: *Actions → Deploy zu ALL-INKL → Run workflow*.

**Erstes Konto:** `https://friendssplitt.stuttgartapps.de/` öffnen. Solange es kein Konto gibt, fragt die App nach dem Einrichtungscode (`SETUP_CODE` bzw. Datenbank-Passwort). Dieses Konto ist Admin. Danach lädst du deine Freunde über *Freunde → Freunde einladen* ein.

**Von Hand statt mit GitHub:** `api/config.sample.php` nach `api/config.php` kopieren, ausfüllen und den Inhalt von `public/` per FTP hochladen.

## Lokale Entwicklung und Tests

```bash
cp public/api/config.sample.php public/api/config.php
# in config.php die SQLite-Zeile aktivieren, 'auto_migrate' => true, 'setup_code' => 'mein-einrichtungscode',
# 'app_url' => 'http://localhost:8000/' und bei 'mail' 'transport' => 'log' setzen –
# dann stehen Codes und Links in public/data/mail.log statt im Postfach
php -S localhost:8000 -t public
# → http://localhost:8000

php tests/SplitTest.php   # Rechenlogik inkl. Beispiel aus dem Konzept und Zufallstests
php tests/ApiTest.php     # startet einen Testserver mit temporärer SQLite-DB
```

## Berechnungsregeln

- **Aufteilung:** Jede Ausgabe wird gleichmäßig auf die ausgewählten Beteiligten verteilt; nicht Beteiligte erhalten keinen Anteil.
- **Rundung:** Jede Person bekommt `floor(Betrag / Anzahl)` Cent. Die übrigen Rest-Cents (höchstens Anzahl − 1) werden einzeln vergeben – **zuerst an die zahlende Person, sofern sie beteiligt ist, danach in der Reihenfolge der Teilnehmendenliste**. Die Summe der Anteile ist dadurch immer exakt der Rechnungsbetrag. Beispiel: 10,00 € auf Alex, Mathis, Sam, bezahlt von Sam → Sam 3,34 €, Alex 3,33 €, Mathis 3,33 €.
- **Saldo** = selbst bezahlt − eigener Anteil + geleistete Ausgleichszahlungen − erhaltene Ausgleichszahlungen.
- **Ausgleichsplan:** Die Person mit der größten Schuld zahlt an die Person mit dem größten Guthaben, bis alles ausgeglichen ist – höchstens *n − 1* Zahlungen. Vorschläge verändern keine Ausgaben.
- Beträge werden ausschließlich als ganze Cent (`INT`) gespeichert und berechnet. Die Anteile werden pro Ausgabe gespeichert (`fs_expense_shares`), damit später auch ungleiche Aufteilungen möglich sind.

## Konten, Freunde und Admin

Aufgebaut wie in der Reiseapp:

- **Nur mit Einladung:** Das erste Konto entsteht mit dem Einrichtungscode und ist Admin. Alle weiteren registrieren sich mit einem Einladungslink (`#/registrieren/ABCD-EFGH-JKLM`). Unter *Freunde → Freunde einladen* hat jede angemeldete Person:
  - **einen festen Einladungslink:** läuft nicht ab und gilt für beliebig viele Personen, ideal für eine WhatsApp-Gruppe. Er lässt sich jederzeit durch einen neuen ersetzen, dann gilt der alte nicht mehr.
  - **zusätzlich Einmal-Links:** für eine Person oder als Gruppenlink für bis zu 30 Personen, 14 Tage gültig, höchstens 10 offene pro Person.

  Die App zeigt, wer sich über welchen Link registriert hat. Wer sich über einen Link registriert, bekommt automatisch eine Freundschaftsanfrage der einladenden Person.
- **Registrieren:** Name (3–24 Zeichen, eindeutig, darüber finden einen Freunde), E-Mail-Adresse und Passwort (mindestens 10 Zeichen). Danach kommt ein 6-stelliger Code per E-Mail. Mit dem Code ist die Adresse bestätigt und man ist angemeldet.
- **Anmelden:** mit Name oder E-Mail-Adresse und Passwort.
  - Auf einem neuen Gerät kommt zusätzlich ein Code per E-Mail. Er gilt 15 Minuten, nach 60 Sekunden kann man ihn neu anfordern.
  - Bekannte Geräte merkt sich die App 90 Tage. Die Sitzung hält 90 Tage.
- **Passwort vergessen:** Link per E-Mail (60 Minuten gültig, nur einmal nutzbar). Ein neues Passwort meldet alle anderen Geräte ab.
- **Freunde:** Suche nach Namen (ab 2 Buchstaben), Anfrage schicken, annehmen, ablehnen, zurückziehen, Freundschaft beenden. Fragen sich zwei gegenseitig an, sind sie sofort befreundet. Freunde sehen nur Namen, nie die E-Mail-Adresse.
- **Freunde ins Event holen:**
  - beim Erstellen des Events, oder
  - später unter *Teilnehmende → Freunde dazuholen*.

  Das Event erscheint sofort in ihrer Liste. Gibt es schon einen Platzhalter mit demselben Namen, wird er mit dem Konto verknüpft, samt der Ausgaben.
- **Profil:**
  - Name (für Freunde und neue Events) und PayPal.me-Link
  - E-Mail-Adresse ändern: Bestätigungslink an die neue Adresse, Hinweis an die alte. Bis zur Bestätigung bleibt die alte aktiv.
  - Passwort ändern: meldet andere Geräte ab
  - Konto löschen

  Für Änderungen an E-Mail und Passwort und zum Löschen ist das aktuelle Passwort nötig.
- **Konto löschen:** Entfernt endgültig das Konto mit E-Mail-Adresse, Passwort, PayPal.me-Link, Freundschaften, Einladungen und allen Sitzungen. In Events bleibt die Person mit Namen und Ausgaben als Platzhalter ohne Konto stehen, damit die Abrechnung der anderen stimmt.
- **Admin-Seite** (`#/admin`, Link „Nutzer verwalten“ im Profil):
  - Liste aller Konten mit E-Mail, wer eingeladen hat, letzter Anmeldung, Zahl der Events und Freunde
  - Passwort-Link erzeugen: 24 Stunden gültig, zum direkten Weitergeben, wenn Mails nicht ankommen
  - Konten sperren, entsperren und löschen
- **Event beitreten per Link:** Wer den Link öffnet und angemeldet ist, wählt einen noch freien Namen aus der Liste oder tritt mit neuem Namen bei. Personen ohne Konto bleiben als Platzhalter möglich, damit man schon Ausgaben für sie eintragen kann.
- **Sicherheit:**
  - Passwörter liegen nur als `password_hash()` vor.
  - Sitzungs-, Geräte-, Code- und Link-Tokens liegen nur als SHA-256-Hash in der Datenbank.
  - Cookies sind `HttpOnly`, `SameSite=Lax` und über HTTPS `Secure`.
  - Jede POST-Anfrage braucht den Header `X-Requested-With: FriendSplit` (Schutz vor CSRF).
  - Anmeldeversuche, Codes und E-Mails sind begrenzt, z. B. 10 Fehlversuche pro Konto in 15 Minuten und 5 Versuche pro Code.
  - Die App verrät nicht, ob es ein Konto zu einer Adresse gibt.

## PayPal-Zahlungen

- Im **Profil** trägt jede Person ihren PayPal.me-Link ein. Er gilt automatisch in allen ihren Events. Für Platzhalter ohne Konto kann man den Link unter **Teilnehmende** über „+ PayPal“ hinterlegen. Erlaubt sind `paypal.me/name`, `https://www.paypal.me/name`, `paypal.com/paypalme/name`, `@name` oder nur `name`. Gespeichert wird nur der Name.
- **QR-Code:** In Browsern mit Barcode-Erkennung (z. B. Chrome auf Android) gibt es den Button „QR-Code scannen“: Foto vom PayPal-QR-Code machen, der Link wird eingetragen. Auf dem iPhone den QR-Code mit der Kamera-App scannen und den Link einfügen. QR-Codes, die keinen PayPal.me-Namen enthalten (`paypal.com/qrcodes/…`), werden mit einem Hinweis abgelehnt, weil sich damit kein Betrag vorbelegen lässt.
- In der **Abrechnung** erscheint bei jeder Zahlung an eine Person mit PayPal.me-Link der Button „PayPal: 30,00 € senden“. Er öffnet `https://www.paypal.me/name/30.00EUR`, also PayPal mit Empfänger und Betrag schon ausgefüllt. Die Zahlung wird in PayPal bestätigt. Danach in FriendSplit „Als bezahlt markieren“. FriendSplit erfährt nicht automatisch, ob die Zahlung durchging.
- Hat die empfangende Person noch keinen Link hinterlegt, zeigt die App das an. Ist man selbst die empfangende Person, gibt es einen Hinweis zum Hinterlegen.

## Zugriff, Berechtigungen und Datenschutz

- **Anmeldung:** Siehe *Konten und Anmeldung*. Änderungen in einem Event darf nur, wer daran teilnimmt.
- **Event-Zugang:** Jedes Event hat einen zufälligen Zugangscode aus 12 Zeichen (≈ 60 Bit, ohne verwechselbare Zeichen wie 0/O, 1/I), z. B. `K7Q2-MX9P-4HTR`. Er steht nur im `#`-Teil des Links und landet dadurch nicht in Server-Logs oder Referrern. Jeder Datenbankzugriff ist auf das Event dieses Codes beschränkt.
- **Personen:** Wer man in einem Event ist, ergibt sich aus dem Konto. Die Verknüpfung lässt sich unter *Teilnehmende* lösen („anderen Namen wählen“), falls man sich vertippt hat.
- **Rechte im Event:** Alle Teilnehmenden dürfen alle Ausgaben anlegen, ändern und löschen. Dafür gibt es Transparenz: Jede Ausgabe zeigt, wer sie eingetragen und zuletzt geändert hat, und der **Verlauf** protokolliert jede Änderung. Löschungen müssen bestätigt werden.
- Gespeichert werden Name, E-Mail-Adresse und Passwort-Hash des Kontos sowie freiwillig der PayPal.me-Name. Keine Telefonnummern oder Bankdaten. Die E-Mail-Adresse sehen andere Teilnehmende nicht. Der PayPal.me-Name ist für die Teilnehmenden deiner Events sichtbar.

## Zuverlässigkeit

- **Speichern:** Die App meldet Erfolg erst nach der Bestätigung durch den Server. Bei Fehlern bleibt das Formular ausgefüllt, es erscheint eine verständliche Meldung und die Möglichkeit, erneut zu speichern.
- **Doppelte Einträge:** Jedes geöffnete Formular hat ein Einmal-Token. Ein wiederholtes Absenden (z. B. nach einem Verbindungsabbruch) legt die Ausgabe nicht doppelt an. Zusätzlich warnt die App, wenn eine sehr ähnliche Ausgabe schon existiert.
- **Gleichzeitige Änderungen:** Ausgaben haben eine Versionsnummer (optimistisches Sperren). Wer eine inzwischen geänderte Ausgabe speichern oder löschen will, sieht den aktuellen Stand und entscheidet: „Aktuelle Version laden“ oder „Meine Version trotzdem speichern“. Schreibvorgänge laufen pro Event in einer Transaktion nacheinander ab.
- **Validierung** auf Server und Client: Betrag > 0,00 € (max. 100.000 €), mindestens eine beteiligte Person, zahlende Person muss teilnehmen, gültiges Datum, Längenbegrenzungen.
- Personen, die an Ausgaben oder Zahlungen beteiligt sind, können nicht entfernt werden, damit keine Abrechnung kaputtgeht.

## API (Kurzüberblick)

`api/index.php?action=…`, JSON. Anmeldung über das Sitzungs-Cookie, Event-Zugriff über den Header `X-Event-Code`. POST-Anfragen brauchen `X-Requested-With: FriendSplit`.

| Aktion | Methode | Zweck |
|---|---|---|
| `status` / `invite_info` | GET | ohne Anmeldung: Einrichtung nötig? / Wer lädt mit diesem Code ein? |
| `setup_account` | POST | Erstes Konto (Admin) mit Einrichtungscode |
| `register` | POST | Konto mit Einladung anlegen → 202 `{ pending, purpose, email }` |
| `login` | POST | Name oder E-Mail + Passwort → `{ user }` oder auf neuen Geräten 202 `{ pending, … }` |
| `verify_code` / `resend_code` | POST | Code aus der E-Mail einlösen (meldet an) bzw. neu anfordern |
| `logout` | POST | Abmelden |
| `request_password_reset` / `reset_password` | POST | Link anfordern (`login`), neues Passwort setzen (meldet an) |
| `me` / `update_profile` | GET / POST | Eigenes Profil mit Events und offenen Anfragen; Name und PayPal.me-Link ändern |
| `change_email` / `confirm_email_change` | POST | Neue E-Mail-Adresse anfordern (mit Passwort) und per Link bestätigen |
| `change_password` / `delete_account` | POST | Passwort ändern bzw. Konto löschen (jeweils mit aktuellem Passwort) |
| `friends` / `search` | GET | Freunde, eingehende und ausgehende Anfragen / Suche nach Namen (`q`) |
| `friend_request` / `friend_accept` / `friend_remove` | POST | Anfragen, annehmen, ablehnen/zurückziehen/beenden (`id`) |
| `invites` / `invite_create` / `invite_delete` | GET / POST | Eigene Einladungen, neue (`note`, `group`), löschen (`code`) |
| `invite_permanent` | POST | Eigener Dauer-Einladungslink (wird beim ersten Aufruf angelegt; `renew: true` ersetzt ihn) |
| `admin_users` / `admin_block` / `admin_delete` / `admin_reset_link` | GET / POST | nur Admin: Konten verwalten |
| `create_event` | POST | Event mit Teilnehmenden (`participants`) und Freunden (`friends`) anlegen → `code`, `person_id` |
| `add_friends` | POST | Freunde (`friends`: Konto-IDs) ins Event holen |
| `join_event` / `claim_person` / `release_person` | POST | Beitreten (neuer Name / freien Namen übernehmen), Verknüpfung lösen |
| `event` | GET | Gesamtzustand: Event, Teilnehmende, Ausgaben mit Anteilen, Zahlungen, Salden, Plan, Verlauf |
| `update_event` | POST | Name, Datum, Ort, Notiz ändern |
| `add_participant` / `rename_participant` / `remove_participant` | POST | Teilnehmende verwalten |
| `set_paypal` | POST | PayPal.me-Link eines Platzhalters ohne Konto setzen (`person_id`, `paypal`; leer = entfernen) |
| `save_expense` | POST | Ausgabe anlegen (`client_token`) oder ändern (`id` + `version`) |
| `delete_expense` | POST | Ausgabe löschen (`id` + `version`) |
| `add_settlement` / `delete_settlement` | POST | Ausgleichszahlung als erledigt markieren bzw. zurücknehmen |

Jede Änderung antwortet mit dem neuen Gesamtzustand. Fehler kommen als `{ ok: false, error: { code, message, fields? } }` mit passendem HTTP-Status (404, 409, 422, …).

## Mögliche Erweiterungen

Individuelle bzw. ungleiche Anteile (das Datenmodell ist vorbereitet), Export als CSV/PDF, mehrere Währungen, Belegfotos, Einladen per E-Mail, Datenexport fürs eigene Konto, Echtzeit-Updates per Server-Sent Events.
