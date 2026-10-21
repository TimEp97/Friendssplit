<?php
declare(strict_types=1);

/**
 * Benutzerkonten: Anmeldung mit Benutzername und Passwort, Sitzungen per Cookie (in der Datenbank
 * gespeichert, nicht als PHP-Session), Registrierung nur mit Einladung, Admin-Funktionen.
 * Konten sind optional – Events funktionieren weiterhin auch nur mit dem Zugangscode.
 */
final class Auth
{
    public const COOKIE = 'fs_session';

    private const REMEMBER_DAYS = 90;
    private const SHORT_HOURS = 12;
    private const MIN_PASSWORD = 10;
    private const MAX_FAILS_PER_USER = 5;
    private const MAX_FAILS_PER_IP = 20;
    private const FAIL_WINDOW = '-15 minutes';
    private const TOKEN_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
    private const TOKEN_LENGTH = 12;
    private const COMMON_PASSWORDS = [
        '1234567890', '12345678910', '0123456789', '1111111111', 'passwort123', 'password123', 'passwort1234',
        'password1234', 'qwertzuiop', 'qwertyuiop', 'hallo12345', 'iloveyou12', 'friendsplit', 'friendsplit1',
    ];

    /** @var array<string,mixed>|null */
    private ?array $user = null;
    private ?string $sessionId = null;

    public function __construct(private PDO $db, private bool $requireHttps = true)
    {
    }

    // ------------------------------------------------------------------ Sitzung

    /**
     * Ermittelt das angemeldete Konto aus dem Sitzungs-Cookie (oder null).
     * @return array<string,mixed>|null
     */
    public function resolve(): ?array
    {
        $token = $_COOKIE[self::COOKIE] ?? null;
        if (!is_string($token) || !preg_match('/^[a-f0-9]{64}$/', $token)) {
            return null;
        }
        $stmt = $this->db->prepare(
            'SELECT s.id AS session_id, s.remember, s.last_seen_at, s.expires_at, u.*
             FROM fs_sessions s JOIN fs_users u ON u.id = s.user_id WHERE s.token_hash = ?'
        );
        $stmt->execute([hash('sha256', $token)]);
        $row = $stmt->fetch();
        $now = Db::now();
        if (!$row || $row['expires_at'] <= $now || $row['status'] !== 'active') {
            if ($row) {
                $this->db->prepare('DELETE FROM fs_sessions WHERE id = ?')->execute([$row['session_id']]);
            }
            Http::cookie(self::COOKIE, null);
            return null;
        }
        // Gleitende Gültigkeit: höchstens einmal pro Stunde in die Datenbank schreiben.
        if ($row['last_seen_at'] <= Db::at('-1 hour')) {
            $remember = (bool) $row['remember'];
            $this->db->prepare('UPDATE fs_sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?')
                ->execute([$now, $this->sessionExpiry($remember), $row['session_id']]);
            if ($remember) {
                Http::cookie(self::COOKIE, $token, time() + self::REMEMBER_DAYS * 86400);
            }
        }
        $this->sessionId = $row['session_id'];
        $this->user = $row;
        return $row;
    }

    /** @return array<string,mixed>|null */
    public function user(): ?array
    {
        return $this->user;
    }

    /** @return array<string,mixed> */
    public function requireUser(): array
    {
        if ($this->user === null) {
            throw new ApiError(401, 'login_required', 'Bitte melde dich an.');
        }
        return $this->user;
    }

    /** @return array<string,mixed> */
    public function requireAdmin(): array
    {
        $user = $this->requireUser();
        if ($user['role'] !== 'admin') {
            throw new ApiError(403, 'forbidden', 'Dafür brauchst du Admin-Rechte.');
        }
        return $user;
    }

    /** @param array<string,mixed>|null $user */
    public static function publicUser(?array $user): ?array
    {
        return $user === null ? null : [
            'id' => $user['id'],
            'username' => $user['username'],
            'display_name' => $user['display_name'],
            'role' => $user['role'],
        ];
    }

    public function needsSetup(): bool
    {
        return (int) $this->db->query('SELECT COUNT(*) FROM fs_users')->fetchColumn() === 0;
    }

    // ------------------------------------------------------------------ Anmelden, Registrieren

