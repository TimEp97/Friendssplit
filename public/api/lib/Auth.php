<?php
declare(strict_types=1);

/**
 * Benutzerkonten: Registrierung mit E-Mail-Bestätigung, Anmeldung mit Passwort,
 * „Passwort vergessen“ und Profil (PayPal.me-Link).
 *
 * Sitzungen laufen über ein HttpOnly-Cookie. In der Datenbank liegen nur SHA-256-Hashes von
 * Sitzungs- und E-Mail-Tokens, Passwörter nur als password_hash().
 */
final class Auth
{
    public const COOKIE = 'fs_session';
    private const SESSION_DAYS = 30;
    private const VERIFY_HOURS = 48;
    private const RESET_MINUTES = 60;
    private const MIN_PASSWORD = 8;
    private const MAX_PASSWORD = 200;
    /** Echter Hash ohne zugehöriges Konto – für gleich lange Antwortzeiten. */
    private const DUMMY_HASH = '$2y$10$B1MsYNPiWIVGkw8e/8qrWuga3JgGhwm9YfOOigv0jXKXlSJ2l4y0K';

    public function __construct(
        private PDO $db,
        private Mailer $mailer,
        private string $appUrl,
        private string $cookiePath = '/',
        private bool $secureCookie = true,
        private string $clientIp = '',
    ) {
    }

    // ------------------------------------------------------------------ Sitzung

    /** @return array<string,mixed>|null Angemeldete Person mit bestätigter E-Mail oder null */
    public function currentUser(): ?array
    {
        $token = $_COOKIE[self::COOKIE] ?? null;
        if (!is_string($token) || !preg_match('/^[A-Za-z0-9_-]{43}$/', $token)) {
            return null;
        }
        $stmt = $this->db->prepare(
            'SELECT u.* FROM fs_sessions s JOIN fs_users u ON u.id = s.user_id
             WHERE s.token_hash = ? AND s.expires_at > ? AND u.email_verified_at IS NOT NULL'
        );
        $stmt->execute([hash('sha256', $token), Db::now()]);
        return $stmt->fetch() ?: null;
    }

    /** @return array<string,mixed> */
    public function requireUser(): array
    {
        return $this->currentUser() ?? throw new ApiError(401, 'not_authenticated', 'Bitte melde dich an.');
    }

