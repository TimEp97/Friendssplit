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
    foreach (['fs_activity', 'fs_settlements', 'fs_expense_shares', 'fs_expenses', 'fs_event_participants', 'fs_persons', 'fs_events'] as $table) {
        $pdo->exec("DROP TABLE IF EXISTS $table");
    }
    $pdo->exec('SET FOREIGN_KEY_CHECKS = 1');
    echo "Datenbank: {$db['dsn']}\n";
}
file_put_contents($configFile, '<?php return ' . var_export([
    'db' => $db,
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

/** @return array{status:int,body:array} */
function call(string $action, ?array $body = null, ?string $code = null, ?string $person = null): array
{
    global $port;
    $headers = ['Accept: application/json'];
    if ($code !== null) {
        $headers[] = "X-Event-Code: $code";
    }
    if ($person !== null) {
        $headers[] = "X-Person-Id: $person";
    }
    if ($body !== null) {
        $headers[] = 'Content-Type: application/json';
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
    return ['status' => (int) $m[0], 'body' => $decoded];
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
});

finish();