    /** @param array<string,mixed> $in */
    public function login(array $in): array
    {
        $this->assertHttps();
        $username = $this->normalizeUsername($in['username'] ?? null);
        $password = is_string($in['password'] ?? null) ? $in['password'] : '';
        if ($username === '' || $password === '') {
            throw ApiError::validation(array_filter([
                'username' => $username === '' ? 'Bitte gib deinen Benutzernamen ein.' : null,
                'password' => $password === '' ? 'Bitte gib dein Passwort ein.' : null,
            ]));
        }

        $ipHash = hash('sha256', Http::clientIp());
        $this->db->prepare('DELETE FROM fs_login_attempts WHERE attempted_at < ?')->execute([Db::at('-1 day')]);
        $since = Db::at(self::FAIL_WINDOW);
        $byUser = $this->db->prepare('SELECT COUNT(*) FROM fs_login_attempts WHERE username = ? AND attempted_at > ?');
        $byUser->execute([$username, $since]);
        $byIp = $this->db->prepare('SELECT COUNT(*) FROM fs_login_attempts WHERE ip_hash = ? AND attempted_at > ?');
        $byIp->execute([$ipHash, $since]);
        if ((int) $byUser->fetchColumn() >= self::MAX_FAILS_PER_USER || (int) $byIp->fetchColumn() >= self::MAX_FAILS_PER_IP) {
            throw new ApiError(429, 'too_many_attempts', 'Zu viele fehlgeschlagene Anmeldungen. Bitte warte 15 Minuten und versuche es dann erneut.');
        }

        $user = $this->findUser('username', $username);
        // Auch bei unbekanntem Namen ein Passwort prüfen, damit die Antwortzeit nichts verrät.
        $valid = password_verify($password, $user['password_hash'] ?? '$2y$10$.ZszPYBTNZeNZqU0Ji0C8uqUIEj4An8ThH1jx.J30svOdJgA6e9vS');
        if (!$user || !$valid) {
            $this->db->prepare('INSERT INTO fs_login_attempts (id, username, ip_hash, attempted_at) VALUES (?, ?, ?, ?)')
                ->execute([Db::id(), $username, $ipHash, Db::now()]);
            throw new ApiError(401, 'invalid_login', 'Benutzername oder Passwort ist falsch.');
        }
        if ($user['status'] !== 'active') {
            throw new ApiError(403, 'account_disabled', 'Dein Konto ist gesperrt. Wende dich an den Admin.');
        }
        $this->db->prepare('DELETE FROM fs_login_attempts WHERE username = ?')->execute([$username]);
        if (password_needs_rehash($user['password_hash'], PASSWORD_DEFAULT)) {
            $this->db->prepare('UPDATE fs_users SET password_hash = ? WHERE id = ?')
                ->execute([password_hash($password, PASSWORD_DEFAULT), $user['id']]);
        }
        $this->db->prepare('UPDATE fs_users SET last_login_at = ? WHERE id = ?')->execute([Db::now(), $user['id']]);
        $this->startSession($user, !empty($in['remember']));
        return ['user' => self::publicUser($user)];
    }

    public function logout(): void
    {
        if ($this->sessionId !== null) {
            $this->db->prepare('DELETE FROM fs_sessions WHERE id = ?')->execute([$this->sessionId]);
        }
        Http::cookie(self::COOKIE, null);
        $this->user = null;
        $this->sessionId = null;
    }

    /**
     * Legt das erste Admin-Konto an. Nur möglich, solange es noch kein Konto gibt, und nur mit
     * dem setup_key aus config.php.
     * @param array<string,mixed> $in
     */
    public function setupAdmin(array $in, string $setupKey): array
    {
        $this->assertHttps();
        $given = is_string($in['setup_key'] ?? null) ? trim($in['setup_key']) : '';
        if (strlen($setupKey) < 16 || !hash_equals($setupKey, $given)) {
            throw ApiError::validation(['setup_key' => 'Der Setup-Schlüssel ist falsch oder in api/config.php nicht gesetzt (mindestens 16 Zeichen).']);
        }
        $fields = $this->validateAccount($in);
        if (!$this->needsSetup()) {
            throw new ApiError(409, 'already_setup', 'Es gibt bereits ein Admin-Konto. Bitte melde dich an.');
        }
        $user = $this->createUser($fields, 'admin');
        $this->startSession($user, true);
        return ['user' => self::publicUser($user)];
    }

