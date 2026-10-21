<?php
declare(strict_types=1);

/*
 * FriendSplit – JSON-API
 *
 * Aufruf: api/index.php?action=<name>
 * Event-Zugriff: Header "X-Event-Code" (geheimer Zugangscode aus dem Event-Link)
 * Konto: HttpOnly-Cookie "fs_session" (optional – Events funktionieren auch ohne Anmeldung)
 * Ohne Anmeldung gewählte Person: Header "X-Person-Id" (keine sichere Anmeldung)
 * Schreibende Aufrufe (POST) brauchen den Header "X-Requested-With: FriendSplit" (Schutz vor CSRF).
 */

require __DIR__ . '/lib/Http.php';
require __DIR__ . '/lib/Db.php';
require __DIR__ . '/lib/Split.php';
require __DIR__ . '/lib/Store.php';
require __DIR__ . '/lib/Auth.php';

ini_set('display_errors', '0');

try {
    $configFile = getenv('FRIENDSPLIT_CONFIG') ?: __DIR__ . '/config.php';
    if (!is_file($configFile)) {
        throw new ApiError(503, 'not_configured', 'FriendSplit ist noch nicht eingerichtet: api/config.php fehlt (siehe README).');
    }
    $config = require $configFile;

    $action = is_string($_GET['action'] ?? null) ? $_GET['action'] : '';
    $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
    if ($method === 'POST' && Http::header('X-Requested-With') !== 'FriendSplit') {
        throw new ApiError(403, 'forbidden', 'Ungültige Anfrage. Bitte lade die Seite neu.');
    }

    try {
        $pdo = Db::connect($config['db']);
    } catch (PDOException $e) {
        error_log('FriendSplit DB connect failed: ' . $e->getMessage());
        throw new ApiError(503, 'db_unavailable', 'Die Datenbank ist gerade nicht erreichbar. Bitte versuche es gleich noch einmal.');
    }
    // Legt fehlende Tabellen an bzw. aktualisiert ältere Installationen automatisch.
    Db::migrate($pdo);

    if ($action === 'setup') {
        $key = (string) ($config['setup_key'] ?? '');
        if (strlen($key) < 16 || !hash_equals($key, (string) ($_GET['key'] ?? ''))) {
            throw new ApiError(403, 'forbidden', 'Ungültiger oder fehlender Setup-Schlüssel.');
        }
        Http::ok(['message' => 'Datenbanktabellen sind eingerichtet (Version ' . Db::version($pdo) . ').']);
    }

    $store = new Store($pdo);
    $auth = new Auth($pdo, (bool) ($config['require_https'] ?? true));
    $user = $auth->resolve();

    // ---------------------------------------------------------------- Konto (ohne Event)

    $accountActions = [
        'me'              => ['GET', fn () => ['user' => Auth::publicUser($auth->user()), 'needs_setup' => $auth->needsSetup()]],
        'login'           => ['POST', fn ($in) => $auth->login($in)],
        'logout'          => ['POST', fn () => $auth->logout()],
        'setup_admin'     => ['POST', fn ($in) => $auth->setupAdmin($in, (string) ($config['setup_key'] ?? ''))],
        'check_invite'    => ['GET', fn () => $auth->checkToken('invite', is_string($_GET['code'] ?? null) ? $_GET['code'] : null)],
        'register'        => ['POST', fn ($in) => $auth->register($in)],
        'check_reset'     => ['GET', fn () => $auth->checkToken('reset', is_string($_GET['code'] ?? null) ? $_GET['code'] : null)],
        'reset_password'  => ['POST', fn ($in) => $auth->resetPassword($in)],
        'update_profile'  => ['POST', fn ($in) => $auth->updateProfile($in)],
        'change_password' => ['POST', fn ($in) => $auth->changePassword($in)],
        'my_events'       => ['GET', fn () => ['events' => $store->myEvents($auth->requireUser()['id'])]],
        'import_local'    => ['POST', fn ($in) => $store->importLocal($in, $auth->requireUser())],
        'admin_overview'  => ['GET', fn () => $auth->adminOverview() + ['events' => $store->allEvents()]],
        'admin_create_invite' => ['POST', fn ($in) => $auth->createInvite($in)],
        'admin_revoke_invite' => ['POST', fn ($in) => $auth->revokeInvite($in)],
        'admin_reset_link'    => ['POST', fn ($in) => $auth->createResetLink($in)],
        'admin_update_user'   => ['POST', fn ($in) => $auth->updateUser($in)],
        'admin_delete_user'   => ['POST', fn ($in) => $auth->deleteUser($in)],
    ];
    if (isset($accountActions[$action])) {
        [$expected, $handler] = $accountActions[$action];
        if ($expected === 'POST') {
            requirePost($method);
        }
        $result = $handler($expected === 'POST' ? Http::jsonBody() : []);
        Http::ok(is_array($result) ? $result : new stdClass());
    }

    if ($action === 'create_event') {
        requirePost($method);
        $created = $store->createEvent(Http::jsonBody(), $user);
        Http::ok($created, 201);
    }

    // ---------------------------------------------------------------- Event (über Zugangscode)

    $event = $store->requireEvent(Http::header('X-Event-Code'));
    $actor = $store->actor($event, $user, Http::header('X-Person-Id'));

    if ($action === 'event') {
        Http::ok($store->state($event, $user));
    }

    if ($action === 'delete_event') {
        requirePost($method);
        $store->deleteEvent($event, $user);
        Http::ok(['deleted' => true]);
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
        'join_event'         => fn ($in) => ['person_id' => $store->joinEvent($event, $in, $auth->requireUser())],
        'leave_event'        => fn ($in) => $store->leaveEvent($event, $auth->requireUser()),
        'unlink_participant' => fn ($in) => $store->unlinkParticipant($event, $in, $user, $actor),
        'regenerate_code'    => fn ($in) => ['code' => $store->regenerateCode($event, $user, $actor)],
    ];
    if (!isset($mutations[$action])) {
        throw new ApiError(404, 'unknown_action', 'Unbekannte Aktion.');
    }
    requirePost($method);
    $result = $mutations[$action](Http::jsonBody());
    $event = $store->requireEventById($event['id']);
    Http::ok(array_merge(is_array($result) ? $result : [], ['state' => $store->state($event, $user)]));
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
