<?php
declare(strict_types=1);

/*
 * FriendSplit – JSON-API
 *
 * Aufruf: api/index.php?action=<name>
 * Anmeldung: Sitzungs-Cookie (HttpOnly) nach Login mit E-Mail und Passwort
 * Event-Zugriff: Header "X-Event-Code" (geheimer Zugangscode aus dem Event-Link)
 * Schutz vor CSRF: Jede POST-Anfrage muss den Header "X-Requested-With: FriendSplit" tragen.
 */

require __DIR__ . '/lib/Http.php';
require __DIR__ . '/lib/Db.php';
require __DIR__ . '/lib/Split.php';
require __DIR__ . '/lib/Store.php';
require __DIR__ . '/lib/Mailer.php';
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

    if ($method === 'POST' && Http::header('X-Requested-With') !== 'FriendSplit') {
        throw new ApiError(403, 'csrf', 'Die Anfrage wurde aus Sicherheitsgründen abgelehnt. Bitte lade die Seite neu.');
    }

    $store = new Store($pdo);
    $https = ($_SERVER['HTTPS'] ?? '') !== '' && ($_SERVER['HTTPS'] ?? '') !== 'off'
        || strtolower((string) ($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '')) === 'https';
    // Cookie gilt für den App-Ordner, z. B. /friendsplit/ bei /friendsplit/api/index.php
    $cookiePath = rtrim(str_replace('\\', '/', dirname((string) ($_SERVER['SCRIPT_NAME'] ?? '/api/index.php'), 2)), '/') . '/';
    $auth = new Auth($pdo, new Mailer($config['mail'] ?? []), (string) ($config['app_url'] ?? ''), $cookiePath, $https, (string) ($_SERVER['REMOTE_ADDR'] ?? ''));

    // Aktionen ohne Anmeldung
    $public = [
        'register'               => function ($in) use ($auth) { $auth->register($in); return ['message' => 'Fast geschafft! Wir haben dir eine E-Mail mit einem Bestätigungslink geschickt.']; },
        'resend_verification'    => function ($in) use ($auth) { $auth->resendVerification($in); return ['message' => 'Falls ein unbestätigtes Konto zu dieser Adresse existiert, haben wir einen neuen Bestätigungslink geschickt.']; },
        'verify_email'           => fn ($in) => ['user' => $auth->profile($auth->verifyEmail($in))],
        'login'                  => fn ($in) => ['user' => $auth->profile($auth->login($in))],
        'logout'                 => function () use ($auth) { $auth->logout(); return []; },
        'request_password_reset' => function ($in) use ($auth) { $auth->requestPasswordReset($in); return ['message' => 'Falls ein Konto zu dieser Adresse existiert, haben wir dir einen Link zum Zurücksetzen geschickt.']; },
        'reset_password'         => fn ($in) => ['user' => $auth->profile($auth->resetPassword($in))],
        'confirm_email_change'   => fn ($in) => ['user' => $auth->profile($auth->confirmEmailChange($in))],
    ];
    if (isset($public[$action])) {
        requirePost($method);
        Http::ok($public[$action](Http::jsonBody()));
    }

    $user = $auth->requireUser();

    if ($action === 'me') {
        Http::ok(['user' => $auth->profile($user)]);
    }
    $account = [
        'update_profile'  => fn ($in) => $auth->updateProfile($user, $in),
        'change_email'    => fn ($in) => $auth->requestEmailChange($user, $in),
        'change_password' => fn ($in) => $auth->changePassword($user, $in),
        'delete_account'  => function ($in) use ($auth, $user) { $auth->deleteAccount($user, $in); return false; },
    ];
    if (isset($account[$action])) {
        requirePost($method);
        $result = $account[$action](Http::jsonBody());
        if ($result === false) {
            Http::ok(['deleted' => true]);
        }
        Http::ok(['user' => $auth->profile($result)]);
    }
    if ($action === 'create_event') {
        requirePost($method);
        $created = $store->createEvent(Http::jsonBody(), $user);
        Http::ok($created, 201);
    }

    $event = $store->requireEvent(Http::header('X-Event-Code'));
    $actor = $store->actor($event, $user['id']);

    if ($action === 'event') {
        Http::ok($store->state($event, $actor));
    }

    // Beitreten: neue Person anlegen oder einen Platzhalter-Namen übernehmen
    $joins = [
        'join_event'   => fn ($in) => $store->joinEvent($event, $in, $user),
        'claim_person' => fn ($in) => $store->claimPerson($event, $in, $user),
    ];
    if (isset($joins[$action])) {
        requirePost($method);
        $personId = $joins[$action](Http::jsonBody());
        Http::ok(['person_id' => $personId, 'state' => $store->state($store->requireEvent($event['access_code']), $personId)]);
    }

    if ($actor === null) {
        throw new ApiError(403, 'not_member', 'Du nimmst an diesem Event noch nicht teil. Tritt zuerst bei.');
    }

    $mutations = [
        'update_event'       => fn ($in) => $store->updateEvent($event, $in, $actor),
        'add_participant'    => fn ($in) => ['person_id' => $store->addParticipant($event, $in, $actor)],
        'rename_participant' => fn ($in) => $store->renameParticipant($event, $in, $actor),
        'set_paypal'         => fn ($in) => $store->setPaypal($event, $in, $actor),
        'remove_participant' => fn ($in) => $store->removeParticipant($event, $in, $actor),
        'save_expense'       => fn ($in) => ['expense_id' => $store->saveExpense($event, $in, $actor)],
        'delete_expense'     => fn ($in) => $store->deleteExpense($event, $in, $actor),
        'add_settlement'     => fn ($in) => $store->addSettlement($event, $in, $actor),
        'delete_settlement'  => fn ($in) => $store->deleteSettlement($event, $in, $actor),
        'release_person'     => fn () => $store->releasePerson($event, $actor),
    ];
    if (!isset($mutations[$action])) {
        throw new ApiError(404, 'unknown_action', 'Unbekannte Aktion.');
    }
    requirePost($method);
    $result = $mutations[$action](Http::jsonBody());
    $event = $store->requireEvent($event['access_code']);
    Http::ok(array_merge(is_array($result) ? $result : [], ['state' => $store->state($event, $store->actor($event, $user['id']))]));
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