    /** @param array<string,mixed> $in */
    public function register(array $in): array
    {
        $this->assertHttps();
        $code = Store::normalizeCode(is_string($in['invite'] ?? null) ? $in['invite'] : null);
        $invalid = 'Diese Einladung ist ungültig, abgelaufen oder wurde schon benutzt. Frag nach einer neuen.';
        $token = $code !== null ? $this->findToken('invite', $code) : null;
        if ($token === null) {
            throw ApiError::validation(['invite' => $invalid]);
        }
        $fields = $this->validateAccount($in);

        $this->db->beginTransaction();
        try {
            $stmt = $this->db->prepare('UPDATE fs_tokens SET uses = uses + 1 WHERE id = ? AND uses < max_uses AND expires_at > ?');
            $stmt->execute([$token['id'], Db::now()]);
            if ($stmt->rowCount() === 0) {
                throw ApiError::validation(['invite' => $invalid]);
            }
            $user = $this->createUser($fields, 'member');
            $this->db->commit();
        } catch (Throwable $e) {
            $this->db->rollBack();
            throw $e;
        }
        $this->startSession($user, true);
        return ['user' => self::publicUser($user)];
    }

    /** Prüft einen Einladungs- oder Reset-Code, bevor das Formular ausgefüllt wird. */
    public function checkToken(string $kind, ?string $raw): array
    {
        $code = Store::normalizeCode($raw);
        $token = $code !== null ? $this->findToken($kind, $code) : null;
        if ($token === null) {
            return ['valid' => false];
        }
        $out = ['valid' => true, 'expires_at' => $this->isoUtc($token['expires_at'])];
        if ($kind === 'reset') {
            $user = $this->findUser('id', (string) $token['user_id']);
            $out['username'] = $user['username'] ?? null;
        }
        return $out;
    }

    /** Neues Passwort mit einem Reset-Link vom Admin setzen. Beendet alle bisherigen Sitzungen. */
    public function resetPassword(array $in): array
    {
        $this->assertHttps();
        $code = Store::normalizeCode(is_string($in['code'] ?? null) ? $in['code'] : null);
        $token = $code !== null ? $this->findToken('reset', $code) : null;
        $user = $token !== null ? $this->findUser('id', (string) $token['user_id']) : null;
        if ($user === null) {
            throw new ApiError(422, 'invalid_token', 'Dieser Link ist ungültig, abgelaufen oder wurde schon benutzt. Bitte frag den Admin nach einem neuen.');
        }
        if ($user['status'] !== 'active') {
            throw new ApiError(403, 'account_disabled', 'Dein Konto ist gesperrt. Wende dich an den Admin.');
        }
        $errors = [];
        $password = $this->validatePassword($in['password'] ?? null, $user['username'], $errors);
        if ($errors) {
            throw ApiError::validation($errors);
        }
        $this->db->beginTransaction();
        try {
            $this->db->prepare('UPDATE fs_tokens SET uses = max_uses WHERE id = ?')->execute([$token['id']]);
            $this->db->prepare('UPDATE fs_users SET password_hash = ? WHERE id = ?')->execute([password_hash($password, PASSWORD_DEFAULT), $user['id']]);
            $this->db->prepare('DELETE FROM fs_sessions WHERE user_id = ?')->execute([$user['id']]);
            $this->db->commit();
        } catch (Throwable $e) {
            $this->db->rollBack();
            throw $e;
        }
        $this->startSession($user, true);
        return ['user' => self::publicUser($user)];
    }

    // ------------------------------------------------------------------ Eigenes Konto

    /** @param array<string,mixed> $in */
    public function updateProfile(array $in): array
    {
        $user = $this->requireUser();
        $errors = [];
        $name = $this->displayName($in['display_name'] ?? null, $errors);
        if ($errors) {
            throw ApiError::validation($errors);
        }
        $this->db->prepare('UPDATE fs_users SET display_name = ? WHERE id = ?')->execute([$name, $user['id']]);
        $user['display_name'] = $name;
        $this->user = $user;
        return ['user' => self::publicUser($user)];
    }

    /** Passwort ändern; meldet alle anderen Geräte ab. */
    public function changePassword(array $in): void
    {
        $user = $this->requireUser();
        $current = is_string($in['current_password'] ?? null) ? $in['current_password'] : '';
        if (!password_verify($current, $user['password_hash'])) {
            throw ApiError::validation(['current_password' => 'Das aktuelle Passwort stimmt nicht.']);
        }
        $errors = [];
        $password = $this->validatePassword($in['password'] ?? null, $user['username'], $errors);
        if ($errors) {
            throw ApiError::validation($errors);
        }
        $this->db->prepare('UPDATE fs_users SET password_hash = ? WHERE id = ?')->execute([password_hash($password, PASSWORD_DEFAULT), $user['id']]);
        $this->db->prepare('DELETE FROM fs_sessions WHERE user_id = ? AND id <> ?')->execute([$user['id'], $this->sessionId]);
    }