    private function startSession(string $userId): void
    {
        $token = self::randomToken();
        $now = Db::now();
        $expires = gmdate('Y-m-d H:i:s', time() + self::SESSION_DAYS * 86400);
        $this->db->prepare('INSERT INTO fs_sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
            ->execute([hash('sha256', $token), $userId, $now, $expires]);
        if (random_int(1, 50) === 1) {
            $this->db->prepare('DELETE FROM fs_sessions WHERE expires_at < ?')->execute([$now]);
            $this->db->prepare('DELETE FROM fs_user_tokens WHERE expires_at < ?')->execute([$now]);
        }
        $this->setCookie($token, time() + self::SESSION_DAYS * 86400);
    }

    public function logout(): void
    {
        $token = $_COOKIE[self::COOKIE] ?? null;
        if (is_string($token)) {
            $this->db->prepare('DELETE FROM fs_sessions WHERE token_hash = ?')->execute([hash('sha256', $token)]);
        }
        $this->setCookie('', time() - 3600);
    }

    private function setCookie(string $value, int $expires): void
    {
        if (headers_sent()) {
            return;
        }
        setcookie(self::COOKIE, $value, [
            'expires' => $expires,
            'path' => $this->cookiePath,
            'secure' => $this->secureCookie,
            'httponly' => true,
            'samesite' => 'Lax',
        ]);
    }

    // ------------------------------------------------------------------ Registrierung und Bestätigung

    /** @param array<string,mixed> $in */
    public function register(array $in): void
    {
        $errors = [];
        $email = $this->email($in, $errors);
        $password = $this->password($in, $errors);
        $name = $this->name($in, $errors);
        if ($errors) {
            throw ApiError::validation($errors);
        }
        $this->limit('register:ip:' . $this->clientIp, 20, 3600);
        $this->limit('mail:' . $email, 5, 3600, 'Für diese E-Mail-Adresse wurden gerade viele E-Mails verschickt. Bitte warte etwas und versuche es später noch einmal.');

        $existing = $this->userByEmail($email);
        $now = Db::now();
        if ($existing !== null && $existing['email_verified_at'] !== null) {
            // Keine Auskunft darüber, ob ein Konto existiert – stattdessen Hinweis an das Postfach.
            $this->mailer->send($email, 'Dein FriendSplit-Konto', "Hallo {$existing['display_name']},\n\n"
                . "jemand (vermutlich du) wollte sich gerade mit dieser E-Mail-Adresse bei FriendSplit registrieren. "
                . "Du hast aber schon ein Konto.\n\nAnmelden: {$this->link('login')}\n"
                . "Passwort vergessen? {$this->link('passwort-vergessen')}\n\n"
                . "Warst du das nicht, kannst du diese E-Mail ignorieren.\n");
            return;
        }
        $hash = password_hash($password, PASSWORD_DEFAULT);
        if ($existing !== null) {
            // Noch nicht bestätigtes Konto: Daten der neuesten Registrierung übernehmen, alte Links ungültig machen.
            $userId = $existing['id'];
            $this->db->prepare('UPDATE fs_users SET password_hash = ?, display_name = ?, updated_at = ? WHERE id = ?')
                ->execute([$hash, $name, $now, $userId]);
            $this->db->prepare('DELETE FROM fs_user_tokens WHERE user_id = ?')->execute([$userId]);
        } else {
            $userId = Db::id();
            $this->db->prepare('INSERT INTO fs_users (id, email, password_hash, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
                ->execute([$userId, $email, $hash, $name, $now, $now]);
        }
        $this->sendVerification($userId, $email, $name);
    }

    /** @param array<string,mixed> $in */
    public function resendVerification(array $in): void
    {
        $errors = [];
        $email = $this->email($in, $errors);
        if ($errors) {
            throw ApiError::validation($errors);
        }
        $this->limit('mail:' . $email, 5, 3600, 'Für diese E-Mail-Adresse wurden gerade viele E-Mails verschickt. Bitte warte etwas und versuche es später noch einmal.');
        $user = $this->userByEmail($email);
        if ($user !== null && $user['email_verified_at'] === null) {
            $this->db->prepare("DELETE FROM fs_user_tokens WHERE user_id = ? AND purpose = 'verify'")->execute([$user['id']]);
            $this->sendVerification($user['id'], $email, $user['display_name']);
        }
    }

    private function sendVerification(string $userId, string $email, string $name): void
    {
        $token = $this->createToken($userId, 'verify', self::VERIFY_HOURS * 3600);
        $this->mailer->send($email, 'Bitte bestätige deine E-Mail-Adresse', "Hallo $name,\n\n"
            . "willkommen bei FriendSplit! Bitte bestätige deine E-Mail-Adresse mit diesem Link:\n\n"
            . $this->link('bestaetigen/' . $token) . "\n\n"
            . 'Der Link ist ' . self::VERIFY_HOURS . " Stunden gültig.\n\n"
            . "Hast du dich nicht registriert? Dann ignoriere diese E-Mail einfach.\n");
    }

    /**
     * Bestätigt die E-Mail-Adresse und meldet direkt an.
     * @param array<string,mixed> $in
     * @return array<string,mixed>
     */
    public function verifyEmail(array $in): array
    {
        $user = $this->consumeToken($in, 'verify',
            'Dieser Bestätigungslink ist ungültig oder abgelaufen. Melde dich an, um einen neuen Link zu bekommen.');
        if ($user['email_verified_at'] === null) {
            $this->db->prepare('UPDATE fs_users SET email_verified_at = ?, updated_at = ? WHERE id = ?')->execute([Db::now(), Db::now(), $user['id']]);
        }
        $this->startSession($user['id']);
        return $this->userById($user['id']);
    }

    // ------------------------------------------------------------------ Anmeldung

    /**
     * @param array<string,mixed> $in
     * @return array<string,mixed>
     */
    public function login(array $in): array
    {
        $email = is_string($in['email'] ?? null) ? mb_strtolower(trim($in['email'])) : '';
        $password = is_string($in['password'] ?? null) ? $in['password'] : '';
        if ($email === '' || $password === '') {
            throw ApiError::validation(array_filter([
                'email' => $email === '' ? 'Bitte gib deine E-Mail-Adresse ein.' : null,
                'password' => $password === '' ? 'Bitte gib dein Passwort ein.' : null,
            ]));
        }
        $tooMany = 'Zu viele Anmeldeversuche. Bitte warte 15 Minuten oder setze dein Passwort zurück.';
        $this->limit('login:ip:' . $this->clientIp, 50, 900, $tooMany);
        $this->limit('login:' . $email, 10, 900, $tooMany);

        $user = $this->userByEmail($email);
        // Auch ohne Konto einen Hash prüfen, damit die Antwortzeit nichts verrät.
        $valid = password_verify($password, $user['password_hash'] ?? self::DUMMY_HASH);
        if ($user === null || !$valid) {
            throw new ApiError(401, 'invalid_credentials', 'E-Mail-Adresse oder Passwort ist falsch.');
        }
        if ($user['email_verified_at'] === null) {
            throw new ApiError(403, 'email_not_verified', 'Bitte bestätige zuerst deine E-Mail-Adresse. Schau in dein Postfach (auch in den Spam-Ordner).');
        }
        if (password_needs_rehash($user['password_hash'], PASSWORD_DEFAULT)) {
            $this->db->prepare('UPDATE fs_users SET password_hash = ? WHERE id = ?')->execute([password_hash($password, PASSWORD_DEFAULT), $user['id']]);
        }
        $this->startSession($user['id']);
        return $user;
    }

    // ------------------------------------------------------------------ Passwort vergessen

    /** @param array<string,mixed> $in */
    public function requestPasswordReset(array $in): void
    {
        $errors = [];
        $email = $this->email($in, $errors);
        if ($errors) {
            throw ApiError::validation($errors);
        }
        $this->limit('reset:ip:' . $this->clientIp, 20, 3600);
        $this->limit('mail:' . $email, 5, 3600, 'Für diese E-Mail-Adresse wurden gerade viele E-Mails verschickt. Bitte warte etwas und versuche es später noch einmal.');
        $user = $this->userByEmail($email);
        if ($user === null) {
            return; // Keine Auskunft darüber, ob ein Konto existiert.
        }
        $this->db->prepare("DELETE FROM fs_user_tokens WHERE user_id = ? AND purpose = 'reset'")->execute([$user['id']]);
        $token = $this->createToken($user['id'], 'reset', self::RESET_MINUTES * 60);
        $this->mailer->send($email, 'Neues Passwort für FriendSplit', "Hallo {$user['display_name']},\n\n"
            . "mit diesem Link kannst du ein neues Passwort festlegen:\n\n"
            . $this->link('passwort-neu/' . $token) . "\n\n"
            . 'Der Link ist ' . self::RESET_MINUTES . " Minuten gültig und funktioniert nur einmal.\n\n"
            . "Hast du das nicht angefordert? Dann ignoriere diese E-Mail – dein Passwort bleibt unverändert.\n");
    }

    /**
     * Setzt ein neues Passwort, beendet alle anderen Sitzungen und meldet an.
     * @param array<string,mixed> $in
     * @return array<string,mixed>
     */
    public function resetPassword(array $in): array
    {
        $errors = [];
        $password = $this->password($in, $errors);
        if ($errors) {
            throw ApiError::validation($errors);
        }
        $user = $this->consumeToken($in, 'reset', 'Dieser Link ist ungültig oder abgelaufen. Bitte fordere einen neuen an.');
        $now = Db::now();
        // Der Link kam per E-Mail an – damit ist die Adresse auch bestätigt.
        $this->db->prepare('UPDATE fs_users SET password_hash = ?, email_verified_at = COALESCE(email_verified_at, ?), updated_at = ? WHERE id = ?')
            ->execute([password_hash($password, PASSWORD_DEFAULT), $now, $now, $user['id']]);
        $this->db->prepare('DELETE FROM fs_sessions WHERE user_id = ?')->execute([$user['id']]);
        $this->startSession($user['id']);
        return $this->userById($user['id']);
    }

    // ------------------------------------------------------------------ Profil

    /**
     * @param array<string,mixed> $user
     * @param array<string,mixed> $in
     * @return array<string,mixed>
     */
    public function updateProfile(array $user, array $in): array
    {
        $errors = [];
        $name = $user['display_name'];
        if (array_key_exists('name', $in)) {
            $name = $this->name($in, $errors);
        }
        $handle = $user['paypal_me'];
        if (array_key_exists('paypal', $in)) {
            $raw = is_string($in['paypal']) ? trim($in['paypal']) : '';
            $handle = null;
            if ($raw !== '') {
                $handle = Store::normalizePaypal($raw);
                if ($handle === null) {
                    $errors['paypal'] = Store::paypalError($raw);
                }
            }
        }
        if ($errors) {
            throw ApiError::validation($errors);
        }
        // Der Name gilt für neue Events. In bestehenden Events bleibt der dort verwendete Name.
        $this->db->prepare('UPDATE fs_users SET display_name = ?, paypal_me = ?, updated_at = ? WHERE id = ?')
            ->execute([$name, $handle, Db::now(), $user['id']]);
        return $this->userById($user['id']);
    }

    /**
     * Neue E-Mail-Adresse anfordern: Bestätigungslink an die neue Adresse, Hinweis an die alte.
     * Die Adresse ändert sich erst nach dem Klick auf den Link.
     * @param array<string,mixed> $user
     * @param array<string,mixed> $in
     */
    public function requestEmailChange(array $user, array $in): array
    {
        $errors = [];
        $email = $this->email($in, $errors);
        if (!$errors && $email === $user['email']) {
            $errors['email'] = 'Das ist bereits deine E-Mail-Adresse.';
        }
        $this->checkPassword($user, $in, $errors);
        if ($errors) {
            throw ApiError::validation($errors);
        }
        $this->limit('mail:' . $email, 5, 3600, 'Für diese E-Mail-Adresse wurden gerade viele E-Mails verschickt. Bitte warte etwas und versuche es später noch einmal.');
        $this->db->prepare("DELETE FROM fs_user_tokens WHERE user_id = ? AND purpose = 'email'")->execute([$user['id']]);
        $this->db->prepare('UPDATE fs_users SET pending_email = ?, updated_at = ? WHERE id = ?')->execute([$email, Db::now(), $user['id']]);
        if ($this->userByEmail($email) !== null) {
            // Adresse gehört schon zu einem Konto: nichts verraten, nur das andere Postfach informieren.
            $this->mailer->send($email, 'Dein FriendSplit-Konto', "Hallo,\n\n"
                . "jemand wollte gerade diese E-Mail-Adresse für ein anderes FriendSplit-Konto verwenden. "
                . "Sie gehört aber schon zu deinem Konto. Es wurde nichts geändert.\n");
            return $this->userById($user['id']);
        }
        $token = $this->createToken($user['id'], 'email', self::VERIFY_HOURS * 3600);
        $this->mailer->send($email, 'Bitte bestätige deine neue E-Mail-Adresse', "Hallo {$user['display_name']},\n\n"
            . "bitte bestätige deine neue E-Mail-Adresse für FriendSplit mit diesem Link:\n\n"
            . $this->link('email-bestaetigen/' . $token) . "\n\n"
            . 'Der Link ist ' . self::VERIFY_HOURS . " Stunden gültig. Bis dahin bleibt deine bisherige Adresse aktiv.\n");
        $this->mailer->send($user['email'], 'Änderung deiner E-Mail-Adresse', "Hallo {$user['display_name']},\n\n"
            . "für dein FriendSplit-Konto wurde eine neue E-Mail-Adresse angefordert ($email). Sie gilt erst, wenn der Link "
            . "in der E-Mail an die neue Adresse bestätigt wird.\n\n"
            . "Warst du das nicht? Dann setze bitte dein Passwort zurück: {$this->link('passwort-vergessen')}\n");
        return $this->userById($user['id']);
    }

    /**
     * @param array<string,mixed> $in
     * @return array<string,mixed>
     */
    public function confirmEmailChange(array $in): array
    {
        $user = $this->consumeToken($in, 'email', 'Dieser Link ist ungültig oder abgelaufen. Bitte fordere die Änderung im Profil erneut an.');
        $email = $user['pending_email'];
        if ($email === null) {
            throw new ApiError(400, 'invalid_token', 'Dieser Link ist ungültig oder abgelaufen. Bitte fordere die Änderung im Profil erneut an.');
        }
        try {
            $this->db->prepare('UPDATE fs_users SET email = ?, pending_email = NULL, email_verified_at = COALESCE(email_verified_at, ?), updated_at = ? WHERE id = ?')
                ->execute([$email, Db::now(), Db::now(), $user['id']]);
        } catch (PDOException) {
            throw new ApiError(409, 'email_taken', 'Diese E-Mail-Adresse wird inzwischen von einem anderen Konto verwendet.');
        }
        // Wer den Link auf einem Gerät ohne Anmeldung öffnet, ist danach dort angemeldet.
        if (($this->currentUser()['id'] ?? null) !== $user['id']) {
            $this->startSession($user['id']);
        }
        return $this->userById($user['id']);
    }

    /**
     * Passwort ändern (aktuelles Passwort nötig). Andere Geräte werden abgemeldet.
     * @param array<string,mixed> $user
     * @param array<string,mixed> $in
     */
    public function changePassword(array $user, array $in): array
    {
        $errors = [];
        $this->checkPassword($user, $in, $errors);
        $newErrors = [];
        $new = $this->password(['password' => $in['new_password'] ?? null], $newErrors);
        if (isset($newErrors['password'])) {
            $errors['new_password'] = $newErrors['password'];
        }
        if ($errors) {
            throw ApiError::validation($errors);
        }
        $this->db->prepare('UPDATE fs_users SET password_hash = ?, updated_at = ? WHERE id = ?')
            ->execute([password_hash($new, PASSWORD_DEFAULT), Db::now(), $user['id']]);
        $this->db->prepare('DELETE FROM fs_sessions WHERE user_id = ?')->execute([$user['id']]);
        $this->startSession($user['id']);
        return $this->userById($user['id']);
    }

    /**
     * Konto endgültig löschen (aktuelles Passwort nötig). Die Personen in Events bleiben als
     * Platzhalter mit ihrem Namen erhalten, damit die Abrechnungen der anderen stimmen.
     * @param array<string,mixed> $user
     * @param array<string,mixed> $in
     */
    public function deleteAccount(array $user, array $in): void
    {
        $errors = [];
        $this->checkPassword($user, $in, $errors);
        if ($errors) {
            throw ApiError::validation($errors);
        }
        $this->db->beginTransaction();
        try {
            $this->db->prepare('UPDATE fs_persons SET auth_user_id = NULL WHERE auth_user_id = ?')->execute([$user['id']]);
            $this->db->prepare('DELETE FROM fs_sessions WHERE user_id = ?')->execute([$user['id']]);
            $this->db->prepare('DELETE FROM fs_user_tokens WHERE user_id = ?')->execute([$user['id']]);
            $this->db->prepare('DELETE FROM fs_users WHERE id = ?')->execute([$user['id']]);
            $this->db->commit();
        } catch (Throwable $e) {
            $this->db->rollBack();
            throw $e;
        }
        $this->setCookie('', time() - 3600);
    }

    /** @param array<string,string> $errors */
    private function checkPassword(array $user, array $in, array &$errors): void
    {
        $password = is_string($in['current_password'] ?? null) ? $in['current_password'] : '';
        if ($password === '') {
            $errors['current_password'] = 'Bitte gib dein aktuelles Passwort ein.';
            return;
        }
        $this->limit('login:' . $user['email'], 10, 900, 'Zu viele Versuche. Bitte warte 15 Minuten.');
        if (!password_verify($password, $user['password_hash'])) {
            $errors['current_password'] = 'Das Passwort ist falsch.';
        }
    }

    /** @param array<string,string> $errors */
    private function name(array $in, array &$errors): string
    {
        $name = is_string($in['name'] ?? null) ? trim((string) preg_replace('/[\x00-\x1F\x7F]/u', '', $in['name'])) : '';
        if ($name === '') {
            $errors['name'] = 'Bitte gib deinen Namen ein.';
        } elseif (mb_strlen($name) > 60) {
            $errors['name'] = 'Höchstens 60 Zeichen erlaubt.';
        }
        return $name;
    }

    /**
     * Öffentliche Sicht auf das eigene Konto inklusive der Events, an denen es teilnimmt.
     * @param array<string,mixed> $user
     * @return array<string,mixed>
     */
    public function profile(array $user): array
    {
        $stmt = $this->db->prepare(
            'SELECT e.access_code, e.name, e.event_date, ep.joined_at
             FROM fs_persons p
             JOIN fs_event_participants ep ON ep.person_id = p.id
             JOIN fs_events e ON e.id = ep.event_id
             WHERE p.auth_user_id = ?
             ORDER BY COALESCE(e.event_date, SUBSTR(e.created_at, 1, 10)) DESC, e.created_at DESC'
        );
        $stmt->execute([$user['id']]);
        return [
            'id' => $user['id'],
            'email' => $user['email'],
            'pending_email' => $user['pending_email'] ?? null,
            'name' => $user['display_name'],
            'paypal' => $user['paypal_me'],
            'events' => array_map(fn ($r) => [
                'code' => $r['access_code'],
                'name' => $r['name'],
                'date' => $r['event_date'] !== null ? substr((string) $r['event_date'], 0, 10) : null,
            ], $stmt->fetchAll()),
        ];
    }

    // ------------------------------------------------------------------ Hilfsfunktionen

    /** @return array<string,mixed>|null */
    private function userByEmail(string $email): ?array
    {
        $stmt = $this->db->prepare('SELECT * FROM fs_users WHERE email = ?');
        $stmt->execute([$email]);
        return $stmt->fetch() ?: null;
    }

    /** @return array<string,mixed> */
    private function userById(string $id): array
    {
        $stmt = $this->db->prepare('SELECT * FROM fs_users WHERE id = ?');
        $stmt->execute([$id]);
        return $stmt->fetch() ?: throw new ApiError(404, 'user_not_found', 'Konto nicht gefunden.');
    }

    private function createToken(string $userId, string $purpose, int $seconds): string
    {
        $token = self::randomToken();
        $this->db->prepare('INSERT INTO fs_user_tokens (token_hash, user_id, purpose, expires_at, created_at) VALUES (?, ?, ?, ?, ?)')
            ->execute([hash('sha256', $token), $userId, $purpose, gmdate('Y-m-d H:i:s', time() + $seconds), Db::now()]);
        return $token;
    }

    /**
     * Löst einen Einmal-Token ein (danach ist er verbraucht).
     * @param array<string,mixed> $in
     * @return array<string,mixed>
     */
    private function consumeToken(array $in, string $purpose, string $invalidMessage): array
    {
        $token = is_string($in['token'] ?? null) ? $in['token'] : '';
        $hash = hash('sha256', $token);
        $stmt = $this->db->prepare('SELECT user_id FROM fs_user_tokens WHERE token_hash = ? AND purpose = ? AND expires_at > ?');
        $stmt->execute([$hash, $purpose, Db::now()]);
        $userId = $stmt->fetchColumn();
        $delete = $this->db->prepare('DELETE FROM fs_user_tokens WHERE token_hash = ?');
        $delete->execute([$hash]);
        if ($userId === false || $delete->rowCount() !== 1) {
            throw new ApiError(400, 'invalid_token', $invalidMessage);
        }
        return $this->userById((string) $userId);
    }

    /** Zählt einen Versuch im Zeitfenster; zu viele → 429. */
    private function limit(string $bucket, int $max, int $windowSeconds, string $message = 'Zu viele Anfragen. Bitte warte etwas und versuche es dann erneut.'): void
    {
        $key = substr(strtok($bucket, ':') . ':' . hash('sha256', $bucket), 0, 120);
        $now = time();
        $stmt = $this->db->prepare('SELECT hits, window_start FROM fs_rate_limits WHERE bucket = ?');
        $stmt->execute([$key]);
        $row = $stmt->fetch();
        if ($row === false || strtotime($row['window_start'] . ' UTC') + $windowSeconds <= $now) {
            $this->db->prepare('DELETE FROM fs_rate_limits WHERE bucket = ?')->execute([$key]);
            try {
                $this->db->prepare('INSERT INTO fs_rate_limits (bucket, hits, window_start) VALUES (?, 1, ?)')->execute([$key, Db::now()]);
            } catch (PDOException) {
                // Gleichzeitiger Zugriff hat die Zeile schon angelegt – dann zählt dieser Versuch eben nicht.
            }
            return;
        }
        if ((int) $row['hits'] >= $max) {
            throw new ApiError(429, 'rate_limited', $message);
        }
        $this->db->prepare('UPDATE fs_rate_limits SET hits = hits + 1 WHERE bucket = ?')->execute([$key]);
    }

    /** @param array<string,string> $errors */
    private function email(array $in, array &$errors): string
    {
        $email = is_string($in['email'] ?? null) ? mb_strtolower(trim($in['email'])) : '';
        if ($email === '') {
            $errors['email'] = 'Bitte gib deine E-Mail-Adresse ein.';
        } elseif (mb_strlen($email) > 190 || !filter_var($email, FILTER_VALIDATE_EMAIL)) {
            $errors['email'] = 'Bitte gib eine gültige E-Mail-Adresse ein.';
        }
        return $email;
    }

    /** @param array<string,string> $errors */
    private function password(array $in, array &$errors): string
    {
        $password = is_string($in['password'] ?? null) ? $in['password'] : '';
        $length = mb_strlen($password);
        if ($length < self::MIN_PASSWORD) {
            $errors['password'] = 'Das Passwort muss mindestens ' . self::MIN_PASSWORD . ' Zeichen lang sein.';
        } elseif ($length > self::MAX_PASSWORD) {
            $errors['password'] = 'Das Passwort darf höchstens ' . self::MAX_PASSWORD . ' Zeichen lang sein.';
        }
        return $password;
    }

    private function link(string $route): string
    {
        if (!preg_match('~^https?://~', $this->appUrl)) {
            error_log('FriendSplit: app_url fehlt in config.php');
            throw new ApiError(503, 'not_configured', 'Der E-Mail-Versand ist noch nicht eingerichtet (app_url fehlt in der Konfiguration).');
        }
        return rtrim($this->appUrl, '/') . '/#/' . $route;
    }

    private static function randomToken(): string
    {
        return rtrim(strtr(base64_encode(random_bytes(32)), '+/', '-_'), '=');
    }
}
