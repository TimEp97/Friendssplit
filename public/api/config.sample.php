<?php
// Kopiere diese Datei nach config.php und trage die Zugangsdaten deiner Datenbank ein.
// config.php wird nicht ins Git-Repository eingecheckt.
return [
    'db' => [
        // ALL-INKL: Datenbankname und Benutzer stehen im KAS unter „Datenbanken“ (z. B. d0123456).
        'dsn'      => 'mysql:host=localhost;dbname=DATENBANKNAME;charset=utf8mb4',
        'user'     => 'DATENBANKBENUTZER',
        'password' => 'PASSWORT',

        // Lokale Entwicklung ohne MySQL:
        // 'dsn' => 'sqlite:' . __DIR__ . '/../data/friendsplit.sqlite',
    ],

    // Öffentliche Adresse der App (mit https://). Daraus werden die Links in den E-Mails gebaut
    // (Bestätigung, Passwort zurücksetzen). Pflicht – ohne sie werden keine E-Mails verschickt.
    'app_url' => 'https://deine-domain.de/friendsplit/',

    // E-Mail-Versand für Registrierung und „Passwort vergessen“.
    // ALL-INKL: PHPs mail() funktioniert ohne weitere Einrichtung. Die Absenderadresse muss zu deiner
    // Domain gehören und sollte im KAS als Postfach oder Weiterleitung existieren.
    'mail' => [
        'transport' => 'mail',                // 'mail' = versenden, 'log' = nur in Datei schreiben (Entwicklung)
        'from'      => 'noreply@deine-domain.de',
        'from_name' => 'FriendSplit',
        // 'log_file' => __DIR__ . '/../data/mail.log', // nur für 'transport' => 'log'
    ],

    // Langer Zufallswert (mind. 16 Zeichen) für die einmalige Einrichtung über
    // https://deine-domain.de/friendsplit/api/index.php?action=setup&key=…
    // Nach der Einrichtung leeren, damit der Aufruf deaktiviert ist.
    'setup_key' => '',

    // true: Tabellen bei jedem Aufruf mit CREATE TABLE IF NOT EXISTS sicherstellen
    // (praktisch für SQLite in der Entwicklung, für den Live-Betrieb nicht nötig).
    'auto_migrate' => false,
];
