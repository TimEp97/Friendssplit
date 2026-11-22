<?php
declare(strict_types=1);

/**
 * Benutzerkonten im Stil der Reiseapp:
 * - Das erste Konto (Admin) entsteht mit dem Einrichtungscode, alle weiteren nur mit Einladung.
 * - Anmelden mit Name oder E-Mail und Passwort. Auf neuen Geräten und bei noch nicht bestätigter
 *   E-Mail-Adresse kommt zusätzlich ein 6-stelliger Code per E-Mail; bekannte Geräte werden 90 Tage gemerkt.
 * - „Passwort vergessen“ per Link, Profil mit PayPal.me-Link, E-Mail/Passwort ändern, Konto löschen.
 *
 * Sitzung und Gerät laufen über HttpOnly-Cookies. In der Datenbank liegen nur SHA-256-Hashes von
 * Sitzungs-, Geräte-, Code- und Link-Tokens, Passwörter nur als password_hash().
 */
final class Auth
{
    public const COOKIE = 'fs_session';
    public const DEVICE_COOKIE = 'fs_device';
    private const SESSION_DAYS = 90;
    private const DEVICE_DAYS = 90;
    private const CODE_MINUTES = 15;
    private const CODE_ATTEMPTS = 5;
    private const CODE_SENDS = 3;
    private const EMAIL_LINK_HOURS = 48;
    private const RESET_MINUTES = 60;
    private const ADMIN_RESET_HOURS = 24;
    public const MIN_PASSWORD = 10;
    private const MAX_PASSWORD = 200;
    /** Echter Hash ohne zugehöriges Konto – für gleich lange Antwortzeiten. */
    private const DUMMY_HASH = '$2y$10$B1MsYNPiWIVGkw8e/8qrWuga3JgGhwm9YfOOigv0jXKXlSJ2l4y0K';
    private const TOO_MANY_MAILS = 'Für diese E-Mail-Adresse wurden gerade viele E-Mails verschickt. Bitte warte etwas und versuche es später noch einmal.';

    public function __construct(
        private PDO $db,
        private Mailer $mailer,
        private string $appUrl,
        private string $cookiePath = '/',
        private bool $secureCookie = true,
        private string $clientIp = '',
        private string $setupCode = '',
    ) {
    }

    // ------------------------------------------------------------------ Sitzung

    /** @return array<string,mixed>|null Angemeldete, bestätigte und nicht gesperrte Person – oder null */
    public function currentUser(): ?array
    {
        $token = $_COOKIE[self::COOKIE] ?? null;
        if (!is_string($token) || !preg_match('/^[A-Za-z0-9_-]{43}$/', $token)) {
            return null;
        }
        $stmt = $this->db->prepare(
            'SELECT u.* FROM fs_sessions s JOIN fs_users u ON u.id = s.user_id
             WHERE s.token_hash = ? AND s.expires_at > ? AND u.email_verified_at IS NOT NULL AND u.blocked = 0'
        );
        $stmt->execute([hash('sha256', $token), Db::now()]);
        return $stmt->fetch() ?: null;
    }

    /** @return array<string,mixed> */
    public function requireUser(): array
    {
        return $this->currentUser() ?? throw new ApiError(401, 'not_authenticated', 'Bitte melde dich an.');
    }

    /** @return array<string,mixed> */
    public function requireAdmin(): array
    {
        $user = $this->requireUser();
        if ($user['role'] !== 'admin') {
            throw new ApiError(403, 'forbidden', 'Nur für Admins.');
        }
        return $user;
    }

