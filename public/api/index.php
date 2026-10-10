<?php
declare(strict_types=1);

/*
 * FriendSplit – JSON-API
 *
 * Aufruf: api/index.php?action=<name>
 * Event-Zugriff: Header "X-Event-Code" (geheimer Zugangscode aus dem Event-Link)
 * Aktuelle Person: Header "X-Person-Id" (nur zur Zuordnung, keine sichere Anmeldung)
 */

require __DIR__ . '/lib/Http.php';
require __DIR__ . '/lib/Db.php';
require __DIR__ . '/lib/Split.php';
require __DIR__ . '/lib/Store.php';

ini_set('display_errors', '0');

try {
    $configFile = getenv('FRIENDSPLIT_CONFIG') ?: __DIR__ . '/config.php';
    if (!is_file($configFile)) {
        throw new ApiError(503, 'not_configured', 'FriendSplit ist noch nicht eingerichtet: api/config.php fehlt (siehe README).');
    }
    $config = require $configFile;

    $action = is_string($_GET['action'] ?? null) ? $_GET['action'] : '';
    $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

    try {
        $pdo = Db::connect($config['db']);
    } catch (PDOException $e) {
        error_log('FriendSplit DB connect failed: ' . $e->getMessage());
        throw new ApiError(503, 'db_unavailable', 'Die Datenbank ist gerade nicht erreichbar. Bitte versuche es gleich noch einmal.');
    }
    if (!empty($config['auto_migrate'])) {
        Db::migrate($pdo);
    }

    // Einmalige Einrichtung der Tabellen über den Browser, geschützt durch setup_key aus der Konfiguration.
    if ($action === 'setup') {
        $key = (string) ($config['setup_key'] ?? '');
        if (strlen($key) < 16 || !hash_equals($key, (string) ($_GET['key'] ?? ''))) {
            throw new ApiError(403, 'forbidden', 'Ungültiger oder fehlender Setup-Schlüssel.');
        }
        Db::migrate($pdo);
        Http::ok(['message' => 'Datenbanktabellen sind eingerichtet.']);
    }

    $store = new Store($pdo);

    if ($action === 'create_event') {
        requirePost($method);
        $created = $store->createEvent(Http::jsonBody());
        Http::ok($created, 201);
    }

    $event = $store->requireEvent(Http::header('X-Event-Code'));
    $actor = $store->actor($event, Http::header('X-Person-Id'));

    if ($action === 'event') {
        Http::ok($store->state($event));
    }

    $mutations = [
        'update_event'       => fn ($in) => $store->updateEvent($event, $in, $actor),
        'add_participant'    => fn ($in) => ['person_id' => $store->addParticipant($event, $in, $actor)],
        'rename_participant' => fn ($in) => $store->renameParticipant($event, $in, $actor),
        'remove_participant' => fn ($in) => $store->removeParticipant($event, $in, $actor),
        'save_expense'       => fn ($in) => ['expense_id' => $store->saveExpense($event, $in, $actor)],
        'delete_expense'     => fn ($in) => $store->deleteExpense($event, $in, $actor),
        'add_settlement'     => fn ($in) => $store->addSettlement($event, $in, $actor),
        'delete_settlement'  => fn ($in) => $store->deleteSettlement($event, $in, $actor),
    ];
    if (!isset($mutations[$action])) {
        throw new ApiError(404, 'unknown_action', 'Unbekannte Aktion.');
    }
    requirePost($method);
    $result = $mutations[$action](Http::jsonBody());
    $event = $store->requireEvent($event['access_code']);
    Http::ok(array_merge(is_array($result) ? $result : [], ['state' => $store->state($event)]));
} catch (ApiError $e) {
    Http::error($e);
} catch (Throwable $e) {
    error_log('FriendSplit error: ' . $e);
    Http::error(new ApiError(500, 'server_error', 'Auf dem Server ist ein Fehler aufgetreten. Deine Änderung wurde nicht gespeichert.'));
}

function requirePost(string $method): void
{
    if ($method !== 'POST') {
        throw new ApiError(405, 'method_not_allowed', 'Diese Aktion erfordert POST.');
    }
}
