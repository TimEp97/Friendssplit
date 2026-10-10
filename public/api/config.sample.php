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

    // Langer Zufallswert (mind. 16 Zeichen) für die einmalige Einrichtung über
    // https://deine-domain.de/friendsplit/api/index.php?action=setup&key=…
    // Nach der Einrichtung leeren, damit der Aufruf deaktiviert ist.
    'setup_key' => '',

    // true: Tabellen bei jedem Aufruf mit CREATE TABLE IF NOT EXISTS sicherstellen
    // (praktisch für SQLite in der Entwicklung, für den Live-Betrieb nicht nötig).
    'auto_migrate' => false,
];
