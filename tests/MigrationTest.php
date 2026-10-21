<?php
declare(strict_types=1);

// Ausführen: php tests/MigrationTest.php
// Prüft, dass eine bestehende Installation (Schema-Version 1, ohne Benutzerkonten) samt Daten
// automatisch auf die aktuelle Version gebracht wird – auch wenn ein Update vorher abgebrochen ist.
//
// Gegen MySQL/MariaDB (Achtung: löscht alle fs_-Tabellen der angegebenen Datenbank):
//   FS_TEST_DSN='mysql:host=127.0.0.1;dbname=fs_test;charset=utf8mb4' FS_TEST_USER=fs FS_TEST_PASSWORD=… php tests/MigrationTest.php

require __DIR__ . '/assert.php';
require __DIR__ . '/../public/api/lib/Http.php';
require __DIR__ . '/../public/api/lib/Db.php';
require __DIR__ . '/../public/api/lib/Split.php';
require __DIR__ . '/../public/api/lib/Store.php';

$tmp = sys_get_temp_dir() . '/friendsplit-migration-' . bin2hex(random_bytes(4));
mkdir($tmp);
register_shutdown_function(function () use ($tmp) {
    array_map('unlink', glob("$tmp/*"));
    rmdir($tmp);
});

/** Frische Datenbank mit dem alten Schema (Version 1) und einem Event darin. */
function oldDatabase(string $tmp): PDO
{
    if (getenv('FS_TEST_DSN')) {
        $pdo = Db::connect(['dsn' => getenv('FS_TEST_DSN'), 'user' => getenv('FS_TEST_USER') ?: null, 'password' => getenv('FS_TEST_PASSWORD') ?: null]);
        $pdo->exec('SET FOREIGN_KEY_CHECKS = 0');
        foreach (['fs_activity', 'fs_settlements', 'fs_expense_shares', 'fs_expenses', 'fs_event_participants', 'fs_persons', 'fs_events', 'fs_login_attempts', 'fs_tokens', 'fs_sessions', 'fs_users'] as $table) {
            $pdo->exec("DROP TABLE IF EXISTS $table");
        }
        $pdo->exec('SET FOREIGN_KEY_CHECKS = 1');
    } else {
        $pdo = Db::connect(['dsn' => "sqlite:$tmp/" . bin2hex(random_bytes(4)) . '.sqlite']);
    }
    $file = __DIR__ . '/fixtures/schema-v1.' . (Db::driver($pdo) === 'sqlite' ? 'sqlite' : 'mysql') . '.sql';
    $sql = (string) preg_replace('/^\s*--.*$/m', '', (string) file_get_contents($file));
    foreach (array_filter(array_map('trim', explode(';', $sql))) as $statement) {
        $pdo->exec($statement);
    }
    $now = Db::now();
    $pdo->exec("INSERT INTO fs_events (id, access_code, name, created_by_person_id, created_at, updated_at) VALUES ('ev1', 'K7Q2MX9P4HTR', 'Altes Event', 'p1', '$now', '$now')");
    $pdo->exec("INSERT INTO fs_persons (id, display_name, created_at) VALUES ('p1', 'Alex', '$now'), ('p2', 'Sam', '$now')");
    $pdo->exec("INSERT INTO fs_event_participants (event_id, person_id, role, position, joined_at) VALUES ('ev1', 'p1', 'organizer', 0, '$now'), ('ev1', 'p2', 'member', 1, '$now')");
    return $pdo;
}

test('Leere Datenbank wird komplett angelegt', function () use ($tmp) {
    $pdo = oldDatabase($tmp);
    if (Db::driver($pdo) === 'mysql') {
        $pdo->exec('SET FOREIGN_KEY_CHECKS = 0');
    }
    foreach (['fs_activity', 'fs_settlements', 'fs_expense_shares', 'fs_expenses', 'fs_event_participants', 'fs_persons', 'fs_events'] as $t) {
        $pdo->exec("DROP TABLE $t");
    }
    if (Db::driver($pdo) === 'mysql') {
        $pdo->exec('SET FOREIGN_KEY_CHECKS = 1');
    }
    assertSame(0, Db::version($pdo));
    Db::migrate($pdo);
    assertSame(Db::VERSION, Db::version($pdo));
});

test('Version 1 mit Daten wird aktualisiert, Daten bleiben erhalten', function () use ($tmp) {
    $pdo = oldDatabase($tmp);
    assertSame(1, Db::version($pdo));
    Db::migrate($pdo);
    assertSame(2, Db::version($pdo));

    $store = new Store($pdo);
    $event = $store->requireEvent('K7Q2-MX9P-4HTR');
    $state = $store->state($event);
    assertSame(['Alex', 'Sam'], array_column($state['participants'], 'name'));
    assertSame([false, false], array_column($state['participants'], 'linked'));
    assertSame(null, $event['owner_user_id']);

    // Konto anlegen und mit Alex verknüpfen: Organisator-Person → wird Owner
    $now = Db::now();
    $pdo->exec("INSERT INTO fs_users (id, username, display_name, password_hash, role, status, created_at) VALUES ('u1', 'alex', 'Alex', 'x', 'member', 'active', '$now')");
    $user = $pdo->query("SELECT * FROM fs_users WHERE id = 'u1'")->fetch();
    $store->joinEvent($event, ['person_id' => 'p1'], $user);
    assertSame('Altes Event', $store->myEvents('u1')[0]['name']);
    assertTrue($store->myEvents('u1')[0]['is_owner']);

    // Ein zweites Konto kann Alex nicht übernehmen (eindeutig pro Event)
    $pdo->exec("INSERT INTO fs_users (id, username, display_name, password_hash, role, status, created_at) VALUES ('u2', 'sam', 'Sam', 'x', 'member', 'active', '$now')");
    $sam = $pdo->query("SELECT * FROM fs_users WHERE id = 'u2'")->fetch();
    assertThrows(fn () => $store->joinEvent($event, ['person_id' => 'p1'], $sam), ApiError::class);
    assertThrows(
        fn () => $pdo->exec("UPDATE fs_event_participants SET user_id = 'u1' WHERE person_id = 'p2'"),
        PDOException::class
    );

    // Erneuter Aufruf ändert nichts
    Db::migrate($pdo);
    assertSame(2, Db::version($pdo));
});

test('Abgebrochenes Update wird beim nächsten Aufruf fortgesetzt', function () use ($tmp) {
    $pdo = oldDatabase($tmp);
    $driver = Db::driver($pdo) === 'sqlite' ? 'sqlite' : 'mysql';
    // Nur die erste Hälfte des Updates ausführen (Tabellen und user_id, aber noch kein owner_user_id)
    $sql = (string) preg_replace('/^\s*--.*$/m', '', (string) file_get_contents(__DIR__ . "/../public/api/schema/update-2.$driver.sql"));
    $statements = array_values(array_filter(array_map('trim', explode(';', $sql))));
    foreach (array_slice($statements, 0, -1) as $statement) {
        $pdo->exec($statement);
    }
    assertSame(1, Db::version($pdo), 'ohne owner_user_id gilt Version 1');
    Db::migrate($pdo);
    assertSame(2, Db::version($pdo));
});

finish();
