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

    // Langer Zufallswert (mind. 16 Zeichen). Wird einmalig gebraucht, um in der App unter
    // „Admin-Konto einrichten“ das erste Admin-Konto anzulegen. Danach wieder leeren.
    'setup_key' => '',

    // Anmelden nur über https:// erlauben (dringend empfohlen). Nur für die lokale
    // Entwicklung ohne Zertifikat auf false setzen.
    'require_https' => true,
];
