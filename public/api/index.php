<?php
declare(strict_types=1);

/*
 * FriendSplit – JSON-API
 *
 * Aufruf: api/index.php?action=<name>
 * Anmeldung: Sitzungs-Cookie (HttpOnly) nach Login mit Name/E-Mail, Passwort und – auf neuen Geräten –
 *            einem 6-stelligen Code per E-Mail. Registrieren nur mit Einladung.
 * Event-Zugriff: Header "X-Event-Code" (geheimer Zugangscode aus dem Event-Link)
 * Schutz vor CSRF: Jede POST-Anfrage muss den Header "X-Requested-With: FriendSplit" tragen.
 */

require __DIR__ . '/lib/Http.php';
require __DIR__ . '/lib/Db.php';
require __DIR__ . '/lib/Split.php';
require __DIR__ . '/lib/Store.php';
require __DIR__ . '/lib/Mailer.php';
require __DIR__ . '/lib/Auth.php';
require __DIR__ . '/lib/Social.php';

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

    // Tabellen von Hand einrichten (falls auto_migrate aus ist), geschützt durch setup_key aus der Konfiguration.
    if ($action === 'migrate') {
        $key = (string) ($config['setup_key'] ?? '');
        if (strlen($key) < 16 || !hash_equals($key, (string) ($_GET['key'] ?? ''))) {
            throw new ApiError(403, 'forbidden', 'Ungültiger oder fehlender Setup-Schlüssel.');
        }
        Db::migrate($pdo, true);
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
    // Einrichtungscode für das erste Konto: setup_code (mind. 12 Zeichen), sonst das Datenbank-Passwort.
    $setupCode = (string) ($config['setup_code'] ?? '');
    if (strlen($setupCode) < 12) {
        $setupCode = (string) ($config['db']['password'] ?? '');
    }
    $auth = new Auth(
        $pdo,
        new Mailer($config['mail'] ?? []),
        (string) ($config['app_url'] ?? ''),
        $cookiePath,
        $https,
        (string) ($_SERVER['REMOTE_ADDR'] ?? ''),
        $setupCode,
    );
    $social = new Social($pdo, $auth);

    // ---------------------------------------------------------------- ohne Anmeldung
    if ($action === 'status') {
        Http::ok(['setup_needed' => $auth->setupNeeded()]);
    }
    if ($action === 'invite_info') {
        Http::ok($social->inviteInfo(is_string($_GET['code'] ?? null) ? $_GET['code'] : ''));
    }
    $userOrChallenge = function (array $result) use ($auth): never {
        if (isset($result['pending'])) {
            Http::ok($result, 202); // Code aus der E-Mail nötig
        }
        Http::ok(['user' => $auth->profile($result['user'] ?? $result)]);
    };
    $public = [
        'setup_account'          => fn ($in) => $userOrChallenge($auth->setup($in)),
        'register'               => fn ($in) => $userOrChallenge($auth->register($in)),
        'login'                  => fn ($in) => $userOrChallenge($auth->login($in)),
        'verify_code'            => fn ($in) => $userOrChallenge($auth->verifyCode($in)),
        'resend_code'            => function ($in) use ($auth) { $auth->resendCode($in); Http::ok(['message' => 'Ein neuer Code ist unterwegs.']); },
        'logout'                 => function () use ($auth) { $auth->logout(); Http::ok([]); },
        'request_password_reset' => function ($in) use ($auth) { $auth->requestPasswordReset($in); Http::ok(['message' => 'Falls es ein Konto dazu gibt, haben wir dir einen Link zum Zurücksetzen geschickt.']); },
        'reset_password'         => fn ($in) => $userOrChallenge($auth->resetPassword($in)),
        'confirm_email_change'   => fn ($in) => $userOrChallenge($auth->confirmEmailChange($in)),
    ];
    if (isset($public[$action])) {
        requirePost($method);
        $public[$action](Http::jsonBody());
    }

    // ---------------------------------------------------------------- Konto, Freunde, Einladungen
    $user = $auth->requireUser();
    $idOf = fn (array $in): string => is_string($in['id'] ?? null) ? $in['id'] : '';

    $reads = [
        'me'      => fn () => ['user' => $auth->profile($user)],
        'friends' => fn () => $social->friends($user),
        'search'  => fn () => ['results' => $social->search($user, is_string($_GET['q'] ?? null) ? $_GET['q'] : '')],
        'invites' => fn () => ['invites' => $social->invites($user)],
        'admin_users' => function () use ($auth, $social) { $auth->requireAdmin(); return ['users' => $social->adminUsers()]; },
    ];
    if (isset($reads[$action])) {
        Http::ok($reads[$action]());
    }

    $account = [
        'update_profile'  => fn ($in) => ['user' => $auth->profile($auth->updateProfile($user, $in))],
        'change_email'    => fn ($in) => ['user' => $auth->profile($auth->requestEmailChange($user, $in))],
        'change_password' => fn ($in) => ['user' => $auth->profile($auth->changePassword($user, $in))],
        'delete_account'  => function ($in) use ($auth, $user) { $auth->deleteAccount($user, $in); return ['deleted' => true]; },
        'invite_create'   => fn ($in) => ['invite' => $social->createInvite($user, $in), 'invites' => $social->invites($user)],
        'invite_permanent' => fn ($in) => ['invite' => $social->permanentInvite($user, ($in['renew'] ?? false) === true)],
        'invite_delete'   => function ($in) use ($social, $user) {
            $social->deleteInvite($user, is_string($in['code'] ?? null) ? $in['code'] : '');
            return ['invites' => $social->invites($user)];
        },
        'friend_request'  => function ($in) use ($social, $user, $idOf) { $social->request($user, $idOf($in)); return $social->friends($user); },
        'friend_accept'   => function ($in) use ($social, $user, $idOf) { $social->accept($user, $idOf($in)); return $social->friends($user); },
        'friend_remove'   => function ($in) use ($social, $user, $idOf) { $social->remove($user, $idOf($in)); return $social->friends($user); },
        'admin_block'     => function ($in) use ($auth, $social, $idOf) {
            $social->adminSetBlocked($auth->requireAdmin(), $idOf($in), ($in['blocked'] ?? false) === true);
            return ['users' => $social->adminUsers()];
        },
        'admin_delete'    => function ($in) use ($auth, $social, $idOf) {
            $social->adminDelete($auth->requireAdmin(), $idOf($in));
            return ['users' => $social->adminUsers()];
        },
        'admin_reset_link' => function ($in) use ($auth, $idOf) { $auth->requireAdmin(); return ['link' => $auth->adminResetLink($idOf($in))]; },
    ];
    if (isset($account[$action])) {
        requirePost($method);
        Http::ok($account[$action](Http::jsonBody()));
    }

    /** Freund:innen aus der Liste prüfen und als Konten laden */
    $friendRows = function (array $ids) use ($social, $auth, $user): array {
        $rows = [];
        foreach (array_unique(array_filter($ids, 'is_string')) as $id) {
            if (!$social->areFriends($user['id'], $id)) {
                throw new ApiError(422, 'not_friends', 'Du kannst nur Freund:innen direkt hinzufügen.');
            }
            $rows[] = $auth->userById($id);
        }
        return $rows;
    };

    if ($action === 'create_event') {
        requirePost($method);
        $in = Http::jsonBody();
        $friends = $friendRows(is_array($in['friends'] ?? null) ? $in['friends'] : []);
        $created = $store->createEvent($in, $user);
        $event = $store->requireEvent($created['code']);
        foreach ($friends as $friend) {
            $store->addAccount($event, $friend, $created['person_id']);
        }
        Http::ok($created, 201);
    }

    // ---------------------------------------------------------------- Event
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
        'add_friends'        => function ($in) use ($store, $event, $actor, $friendRows) {
            $ids = [];
            foreach ($friendRows(is_array($in['friends'] ?? null) ? $in['friends'] : []) as $friend) {
                $ids[] = $store->addAccount($event, $friend, $actor);
            }
            return ['person_ids' => $ids];
        },
        'rename_participant' => fn ($in) => $store->renameParticipant($event, $in, $actor),
        'set_paypal'         => fn ($in) => $store->setPaypal($event, $in, $actor),
        'remove_participant' => fn ($in) => $store->removeParticipant($event, $in, $actor),
        'save_expense'       => fn ($in) => ['expense_id' => $store->saveExpense($event, $in, $actor)],
        'delete_expense'     => fn ($in) => $store->deleteExpense($event, $in, $actor),
        'add_settlement'     => fn ($in) => $store->addSettlement($event, $in, $actor),
        'delete_settlement'  => fn ($in) => $store->deleteSettlement($event, $in, $actor),
        'release_person'     => fn () => $store->releasePerson($event, $actor),
        'close_event'        => fn () => $store->closeEvent($event, $actor),
        'reopen_event'       => fn () => $store->reopenEvent($event, $actor),
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
