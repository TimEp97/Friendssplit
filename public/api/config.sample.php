<?php
// Vorlage. Beim Upload mit GitHub Actions entsteht config.php automatisch aus den Secrets.
// Für einen Upload von Hand: nach config.php kopieren und die Zugangsdaten eintragen.
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

    // Code zum Anlegen des ersten Kontos (Admin), mindestens 12 Zeichen.
    // Leer = das Datenbank-Passwort gilt als Einrichtungscode.
    'setup_code' => '',

    // true: Die App legt fehlende Tabellen selbst an und rüstet sie nach Updates nach
    // (prüft dafür nur eine Schema-Version – kostet praktisch nichts). Empfohlen.
    'auto_migrate' => true,

    // Nur falls auto_migrate aus ist: langer Zufallswert (mind. 16 Zeichen), dann einmal
    // https://deine-domain.de/api/index.php?action=migrate&key=… aufrufen und danach wieder leeren.
    'setup_key' => '',
];