    private function startSession(string $userId): void
    {
        $token = self::randomToken();
        $now = Db::now();
        $this->db->prepare('INSERT INTO fs_sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
            ->execute([hash('sha256', $token), $userId, $now, self::inSeconds(self::SESSION_DAYS * 86400)]);
        $this->db->prepare('UPDATE fs_users SET last_login_at = ? WHERE id = ?')->execute([$now, $userId]);
        if (random_int(1, 50) === 1) {
            foreach (['fs_sessions', 'fs_user_tokens', 'fs_codes'] as $table) {
                $this->db->prepare("DELETE FROM $table WHERE expires_at < ?")->execute([$now]);
            }
            $this->db->prepare('DELETE FROM fs_devices WHERE last_used_at < ?')->execute([self::inSeconds(-self::DEVICE_DAYS * 86400)]);
        }
        $this->setCookie(self::COOKIE, $token, time() + self::SESSION_DAYS * 86400);
    }

    public function logout(): void
    {
        $token = $_COOKIE[self::COOKIE] ?? null;
        if (is_string($token)) {
            $this->db->prepare('DELETE FROM fs_sessions WHERE token_hash = ?')->execute([hash('sha256', $token)]);
        }
        $this->setCookie(self::COOKIE, '', time() - 3600);
    }

    private function setCookie(string $name, string $value, int $expires): void
    {
        if (headers_sent()) {
            return;
        }
        setcookie($name, $value, [
            'expires' => $expires,
            'path' => $this->cookiePath,
            'secure' => $this->secureCookie,
            'httponly' => true,
            'samesite' => 'Lax',
        ]);
    }

    // ------------------------------------------------------------------ Bekannte Geräte

    private function trustDevice(string $userId): void
    {
        $token = self::randomToken();
        $now = Db::now();
        $this->db->prepare('INSERT INTO fs_devices (token_hash, user_id, created_at, last_used_at) VALUES (?, ?, ?, ?)')
            ->execute([hash('sha256', $token), $userId, $now, $now]);
        $this->setCookie(self::DEVICE_COOKIE, $token, time() + self::DEVICE_DAYS * 86400);
    }

    private function isTrustedDevice(string $userId): bool
    {
        $token = $_COOKIE[self::DEVICE_COOKIE] ?? null;
        if (!is_string($token) || !preg_match('/^[A-Za-z0-9_-]{43}$/', $token)) {
            return false;
        }
        $stmt = $this->db->prepare('UPDATE fs_devices SET last_used_at = ? WHERE token_hash = ? AND user_id = ? AND last_used_at > ?');
        $stmt->execute([Db::now(), hash('sha256', $token), $userId, self::inSeconds(-self::DEVICE_DAYS * 86400)]);
        return $stmt->rowCount() === 1;
    }

    // ------------------------------------------------------------------ Einrichtung (erstes Konto)

    public function setupNeeded(): bool
    {
        return (int) $this->db->query('SELECT COUNT(*) FROM fs_users')->fetchColumn() === 0;
    }

    /**
     * Legt das erste Konto als Admin an. Geschützt durch den Einrichtungscode aus der Konfiguration.
     * @param array<string,mixed> $in
     * @return array<string,mixed>
     */
    public function setup(array $in): array
    {
        $this->limit('setup:ip:' . $this->clientIp, 10, 3600);
        $given = is_string($in['code'] ?? null) ? trim($in['code']) : '';
        if ($this->setupCode === '' || !hash_equals($this->setupCode, $given)) {
            usleep(300_000);
            throw ApiError::validation(['code' => 'Der Einrichtungscode stimmt nicht.']);
        }
        if (!$this->setupNeeded()) {
            throw new ApiError(409, 'already_setup', 'FriendSplit ist bereits eingerichtet. Bitte melde dich an.');
        }
        [$name, $email, $password] = $this->accountFields($in);
        $id = $this->createUser($name, $email, $password, 'admin');
        $this->db->prepare('UPDATE fs_users SET email_verified_at = ? WHERE id = ?')->execute([Db::now(), $id]);
        $this->trustDevice($id);
        $this->startSession($id);
        return $this->userById($id);
    }

    // ------------------------------------------------------------------ Registrierung mit Einladung

    /**
     * @param array<string,mixed> $in
     * @return array{pending:string,purpose:string,email:string}
     */
    public function register(array $in): array
    {
        $this->limit('register:ip:' . $this->clientIp, 20, 3600);
        $code = Social::normalizeInviteCode(is_string($in['invite'] ?? null) ? $in['invite'] : '');
        [$name, $email, $password] = $this->accountFields($in);
        $this->limit('mail:' . $email, 5, 3600, self::TOO_MANY_MAILS);

        $this->db->beginTransaction();
        try {
            // Platz im Link atomar belegen – auch wenn sich mehrere gleichzeitig registrieren.
            $take = $this->db->prepare('UPDATE fs_invites SET uses = uses + 1 WHERE code = ? AND uses < max_uses AND expires_at > ?');
            $take->execute([$code, Db::now()]);
            if ($take->rowCount() !== 1) {
                throw ApiError::validation(['invite' => 'Diese Einladung ist ungültig, schon benutzt oder abgelaufen. Bitte um einen neuen Link.']);
            }
            $inviter = $this->db->prepare('SELECT created_by FROM fs_invites WHERE code = ?');
            $inviter->execute([$code]);
            $inviterId = (string) $inviter->fetchColumn();
            $id = $this->createUser($name, $email, $password, 'user');
            $now = Db::now();
            $this->db->prepare('INSERT INTO fs_invite_uses (code, user_id, used_at) VALUES (?, ?, ?)')->execute([$code, $id, $now]);
            // Wer einlädt, schickt automatisch eine Freundschaftsanfrage – die neue Person bestätigt sie selbst.
            $exists = $this->db->prepare('SELECT 1 FROM fs_users WHERE id = ?');
            $exists->execute([$inviterId]);
            if ($exists->fetchColumn() !== false) {
                $this->db->prepare("INSERT INTO fs_friends (requester_id, addressee_id, status, created_at) VALUES (?, ?, 'pending', ?)")
                    ->execute([$inviterId, $id, $now]);
            }
            $this->db->commit();
        } catch (Throwable $e) {
            $this->db->rollBack();
            throw $e;
        }
        return $this->startChallenge($this->userById($id), 'verify');
    }

    // ------------------------------------------------------------------ Anmeldung

    /**
     * Gibt ['user' => …] zurück oder – auf neuen Geräten bzw. bei unbestätigter Adresse –
     * ['pending' => …, 'purpose' => …, 'email' => …]; dann folgt verifyCode().
     * @param array<string,mixed> $in
     * @return array<string,mixed>
     */
    public function login(array $in): array
    {
        $login = is_string($in['login'] ?? null) ? self::key($in['login']) : '';
        $password = is_string($in['password'] ?? null) ? $in['password'] : '';
        if ($login === '' || $password === '') {
            throw ApiError::validation(array_filter([
                'login' => $login === '' ? 'Bitte gib deinen Namen oder deine E-Mail-Adresse ein.' : null,
                'password' => $password === '' ? 'Bitte gib dein Passwort ein.' : null,
            ]));
        }
        $tooMany = 'Zu viele Anmeldeversuche. Bitte warte 15 Minuten oder setze dein Passwort zurück.';
        $this->limit('login:ip:' . $this->clientIp, 30, 900, $tooMany);
        $this->limit('login:' . $login, 10, 900, $tooMany);

        $user = $this->userByLogin($login);
        // Auch ohne Konto einen Hash prüfen, damit die Antwortzeit nichts verrät.
        $valid = password_verify($password, $user['password_hash'] ?? self::DUMMY_HASH);
        if ($user === null || !$valid) {
            usleep(200_000);
            throw new ApiError(401, 'invalid_credentials', 'Name/E-Mail oder Passwort ist falsch.');
        }
        if ((int) $user['blocked'] === 1) {
            throw new ApiError(403, 'blocked', 'Dieses Konto ist gesperrt. Wende dich an die Person, die dich eingeladen hat.');
        }
        if (password_needs_rehash($user['password_hash'], PASSWORD_DEFAULT)) {
            $this->db->prepare('UPDATE fs_users SET password_hash = ? WHERE id = ?')->execute([password_hash($password, PASSWORD_DEFAULT), $user['id']]);
        }
        if ($user['email_verified_at'] === null) {
            return $this->startChallenge($user, 'verify');
        }
        if (!$this->isTrustedDevice($user['id'])) {
            return $this->startChallenge($user, 'login');
        }
        $this->startSession($user['id']);
        return ['user' => $user];
    }

    /**
     * Schickt einen 6-stelligen Code per E-Mail. Die App bekommt nur ein „pending“-Token,
     * mit dem sie den Code einlösen oder neu anfordern kann.
     * @param array<string,mixed> $user
     * @return array{pending:string,purpose:string,email:string}
     */
    private function startChallenge(array $user, string $purpose): array
    {
        $pending = self::randomToken();
        $code = self::sixDigits();
        $now = Db::now();
        $this->db->prepare('DELETE FROM fs_codes WHERE user_id = ? AND purpose = ?')->execute([$user['id'], $purpose]);
        $this->db->prepare('INSERT INTO fs_codes (token_hash, user_id, purpose, code_hash, sent_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
            ->execute([hash('sha256', $pending), $user['id'], $purpose, hash('sha256', $pending . $code), $now, self::inSeconds(self::CODE_MINUTES * 60)]);
        $this->sendCode($user, $code, $purpose);
        return ['pending' => $pending, 'purpose' => $purpose, 'email' => self::maskEmail($user['email'])];
    }

    /** @param array<string,mixed> $user */
    private function sendCode(array $user, string $code, string $purpose): void
    {
        $intro = $purpose === 'verify'
            ? 'mit diesem Code bestätigst du deine E-Mail-Adresse bei FriendSplit:'
            : 'du meldest dich auf einem neuen Gerät bei FriendSplit an. Dein Code:';
        $this->mailer->send($user['email'], "FriendSplit-Code: $code", "Hallo {$user['display_name']},\n\n$intro\n\n    $code\n\n"
            . 'Der Code gilt ' . self::CODE_MINUTES . " Minuten.\n\n"
            . "Warst du das nicht? Dann ignoriere diese E-Mail – ohne den Code kommt niemand in dein Konto.\n");
    }

    /**
     * Code aus der E-Mail einlösen: bestätigt die Adresse bzw. das Gerät und meldet an.
     * @param array<string,mixed> $in
     * @return array<string,mixed>
     */
    public function verifyCode(array $in): array
    {
        $row = $this->pendingCode($in);
        $code = preg_replace('/\D/', '', is_string($in['code'] ?? null) ? $in['code'] : '') ?? '';
        if (!hash_equals($row['code_hash'], hash('sha256', $in['pending'] . $code))) {
            $this->db->prepare('UPDATE fs_codes SET attempts = attempts + 1 WHERE token_hash = ?')->execute([$row['token_hash']]);
            usleep(300_000);
            if ((int) $row['attempts'] + 1 >= self::CODE_ATTEMPTS) {
                throw new ApiError(400, 'code_expired', 'Zu viele falsche Versuche. Bitte melde dich neu an, dann kommt ein neuer Code.');
            }
            throw ApiError::validation(['code' => 'Der Code stimmt nicht. Bitte prüfe die E-Mail.']);
        }
        $this->db->prepare('DELETE FROM fs_codes WHERE token_hash = ?')->execute([$row['token_hash']]);
        $user = $this->userById($row['user_id']);
        if ((int) $user['blocked'] === 1) {
            throw new ApiError(403, 'blocked', 'Dieses Konto ist gesperrt.');
        }
        if ($user['email_verified_at'] === null) {
            $this->db->prepare('UPDATE fs_users SET email_verified_at = ?, updated_at = ? WHERE id = ?')->execute([Db::now(), Db::now(), $user['id']]);
        }
        $this->trustDevice($user['id']);
        $this->startSession($user['id']);
        return $this->userById($user['id']);
    }

    /** @param array<string,mixed> $in */
    public function resendCode(array $in): void
    {
        $row = $this->pendingCode($in);
        if ((int) $row['sends'] >= self::CODE_SENDS || strtotime($row['sent_at'] . ' UTC') > time() - 60) {
            throw new ApiError(429, 'resend_wait', 'Bitte warte eine Minute, bevor du einen neuen Code anforderst.');
        }
        $code = self::sixDigits();
        $this->db->prepare('UPDATE fs_codes SET code_hash = ?, sends = sends + 1, sent_at = ?, attempts = 0, expires_at = ? WHERE token_hash = ?')
            ->execute([hash('sha256', $in['pending'] . $code), Db::now(), self::inSeconds(self::CODE_MINUTES * 60), $row['token_hash']]);
        $this->sendCode($this->userById($row['user_id']), $code, $row['purpose']);
    }

    /**
     * @param array<string,mixed> $in
     * @return array<string,mixed>
     */
    private function pendingCode(array $in): array
    {
        $this->limit('code:ip:' . $this->clientIp, 30, 900);
        $pending = is_string($in['pending'] ?? null) ? $in['pending'] : '';
        $stmt = $this->db->prepare('SELECT * FROM fs_codes WHERE token_hash = ? AND expires_at > ?');
        $stmt->execute([hash('sha256', $pending), Db::now()]);
        $row = $stmt->fetch();
        if ($row === false || (int) $row['attempts'] >= self::CODE_ATTEMPTS) {
            throw new ApiError(400, 'code_expired', 'Der Code ist abgelaufen. Bitte melde dich neu an, dann kommt ein neuer Code.');
        }
        return $row;
    }

    // ------------------------------------------------------------------ Passwort vergessen

    /** @param array<string,mixed> $in */
    public function requestPasswordReset(array $in): void
    {
        $login = is_string($in['login'] ?? null) ? self::key($in['login']) : '';
        if ($login === '') {
            throw ApiError::validation(['login' => 'Bitte gib deinen Namen oder deine E-Mail-Adresse ein.']);
        }
        $this->limit('reset:ip:' . $this->clientIp, 20, 3600);
        $this->limit('reset:' . $login, 3, 3600, self::TOO_MANY_MAILS);
        $user = $this->userByLogin($login);
        if ($user === null || (int) $user['blocked'] === 1) {
            return; // Keine Auskunft darüber, ob ein Konto existiert.
        }
        $link = $this->resetLink($user['id'], self::RESET_MINUTES * 60);
        $this->mailer->send($user['email'], 'Neues Passwort für FriendSplit', "Hallo {$user['display_name']},\n\n"
            . "mit diesem Link kannst du ein neues Passwort festlegen:\n\n$link\n\n"
            . 'Der Link ist ' . self::RESET_MINUTES . " Minuten gültig und funktioniert nur einmal.\n\n"
            . "Hast du das nicht angefordert? Dann ignoriere diese E-Mail – dein Passwort bleibt unverändert.\n");
    }

    /** Link zum Setzen eines neuen Passworts (alte Links verfallen). */
    private function resetLink(string $userId, int $seconds): string
    {
        $this->db->prepare("DELETE FROM fs_user_tokens WHERE user_id = ? AND purpose = 'reset'")->execute([$userId]);
        return $this->link('passwort-neu/' . $this->createToken($userId, 'reset', $seconds));
    }

    /** Für die Admin-Seite: Link zum Weitergeben, wenn E-Mails nicht ankommen. */
    public function adminResetLink(string $userId): string
    {
        $this->userById($userId);
        return $this->resetLink($userId, self::ADMIN_RESET_HOURS * 3600);
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
        if ((int) $user['blocked'] === 1) {
            throw new ApiError(403, 'blocked', 'Dieses Konto ist gesperrt.');
        }
        $now = Db::now();
        // Der Link kam per E-Mail (oder vom Admin) – damit ist die Adresse bestätigt und das Gerät bekannt.
        $this->db->prepare('UPDATE fs_users SET password_hash = ?, email_verified_at = COALESCE(email_verified_at, ?), updated_at = ? WHERE id = ?')
            ->execute([password_hash($password, PASSWORD_DEFAULT), $now, $now, $user['id']]);
        $this->db->prepare('DELETE FROM fs_sessions WHERE user_id = ?')->execute([$user['id']]);
        $this->trustDevice($user['id']);
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
            $name = $this->username($in, $errors);
            if (!$errors && self::key($name) !== $user['username_key'] && $this->userByName(self::key($name)) !== null) {
                $errors['name'] = 'Diesen Namen gibt es schon. Bitte wähle einen anderen.';
            }
        }
        $handle = $user['paypal_me'];
        $paypalEmail = $user['paypal_email'] ?? null;
        if (array_key_exists('paypal', $in)) {
            try {
                ['me' => $handle, 'email' => $paypalEmail] = Store::parsePaypal(is_string($in['paypal']) ? $in['paypal'] : '');
            } catch (ApiError $e) {
                $errors += $e->fields;
            }
        }
        if ($errors) {
            throw ApiError::validation($errors);
        }
        // Der Name gilt für neue Events und bei Freunden. In bestehenden Events bleibt der dort verwendete Name.
        $this->db->prepare('UPDATE fs_users SET display_name = ?, username_key = ?, paypal_me = ?, paypal_email = ?, updated_at = ? WHERE id = ?')
            ->execute([$name, self::key($name), $handle, $paypalEmail, Db::now(), $user['id']]);
        return $this->userById($user['id']);
    }

    /**
     * Neue E-Mail-Adresse anfordern: Bestätigungslink an die neue Adresse, Hinweis an die alte.
     * Die Adresse ändert sich erst nach dem Klick auf den Link.
     * @param array<string,mixed> $user
     * @param array<string,mixed> $in
     * @return array<string,mixed>
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
        $this->limit('mail:' . $email, 5, 3600, self::TOO_MANY_MAILS);
        $this->db->prepare("DELETE FROM fs_user_tokens WHERE user_id = ? AND purpose = 'email'")->execute([$user['id']]);
        $this->db->prepare('UPDATE fs_users SET pending_email = ?, updated_at = ? WHERE id = ?')->execute([$email, Db::now(), $user['id']]);
        if ($this->userByEmail($email) !== null) {
            // Adresse gehört schon zu einem Konto: nichts verraten, nur das andere Postfach informieren.
            $this->mailer->send($email, 'Dein FriendSplit-Konto', "Hallo,\n\n"
                . 'jemand wollte gerade diese E-Mail-Adresse für ein anderes FriendSplit-Konto verwenden. '
                . "Sie gehört aber schon zu deinem Konto. Es wurde nichts geändert.\n");
            return $this->userById($user['id']);
        }
        $token = $this->createToken($user['id'], 'email', self::EMAIL_LINK_HOURS * 3600);
        $this->mailer->send($email, 'Bitte bestätige deine neue E-Mail-Adresse', "Hallo {$user['display_name']},\n\n"
            . "bitte bestätige deine neue E-Mail-Adresse für FriendSplit mit diesem Link:\n\n"
            . $this->link('email-bestaetigen/' . $token) . "\n\n"
            . 'Der Link ist ' . self::EMAIL_LINK_HOURS . " Stunden gültig. Bis dahin bleibt deine bisherige Adresse aktiv.\n");
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
        $invalid = 'Dieser Link ist ungültig oder abgelaufen. Bitte fordere die Änderung im Profil erneut an.';
        $user = $this->consumeToken($in, 'email', $invalid);
        $email = $user['pending_email'];
        if ($email === null) {
            throw new ApiError(400, 'invalid_token', $invalid);
        }
        try {
            $this->db->prepare('UPDATE fs_users SET email = ?, pending_email = NULL, updated_at = ? WHERE id = ?')
                ->execute([$email, Db::now(), $user['id']]);
        } catch (PDOException) {
            throw new ApiError(409, 'email_taken', 'Diese E-Mail-Adresse wird inzwischen von einem anderen Konto verwendet.');
        }
        if (($this->currentUser()['id'] ?? null) !== $user['id']) {
            $this->trustDevice($user['id']);
            $this->startSession($user['id']);
        }
        return $this->userById($user['id']);
    }

    /**
     * Passwort ändern (aktuelles Passwort nötig). Andere Geräte werden abgemeldet.
     * @param array<string,mixed> $user
     * @param array<string,mixed> $in
     * @return array<string,mixed>
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
     * Konto endgültig löschen (aktuelles Passwort nötig).
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
        $this->deleteUser($user['id']);
        $this->setCookie(self::COOKIE, '', time() - 3600);
    }

    /**
     * Löscht ein Konto mit allen persönlichen Daten. Die Personen in Events bleiben als Platzhalter
     * mit ihrem Namen erhalten, damit die Abrechnungen der anderen stimmen.
     */
    public function deleteUser(string $userId): void
    {
        $this->db->beginTransaction();
        try {
            $this->db->prepare('UPDATE fs_persons SET auth_user_id = NULL WHERE auth_user_id = ?')->execute([$userId]);
            foreach (['fs_sessions', 'fs_user_tokens', 'fs_codes', 'fs_devices', 'fs_invite_uses'] as $table) {
                $this->db->prepare("DELETE FROM $table WHERE user_id = ?")->execute([$userId]);
            }
            $this->db->prepare('DELETE FROM fs_friends WHERE requester_id = ? OR addressee_id = ?')->execute([$userId, $userId]);
            $this->db->prepare('DELETE FROM fs_invites WHERE created_by = ?')->execute([$userId]);
            $this->db->prepare('DELETE FROM fs_users WHERE id = ?')->execute([$userId]);
            $this->db->commit();
        } catch (Throwable $e) {
            $this->db->rollBack();
            throw $e;
        }
    }

    /**
     * Eigenes Konto für die App inklusive der Events, an denen es teilnimmt.
     * @param array<string,mixed> $user
     * @return array<string,mixed>
     */
    public function profile(array $user): array
    {
        $stmt = $this->db->prepare(
            'SELECT e.access_code, e.name, e.event_date
             FROM fs_persons p
             JOIN fs_event_participants ep ON ep.person_id = p.id
             JOIN fs_events e ON e.id = ep.event_id
             WHERE p.auth_user_id = ?
             ORDER BY COALESCE(e.event_date, SUBSTR(e.created_at, 1, 10)) DESC, e.created_at DESC'
        );
        $stmt->execute([$user['id']]);
        $requests = $this->db->prepare("SELECT COUNT(*) FROM fs_friends WHERE addressee_id = ? AND status = 'pending'");
        $requests->execute([$user['id']]);
        return [
            'id' => $user['id'],
            'email' => $user['email'],
            'pending_email' => $user['pending_email'] ?? null,
            'name' => $user['display_name'],
            'paypal' => $user['paypal_me'],
            'paypal_email' => $user['paypal_email'] ?? null,
            'role' => $user['role'],
            'friend_requests' => (int) $requests->fetchColumn(),
            'events' => array_map(fn ($r) => [
                'code' => $r['access_code'],
                'name' => $r['name'],
                'date' => $r['event_date'] !== null ? substr((string) $r['event_date'], 0, 10) : null,
            ], $stmt->fetchAll()),
        ];
    }

    // ------------------------------------------------------------------ Hilfsfunktionen

    /**
     * Prüft Name, E-Mail und Passwort für ein neues Konto.
     * @param array<string,mixed> $in
     * @return array{0:string,1:string,2:string}
     */
    private function accountFields(array $in): array
    {
        $errors = [];
        $name = $this->username($in, $errors);
        $email = $this->email($in, $errors);
        $password = $this->password($in, $errors);
        if (!isset($errors['name']) && $this->userByName(self::key($name)) !== null) {
            $errors['name'] = 'Diesen Namen gibt es schon. Bitte wähle einen anderen, z. B. mit Nachnamen.';
        }
        if (!isset($errors['email']) && $this->userByEmail($email) !== null) {
            $errors['email'] = 'Mit dieser E-Mail-Adresse gibt es schon ein Konto. Melde dich an oder setze dein Passwort zurück.';
        }
        if ($errors) {
            throw ApiError::validation($errors);
        }
        return [$name, $email, $password];
    }

    private function createUser(string $name, string $email, string $password, string $role): string
    {
        $id = Db::id();
        $now = Db::now();
        $this->db->prepare(
            'INSERT INTO fs_users (id, display_name, username_key, email, password_hash, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        )->execute([$id, $name, self::key($name), $email, password_hash($password, PASSWORD_DEFAULT), $role, $now, $now]);
        return $id;
    }

    /** Vergleichsschlüssel für Namen und E-Mail: Kleinbuchstaben, Leerraum zusammengefasst. */
    public static function key(string $value): string
    {
        return mb_strtolower(trim((string) preg_replace('/\s+/u', ' ', $value)));
    }

    /** @return array<string,mixed>|null */
    private function userByLogin(string $key): ?array
    {
        $stmt = $this->db->prepare('SELECT * FROM fs_users WHERE username_key = ? OR email = ?');
        $stmt->execute([$key, $key]);
        return $stmt->fetch() ?: null;
    }

    /** @return array<string,mixed>|null */
    private function userByName(string $key): ?array
    {
        $stmt = $this->db->prepare('SELECT * FROM fs_users WHERE username_key = ?');
        $stmt->execute([$key]);
        return $stmt->fetch() ?: null;
    }

    /** @return array<string,mixed>|null */
    private function userByEmail(string $email): ?array
    {
        $stmt = $this->db->prepare('SELECT * FROM fs_users WHERE email = ?');
        $stmt->execute([$email]);
        return $stmt->fetch() ?: null;
    }

    /** @return array<string,mixed> */
    public function userById(string $id): array
    {
        $stmt = $this->db->prepare('SELECT * FROM fs_users WHERE id = ?');
        $stmt->execute([$id]);
        return $stmt->fetch() ?: throw new ApiError(404, 'user_not_found', 'Konto nicht gefunden.');
    }

    private function createToken(string $userId, string $purpose, int $seconds): string
    {
        $token = self::randomToken();
        $this->db->prepare('INSERT INTO fs_user_tokens (token_hash, user_id, purpose, expires_at, created_at) VALUES (?, ?, ?, ?, ?)')
            ->execute([hash('sha256', $token), $userId, $purpose, self::inSeconds($seconds), Db::now()]);
        return $token;
    }

    /**
     * Löst einen Link-Token ein (danach ist er verbraucht).
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
    public function limit(string $bucket, int $max, int $windowSeconds, string $message = 'Zu viele Anfragen. Bitte warte etwas und versuche es dann erneut.'): void
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

    /**
     * Anzeigename, über den Freunde einen finden: 3–24 Zeichen, Buchstaben (auch Umlaute), Ziffern,
     * Leerzeichen, Punkt, Unterstrich und Bindestrich – wie in der Reiseapp.
     * @param array<string,string> $errors
     */
    private function username(array $in, array &$errors): string
    {
        $name = is_string($in['name'] ?? null) ? trim((string) preg_replace('/\s+/u', ' ', $in['name'])) : '';
        if ($name === '') {
            $errors['name'] = 'Bitte gib deinen Namen ein.';
        } elseif (!preg_match('/^[\p{L}\p{N}][\p{L}\p{N} ._-]{1,22}[\p{L}\p{N}]$/u', $name)) {
            $errors['name'] = '3–24 Zeichen: Buchstaben, Ziffern, Leerzeichen, Punkt oder Bindestrich.';
        }
        return $name;
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

    public function link(string $route): string
    {
        if (!preg_match('~^https?://~', $this->appUrl)) {
            error_log('FriendSplit: app_url fehlt in config.php');
            throw new ApiError(503, 'not_configured', 'Die App-Adresse (app_url) fehlt in der Konfiguration.');
        }
        return rtrim($this->appUrl, '/') . '/#/' . $route;
    }

    /** „t***@example.de“ – zeigt, wohin der Code ging, ohne die ganze Adresse zu verraten. */
    private static function maskEmail(string $email): string
    {
        [$local, $domain] = explode('@', $email, 2) + [1 => ''];
        return mb_substr($local, 0, 1) . '***@' . $domain;
    }

    private static function sixDigits(): string
    {
        return str_pad((string) random_int(0, 999_999), 6, '0', STR_PAD_LEFT);
    }

    private static function inSeconds(int $seconds): string
    {
        return gmdate('Y-m-d H:i:s', time() + $seconds);
    }

    public static function randomToken(): string
    {
        return rtrim(strtr(base64_encode(random_bytes(32)), '+/', '-_'), '=');
    }
}