    // ------------------------------------------------------------------ Admin

    /** @return array<string,mixed> */
    public function adminOverview(): array
    {
        $this->requireAdmin();
        $users = $this->db->query(
            'SELECT u.id, u.username, u.display_name, u.role, u.status, u.created_at, u.last_login_at,
               (SELECT COUNT(*) FROM fs_event_participants p WHERE p.user_id = u.id) AS events
             FROM fs_users u ORDER BY u.display_name, u.username'
        )->fetchAll();
        $stmt = $this->db->prepare(
            "SELECT t.id, t.note, t.uses, t.max_uses, t.expires_at, t.created_at, u.display_name AS created_by
             FROM fs_tokens t LEFT JOIN fs_users u ON u.id = t.created_by
             WHERE t.kind = 'invite' AND t.uses < t.max_uses AND t.expires_at > ? ORDER BY t.created_at DESC"
        );
        $stmt->execute([Db::now()]);
        $invites = $stmt->fetchAll();

        return [
            'users' => array_map(fn ($u) => [
                'id' => $u['id'],
                'username' => $u['username'],
                'display_name' => $u['display_name'],
                'role' => $u['role'],
                'status' => $u['status'],
                'events' => (int) $u['events'],
                'created_at' => $this->isoUtc($u['created_at']),
                'last_login_at' => $u['last_login_at'] !== null ? $this->isoUtc($u['last_login_at']) : null,
            ], $users),
            'invites' => array_map(fn ($t) => [
                'id' => $t['id'],
                'note' => $t['note'],
                'uses' => (int) $t['uses'],
                'max_uses' => (int) $t['max_uses'],
                'created_by' => $t['created_by'],
                'expires_at' => $this->isoUtc($t['expires_at']),
                'created_at' => $this->isoUtc($t['created_at']),
            ], $invites),
        ];
    }

    /** @param array<string,mixed> $in */
    public function createInvite(array $in): array
    {
        $admin = $this->requireAdmin();
        $errors = [];
        $note = is_string($in['note'] ?? null) ? trim($in['note']) : '';
        if (mb_strlen($note) > 120) {
            $errors['note'] = 'Höchstens 120 Zeichen erlaubt.';
        }
        $maxUses = $in['max_uses'] ?? 1;
        if (!is_int($maxUses) || $maxUses < 1 || $maxUses > 50) {
            $errors['max_uses'] = 'Bitte eine Zahl zwischen 1 und 50 angeben.';
        }
        $days = $in['days'] ?? 14;
        if (!is_int($days) || $days < 1 || $days > 90) {
            $errors['days'] = 'Bitte eine Zahl zwischen 1 und 90 angeben.';
        }
        if ($errors) {
            throw ApiError::validation($errors);
        }
        $code = $this->insertToken('invite', null, $admin['id'], $note !== '' ? $note : null, $maxUses, "+$days days");
        return ['code' => $code];
    }

    /** @param array<string,mixed> $in */
    public function revokeInvite(array $in): void
    {
        $this->requireAdmin();
        $this->db->prepare("DELETE FROM fs_tokens WHERE id = ? AND kind = 'invite'")->execute([(string) ($in['id'] ?? '')]);
    }

    /** Link zum Zurücksetzen des Passworts (24 Stunden gültig, einmalig). */
    public function createResetLink(array $in): array
    {
        $admin = $this->requireAdmin();
        $user = $this->findUser('id', (string) ($in['user_id'] ?? ''));
        if ($user === null) {
            throw new ApiError(404, 'user_not_found', 'Dieses Konto gibt es nicht (mehr).');
        }
        $this->db->prepare("DELETE FROM fs_tokens WHERE kind = 'reset' AND user_id = ?")->execute([$user['id']]);
        $code = $this->insertToken('reset', $user['id'], $admin['id'], null, 1, '+24 hours');
        return ['code' => $code, 'username' => $user['username']];
    }

