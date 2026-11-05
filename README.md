# FriendSplit

Mobile-first Web-App, mit der eine Freundesgruppe gemeinsame Ausgaben für einen Ausflug, Abend oder ein Event erfasst und fair abrechnet – gedacht zur Einbindung in eine bestehende Webseite bei **ALL-INKL.COM** (oder jedem anderen Webhosting mit PHP und MySQL).

- **Konto mit E-Mail und Passwort:** Registrierung mit Bestätigungslink per E-Mail, „Passwort vergessen“. Im Profil: Name, PayPal.me-Link, E-Mail-Adresse und Passwort ändern, Konto löschen. Alle eigenen Events auf jedem Gerät
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

## Installation bei ALL-INKL.COM

1. **Datenbank anlegen:** KAS → *Datenbanken* → *Neue Datenbank*. Datenbankname, Benutzer und Passwort notieren (z. B. `d0123456`).
2. **Dateien hochladen:** Den Inhalt von `public/` per FTP in einen Unterordner deiner Webseite laden, z. B. `/friendsplit/`.
3. **Konfiguration:** `api/config.sample.php` nach `api/config.php` kopieren und eintragen:
   ```php
   'dsn'      => 'mysql:host=localhost;dbname=d0123456;charset=utf8mb4',
   'user'     => 'd0123456',
   'password' => '…',
   // …
   'app_url'  => 'https://deine-domain.de/friendsplit/',   // für die Links in den E-Mails
   'mail'     => ['transport' => 'mail', 'from' => 'noreply@deine-domain.de', 'from_name' => 'FriendSplit'],
   ```
   **E-Mail bei ALL-INKL:** Der Versand läuft über PHPs `mail()` und braucht keine weitere Einrichtung. Die Absenderadresse (`from`) muss aber zu deiner Domain gehören. Lege sie im KAS unter *E-Mail* als Postfach oder Weiterleitung an, sonst landen die Mails eher im Spam. `app_url` ist Pflicht: Ohne sie verschickt die App keine Bestätigungs- oder Passwort-Links.
4. **Tabellen anlegen** – eine der beiden Varianten:
   - phpMyAdmin öffnen (KAS → Datenbanken → phpMyAdmin), Datenbank wählen, *Importieren* → `api/schema/mysql.sql`.
   - Oder in `config.php` einen langen Zufallswert als `setup_key` eintragen und einmal  
     `https://deine-domain.de/friendsplit/api/index.php?action=setup&key=DEIN_SETUP_KEY` aufrufen. Danach `setup_key` wieder leeren.
5. **HTTPS:** Im KAS ein (kostenloses Let's-Encrypt-)Zertifikat für die Domain aktivieren. Kopieren und Teilen von Links funktionieren im Browser nur über HTTPS zuverlässig.
6. **Einbinden:** Auf der bestehenden Webseite einen Link auf `/friendsplit/` setzen. Alle Pfade sind relativ, der Ordnername ist frei wählbar.

### Update einer bestehenden Installation

Neue Dateien per FTP hochladen (deine `api/config.php` bleibt unverändert). Danach die Datenbank einmal nachrüsten:

- `setup_key` in `config.php` setzen und `…/api/index.php?action=setup&key=DEIN_SETUP_KEY` aufrufen. Das legt neue Tabellen an und ergänzt fehlende Spalten automatisch.
- Oder in phpMyAdmin erst `api/schema/mysql.sql` und dann `api/schema/upgrade.sql` importieren.

Außerdem `app_url` und `mail` in `config.php` ergänzen (siehe `config.sample.php`). Nach dem Update muss sich jede Person einmal registrieren. Bestehende Events bleiben erhalten: Wer den Event-Link öffnet, wählt seinen bisherigen Namen und übernimmt ihn damit samt aller Ausgaben ins eigene Konto.

Alle Tabellen haben das Präfix `fs_`, damit sie neben bestehenden Tabellen in derselben Datenbank liegen können.

## Lokale Entwicklung und Tests

```bash
cp public/api/config.sample.php public/api/config.php
# in config.php die SQLite-Zeile aktivieren, 'auto_migrate' => true setzen,
# 'app_url' => 'http://localhost:8000/' und bei 'mail' 'transport' => 'log' –
# dann stehen Bestätigungs-Mails in public/data/mail.log statt im Postfach
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

## Konten und Anmeldung

- **Registrieren:** Name, E-Mail-Adresse und Passwort (mindestens 8 Zeichen). Danach kommt eine E-Mail mit einem Bestätigungslink (48 Stunden gültig). Erst mit bestätigter Adresse kann man sich anmelden. Der Link meldet direkt an und führt zurück zum Event, falls man über einen Event-Link gekommen ist.
- **Anmelden:** E-Mail und Passwort. Die Sitzung hält 30 Tage.
- **Passwort vergessen:** Link per E-Mail (60 Minuten gültig, nur einmal nutzbar). Ein neues Passwort meldet alle anderen Geräte ab.
- **Profil:** Name (gilt für neue Events), PayPal.me-Link, E-Mail-Adresse ändern (Bestätigungslink an die neue Adresse, Hinweis an die alte, bis zur Bestätigung bleibt die alte aktiv), Passwort ändern (meldet andere Geräte ab). Für Änderungen an E-Mail, Passwort und zum Löschen ist das aktuelle Passwort nötig.
- **Konto löschen:** Entfernt Konto, E-Mail-Adresse, Passwort, PayPal.me-Link und alle Sitzungen endgültig. In Events bleibt die Person mit ihrem Namen und ihren Ausgaben als Platzhalter ohne Konto stehen, damit die Abrechnung der anderen stimmt. Wer sich neu registriert, kann den Namen wieder übernehmen.
- **Pflicht für alles:** Ohne Anmeldung zeigt die App nur Login und Registrierung. Events anlegen, beitreten und Ausgaben eintragen geht nur mit bestätigtem Konto.
- **Event beitreten:** Wer den Link öffnet und angemeldet ist, wählt einen noch freien Namen aus der Liste (z. B. „Sam“, vom Organisator angelegt) oder tritt mit neuem Namen bei. Personen ohne Konto bleiben als Platzhalter möglich, damit man schon Ausgaben für sie eintragen kann.
- **Sicherheit:** Passwörter nur als `password_hash()`. Sitzungs- und E-Mail-Tokens nur als SHA-256-Hash in der Datenbank. Das Sitzungs-Cookie ist `HttpOnly`, `SameSite=Lax` und über HTTPS `Secure`. Jede POST-Anfrage braucht den Header `X-Requested-With: FriendSplit` (Schutz vor CSRF). Anmeldeversuche und E-Mails sind begrenzt (z. B. 10 Fehlversuche pro Adresse in 15 Minuten). Die App verrät nicht, ob ein Konto zu einer E-Mail-Adresse existiert.

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
| `register` / `verify_email` / `resend_verification` | POST | Konto anlegen, E-Mail bestätigen (meldet an), Link erneut senden |
| `login` / `logout` | POST | An- und Abmelden |
| `request_password_reset` / `reset_password` | POST | Link anfordern, neues Passwort setzen (meldet an) |
| `me` / `update_profile` | GET / POST | Eigenes Profil mit Events lesen, Name und PayPal.me-Link ändern |
| `change_email` / `confirm_email_change` | POST | Neue E-Mail-Adresse anfordern (mit Passwort) und per Link bestätigen |
| `change_password` / `delete_account` | POST | Passwort ändern bzw. Konto löschen (jeweils mit aktuellem Passwort) |
| `create_event` | POST | Event mit Teilnehmenden anlegen → `code`, `person_id` |
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
