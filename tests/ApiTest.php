<?php
declare(strict_types=1);

// Ausführen: php tests/ApiTest.php
// Startet den eingebauten PHP-Server mit einer temporären SQLite-Datenbank und testet die API end-to-end.
//
// Gegen MySQL/MariaDB (Achtung: löscht alle fs_-Tabellen der angegebenen Datenbank):
//   FS_TEST_DSN='mysql:host=127.0.0.1;dbname=fs_test;charset=utf8mb4' FS_TEST_USER=fs FS_TEST_PASSWORD=… php tests/ApiTest.php

require __DIR__ . '/assert.php';
require __DIR__ . '/../public/api/lib/Auth.php';

$tmp = sys_get_temp_dir() . '/friendsplit-test-' . bin2hex(random_bytes(4));
mkdir($tmp);
$configFile = "$tmp/config.php";
$db = ['dsn' => "sqlite:$tmp/test.sqlite"];
if (getenv('FS_TEST_DSN')) {
    $db = ['dsn' => getenv('FS_TEST_DSN'), 'user' => getenv('FS_TEST_USER') ?: null, 'password' => getenv('FS_TEST_PASSWORD') ?: null];
    $pdo = new PDO($db['dsn'], $db['user'], $db['password'], [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
    $pdo->exec('SET FOREIGN_KEY_CHECKS = 0');
    foreach (['fs_rate_limits', 'fs_user_tokens', 'fs_sessions', 'fs_users', 'fs_activity', 'fs_settlements', 'fs_expense_shares', 'fs_expenses', 'fs_event_participants', 'fs_persons', 'fs_events'] as $table) {
        $pdo->exec("DROP TABLE IF EXISTS $table");
    }
    $pdo->exec('SET FOREIGN_KEY_CHECKS = 1');
    echo "Datenbank: {$db['dsn']}\n";
}
$mailLog = "$tmp/mail.log";
file_put_contents($configFile, '<?php return ' . var_export([
    'db' => $db,
    'app_url' => 'https://example.test/friendsplit/',
    'mail' => ['transport' => 'log', 'log_file' => $mailLog],
    'auto_migrate' => true,
    'setup_key' => 'test-setup-key-1234567890',
], true) . ';');

$port = random_int(20000, 40000);
$docroot = realpath(__DIR__ . '/../public');
$server = proc_open(
    [PHP_BINARY, '-S', "127.0.0.1:$port", '-t', $docroot],
    [1 => ['file', "$tmp/server.log", 'a'], 2 => ['file', "$tmp/server.log", 'a']],
    $pipes,
    null,
    array_merge(getenv(), ['FRIENDSPLIT_CONFIG' => $configFile])
);
register_shutdown_function(function () use ($server, $tmp) {
    proc_terminate($server);
    array_map('unlink', glob("$tmp/*"));
    rmdir($tmp);
});
for ($i = 0; $i < 50 && !@fsockopen('127.0.0.1', $port); $i++) {
    usleep(100_000);
}

/** Sitzungs-Cookies je Testkonto (Bezeichnung => Cookie-Wert) und Zuordnung Personen-ID => Konto */
$sessions = [];
$personAccount = [];

/**
 * Ruft die API auf. $as ist eine Kontobezeichnung (z. B. 'Alex'), eine Personen-ID (dann das
 * verknüpfte Konto) oder null für Aufrufe ohne Anmeldung. Gesetzte Sitzungs-Cookies werden
 * für das Konto gemerkt.
 * @return array{status:int,body:array}
 */
function call(string $action, ?array $body = null, ?string $code = null, ?string $as = 'Alex', bool $csrf = true): array
{
    global $port, $sessions, $personAccount;
    $account = $as !== null ? ($personAccount[$as] ?? $as) : null;
    $headers = ['Accept: application/json'];
    if ($code !== null) {
        $headers[] = "X-Event-Code: $code";
    }
    if ($account !== null && isset($sessions[$account])) {
        $headers[] = 'Cookie: ' . Auth::COOKIE . '=' . $sessions[$account];
    }
    if ($body !== null) {
        $headers[] = 'Content-Type: application/json';
        if ($csrf) {
            $headers[] = 'X-Requested-With: FriendSplit';
        }
    }
    $context = stream_context_create(['http' => [
        'method' => $body !== null ? 'POST' : 'GET',
        'header' => implode("\r\n", $headers),
        'content' => $body !== null ? json_encode($body) : '',
        'ignore_errors' => true,
    ]]);
    $raw = file_get_contents("http://127.0.0.1:$port/api/index.php?action=$action", false, $context);
    preg_match('/\d{3}/', $http_response_header[0], $m);
    foreach ($http_response_header as $line) {
        if ($account !== null && preg_match('/^Set-Cookie: ' . Auth::COOKIE . '=([^;]*)/i', $line, $c)) {
            if ($c[1] === '' || $c[1] === 'deleted') {
                unset($sessions[$account]);
            } else {
                $sessions[$account] = $c[1];
            }
        }
    }
    $decoded = json_decode((string) $raw, true);
    if (!is_array($decoded)) {
        throw new RuntimeException("Keine JSON-Antwort für $action: $raw");
    }
    return ['status' => (int) $m[0], 'body' => $decoded];
}

/** @return array{to:string,subject:string,body:string}|null Letzte E-Mail an diese Adresse */
function lastMail(string $to): ?array
{
    global $mailLog;
    $found = null;
    foreach (is_file($mailLog) ? file($mailLog) : [] as $line) {
        $mail = json_decode($line, true);
        if ($mail['to'] === $to) {
            $found = $mail;
        }
    }
    return $found;
}

function tokenFrom(array $mail, string $route): string
{
    if (!preg_match('~#/' . $route . '/([A-Za-z0-9_-]+)~', $mail['body'], $m)) {
        throw new RuntimeException("Kein $route-Link in der E-Mail");
    }
    return $m[1];
}

/** Registriert ein Konto, bestätigt die E-Mail und merkt sich die Sitzung. */
function account(string $label): void
{
    $email = strtolower($label) . '@example.test';
    assertSame(200, call('register', ['email' => $email, 'password' => "geheim-$label-123", 'name' => $label], null, null)['status']);
    $r = call('verify_email', ['token' => tokenFrom(lastMail($email), 'bestaetigen')], null, $label);
    assertSame(200, $r['status'], "Bestätigung für $label");
}

function byName(array $state): array
{
    return array_column($state['participants'], 'id', 'name');
}

function paypalOf(array $state, string $name): ?string
{
    return array_column($state['participants'], 'paypal', 'name')[$name] ?? null;
}

$code = null;
$ids = [];

test('Registrierung mit E-Mail-Bestätigung', function () {
    global $sessions;
    $r = call('register', ['email' => 'kein-mail', 'password' => 'kurz', 'name' => ''], null, null);
    assertSame(422, $r['status']);
    assertSame(['email', 'password', 'name'], array_keys($r['body']['error']['fields']));

    $r = call('register', ['email' => ' Alex@Example.test ', 'password' => 'erstes-passwort', 'name' => 'Alex'], null, null);
    assertSame(200, $r['status']);
    $mail = lastMail('alex@example.test');
    assertSame('Bitte bestätige deine E-Mail-Adresse', $mail['subject']);
    assertTrue(str_contains($mail['body'], 'https://example.test/friendsplit/#/bestaetigen/'), 'Link mit app_url');
    $firstToken = tokenFrom($mail, 'bestaetigen');

    // Anmelden geht erst nach der Bestätigung
    $r = call('login', ['email' => 'alex@example.test', 'password' => 'erstes-passwort'], null, 'Alex');
    assertSame(403, $r['status']);
    assertSame('email_not_verified', $r['body']['error']['code']);

    // Erneute Registrierung des unbestätigten Kontos übernimmt das neue Passwort, alte Links verfallen
    assertSame(200, call('register', ['email' => 'alex@example.test', 'password' => 'geheim-Alex-123', 'name' => 'Alex'], null, null)['status']);
    assertSame(400, call('verify_email', ['token' => $firstToken], null, 'Alex')['status'], 'alter Link ungültig');
    assertSame(400, call('verify_email', ['token' => 'falsch'], null, 'Alex')['status']);

    $token = tokenFrom(lastMail('alex@example.test'), 'bestaetigen');
    $r = call('verify_email', ['token' => $token], null, 'Alex');
    assertSame(200, $r['status']);
    assertSame('alex@example.test', $r['body']['data']['user']['email']);
    assertTrue(isset($sessions['Alex']), 'nach Bestätigung angemeldet');
    assertSame(400, call('verify_email', ['token' => $token], null, 'Gast')['status'], 'Link nur einmal nutzbar');

    // Erneute Registrierung eines bestätigten Kontos verrät nichts, schickt aber einen Hinweis
    $r = call('register', ['email' => 'alex@example.test', 'password' => 'anderes-passwort', 'name' => 'Fake'], null, null);
    assertSame(200, $r['status']);
    assertSame('Dein FriendSplit-Konto', lastMail('alex@example.test')['subject']);
});

test('Anmelden, Abmelden und geschützte Aktionen', function () {
    global $sessions;
    assertSame(401, call('me', null, null, null)['status']);
    assertSame(401, call('create_event', ['name' => 'X'], null, null)['status']);
    $r = call('me');
    assertSame(200, $r['status']);
    assertSame('Alex', $r['body']['data']['user']['name']);

    assertSame(200, call('logout', [], null, 'Alex')['status']);
    assertTrue(!isset($sessions['Alex']), 'Cookie gelöscht');
    $r = call('login', ['email' => 'alex@example.test', 'password' => 'falsch-falsch'], null, 'Alex');
    assertSame(401, $r['status']);
    assertSame('invalid_credentials', $r['body']['error']['code']);
    assertSame(401, call('login', ['email' => 'niemand@example.test', 'password' => 'falsch-falsch'], null, 'Alex')['status'], 'gleiche Antwort ohne Konto');
    assertSame(200, call('login', ['email' => 'ALEX@example.test', 'password' => 'geheim-Alex-123'], null, 'Alex')['status']);
    assertSame(200, call('me')['status']);

    // POST ohne CSRF-Header wird abgelehnt
    $r = call('update_profile', ['paypal' => ''], null, 'Alex', false);
    assertSame(403, $r['status']);
    assertSame('csrf', $r['body']['error']['code']);
});

test('Passwort vergessen', function () {
    global $sessions;
    account('Mathis');
    $oldSession = $sessions['Mathis'];
    assertSame(200, call('request_password_reset', ['email' => 'unbekannt@example.test'], null, null)['status']);
    assertSame(null, lastMail('unbekannt@example.test'), 'keine Mail ohne Konto');
    assertSame(200, call('request_password_reset', ['email' => 'mathis@example.test'], null, null)['status']);
    $token = tokenFrom(lastMail('mathis@example.test'), 'passwort-neu');
    assertSame(422, call('reset_password', ['token' => $token, 'password' => 'kurz'], null, 'Mathis')['status']);
    assertSame(200, call('reset_password', ['token' => $token, 'password' => 'neues-passwort-1'], null, 'Mathis')['status']);
    assertSame(400, call('reset_password', ['token' => $token, 'password' => 'noch-ein-passwort'], null, 'Mathis')['status'], 'nur einmal');
    assertTrue($sessions['Mathis'] !== $oldSession, 'neue Sitzung');
    $sessions['Alt'] = $oldSession;
    assertSame(401, call('me', null, null, 'Alt')['status'], 'alte Sitzungen beendet');
    assertSame(200, call('login', ['email' => 'mathis@example.test', 'password' => 'neues-passwort-1'], null, 'Mathis')['status']);
});

test('Zu viele Fehlversuche werden gebremst', function () {
    account('Bruno');
    for ($i = 0; $i < 10; $i++) {
        call('login', ['email' => 'bruno@example.test', 'password' => 'falsch-falsch'], null, null);
    }
    $r = call('login', ['email' => 'bruno@example.test', 'password' => 'geheim-Bruno-123'], null, null);
    assertSame(429, $r['status']);
});

test('Event erstellen – Validierung', function () {
    account('Sam');
    account('Eve');
    $r = call('create_event', ['name' => '']);
    assertSame(422, $r['status']);
    assertTrue(isset($r['body']['error']['fields']['name']));

    $r = call('create_event', ['name' => 'X', 'participants' => ['alex']]);
    assertSame(422, $r['status'], 'doppelte Namen');
    $r = call('create_event', ['name' => 'X', 'date' => '2026-02-30']);
    assertSame(422, $r['status'], 'ungültiges Datum');
});

test('Event erstellen und erneut öffnen', function () use (&$code, &$ids) {
    $r = call('create_event', [
        'name' => 'Stuttgart Night',
        'date' => '2026-10-23',
        'location' => 'Stuttgart',
        'participants' => ['Mathis', 'Sam', ''],
    ]);
    assertSame(201, $r['status']);
    $code = $r['body']['data']['code'];
    assertTrue((bool) preg_match('/^[2-9A-HJ-NP-Z]{12}$/', $code), "Code-Format: $code");

    // Code mit Bindestrichen und in Kleinschreibung wird ebenfalls akzeptiert.
    $formatted = strtolower(implode('-', str_split($code, 4)));
    $r = call('event', null, $formatted);
    assertSame(200, $r['status']);
    $state = $r['body']['data'];
    assertSame('Stuttgart Night', $state['event']['name']);
    assertSame('2026-10-23', $state['event']['date']);
    assertSame(['Alex', 'Mathis', 'Sam'], array_column($state['participants'], 'name'));
    assertSame('organizer', $state['participants'][0]['role']);
    $ids = byName($state);
    assertSame($ids['Alex'], $r['body']['data']['event']['created_by']);
    assertSame($ids['Alex'], $state['me'], 'Ersteller:in ist verknüpft');
    assertSame([true, false, false], array_column($state['participants'], 'linked'));
});

test('Beitreten: Platzhalter übernehmen oder neu beitreten', function () use (&$code, &$ids) {
    global $personAccount;
    $personAccount[$ids['Alex']] = 'Alex';
    // Sam sieht das Event, ist aber noch kein Mitglied
    $r = call('event', null, $code, 'Sam');
    assertSame(200, $r['status']);
    assertSame(null, $r['body']['data']['me']);
    assertSame(403, call('add_participant', ['name' => 'Hacker'], $code, 'Sam')['status'], 'ohne Teilnahme keine Änderungen');

    foreach (['Mathis', 'Sam'] as $name) {
        $r = call('claim_person', ['person_id' => $ids[$name]], $code, $name);
        assertSame(200, $r['status'], "$name übernimmt Platzhalter");
        assertSame($ids[$name], $r['body']['data']['state']['me']);
        $personAccount[$ids[$name]] = $name;
    }
    assertSame(409, call('claim_person', ['person_id' => $ids['Sam']], $code, 'Eve')['status'], 'schon verknüpft');
    assertSame(409, call('claim_person', ['person_id' => $ids['Mathis']], $code, 'Sam')['status'], 'Sam ist schon dabei');
    assertSame(409, call('join_event', [], $code, 'Sam')['status']);

    // Eve tritt neu bei (Name aus dem Konto) und löst die Verknüpfung wieder
    $r = call('join_event', [], $code, 'Eve');
    assertSame(200, $r['status']);
    $eve = $r['body']['data']['person_id'];
    assertSame('Eve', byName($r['body']['data']['state'])['Eve'] === $eve ? 'Eve' : null);
    $r = call('release_person', [], $code, 'Eve');
    assertSame(null, $r['body']['data']['state']['me']);
    assertSame(200, call('remove_participant', ['person_id' => $eve], $code)['status']);
});

test('Falscher Code liefert 404', function () {
    assertSame(404, call('event', null, 'AAAA-BBBB-CCCC')['status']);
    assertSame(404, call('event', null, null)['status']);
    assertSame(404, call('event', null, "' OR 1=1 --")['status']);
});

test('Beispielrechnung aus dem Konzept über die API', function () use (&$code, &$ids) {
    $r = call('save_expense', [
        'amount_cents' => 3000, 'description' => 'Getränke', 'category' => 'getraenke',
        'paid_by' => $ids['Alex'], 'participants' => [$ids['Alex'], $ids['Mathis'], $ids['Sam']],
        'spent_at' => '2026-10-23T21:15', 'client_token' => 'token-getraenke-1',
    ], $code, $ids['Alex']);
    assertSame(200, $r['status']);
    $r = call('save_expense', [
        'amount_cents' => 2000, 'description' => 'Essen', 'category' => 'essen',
        'paid_by' => $ids['Mathis'], 'participants' => [$ids['Mathis'], $ids['Sam']],
        'spent_at' => '2026-10-23T22:00',
    ], $code, $ids['Mathis']);
    assertSame(200, $r['status']);
    $s = $r['body']['data']['state']['summary'];
    assertSame(5000, $s['total_cents']);
    assertSame(2000, $s['people'][$ids['Alex']]['balance']);
    assertSame(0, $s['people'][$ids['Mathis']]['balance']);
    assertSame(-2000, $s['people'][$ids['Sam']]['balance']);
    assertSame([['from' => $ids['Sam'], 'to' => $ids['Alex'], 'amount_cents' => 2000]], $s['plan']);
    assertSame(2000, $s['open_cents']);

    $expenses = $r['body']['data']['state']['expenses'];
    assertSame('Essen', $expenses[0]['description'], 'neueste zuerst');
    assertSame('🍕', $expenses[0]['icon']);
    assertSame([], array_values(array_filter($expenses[0]['shares'], fn ($x) => $x['person_id'] === $ids['Alex'])), 'Alex nicht am Essen beteiligt');
});

test('Doppelt abgeschickte Ausgabe wird nur einmal gespeichert', function () use (&$code, &$ids) {
    $r = call('save_expense', [
        'amount_cents' => 3000, 'description' => 'Getränke', 'category' => 'getraenke',
        'paid_by' => $ids['Alex'], 'participants' => [$ids['Alex'], $ids['Mathis'], $ids['Sam']],
        'spent_at' => '2026-10-23T21:15', 'client_token' => 'token-getraenke-1',
    ], $code, $ids['Alex']);
    assertSame(200, $r['status']);
    assertSame(2, count($r['body']['data']['state']['expenses']));
});

test('Validierung von Ausgaben', function () use (&$code, &$ids) {
    $r = call('save_expense', ['amount_cents' => 0, 'category' => 'nope', 'paid_by' => 'unknown', 'participants' => [], 'spent_at' => 'gestern'], $code);
    assertSame(422, $r['status']);
    $fields = $r['body']['error']['fields'];
    foreach (['amount', 'category', 'paid_by', 'participants', 'spent_at'] as $field) {
        assertTrue(isset($fields[$field]), "Fehler für $field erwartet");
    }
    $r = call('save_expense', [
        'amount_cents' => 100, 'category' => 'essen', 'paid_by' => $ids['Alex'],
        'participants' => ['fremde-person-id'], 'spent_at' => '2026-10-23T22:00',
    ], $code);
    assertSame(422, $r['status']);
    assertTrue(isset($r['body']['error']['fields']['participants']));
});

test('Rundung: Summe der Anteile = Betrag', function () use (&$code, &$ids) {
    $r = call('save_expense', [
        'amount_cents' => 1000, 'category' => 'transport', 'paid_by' => $ids['Sam'],
        'participants' => [$ids['Alex'], $ids['Mathis'], $ids['Sam']], 'spent_at' => '2026-10-23T23:30',
    ], $code, $ids['Sam']);
    $expense = $r['body']['data']['state']['expenses'][0];
    assertSame('Transport', $expense['description'], 'leere Beschreibung → Kategoriename');
    $shares = array_column($expense['shares'], 'share_cents', 'person_id');
    assertSame(1000, array_sum($shares));
    assertSame(334, $shares[$ids['Sam']], 'Rest-Cent an zahlende Person');
    assertSame(333, $shares[$ids['Alex']]);
});

test('Bearbeiten aktualisiert Salden; veraltete Version ergibt Konflikt', function () use (&$code, &$ids) {
    $state = call('event', null, $code)['body']['data'];
    $taxi = $state['expenses'][0];
    $payload = [
        'id' => $taxi['id'], 'version' => $taxi['version'], 'amount_cents' => 1200, 'category' => 'transport',
        'description' => 'Taxi', 'paid_by' => $ids['Sam'], 'participants' => [$ids['Mathis'], $ids['Sam']],
        'spent_at' => $taxi['spent_at'],
    ];
    $r = call('save_expense', $payload, $code, $ids['Sam']);
    assertSame(200, $r['status']);
    $updated = $r['body']['data']['state']['expenses'][0];
    assertSame(2, $updated['version']);
    assertSame(1200, $updated['amount_cents']);
    assertSame($ids['Sam'], $updated['updated_by']);

    // Zweiter Client mit alter Version
    $payload['amount_cents'] = 999;
    $r = call('save_expense', $payload, $code, $ids['Mathis']);
    assertSame(409, $r['status']);
    assertSame('conflict', $r['body']['error']['code']);
    assertSame(1200, $r['body']['error']['data']['expense']['amount_cents']);

    $s = call('event', null, $code)['body']['data']['summary'];
    // Alex: 3000 − 1000 = +2000 · Mathis: 2000 − 1000 − 1000 − 600 = −600 · Sam: 1200 − 1000 − 1000 − 600 = −1400
    assertSame(2000, $s['people'][$ids['Alex']]['balance']);
    assertSame(-600, $s['people'][$ids['Mathis']]['balance']);
    assertSame(-1400, $s['people'][$ids['Sam']]['balance']);
    assertSame(0, array_sum(array_column($s['people'], 'balance')));
});

test('Löschen mit veralteter Version scheitert, mit aktueller klappt es', function () use (&$code, &$ids) {
    $state = call('event', null, $code)['body']['data'];
    $taxi = $state['expenses'][0];
    assertSame(409, call('delete_expense', ['id' => $taxi['id'], 'version' => 1], $code)['status']);
    $r = call('delete_expense', ['id' => $taxi['id'], 'version' => $taxi['version']], $code, $ids['Alex']);
    assertSame(200, $r['status']);
    assertSame(2, count($r['body']['data']['state']['expenses']));
    assertSame(-2000, $r['body']['data']['state']['summary']['people'][$ids['Sam']]['balance']);
    assertSame(404, call('save_expense', [
        'id' => $taxi['id'], 'version' => 2, 'amount_cents' => 100, 'category' => 'essen',
        'paid_by' => $ids['Sam'], 'participants' => [$ids['Sam']], 'spent_at' => '2026-10-23T22:00',
    ], $code)['status']);
});

test('Ausgleichszahlung als erledigt markieren und zurücknehmen', function () use (&$code, &$ids) {
    $r = call('add_settlement', ['from' => $ids['Sam'], 'to' => $ids['Alex'], 'amount_cents' => 2000], $code, $ids['Sam']);
    assertSame(200, $r['status']);
    $s = $r['body']['data']['state'];
    assertSame([], $s['summary']['plan']);
    assertSame(0, $s['summary']['open_cents']);
    assertSame(0, $s['summary']['people'][$ids['Sam']]['balance']);
    assertSame(422, call('add_settlement', ['from' => $ids['Sam'], 'to' => $ids['Sam'], 'amount_cents' => 5], $code)['status']);

    $r = call('delete_settlement', ['id' => $s['settlements'][0]['id']], $code, $ids['Alex']);
    assertSame(1, count($r['body']['data']['state']['summary']['plan']));
});

test('Teilnehmende verwalten', function () use (&$code, &$ids) {
    $r = call('add_participant', ['name' => 'mathis'], $code);
    assertSame(422, $r['status'], 'Name doppelt');
    $r = call('add_participant', ['name' => 'Kim'], $code, $ids['Alex']);
    assertSame(200, $r['status']);
    $kim = $r['body']['data']['person_id'];
    assertSame('Kim', end($r['body']['data']['state']['participants'])['name']);

    assertSame(200, call('rename_participant', ['person_id' => $kim, 'name' => 'Kimberly'], $code)['status']);
    assertSame(409, call('remove_participant', ['person_id' => $ids['Sam']], $code)['status'], 'Sam ist beteiligt');
    $r = call('remove_participant', ['person_id' => $kim], $code, $ids['Alex']);
    assertSame(200, $r['status']);
    assertSame(3, count($r['body']['data']['state']['participants']));
});

test('PayPal.me: im Profil und für Platzhalter', function () use (&$code, &$ids) {
    foreach (['https://www.paypal.me/AlexM/12.50EUR?locale.x=de_DE', 'paypal.me/AlexM', '@AlexM', 'AlexM', 'https://www.paypal.com/paypalme/AlexM'] as $input) {
        $r = call('update_profile', ['paypal' => $input]);
        assertSame(200, $r['status'], $input);
        assertSame('AlexM', $r['body']['data']['user']['paypal'], $input);
    }
    assertSame('AlexM', paypalOf(call('event', null, $code)['body']['data'], 'Alex'), 'Profil-Link gilt im Event');
    $r = call('update_profile', ['paypal' => 'https://www.paypal.com/qrcodes/p2pqrc/ABC']);
    assertSame(422, $r['status']);
    assertTrue(str_contains($r['body']['error']['fields']['paypal'], 'QR-Code'));
    $r = call('set_paypal', ['person_id' => $ids['Sam'], 'paypal' => 'SamS'], $code);
    assertSame('paypal_from_profile', $r['body']['error']['code'], 'Konto-Personen nur über ihr Profil');

    // Platzhalter ohne Konto: Link im Event hinterlegen
    $lena = call('add_participant', ['name' => 'Lena'], $code)['body']['data']['person_id'];
    $r = call('set_paypal', ['person_id' => $lena, 'paypal' => 'paypal.me/LenaK'], $code);
    assertSame(200, $r['status']);
    assertSame('LenaK', paypalOf($r['body']['data']['state'], 'Lena'));
    assertTrue(str_contains($r['body']['data']['state']['activity'][0]['summary'], 'Alex hat einen für Lena'));
    assertSame(422, call('set_paypal', ['person_id' => $lena, 'paypal' => 'kein name'], $code)['status']);
    assertSame(404, call('set_paypal', ['person_id' => 'gibtsnicht', 'paypal' => 'x'], $code)['status']);
    assertSame(200, call('remove_participant', ['person_id' => $lena], $code)['status']);
});

test('Zugriff ist auf das eigene Event beschränkt', function () use (&$code, &$ids) {
    $other = call('create_event', ['name' => 'Anderes Event'], null, 'Eve')['body']['data'];
    // Person aus Event A kann nicht in Event B zahlen
    $r = call('save_expense', [
        'amount_cents' => 100, 'category' => 'essen', 'paid_by' => $ids['Alex'],
        'participants' => [$ids['Alex']], 'spent_at' => '2026-10-23T22:00',
    ], $other['code'], 'Eve');
    assertSame(422, $r['status']);
    // Ausgabe aus Event A kann nicht über Event B gelöscht werden
    $expense = call('event', null, $code)['body']['data']['expenses'][0];
    assertSame(404, call('delete_expense', ['id' => $expense['id'], 'version' => $expense['version']], $other['code'], 'Eve')['status']);
    assertSame(2, count(call('event', null, $code)['body']['data']['expenses']));
    // Alex kann nicht über Event B entfernt werden; Alex (kein Mitglied) darf in Event B nichts ändern
    assertSame(404, call('remove_participant', ['person_id' => $ids['Alex']], $other['code'], 'Eve')['status']);
    assertSame(403, call('update_event', ['name' => 'Gekapert'], $other['code'])['status']);

    // Übersicht im Profil: nur eigene Events
    $events = array_column(call('me', null, null, 'Eve')['body']['data']['user']['events'], 'name');
    assertSame(['Anderes Event'], $events);
    assertSame(['Stuttgart Night'], array_column(call('me')['body']['data']['user']['events'], 'name'));
});

test('Eventdaten bearbeiten und Verlauf', function () use (&$code, &$ids) {
    $r = call('update_event', ['name' => 'Stuttgart Night 2026', 'date' => '2026-10-24', 'location' => '', 'notes' => 'Treffpunkt Schlossplatz'], $code, $ids['Mathis']);
    assertSame(200, $r['status']);
    $state = $r['body']['data']['state'];
    assertSame('Stuttgart Night 2026', $state['event']['name']);
    assertSame(null, $state['event']['location']);
    assertTrue(count($state['activity']) >= 8);
    assertTrue(str_contains($state['activity'][0]['summary'], 'Mathis'));
});

test('Methoden und Aktionen', function () use (&$code) {
    global $port, $sessions;
    $raw = file_get_contents("http://127.0.0.1:$port/api/index.php?action=delete_expense", false, stream_context_create(['http' => [
        'header' => "X-Event-Code: $code\r\nCookie: " . Auth::COOKIE . '=' . $sessions['Alex'], 'ignore_errors' => true,
    ]]));
    assertSame('method_not_allowed', json_decode($raw, true)['error']['code'], 'Änderungen nur per POST');
    assertSame(404, call('gibt_es_nicht', [], $code)['status']);
    assertSame(403, call('setup&key=falsch', null, null, null)['status']);
    assertSame(200, call('setup&key=test-setup-key-1234567890', null, null, null)['status']);
});

finish();