    /** Konto sperren/entsperren oder Rolle ändern. */
    public function updateUser(array $in): void
    {
        $admin = $this->requireAdmin();
        $target = $this->findUser('id', (string) ($in['user_id'] ?? ''));
        if ($target === null) {
            throw new ApiError(404, 'user_not_found', 'Dieses Konto gibt es nicht (mehr).');
        }
        if ($target['id'] === $admin['id']) {
            throw new ApiError(422, 'self', 'Dein eigenes Konto kannst du hier nicht sperren oder herabstufen.');
        }
        $status = $in['status'] ?? null;
        if ($status !== null) {
            if (!in_array($status, ['active', 'disabled'], true)) {
                throw new ApiError(422, 'validation', 'Ungültiger Status.');
            }
            $this->db->prepare('UPDATE fs_users SET status = ? WHERE id = ?')->execute([$status, $target['id']]);
            if ($status === 'disabled') {
                $this->db->prepare('DELETE FROM fs_sessions WHERE user_id = ?')->execute([$target['id']]);
            }
        }
        $role = $in['role'] ?? null;
        if ($role !== null) {
            if (!in_array($role, ['admin', 'member'], true)) {
                throw new ApiError(422, 'validation', 'Ungültige Rolle.');
            }
            $this->db->prepare('UPDATE fs_users SET role = ? WHERE id = ?')->execute([$role, $target['id']]);
        }
    }

    /**
     * Konto löschen. Die Person bleibt in den Events als Name erhalten (sonst gingen Abrechnungen
     * kaputt), nur die Verknüpfung zum Konto wird gelöst.
     */
    public function deleteUser(array $in): void
    {
        $admin = $this->requireAdmin();
        $target = $this->findUser('id', (string) ($in['user_id'] ?? ''));
        if ($target === null) {
            throw new ApiError(404, 'user_not_found', 'Dieses Konto gibt es nicht (mehr).');
        }
        if ($target['id'] === $admin['id']) {
            throw new ApiError(422, 'self', 'Dein eigenes Konto kannst du nicht löschen.');
        }
        $this->db->beginTransaction();
        try {
            $this->db->prepare('UPDATE fs_event_participants SET user_id = NULL WHERE user_id = ?')->execute([$target['id']]);
            $this->db->prepare('UPDATE fs_events SET owner_user_id = NULL WHERE owner_user_id = ?')->execute([$target['id']]);
            $this->db->prepare('DELETE FROM fs_users WHERE id = ?')->execute([$target['id']]);
            $this->db->commit();
        } catch (Throwable $e) {
            $this->db->rollBack();
            throw $e;
        }
    }

    // ------------------------------------------------------------------ Hilfsfunktionen

    private function assertHttps(): void
    {
        if ($this->requireHttps && !Http::isHttps()) {
            throw new ApiError(403, 'https_required', 'Anmelden ist nur über eine verschlüsselte Verbindung (https://) möglich. Aktiviere im KAS ein SSL-Zertifikat für die Domain und rufe die Seite mit https:// auf.');
        }
    }

    private function sessionExpiry(bool $remember): string
    {
        return Db::at($remember ? '+' . self::REMEMBER_DAYS . ' days' : '+' . self::SHORT_HOURS . ' hours');
    }

