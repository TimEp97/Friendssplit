<?php
declare(strict_types=1);

// Ausführen: php tests/ApiTest.php
// Startet den eingebauten PHP-Server mit einer temporären SQLite-Datenbank und testet die API end-to-end.
//
// Gegen MySQL/MariaDB (Achtung: löscht alle fs_-Tabellen der angegebenen Datenbank):
//   FS_TEST_DSN='mysql:host=127.0.0.1;dbname=fs_test;charset=utf8mb4' FS_TEST_USER=fs FS_TEST_PASSWORD=… php tests/ApiTest.php

require __DIR__ . '/assert.php';
require __DIR__ . '/../public/api/lib/Auth.php';

const SETUP_CODE = 'test-einrichtungscode-123';

$tmp = sys_get_temp_dir() . '/friendsplit-test-' . bin2hex(random_bytes(4));
mkdir($tmp);
$configFile = "$tmp/config.php";
$db = ['dsn' => "sqlite:$tmp/test.sqlite"];
if (getenv('FS_TEST_DSN')) {
    $db = ['dsn' => getenv('FS_TEST_DSN'), 'user' => getenv('FS_TEST_USER') ?: null, 'password' => getenv('FS_TEST_PASSWORD') ?: null];
    $pdo = new PDO($db['dsn'], $db['user'], $db['password'], [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
    $pdo->exec('SET FOREIGN_KEY_CHECKS = 0');
    foreach ($pdo->query("SHOW TABLES LIKE 'fs\\_%'")->fetchAll(PDO::FETCH_COLUMN) as $table) {
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
    'setup_code' => SETUP_CODE,
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

/**
 * Cookies je Testkonto: $sessions = Sitzung, $devices = bekanntes Gerät (Bezeichnung => Cookie-Wert).
 * $personAccount ordnet Personen-IDs im Event einem Testkonto zu.
 */
$sessions = [];
$devices = [];
$personAccount = [];

/**
 * Ruft die API auf. $as ist eine Kontobezeichnung (z. B. 'Alex'), eine Personen-ID (dann das
 * verknüpfte Konto) oder null für Aufrufe ohne Anmeldung. Gesetzte Cookies werden für das Konto gemerkt.
 * @return array{status:int,body:array}
 */
function call(string $action, ?array $body = null, ?string $code = null, ?string $as = 'Alex', bool $csrf = true): array
{
    global $port, $sessions, $devices, $personAccount;
    $account = $as !== null ? ($personAccount[$as] ?? $as) : null;
    $headers = ['Accept: application/json'];
    if ($code !== null) {
        $headers[] = "X-Event-Code: $code";
    }
    $cookies = [];
    if ($account !== null && isset($sessions[$account])) {
        $cookies[] = Auth::COOKIE . '=' . $sessions[$account];
    }
    if ($account !== null && isset($devices[$account])) {
        $cookies[] = Auth::DEVICE_COOKIE . '=' . $devices[$account];
    }
    if ($cookies) {
        $headers[] = 'Cookie: ' . implode('; ', $cookies);
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
        if ($account === null || !preg_match('/^Set-Cookie: (fs_session|fs_device)=([^;]*)/i', $line, $c)) {
            continue;
        }
        $jar = $c[1] === Auth::COOKIE ? 'sessions' : 'devices';
        if ($c[2] === '' || $c[2] === 'deleted') {
            unset($GLOBALS[$jar][$account]);
        } else {
            $GLOBALS[$jar][$account] = $c[2];
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

/** 6-stelliger Code aus der letzten E-Mail an diese Adresse */
function codeFrom(string $email): string
{
    $mail = lastMail($email);
    if ($mail === null || !preg_match('/^\s+(\d{6})$/m', $mail['body'], $m)) {
        throw new RuntimeException("Kein Code in der E-Mail an $email");
    }
    return $m[1];
}

function emailOf(string $label): string
{
    return strtolower($label) . '@example.test';
}

/** Neue Einladung von $from; gibt den Code zurück */
function invite(string $from = 'Alex', bool $group = false): string
{
    $r = call('invite_create', ['note' => 'Test', 'group' => $group], null, $from);
    assertSame(200, $r['status'], 'Einladung erstellen');
    return $r['body']['data']['invite']['code'];
}

/** Registriert ein Konto mit Einladung von Alex, bestätigt den Code aus der E-Mail und merkt sich die Sitzung. */
function account(string $label, string $from = 'Alex'): void
{
    $r = call('register', ['invite' => invite($from), 'name' => $label, 'email' => emailOf($label), 'password' => "geheim-$label-123"], null, $label);
    assertSame(202, $r['status'], "Registrierung $label");
    $r = call('verify_code', ['pending' => $r['body']['data']['pending'], 'code' => codeFrom(emailOf($label))], null, $label);
    assertSame(200, $r['status'], "Bestätigung $label");
}

/** Freundschaft zwischen zwei Testkonten herstellen */
function befriend(string $a, string $b): void
{
    $id = call('me', null, null, $b)['body']['data']['user']['id'];
    call('friend_request', ['id' => $id], null, $a);
    $aid = call('me', null, null, $a)['body']['data']['user']['id'];
    call('friend_accept', ['id' => $aid], null, $b);
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

test('Einrichtung: erstes Konto mit Einrichtungscode wird Admin', function () {
    global $sessions;
    assertSame(true, call('status', null, null, null)['body']['data']['setup_needed']);
    $r = call('setup_account', ['code' => 'falsch', 'name' => 'Alex', 'email' => 'alex@example.test', 'password' => 'geheim-Alex-123'], null, 'Alex');
    assertSame(422, $r['status']);
    assertTrue(isset($r['body']['error']['fields']['code']));
    $r = call('setup_account', ['code' => SETUP_CODE, 'name' => 'A', 'email' => 'kein-mail', 'password' => 'kurz'], null, 'Alex');
    assertSame(['name', 'email', 'password'], array_keys($r['body']['error']['fields']));

    $r = call('setup_account', ['code' => SETUP_CODE, 'name' => 'Alex', 'email' => 'Alex@Example.test', 'password' => 'geheim-Alex-123'], null, 'Alex');
    assertSame(200, $r['status']);
    assertSame('admin', $r['body']['data']['user']['role']);
    assertSame('alex@example.test', $r['body']['data']['user']['email']);
    assertTrue(isset($sessions['Alex']), 'direkt angemeldet');
    assertSame(false, call('status', null, null, null)['body']['data']['setup_needed']);
    $r = call('setup_account', ['code' => SETUP_CODE, 'name' => 'Zweit', 'email' => 'zweit@example.test', 'password' => 'geheim-zweit-123'], null, null);
    assertSame(409, $r['status'], 'nur einmal');
});

test('Registrieren nur mit Einladung, Code per E-Mail', function () {
    global $sessions;
    $r = call('register', ['invite' => 'AAAA-BBBB-CCCC', 'name' => 'Sam', 'email' => 'sam@example.test', 'password' => 'geheim-Sam-123'], null, 'Sam');
    assertSame(422, $r['status']);
    assertTrue(isset($r['body']['error']['fields']['invite']));

    $invite = invite();
    $r = call('invites');
    assertTrue(str_contains($r['body']['data']['invites'][0]['link'], 'https://example.test/friendsplit/#/registrieren/' . $invite));
    $info = call('invite_info&code=' . strtolower($invite), null, null, null)['body']['data'];
    assertSame(['valid' => true, 'from' => 'Alex', 'group' => false], $info);

    // Name schon vergeben (Groß-/Kleinschreibung egal)
    $r = call('register', ['invite' => $invite, 'name' => 'alex', 'email' => 'sam@example.test', 'password' => 'geheim-Sam-123'], null, 'Sam');
    assertSame(422, $r['status']);
    assertTrue(isset($r['body']['error']['fields']['name']));

    $r = call('register', ['invite' => $invite, 'name' => 'Sam', 'email' => 'sam@example.test', 'password' => 'geheim-Sam-123'], null, 'Sam');
    assertSame(202, $r['status']);
    $pending = $r['body']['data']['pending'];
    assertSame(['verify', 's***@example.test'], [$r['body']['data']['purpose'], $r['body']['data']['email']]);
    assertTrue(!isset($sessions['Sam']), 'erst nach dem Code angemeldet');
    $code = codeFrom('sam@example.test');
    assertSame(422, call('verify_code', ['pending' => $pending, 'code' => $code === '000000' ? '111111' : '000000'], null, 'Sam')['status']);
    $r = call('verify_code', ['pending' => $pending, 'code' => $code], null, 'Sam');
    assertSame(200, $r['status']);
    assertSame(['Sam', 'user', 1], [$r['body']['data']['user']['name'], $r['body']['data']['user']['role'], $r['body']['data']['user']['friend_requests']]);
    assertTrue(isset($sessions['Sam']));
    assertSame(400, call('verify_code', ['pending' => $pending, 'code' => $code], null, 'Sam')['status'], 'Code nur einmal');

    // Einladung ist verbraucht
    $r = call('register', ['invite' => $invite, 'name' => 'Kai', 'email' => 'kai@example.test', 'password' => 'geheim-Kai-123'], null, null);
    assertSame(422, $r['status']);
    assertSame(false, call('invite_info&code=' . $invite, null, null, null)['body']['data']['valid']);
    assertSame(['Sam'], call('invites')['body']['data']['invites'][0]['members']);
});

test('Anmelden mit Name oder E-Mail, Code nur auf neuen Geräten', function () {
    global $sessions, $devices;
    call('logout', [], null, 'Sam');
    assertSame(401, call('me', null, null, 'Sam')['status']);
    // Bekanntes Gerät: direkt angemeldet, mit Name statt E-Mail
    $r = call('login', ['login' => ' sAm ', 'password' => 'geheim-Sam-123'], null, 'Sam');
    assertSame(200, $r['status']);
    assertSame('Sam', $r['body']['data']['user']['name']);

    // Neues Gerät (ohne Geräte-Cookie): Code per E-Mail
    $r = call('login', ['login' => 'sam@example.test', 'password' => 'geheim-Sam-123'], null, 'SamHandy');
    assertSame(202, $r['status']);
    assertSame('login', $r['body']['data']['purpose']);
    assertSame('FriendSplit-Code: ' . codeFrom('sam@example.test'), lastMail('sam@example.test')['subject']);
    $pending = $r['body']['data']['pending'];
    assertSame(429, call('resend_code', ['pending' => $pending], null, 'SamHandy')['status'], 'erst nach einer Minute');
    $r = call('verify_code', ['pending' => $pending, 'code' => codeFrom('sam@example.test')], null, 'SamHandy');
    assertSame(200, $r['status']);
    assertTrue(isset($devices['SamHandy']), 'Gerät gemerkt');
    call('logout', [], null, 'SamHandy');
    assertSame(200, call('login', ['login' => 'Sam', 'password' => 'geheim-Sam-123'], null, 'SamHandy')['status'], 'danach ohne Code');

    $r = call('login', ['login' => 'Sam', 'password' => 'falsch-falsch'], null, null);
    assertSame(401, $r['status']);
    assertSame('invalid_credentials', $r['body']['error']['code']);
    assertSame(401, call('login', ['login' => 'niemand', 'password' => 'falsch-falsch'], null, null)['status'], 'gleiche Antwort ohne Konto');

    // Geschützte Aktionen und CSRF-Schutz
    assertSame(401, call('me', null, null, null)['status']);
    assertSame(401, call('create_event', ['name' => 'X'], null, null)['status']);
    $r = call('update_profile', ['paypal' => ''], null, 'Alex', false);
    assertSame(403, $r['status']);
    assertSame('csrf', $r['body']['error']['code']);
});

test('Passwort vergessen', function () {
    global $sessions;
    account('Mathis');
    $oldSession = $sessions['Mathis'];
    assertSame(200, call('request_password_reset', ['login' => 'unbekannt'], null, null)['status']);
    assertSame(200, call('request_password_reset', ['login' => 'Mathis'], null, null)['status']);
    $token = tokenFrom(lastMail('mathis@example.test'), 'passwort-neu');
    assertSame(422, call('reset_password', ['token' => $token, 'password' => 'kurz'], null, 'Mathis')['status']);
    assertSame(200, call('reset_password', ['token' => $token, 'password' => 'neues-passwort-1'], null, 'Mathis')['status']);
    assertSame(400, call('reset_password', ['token' => $token, 'password' => 'noch-ein-passwort'], null, 'Mathis')['status'], 'nur einmal');
    assertTrue($sessions['Mathis'] !== $oldSession, 'neue Sitzung');
    $sessions['Alt'] = $oldSession;
    assertSame(401, call('me', null, null, 'Alt')['status'], 'alte Sitzungen beendet');
    assertSame(200, call('login', ['login' => 'mathis@example.test', 'password' => 'neues-passwort-1'], null, 'Mathis')['status']);
});

test('Zu viele Fehlversuche werden gebremst', function () {
    account('Bruno');
    for ($i = 0; $i < 10; $i++) {
        call('login', ['login' => 'Bruno', 'password' => 'falsch-falsch'], null, null);
    }
    assertSame(429, call('login', ['login' => 'bruno', 'password' => 'geheim-Bruno-123'], null, 'Bruno')['status']);
});

test('Freunde: suchen, anfragen, annehmen, entfernen', function () {
    $sam = call('me', null, null, 'Sam')['body']['data']['user']['id'];
    $alex = call('me')['body']['data']['user']['id'];
    $mathis = call('me', null, null, 'Mathis')['body']['data']['user']['id'];
    // Alex hat Sam eingeladen → offene Anfrage bei Sam
    $f = call('friends', null, null, 'Sam')['body']['data'];
    assertSame([['id' => $alex, 'name' => 'Alex']], $f['incoming']);
    $f = call('friend_accept', ['id' => $alex], null, 'Sam')['body']['data'];
    assertSame(['Alex'], array_column($f['friends'], 'name'));
    assertSame(0, call('me', null, null, 'Sam')['body']['data']['user']['friend_requests']);

    // Suche: Teil des Namens, mit Stand der Freundschaft, ohne E-Mail-Adressen
    $r = call('search&q=sa', null, null, 'Alex')['body']['data']['results'];
    assertSame([['id' => $sam, 'name' => 'Sam', 'status' => 'friend']], $r);
    assertSame([], call('search&q=s', null, null, 'Alex')['body']['data']['results'], 'ab 2 Zeichen');
    assertSame([], call('search&q=example', null, null, 'Alex')['body']['data']['results'], 'keine Suche nach E-Mail');

    // Mathis fragt Sam an; Sam lehnt ab; Gegenanfrage gilt als Annehmen
    call('friend_request', ['id' => $sam], null, 'Mathis');
    assertSame('outgoing', call('search&q=sam', null, null, 'Mathis')['body']['data']['results'][0]['status']);
    $f = call('friend_remove', ['id' => $mathis], null, 'Sam')['body']['data'];
    assertSame([], $f['incoming']);
    call('friend_request', ['id' => $sam], null, 'Mathis');
    $f = call('friend_request', ['id' => $mathis], null, 'Sam')['body']['data'];
    assertSame(['Alex', 'Mathis'], array_column($f['friends'], 'name'));
    assertSame(422, call('friend_request', ['id' => $sam], null, 'Sam')['status'], 'nicht mit sich selbst');
    assertSame(404, call('friend_accept', ['id' => $mathis], null, 'Alex')['status'], 'keine Anfrage');
    befriend('Alex', 'Mathis');
});

test('Gruppen-Einladung für mehrere Personen', function () {
    $code = invite('Sam', true);
    $info = call('invite_info&code=' . $code, null, null, null)['body']['data'];
    assertSame(['valid' => true, 'from' => 'Sam', 'group' => true], $info);
    foreach (['Gina', 'Hugo'] as $name) {
        $r = call('register', ['invite' => $code, 'name' => $name, 'email' => emailOf($name), 'password' => "geheim-$name-123"], null, $name);
        assertSame(202, $r['status'], $name);
        call('verify_code', ['pending' => $r['body']['data']['pending'], 'code' => codeFrom(emailOf($name))], null, $name);
    }
    $invite = call('invites', null, null, 'Sam')['body']['data']['invites'][0];
    assertSame([2, 30, ['Gina', 'Hugo'], true], [$invite['uses'], $invite['max_uses'], $invite['members'], $invite['open']]);
    assertSame(2, count(call('friends', null, null, 'Sam')['body']['data']['outgoing']));
    assertSame(200, call('invite_delete', ['code' => $code], null, 'Sam')['status']);
    assertSame(false, call('invite_info&code=' . $code, null, null, null)['body']['data']['valid']);
});

test('Dauer-Einladungslink: ohne Ablauf, beliebig oft, neu erzeugbar', function () {
    $first = call('invite_permanent', [], null, 'Gina')['body']['data']['invite'];
    assertSame([true, null, true], [$first['permanent'], $first['expires_at'], $first['open']]);
    assertSame($first['code'], call('invite_permanent', [], null, 'Gina')['body']['data']['invite']['code'], 'bleibt gleich');
    assertSame(['valid' => true, 'from' => 'Gina', 'group' => false], call('invite_info&code=' . $first['code'], null, null, null)['body']['data']);
    foreach (['Ida', 'Jan', 'Kim'] as $name) {
        $r = call('register', ['invite' => $first['code'], 'name' => $name, 'email' => emailOf($name), 'password' => "geheim-$name-123"], null, $name);
        assertSame(202, $r['status'], $name);
        call('verify_code', ['pending' => $r['body']['data']['pending'], 'code' => codeFrom(emailOf($name))], null, $name);
    }
    $invite = call('invite_permanent', [], null, 'Gina')['body']['data']['invite'];
    assertSame([3, ['Ida', 'Jan', 'Kim'], true], [$invite['uses'], $invite['members'], $invite['open']]);
    assertSame(3, count(call('friends', null, null, 'Gina')['body']['data']['outgoing']), 'Anfragen an alle drei');

    // Zählt nicht gegen die 10 offenen Einladungen
    for ($i = 0; $i < 10; $i++) {
        assertSame(200, call('invite_create', ['note' => "Nr $i"], null, 'Gina')['status']);
    }
    assertSame(409, call('invite_create', ['note' => 'zu viel'], null, 'Gina')['status']);

    // Neu erzeugen: alter Link ungültig
    $renewed = call('invite_permanent', ['renew' => true], null, 'Gina')['body']['data']['invite'];
    assertTrue($renewed['code'] !== $first['code'], 'neuer Code');
    assertSame(false, call('invite_info&code=' . $first['code'], null, null, null)['body']['data']['valid']);
    assertSame(true, call('invite_info&code=' . $renewed['code'], null, null, null)['body']['data']['valid']);
});

test('Admin: Konten sehen, sperren, Passwort-Link, löschen', function () {
    assertSame(403, call('admin_users', null, null, 'Sam')['status'], 'nur Admin');
    $users = call('admin_users')['body']['data']['users'];
    $byName = array_column($users, null, 'name');
    assertSame(['sam@example.test', 'Alex', 1], [$byName['Sam']['email'], $byName['Sam']['invited_by'], $byName['Sam']['friends'] >= 1 ? 1 : 0]);
    $hugo = $byName['Hugo']['id'];

    $r = call('admin_block', ['id' => $hugo, 'blocked' => true]);
    assertSame(true, array_column($r['body']['data']['users'], 'blocked', 'name')['Hugo']);
    assertSame(401, call('me', null, null, 'Hugo')['status'], 'Sitzung beendet');
    $r = call('login', ['login' => 'Hugo', 'password' => 'geheim-Hugo-123'], null, 'Hugo');
    assertSame('blocked', $r['body']['error']['code']);
    assertSame([], call('search&q=hug', null, null, 'Sam')['body']['data']['results'], 'gesperrte nicht auffindbar');
    call('admin_block', ['id' => $hugo, 'blocked' => false]);

    $link = call('admin_reset_link', ['id' => $hugo])['body']['data']['link'];
    assertTrue(str_starts_with($link, 'https://example.test/friendsplit/#/passwort-neu/'));
    $token = substr($link, strrpos($link, '/') + 1);
    assertSame(200, call('reset_password', ['token' => $token, 'password' => 'vom-admin-gesetzt'], null, 'Hugo')['status']);

    $alex = $byName['Alex']['id'];
    assertSame(422, call('admin_block', ['id' => $alex, 'blocked' => true])['status'], 'nicht sich selbst');
    $r = call('admin_delete', ['id' => $hugo]);
    assertSame(false, in_array('Hugo', array_column($r['body']['data']['users'], 'name'), true));
    assertSame(401, call('login', ['login' => 'Hugo', 'password' => 'vom-admin-gesetzt'], null, null)['status']);
});

test('Event erstellen – Validierung', function () {
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
    assertTrue(str_contains($r['body']['data']['state']['activity'][0]['summary'], 'Alex hat für Lena PayPal hinterlegt'));
    assertSame(422, call('set_paypal', ['person_id' => $lena, 'paypal' => 'kein name'], $code)['status']);
    assertSame(404, call('set_paypal', ['person_id' => 'gibtsnicht', 'paypal' => 'x'], $code)['status']);
    assertSame(200, call('remove_participant', ['person_id' => $lena], $code)['status']);
});

test('PayPal per E-Mail-Adresse', function () use (&$code, &$ids) {
    $r = call('update_profile', ['paypal' => '  Alex.PayPal@Example.TEST ']);
    assertSame(200, $r['status']);
    assertSame([null, 'alex.paypal@example.test'], [$r['body']['data']['user']['paypal'], $r['body']['data']['user']['paypal_email']]);
    $alex = array_values(array_filter(call('event', null, $code)['body']['data']['participants'], fn ($p) => $p['name'] === 'Alex'))[0];
    assertSame([null, 'alex.paypal@example.test'], [$alex['paypal'], $alex['paypal_email']], 'gilt im Event');
    assertSame(422, call('update_profile', ['paypal' => 'kein@mail'])['status']);
    // Wechsel zurück auf PayPal.me löscht die E-Mail
    $r = call('update_profile', ['paypal' => 'paypal.me/AlexM']);
    assertSame(['AlexM', null], [$r['body']['data']['user']['paypal'], $r['body']['data']['user']['paypal_email']]);
    // Platzhalter ohne Konto
    $lena = call('add_participant', ['name' => 'Lena'], $code)['body']['data']['person_id'];
    $r = call('set_paypal', ['person_id' => $lena, 'paypal' => 'lena@example.test'], $code);
    $p = array_values(array_filter($r['body']['data']['state']['participants'], fn ($x) => $x['id'] === $lena))[0];
    assertSame([null, 'lena@example.test'], [$p['paypal'], $p['paypal_email']]);
    call('remove_participant', ['person_id' => $lena], $code);
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

test('Profil: Name, E-Mail und Passwort ändern', function () use (&$code) {
    global $sessions;
    account('Paula');
    $r = call('update_profile', ['name' => '  Paula   P '], null, 'Paula');
    assertSame('Paula P', $r['body']['data']['user']['name']);
    assertSame(422, call('update_profile', ['name' => 'sam'], null, 'Paula')['status'], 'Name vergeben');
    assertSame(422, call('update_profile', ['name' => ''], null, 'Paula')['status']);

    // E-Mail ändern: Passwort nötig, Bestätigung an neue Adresse, Hinweis an alte
    $r = call('change_email', ['email' => 'paula.neu@example.test', 'current_password' => 'falsch'], null, 'Paula');
    assertSame(422, $r['status']);
    assertTrue(isset($r['body']['error']['fields']['current_password']));
    $r = call('change_email', ['email' => 'paula.neu@example.test', 'current_password' => 'geheim-Paula-123'], null, 'Paula');
    assertSame(200, $r['status']);
    assertSame('paula@example.test', $r['body']['data']['user']['email'], 'gilt erst nach Bestätigung');
    assertSame('paula.neu@example.test', $r['body']['data']['user']['pending_email']);
    assertSame('Änderung deiner E-Mail-Adresse', lastMail('paula@example.test')['subject']);
    $token = tokenFrom(lastMail('paula.neu@example.test'), 'email-bestaetigen');
    $r = call('confirm_email_change', ['token' => $token], null, 'Paula');
    assertSame(200, $r['status']);
    assertSame('paula.neu@example.test', $r['body']['data']['user']['email']);
    assertSame(null, $r['body']['data']['user']['pending_email']);
    assertSame(400, call('confirm_email_change', ['token' => $token], null, 'Paula')['status']);
    assertSame(401, call('login', ['login' => 'paula@example.test', 'password' => 'geheim-Paula-123'], null, null)['status']);

    // Adresse eines anderen Kontos: keine Änderung, keine Auskunft
    $r = call('change_email', ['email' => 'sam@example.test', 'current_password' => 'geheim-Paula-123'], null, 'Paula');
    assertSame(200, $r['status']);
    assertSame('Dein FriendSplit-Konto', lastMail('sam@example.test')['subject']);
    assertSame('paula.neu@example.test', call('me', null, null, 'Paula')['body']['data']['user']['email']);

    // Passwort ändern meldet andere Sitzungen ab
    $sessions['Paula2'] = $sessions['Paula'];
    $r = call('change_password', ['current_password' => 'geheim-Paula-123', 'new_password' => 'kurz'], null, 'Paula');
    assertSame(422, $r['status']);
    assertTrue(isset($r['body']['error']['fields']['new_password']));
    assertSame(200, call('change_password', ['current_password' => 'geheim-Paula-123', 'new_password' => 'neues-paula-pw'], null, 'Paula')['status']);
    assertSame(200, call('me', null, null, 'Paula')['status'], 'diese Sitzung bleibt');
    assertSame(401, call('me', null, null, 'Paula2')['status'], 'andere Sitzung beendet');
});

test('Konto löschen: Person bleibt als Platzhalter im Event', function () use (&$code, &$ids) {
    account('Lou');
    $r = call('join_event', [], $code, 'Lou');
    $lou = $r['body']['data']['person_id'];
    call('save_expense', [
        'amount_cents' => 600, 'category' => 'essen', 'paid_by' => $lou,
        'participants' => [$lou, $ids['Alex']], 'spent_at' => '2026-10-24T01:00',
    ], $code, 'Lou');
    assertSame(422, call('delete_account', ['current_password' => 'falsch'], null, 'Lou')['status']);
    $r = call('delete_account', ['current_password' => 'geheim-Lou-123'], null, 'Lou');
    assertSame(200, $r['status']);
    assertSame(401, call('me', null, null, 'Lou')['status']);
    assertSame(401, call('login', ['login' => 'lou@example.test', 'password' => 'geheim-Lou-123'], null, null)['status']);
    $state = call('event', null, $code)['body']['data'];
    $person = array_values(array_filter($state['participants'], fn ($p) => $p['id'] === $lou))[0];
    assertSame(['Lou', false], [$person['name'], $person['linked']]);
    assertSame(300, $state['summary']['people'][$lou]['balance'], 'Abrechnung unverändert');
    // Neues Konto kann den Platzhalter übernehmen
    account('Lou');
    assertSame(200, call('claim_person', ['person_id' => $lou], $code, 'Lou')['status']);
});

test('Freunde direkt ins Event holen', function () {
    $sam = call('me', null, null, 'Sam')['body']['data']['user']['id'];
    $gina = call('me', null, null, 'Gina')['body']['data']['user']['id'];
    $eve = call('me', null, null, 'Eve')['body']['data']['user']['id'];
    // Nur Freund:innen lassen sich direkt hinzufügen
    assertSame(422, call('create_event', ['name' => 'Grillen', 'friends' => [$eve]])['status']);

    // Platzhalter „Sam“ wird mit Sams Konto verknüpft
    $r = call('create_event', ['name' => 'Grillen', 'participants' => ['Sam', 'Tom'], 'friends' => [$sam]]);
    assertSame(201, $r['status']);
    $code = $r['body']['data']['code'];
    $state = call('event', null, $code, 'Sam')['body']['data'];
    $samPerson = array_values(array_filter($state['participants'], fn ($p) => $p['name'] === 'Sam'))[0];
    assertSame([true, $sam], [$samPerson['linked'], $samPerson['user_id']]);
    assertSame($samPerson['id'], $state['me'], 'Sam ist sofort Mitglied');
    assertTrue(in_array('Grillen', array_column(call('me', null, null, 'Sam')['body']['data']['user']['events'], 'name'), true), 'Event in Sams Liste');

    // Sam holt Gina später dazu
    befriend('Sam', 'Gina');
    $r = call('add_friends', ['friends' => [$gina]], $code, 'Sam');
    assertSame(200, $r['status']);
    assertSame(['Alex', 'Sam', 'Tom', 'Gina'], array_column($r['body']['data']['state']['participants'], 'name'));
    assertSame(409, call('add_friends', ['friends' => [$gina]], $code, 'Sam')['status'], 'schon dabei');
    assertSame(422, call('add_friends', ['friends' => [$eve]], $code, 'Sam')['status'], 'keine Freundin von Sam');
    assertTrue(str_contains($r['body']['data']['state']['activity'][0]['summary'], 'Sam hat Gina hinzugefügt'));
});

test('Abrechnung abschließen sperrt Ausgaben, Zahlungen bleiben möglich', function () use (&$code, &$ids) {
    $r = call('close_event', [], $code, 'Sam');
    assertSame(200, $r['status']);
    $state = $r['body']['data']['state'];
    assertTrue($state['event']['closed_at'] !== null, 'abgeschlossen');
    assertSame($ids['Sam'], $state['event']['closed_by']);
    assertTrue(str_contains($state['activity'][0]['summary'], 'Sam hat die Abrechnung abgeschlossen'));

    $r = call('save_expense', [
        'amount_cents' => 500, 'category' => 'essen', 'paid_by' => $ids['Alex'],
        'participants' => [$ids['Alex']], 'spent_at' => '2026-10-24T02:00',
    ], $code);
    assertSame(409, $r['status']);
    assertSame('event_closed', $r['body']['error']['code']);
    $expense = $state['expenses'][0];
    assertSame(409, call('delete_expense', ['id' => $expense['id'], 'version' => $expense['version']], $code)['status']);

    // Ausgleich bleibt möglich
    $pay = $state['summary']['plan'][0];
    $r = call('add_settlement', ['from' => $pay['from'], 'to' => $pay['to'], 'amount_cents' => $pay['amount_cents']], $code);
    assertSame(200, $r['status']);
    call('delete_settlement', ['id' => $r['body']['data']['state']['settlements'][0]['id']], $code);

    assertSame(200, call('close_event', [], $code)['status'], 'zweimal schließen ist harmlos');
    $r = call('reopen_event', [], $code, 'Alex');
    assertSame(null, $r['body']['data']['state']['event']['closed_at']);
    assertTrue(str_contains($r['body']['data']['state']['activity'][0]['summary'], 'Alex hat die Abrechnung wieder geöffnet'));
});

test('Methoden und Aktionen', function () use (&$code) {
    global $port, $sessions;
    $raw = file_get_contents("http://127.0.0.1:$port/api/index.php?action=delete_expense", false, stream_context_create(['http' => [
        'header' => "X-Event-Code: $code\r\nCookie: " . Auth::COOKIE . '=' . $sessions['Alex'], 'ignore_errors' => true,
    ]]));
    assertSame('method_not_allowed', json_decode($raw, true)['error']['code'], 'Änderungen nur per POST');
    assertSame(404, call('gibt_es_nicht', [], $code)['status']);
    assertSame(403, call('migrate&key=falsch', null, null, null)['status']);
    assertSame(200, call('migrate&key=test-setup-key-1234567890', null, null, null)['status']);
});

finish();
