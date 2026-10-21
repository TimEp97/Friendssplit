<?php
declare(strict_types=1);

// Ausführen: php tests/ApiTest.php
// Startet den eingebauten PHP-Server mit einer temporären SQLite-Datenbank und testet die API end-to-end.
//
// Gegen MySQL/MariaDB (Achtung: löscht alle fs_-Tabellen der angegebenen Datenbank):
//   FS_TEST_DSN='mysql:host=127.0.0.1;dbname=fs_test;charset=utf8mb4' FS_TEST_USER=fs FS_TEST_PASSWORD=… php tests/ApiTest.php

require __DIR__ . '/assert.php';

$tmp = sys_get_temp_dir() . '/friendsplit-test-' . bin2hex(random_bytes(4));
mkdir($tmp);
$configFile = "$tmp/config.php";
$db = ['dsn' => "sqlite:$tmp/test.sqlite"];
if (getenv('FS_TEST_DSN')) {
    $db = ['dsn' => getenv('FS_TEST_DSN'), 'user' => getenv('FS_TEST_USER') ?: null, 'password' => getenv('FS_TEST_PASSWORD') ?: null];
    $pdo = new PDO($db['dsn'], $db['user'], $db['password'], [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
    $pdo->exec('SET FOREIGN_KEY_CHECKS = 0');
    foreach (['fs_activity', 'fs_settlements', 'fs_expense_shares', 'fs_expenses', 'fs_event_participants', 'fs_persons', 'fs_events', 'fs_login_attempts', 'fs_tokens', 'fs_sessions', 'fs_users'] as $table) {
        $pdo->exec("DROP TABLE IF EXISTS $table");
    }
    $pdo->exec('SET FOREIGN_KEY_CHECKS = 1');
    echo "Datenbank: {$db['dsn']}\n";
}
file_put_contents($configFile, '<?php return ' . var_export([
    'db' => $db,
    'setup_key' => 'test-setup-key-1234567890',
    'require_https' => false,
], true) . ';');

$port = random_int(20000, 40000);
$docroot = realpath(__DIR__ . '/../public');
$server = proc_open(
    [PHP_BINARY, '-d', 'opcache.enable=0', '-S', "127.0.0.1:$port", '-t', $docroot],
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

/**
 * @param string|null $session Wert des Sitzungs-Cookies (angemeldet) oder null
 * @return array{status:int,body:array,session:?string} session: neu gesetztes Cookie ('' = gelöscht)
 */
function call(string $action, ?array $body = null, ?string $code = null, ?string $person = null, ?string $session = null): array
{
    global $port;
    $headers = ['Accept: application/json'];
    if ($session !== null) {
        $headers[] = "Cookie: fs_session=$session";
    }
    if ($code !== null) {
        $headers[] = "X-Event-Code: $code";
    }
    if ($person !== null) {
        $headers[] = "X-Person-Id: $person";
    }
    if ($body !== null) {
        $headers[] = 'Content-Type: application/json';
        $headers[] = 'X-Requested-With: FriendSplit';
    }
    $context = stream_context_create(['http' => [
        'method' => $body !== null ? 'POST' : 'GET',
        'header' => implode("\r\n", $headers),
        'content' => $body !== null ? json_encode($body) : '',
        'ignore_errors' => true,
    ]]);
    $raw = file_get_contents("http://127.0.0.1:$port/api/index.php?action=$action", false, $context);
    preg_match('/\d{3}/', $http_response_header[0], $m);
    $decoded = json_decode((string) $raw, true);
    if (!is_array($decoded)) {
        throw new RuntimeException("Keine JSON-Antwort für $action: $raw");
    }
    $newSession = null;
    foreach ($http_response_header as $line) {
        if (preg_match('/^Set-Cookie: fs_session=([^;]*)/i', $line, $c)) {
            $newSession = $c[1] === 'deleted' ? '' : $c[1];
        }
    }
    return ['status' => (int) $m[0], 'body' => $decoded, 'session' => $newSession];
}

function byName(array $state): array
{
    return array_column($state['participants'], 'id', 'name');
}

$code = null;
$ids = [];

test('Event erstellen – Validierung', function () {
    $r = call('create_event', ['name' => '', 'creator_name' => '']);
    assertSame(422, $r['status']);
    assertTrue(isset($r['body']['error']['fields']['name'], $r['body']['error']['fields']['creator_name']));

    $r = call('create_event', ['name' => 'X', 'creator_name' => 'Alex', 'participants' => ['alex']]);
    assertSame(422, $r['status'], 'doppelte Namen');
    $r = call('create_event', ['name' => 'X', 'creator_name' => 'Alex', 'date' => '2026-02-30']);
    assertSame(422, $r['status'], 'ungültiges Datum');
});

test('Event erstellen und erneut öffnen', function () use (&$code, &$ids) {
    $r = call('create_event', [
        'name' => 'Stuttgart Night',
        'date' => '2026-10-23',
        'location' => 'Stuttgart',
        'creator_name' => 'Alex',
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

test('Zugriff ist auf das eigene Event beschränkt', function () use (&$code, &$ids) {
    $other = call('create_event', ['name' => 'Anderes Event', 'creator_name' => 'Eve'])['body']['data'];
    // Person aus Event A kann nicht in Event B zahlen
    $r = call('save_expense', [
        'amount_cents' => 100, 'category' => 'essen', 'paid_by' => $ids['Alex'],
        'participants' => [$ids['Alex']], 'spent_at' => '2026-10-23T22:00',
    ], $other['code']);
    assertSame(422, $r['status']);
    // Ausgabe aus Event A kann nicht über Event B gelöscht werden
    $expense = call('event', null, $code)['body']['data']['expenses'][0];
    assertSame(404, call('delete_expense', ['id' => $expense['id'], 'version' => $expense['version']], $other['code'])['status']);
    assertSame(2, count(call('event', null, $code)['body']['data']['expenses']));
    // Eve kann nicht aus Event A entfernt werden / Alex nicht über Event B
    assertSame(404, call('remove_participant', ['person_id' => $ids['Alex']], $other['code'])['status']);
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
    global $port;
    $raw = file_get_contents("http://127.0.0.1:$port/api/index.php?action=delete_expense", false, stream_context_create(['http' => [
        'header' => "X-Event-Code: $code", 'ignore_errors' => true,
    ]]));
    assertSame('method_not_allowed', json_decode($raw, true)['error']['code'], 'Änderungen nur per POST');
    assertSame(404, call('gibt_es_nicht', [], $code)['status']);
    assertSame(403, call('setup&key=falsch')['status']);
    assertSame(200, call('setup&key=test-setup-key-1234567890')['status']);

    // Schreibende Aufrufe ohne X-Requested-With (z. B. von einer fremden Seite) werden abgelehnt.
    $raw = file_get_contents("http://127.0.0.1:$port/api/index.php?action=create_event", false, stream_context_create(['http' => [
        'method' => 'POST', 'header' => "Content-Type: application/json", 'content' => '{"name":"X","creator_name":"Y"}', 'ignore_errors' => true,
    ]]));
    assertSame('forbidden', json_decode($raw, true)['error']['code'], 'CSRF-Schutz');
});

// ---------------------------------------------------------------- Benutzerkonten

$admin = null;      // Sitzung Admin
$alex = null;       // Sitzung Alex (Mitglied)
$alexUserId = null;

test('Erstes Admin-Konto einrichten', function () use (&$admin) {
    $me = call('me')['body']['data'];
    assertSame(null, $me['user']);
    assertTrue($me['needs_setup'], 'needs_setup vor der Einrichtung');

    $r = call('setup_admin', ['setup_key' => 'falsch', 'username' => 'tim', 'display_name' => 'Tim', 'password' => 'sehr-geheimes-pw']);
    assertSame(422, $r['status']);
    assertTrue(isset($r['body']['error']['fields']['setup_key']));
    $r = call('setup_admin', ['setup_key' => 'test-setup-key-1234567890', 'username' => 'Tim Ä', 'display_name' => '', 'password' => 'kurz']);
    assertSame(422, $r['status']);
    assertSame(['username', 'display_name', 'password'], array_keys($r['body']['error']['fields']));

    $r = call('setup_admin', ['setup_key' => 'test-setup-key-1234567890', 'username' => 'Tim', 'display_name' => 'Tim', 'password' => 'sehr-geheimes-pw']);
    assertSame(200, $r['status']);
    assertSame('admin', $r['body']['data']['user']['role']);
    assertSame('tim', $r['body']['data']['user']['username'], 'Benutzername klein geschrieben');
    $admin = $r['session'];
    assertTrue(strlen((string) $admin) === 64, 'Sitzungs-Cookie gesetzt');

    $me = call('me', null, null, null, $admin)['body']['data'];
    assertSame('Tim', $me['user']['display_name']);
    assertFalse($me['needs_setup']);
    $r = call('setup_admin', ['setup_key' => 'test-setup-key-1234567890', 'username' => 'zweiter', 'display_name' => 'X', 'password' => 'sehr-geheimes-pw']);
    assertSame(409, $r['status'], 'nur einmal möglich');
});

test('Registrierung nur mit gültiger Einladung', function () use (&$admin, &$alex, &$alexUserId) {
    assertSame(401, call('admin_create_invite', [])['status'], 'ohne Anmeldung');
    $r = call('register', ['invite' => 'AAAA-BBBB-CCCC', 'username' => 'alex', 'display_name' => 'Alex', 'password' => 'alex-passwort-1']);
    assertSame(422, $r['status']);
    assertTrue(isset($r['body']['error']['fields']['invite']));

    $r = call('admin_create_invite', ['note' => 'für Alex', 'max_uses' => 1, 'days' => 7], null, null, $admin);
    assertSame(200, $r['status']);
    $invite = $r['body']['data']['code'];
    assertTrue(call('check_invite&code=' . strtolower($invite))['body']['data']['valid']);

    $r = call('register', ['invite' => $invite, 'username' => 'tim', 'display_name' => 'Noch ein Tim', 'password' => 'alex-passwort-1']);
    assertSame(422, $r['status'], 'Benutzername vergeben');
    assertTrue(isset($r['body']['error']['fields']['username']));

    $r = call('register', ['invite' => $invite, 'username' => 'alex', 'display_name' => 'Alex', 'password' => 'alex-passwort-1']);
    assertSame(200, $r['status']);
    assertSame('member', $r['body']['data']['user']['role']);
    $alex = $r['session'];
    $alexUserId = $r['body']['data']['user']['id'];

    // Einladung ist verbraucht
    assertFalse(call('check_invite&code=' . $invite)['body']['data']['valid']);
    $r = call('register', ['invite' => $invite, 'username' => 'sam', 'display_name' => 'Sam', 'password' => 'sam-passwort-12']);
    assertSame(422, $r['status']);
    // Mitglieder dürfen nicht in den Admin-Bereich
    assertSame(403, call('admin_overview', null, null, null, $alex)['status']);
});

test('Anmelden, Abmelden und Schutz vor Passwort-Raten', function () use (&$alex) {
    $r = call('login', ['username' => 'ALEX', 'password' => 'alex-passwort-1', 'remember' => true]);
    assertSame(200, $r['status'], 'Groß-/Kleinschreibung egal');
    $second = $r['session'];
    assertSame('Alex', call('me', null, null, null, $second)['body']['data']['user']['display_name']);
    $r = call('logout', [], null, null, $second);
    assertSame('', $r['session'], 'Cookie gelöscht');
    assertSame(null, call('me', null, null, null, $second)['body']['data']['user'], 'Sitzung beendet');
    assertSame('Alex', call('me', null, null, null, $alex)['body']['data']['user']['display_name'], 'andere Sitzung bleibt');

    assertSame(401, call('login', ['username' => 'niemand', 'password' => 'irgendwas-langes'])['status']);
    for ($i = 0; $i < 5; $i++) {
        assertSame(401, call('login', ['username' => 'sam-gibts-nicht', 'password' => 'falsches-passwort'])['status']);
    }
    assertSame(429, call('login', ['username' => 'sam-gibts-nicht', 'password' => 'falsches-passwort'])['status'], 'gesperrt nach 5 Fehlversuchen');
    assertSame(200, call('login', ['username' => 'alex', 'password' => 'alex-passwort-1'])['status'], 'andere Konten nicht betroffen');
});

test('Event mit Konto erstellen erscheint in „Meine Events“', function () use (&$alex) {
    $r = call('create_event', ['name' => 'Skiausflug', 'creator_name' => 'Alex', 'participants' => ['Mathis', 'Sam']], null, null, $alex);
    assertSame(201, $r['status']);
    $code = $r['body']['data']['code'];
    $events = call('my_events', null, null, null, $alex)['body']['data']['events'];
    assertSame(['Skiausflug'], array_column($events, 'name'));
    assertTrue($events[0]['is_owner']);
    assertSame('Alex', $events[0]['person_name']);

    $state = call('event', null, $code, null, $alex)['body']['data'];
    assertSame($r['body']['data']['person_id'], $state['viewer']['person_id']);
    assertTrue($state['viewer']['can_manage']);
    assertSame([true, false, false], array_column($state['participants'], 'linked'));
    assertSame(401, call('my_events')['status'], 'nur angemeldet');
});

test('Per Code beitreten, Person verknüpfen und wechseln', function () use (&$admin, &$alex) {
    $code = call('my_events', null, null, null, $alex)['body']['data']['events'][0]['code'];
    $state = call('event', null, $code, null, $admin)['body']['data'];
    $ids = byName($state);
    assertSame(null, $state['viewer']['person_id'], 'noch nicht beigetreten');
    assertTrue($state['viewer']['can_manage'], 'Admin darf verwalten');

    assertSame(401, call('join_event', ['person_id' => $ids['Mathis']], $code)['status'], 'Beitreten nur mit Konto');
    $r = call('join_event', ['person_id' => $ids['Alex']], $code, null, $admin);
    assertSame(409, $r['status'], 'Alex gehört schon einem anderen Konto');

    $r = call('join_event', ['person_id' => $ids['Mathis']], $code, null, $admin);
    assertSame(200, $r['status']);
    assertSame($ids['Mathis'], $r['body']['data']['state']['viewer']['person_id']);
    // Wechsel auf Sam: Mathis wird wieder frei
    $r = call('join_event', ['person_id' => $ids['Sam']], $code, null, $admin);
    assertSame([true, false, true], array_column($r['body']['data']['state']['participants'], 'linked'));
    assertSame(['Skiausflug'], array_column(call('my_events', null, null, null, $admin)['body']['data']['events'], 'name'));

    // Neu hinzufügen mit eigenem Namen – Namen müssen eindeutig sein
    assertSame(422, call('join_event', ['name' => 'alex'], $code, null, $admin)['status']);
    $r = call('join_event', ['name' => 'Tim'], $code, null, $admin);
    assertSame(200, $r['status']);
    assertSame(['Alex', 'Mathis', 'Sam', 'Tim'], array_column($r['body']['data']['state']['participants'], 'name'));
    assertSame([true, false, false, true], array_column($r['body']['data']['state']['participants'], 'linked'));
});

test('Angemeldet zählt das Konto, nicht X-Person-Id', function () use (&$alex) {
    $code = call('my_events', null, null, null, $alex)['body']['data']['events'][0]['code'];
    $ids = byName(call('event', null, $code)['body']['data']);
    $expense = [
        'amount_cents' => 3000, 'category' => 'essen', 'paid_by' => $ids['Alex'],
        'participants' => [$ids['Alex'], $ids['Mathis']], 'spent_at' => '2026-12-01T12:00',
    ];
    // Gast gibt sich als Alex (mit Konto) aus → wird nicht als Alex eingetragen
    $createdBy = fn ($r, $description) => array_column($r['body']['data']['state']['expenses'], 'created_by', 'description')[$description];
    $r = call('save_expense', $expense + ['description' => 'Gast'], $code, $ids['Alex']);
    assertSame(200, $r['status']);
    assertSame(null, $createdBy($r, 'Gast'));
    // Gast als Mathis (ohne Konto) → wie bisher erlaubt
    $r = call('save_expense', $expense + ['description' => 'Mathis'], $code, $ids['Mathis']);
    assertSame($ids['Mathis'], $createdBy($r, 'Mathis'));
    // Alex angemeldet, schickt aber Mathis' ID → zählt trotzdem als Alex
    $r = call('save_expense', $expense + ['description' => 'Alex'], $code, $ids['Mathis'], $alex);
    assertSame($ids['Alex'], $createdBy($r, 'Alex'));
    assertTrue(str_starts_with($r['body']['data']['state']['activity'][0]['summary'], 'Alex hat'));
});

test('Geräte-Events ins Konto übernehmen', function () use (&$admin) {
    $guest = call('create_event', ['name' => 'Altes Event', 'creator_name' => 'Tim', 'participants' => ['Jo']])['body']['data'];
    $r = call('import_local', ['items' => [
        ['code' => $guest['code'], 'person_id' => $guest['person_id']],
        ['code' => 'AAAABBBBCCCC', 'person_id' => 'x'],
        ['code' => $guest['code']],
    ]], null, null, $admin);
    assertSame(1, $r['body']['data']['imported']);
    $names = array_column(call('my_events', null, null, null, $admin)['body']['data']['events'], 'name');
    sort($names);
    assertSame(['Altes Event', 'Skiausflug'], $names);
    // Organisator-Person übernommen → Owner des bisher besitzerlosen Events
    $events = array_column(call('my_events', null, null, null, $admin)['body']['data']['events'], 'is_owner', 'name');
    assertTrue($events['Altes Event']);
});

test('Code erneuern, Verknüpfung lösen, Event verlassen und löschen', function () use (&$admin, &$alex) {
    $code = call('my_events', null, null, null, $alex)['body']['data']['events'][0]['code'];
    $ids = byName(call('event', null, $code)['body']['data']);
    assertSame(403, call('regenerate_code', [], $code)['status'], 'Gäste dürfen nicht');

    $r = call('regenerate_code', [], $code, null, $alex);
    assertSame(200, $r['status']);
    $newCode = $r['body']['data']['code'];
    assertTrue($newCode !== $code);
    assertSame($newCode, $r['body']['data']['state']['event']['code']);
    assertSame(404, call('event', null, $code)['status'], 'alter Code ungültig');
    $adminEvents = array_column(call('my_events', null, null, null, $admin)['body']['data']['events'], 'code', 'name');
    assertSame($newCode, $adminEvents['Skiausflug'], 'Mitglieder behalten Zugang');

    $r = call('unlink_participant', ['person_id' => $ids['Tim']], $newCode, null, $alex);
    assertSame(200, $r['status']);
    assertSame(['Altes Event'], array_column(call('my_events', null, null, null, $admin)['body']['data']['events'], 'name'));

    $r = call('leave_event', [], $newCode, null, $alex);
    assertSame(null, $r['body']['data']['state']['viewer']['person_id']);
    assertSame([], call('my_events', null, null, null, $alex)['body']['data']['events']);

    assertSame(403, call('delete_event', [], $newCode)['status']);
    assertSame(200, call('delete_event', [], $newCode, null, $admin)['status']);
    assertSame(404, call('event', null, $newCode)['status']);
});

test('Admin: Konten verwalten und Passwort zurücksetzen', function () use (&$admin, &$alex, &$alexUserId) {
    $overview = call('admin_overview', null, null, null, $admin)['body']['data'];
    assertSame(['Alex', 'Tim'], array_column($overview['users'], 'display_name'));
    assertTrue(count($overview['events']) >= 3);
    $tim = $overview['users'][1]['id'];
    assertSame(422, call('admin_update_user', ['user_id' => $tim, 'status' => 'disabled'], null, null, $admin)['status'], 'nicht sich selbst sperren');

    // Reset-Link
    $r = call('admin_reset_link', ['user_id' => $alexUserId], null, null, $admin);
    $reset = $r['body']['data']['code'];
    assertSame('alex', call('check_reset&code=' . $reset)['body']['data']['username']);
    assertSame(422, call('reset_password', ['code' => $reset, 'password' => 'kurz'])['status']);
    $r = call('reset_password', ['code' => $reset, 'password' => 'neues-alex-passwort']);
    assertSame(200, $r['status']);
    $fresh = $r['session'];
    assertSame(null, call('me', null, null, null, $alex)['body']['data']['user'], 'alte Sitzungen beendet');
    assertSame(422, call('reset_password', ['code' => $reset, 'password' => 'noch-ein-passwort'])['status'], 'Link nur einmal gültig');
    assertSame(401, call('login', ['username' => 'alex', 'password' => 'alex-passwort-1'])['status']);

    // Passwort ändern
    assertSame(422, call('change_password', ['current_password' => 'falsch', 'password' => 'drittes-passwort-1'], null, null, $fresh)['status']);
    assertSame(200, call('change_password', ['current_password' => 'neues-alex-passwort', 'password' => 'drittes-passwort-1'], null, null, $fresh)['status']);
    $alex = call('login', ['username' => 'alex', 'password' => 'drittes-passwort-1'])['session'];

    // Sperren beendet Sitzungen und verhindert Anmeldung
    assertSame(200, call('admin_update_user', ['user_id' => $alexUserId, 'status' => 'disabled'], null, null, $admin)['status']);
    assertSame(null, call('me', null, null, null, $alex)['body']['data']['user']);
    assertSame(403, call('login', ['username' => 'alex', 'password' => 'drittes-passwort-1'])['status']);
    call('admin_update_user', ['user_id' => $alexUserId, 'status' => 'active', 'role' => 'admin'], null, null, $admin);
    $alex = call('login', ['username' => 'alex', 'password' => 'drittes-passwort-1'])['session'];
    assertSame(200, call('admin_overview', null, null, null, $alex)['status'], 'Alex ist jetzt Admin');

    // Konto löschen: Person bleibt im Event erhalten, nur die Verknüpfung verschwindet
    $guest = call('create_event', ['name' => 'Kino', 'creator_name' => 'Alex'], null, null, $alex)['body']['data'];
    assertSame(200, call('admin_delete_user', ['user_id' => $alexUserId], null, null, $admin)['status']);
    $state = call('event', null, $guest['code'])['body']['data'];
    assertSame([['id' => $guest['person_id'], 'name' => 'Alex', 'role' => 'organizer', 'linked' => false]], $state['participants']);
    assertSame(null, call('me', null, null, null, $alex)['body']['data']['user']);
});

test('Ohne HTTPS ist Anmelden gesperrt, wenn require_https aktiv ist', function () use ($configFile) {
    $config = require $configFile;
    file_put_contents($configFile, '<?php return ' . var_export(['require_https' => true] + $config, true) . ';');
    try {
        $r = call('login', ['username' => 'tim', 'password' => 'sehr-geheimes-pw']);
        assertSame('https_required', $r['body']['error']['code']);
    } finally {
        file_put_contents($configFile, '<?php return ' . var_export($config, true) . ';');
    }
});

finish();