    /** @param array<string,mixed> $user */
    private function startSession(array $user, bool $remember): void
    {
        $token = bin2hex(random_bytes(32));
        $now = Db::now();
        $id = Db::id();
        $agent = mb_substr((string) ($_SERVER['HTTP_USER_AGENT'] ?? ''), 0, 190);
        $this->db->prepare(
            'INSERT INTO fs_sessions (id, user_id, token_hash, remember, created_at, last_seen_at, expires_at, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        )->execute([$id, $user['id'], hash('sha256', $token), $remember ? 1 : 0, $now, $now, $this->sessionExpiry($remember), $agent !== '' ? $agent : null]);
        // Abgelaufene Sitzungen bei Gelegenheit aufräumen (kein Cronjob nötig).
        $this->db->prepare('DELETE FROM fs_sessions WHERE expires_at < ?')->execute([$now]);
        Http::cookie(self::COOKIE, $token, $remember ? time() + self::REMEMBER_DAYS * 86400 : 0);
        $this->sessionId = $id;
        $this->user = $user;
    }

    /**
     * @param array{username:string,display_name:string,password:string} $fields
     * @return array<string,mixed>
     */
    private function createUser(array $fields, string $role): array
    {
        if ($this->findUser('username', $fields['username']) !== null) {
            throw ApiError::validation(['username' => 'Dieser Benutzername ist schon vergeben.']);
        }
        $user = [
            'id' => Db::id(),
            'username' => $fields['username'],
            'display_name' => $fields['display_name'],
            'password_hash' => password_hash($fields['password'], PASSWORD_DEFAULT),
            'role' => $role,
            'status' => 'active',
            'created_at' => Db::now(),
        ];
        try {
            $this->db->prepare(
                'INSERT INTO fs_users (id, username, display_name, password_hash, role, status, created_at, last_login_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
            )->execute([$user['id'], $user['username'], $user['display_name'], $user['password_hash'], $role, 'active', $user['created_at'], $user['created_at']]);
        } catch (PDOException $e) {
            if ((string) $e->getCode() === '23000') {
                throw ApiError::validation(['username' => 'Dieser Benutzername ist schon vergeben.']);
            }
            throw $e;
        }
        return $user;
    }

    /** @return array{username:string,display_name:string,password:string} */
    private function validateAccount(array $in): array
    {
        $errors = [];
        $username = $this->normalizeUsername($in['username'] ?? null);
        if (!preg_match('/^[a-z0-9][a-z0-9._-]{2,39}$/', $username)) {
            $errors['username'] = '3 bis 40 Zeichen: Buchstaben a–z, Ziffern, Punkt, Unterstrich oder Bindestrich (keine Umlaute, keine Leerzeichen).';
        }
        $displayName = $this->displayName($in['display_name'] ?? null, $errors);
        $password = $this->validatePassword($in['password'] ?? null, $username, $errors);
        if ($errors) {
            throw ApiError::validation($errors);
        }
        return ['username' => $username, 'display_name' => $displayName, 'password' => $password];
    }

    /** @param array<string,string> $errors */
    private function displayName(mixed $value, array &$errors): string
    {
        $name = is_string($value) ? trim((string) preg_replace('/[\x00-\x1F\x7F]/u', '', $value)) : '';
        if ($name === '') {
            $errors['display_name'] = 'Bitte gib einen Anzeigenamen ein.';
        } elseif (mb_strlen($name) > 60) {
            $errors['display_name'] = 'Höchstens 60 Zeichen erlaubt.';
        }
        return $name;
    }

    /** @param array<string,string> $errors */
    private function validatePassword(mixed $value, string $username, array &$errors): string
    {
        $password = is_string($value) ? $value : '';
        if (mb_strlen($password) < self::MIN_PASSWORD) {
            $errors['password'] = 'Das Passwort muss mindestens ' . self::MIN_PASSWORD . ' Zeichen lang sein.';
        } elseif (strlen($password) > 200) {
            $errors['password'] = 'Das Passwort ist zu lang (höchstens 200 Zeichen).';
        } elseif (in_array(mb_strtolower($password), self::COMMON_PASSWORDS, true) || mb_strtolower($password) === $username) {
            $errors['password'] = 'Dieses Passwort ist zu leicht zu erraten. Bitte wähle ein anderes.';
        }
        return $password;
    }

    private function normalizeUsername(mixed $value): string
    {
        return is_string($value) ? mb_strtolower(trim($value)) : '';
    }

    /** @return array<string,mixed>|null */
    private function findUser(string $column, string $value): ?array
    {
        $stmt = $this->db->prepare("SELECT * FROM fs_users WHERE $column = ?");
        $stmt->execute([$value]);
        return $stmt->fetch() ?: null;
    }

    /** @return array<string,mixed>|null gültiges (nicht abgelaufenes, nicht aufgebrauchtes) Token */
    private function findToken(string $kind, string $code): ?array
    {
        $stmt = $this->db->prepare('SELECT * FROM fs_tokens WHERE token_hash = ? AND kind = ? AND uses < max_uses AND expires_at > ?');
        $stmt->execute([hash('sha256', $code), $kind, Db::now()]);
        return $stmt->fetch() ?: null;
    }

    private function insertToken(string $kind, ?string $userId, string $createdBy, ?string $note, int $maxUses, string $validFor): string
    {
        $code = '';
        for ($i = 0; $i < self::TOKEN_LENGTH; $i++) {
            $code .= self::TOKEN_ALPHABET[random_int(0, strlen(self::TOKEN_ALPHABET) - 1)];
        }
        $this->db->prepare(
            'INSERT INTO fs_tokens (id, kind, token_hash, user_id, created_by, note, max_uses, uses, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)'
        )->execute([Db::id(), $kind, hash('sha256', $code), $userId, $createdBy, $note, $maxUses, Db::at($validFor), Db::now()]);
        return $code;
    }

    private function isoUtc(string $dbValue): string
    {
        return str_replace(' ', 'T', substr($dbValue, 0, 19)) . 'Z';
    }
}
