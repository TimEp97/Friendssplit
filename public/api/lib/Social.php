<?php
declare(strict_types=1);

/**
 * Einladungen, Freunde und Admin-Übersicht – im Stil der Reiseapp.
 *
 * - Einladungen: Jede angemeldete Person kann Links erzeugen (für eine Person oder als Gruppenlink
 *   für bis zu 30 Personen, 14 Tage gültig) und hat einen festen Dauerlink ohne Ablauf und ohne Limit. Wer sich damit registriert, bekommt automatisch eine
 *   Freundschaftsanfrage der einladenden Person.
 * - Freunde: Suche nach Namen, Anfrage, Annehmen/Ablehnen/Entfernen. Freunde sehen nur Namen –
 *   nie die E-Mail-Adresse.
 * - Admin: alle Konten sehen, sperren/entsperren, löschen, Passwort-Link erzeugen.
 */
final class Social
{
    private const INVITE_DAYS = 14;
    private const GROUP_USES = 30;
    private const OPEN_INVITES = 10;
    private const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    /** Dauerlink: läuft nie ab und hat praktisch kein Limit (ohne eigene Spalte, damit kein Schema-Update nötig ist). */
    private const PERMANENT_EXPIRES = '9999-12-31 00:00:00';
    private const PERMANENT_USES = 1_000_000;

    public function __construct(private PDO $db, private Auth $auth)
    {
    }

    public static function normalizeInviteCode(string $raw): string
    {
        return strtoupper((string) preg_replace('/[^A-Za-z0-9]/', '', $raw));
    }

    public static function formatInviteCode(string $code): string
    {
        return implode('-', str_split($code, 4));
    }

    // ------------------------------------------------------------------ Einladungen

    /**
     * Öffentlich (ohne Anmeldung): Wer lädt ein, und ist der Link noch gültig?
     * @return array{valid:bool,from:?string,group:bool}
     */
    public function inviteInfo(string $raw): array
    {
        $this->auth->limit('invite_info:ip:' . ($_SERVER['REMOTE_ADDR'] ?? ''), 60, 900);
        $stmt = $this->db->prepare(
            'SELECT i.max_uses, i.uses, i.expires_at, u.display_name, u.blocked FROM fs_invites i
             LEFT JOIN fs_users u ON u.id = i.created_by WHERE i.code = ?'
        );
        $stmt->execute([self::normalizeInviteCode($raw)]);
        $row = $stmt->fetch();
        $valid = $row !== false && (int) $row['uses'] < (int) $row['max_uses'] && $row['expires_at'] > Db::now() && (int) ($row['blocked'] ?? 0) === 0;
        if ($row === false) {
            // Event-Link als Einladung: wer das Event erstellt hat und wie es heißt
            $event = $this->db->prepare(
                'SELECT e.name, p.display_name FROM fs_events e LEFT JOIN fs_persons p ON p.id = e.created_by_person_id WHERE e.access_code = ?'
            );
            $event->execute([self::normalizeInviteCode($raw)]);
            $ev = $event->fetch();
            if ($ev !== false) {
                return ['valid' => true, 'from' => $ev['display_name'], 'group' => true, 'event' => $ev['name']];
            }
        }
        $permanent = $valid && $row['expires_at'] >= self::PERMANENT_EXPIRES;
        return ['valid' => $valid, 'from' => $valid ? $row['display_name'] : null, 'group' => $valid && !$permanent && (int) $row['max_uses'] > 1];
    }

    /**
     * @param array<string,mixed> $user
     * @return array<int,array<string,mixed>>
     */
    public function invites(array $user): array
    {
        $stmt = $this->db->prepare('SELECT * FROM fs_invites WHERE created_by = ? ORDER BY created_at DESC LIMIT 50');
        $stmt->execute([$user['id']]);
        $names = $this->db->prepare('SELECT u.display_name FROM fs_invite_uses x JOIN fs_users u ON u.id = x.user_id WHERE x.code = ? ORDER BY x.used_at, u.username_key');
        return array_map(function ($r) use ($names) {
            $names->execute([$r['code']]);
            $permanent = $r['expires_at'] >= self::PERMANENT_EXPIRES;
            return [
                'code' => self::formatInviteCode($r['code']),
                'permanent' => $permanent,
                'note' => $r['note'],
                'group' => (int) $r['max_uses'] > 1,
                'uses' => (int) $r['uses'],
                'max_uses' => (int) $r['max_uses'],
                'members' => $names->fetchAll(PDO::FETCH_COLUMN),
                'expires_at' => $permanent ? null : self::iso($r['expires_at']),
                'open' => (int) $r['uses'] < (int) $r['max_uses'] && $r['expires_at'] > Db::now(),
                'link' => $this->auth->link('registrieren/' . self::formatInviteCode($r['code'])),
            ];
        }, $stmt->fetchAll());
    }

    /**
     * @param array<string,mixed> $user
     * @param array<string,mixed> $in
     * @return array<string,mixed>
     */
    public function createInvite(array $user, array $in): array
    {
        $note = is_string($in['note'] ?? null) ? mb_substr(trim((string) preg_replace('/[\x00-\x1F\x7F]/u', '', $in['note'])), 0, 100) : '';
        $group = ($in['group'] ?? false) === true;
        $open = $this->db->prepare('SELECT COUNT(*) FROM fs_invites WHERE created_by = ? AND uses < max_uses AND expires_at > ? AND expires_at < ?');
        $open->execute([$user['id'], Db::now(), self::PERMANENT_EXPIRES]);
        if ((int) $open->fetchColumn() >= self::OPEN_INVITES) {
            throw new ApiError(409, 'too_many_invites', 'Du hast schon ' . self::OPEN_INVITES . ' offene Einladungen. Lösche eine alte, bevor du eine neue erstellst.');
        }
        return $this->insertInvite($user, $note, gmdate('Y-m-d H:i:s', time() + self::INVITE_DAYS * 86400), $group ? self::GROUP_USES : 1);
    }

    /**
     * Fester Einladungslink der Person: läuft nicht ab, beliebig oft nutzbar. Wird beim ersten Abruf angelegt.
     * Mit $renew = true wird der alte Link ungültig und ein neuer erzeugt (falls er in falsche Hände geraten ist).
     * @param array<string,mixed> $user
     * @return array<string,mixed>
     */
    public function permanentInvite(array $user, bool $renew = false): array
    {
        $find = $this->db->prepare('SELECT code FROM fs_invites WHERE created_by = ? AND expires_at >= ? ORDER BY created_at DESC');
        $find->execute([$user['id'], self::PERMANENT_EXPIRES]);
        $code = $find->fetchColumn();
        if ($code !== false && !$renew) {
            return $this->inviteByCode($user, (string) $code);
        }
        if ($code !== false) {
            $this->db->prepare('DELETE FROM fs_invites WHERE created_by = ? AND expires_at >= ?')->execute([$user['id'], self::PERMANENT_EXPIRES]);
        }
        return $this->insertInvite($user, '', self::PERMANENT_EXPIRES, self::PERMANENT_USES);
    }

    /**
     * @param array<string,mixed> $user
     * @return array<string,mixed>
     */
    private function insertInvite(array $user, string $note, string $expiresAt, int $maxUses): array
    {
        $stmt = $this->db->prepare('INSERT INTO fs_invites (code, created_by, note, created_at, expires_at, max_uses) VALUES (?, ?, ?, ?, ?, ?)');
        for ($attempt = 0; ; $attempt++) {
            $code = '';
            for ($i = 0; $i < 12; $i++) {
                $code .= self::CODE_ALPHABET[random_int(0, strlen(self::CODE_ALPHABET) - 1)];
            }
            try {
                $stmt->execute([$code, $user['id'], $note, Db::now(), $expiresAt, $maxUses]);
                break;
            } catch (PDOException $e) {
                if ($attempt >= 4) {
                    throw $e;
                }
            }
        }
        return $this->inviteByCode($user, $code);
    }

    /**
     * @param array<string,mixed> $user
     * @return array<string,mixed>
     */
    private function inviteByCode(array $user, string $code): array
    {
        foreach ($this->invites($user) as $invite) {
            if ($invite['code'] === self::formatInviteCode($code)) {
                return $invite;
            }
        }
        throw new RuntimeException('Einladung nicht gefunden.');
    }

    /** @param array<string,mixed> $user */
    public function deleteInvite(array $user, string $raw): void
    {
        $this->db->prepare('DELETE FROM fs_invites WHERE code = ? AND created_by = ?')->execute([self::normalizeInviteCode($raw), $user['id']]);
    }

    // ------------------------------------------------------------------ Freunde

    /**
     * @param array<string,mixed> $user
     * @return array{friends:array<int,array<string,mixed>>,incoming:array<int,array<string,mixed>>,outgoing:array<int,array<string,mixed>>}
     */
    public function friends(array $user): array
    {
        $stmt = $this->db->prepare(
            "SELECT f.requester_id, f.addressee_id, f.status, f.created_at, f.accepted_at, u.id, u.display_name, u.paypal_me, u.paypal_email
             FROM fs_friends f JOIN fs_users u ON u.id = CASE WHEN f.requester_id = ? THEN f.addressee_id ELSE f.requester_id END
             WHERE (f.requester_id = ? OR f.addressee_id = ?) AND u.blocked = 0 AND u.email_verified_at IS NOT NULL
             ORDER BY u.username_key"
        );
        $stmt->execute([$user['id'], $user['id'], $user['id']]);
        $out = ['friends' => [], 'incoming' => [], 'outgoing' => []];
        foreach ($stmt->fetchAll() as $r) {
            $entry = ['id' => $r['id'], 'name' => $r['display_name']];
            if ($r['status'] === 'accepted') {
                $out['friends'][] = $entry + ['paypal' => $r['paypal_me'] ?? $r['paypal_email'], 'since' => self::iso($r['accepted_at'] ?? $r['created_at'])];
            } elseif ($r['addressee_id'] === $user['id']) {
                $out['incoming'][] = $entry;
            } else {
                $out['outgoing'][] = $entry;
            }
        }
        return $out;
    }

    /**
     * Suche nach Namen (ab 2 Zeichen). Zeigt zu jedem Treffer den Stand der Freundschaft.
     * @param array<string,mixed> $user
     * @return array<int,array<string,mixed>>
     */
    public function search(array $user, string $query): array
    {
        $q = Auth::key($query);
        if (mb_strlen($q) < 2) {
            return [];
        }
        $this->auth->limit('search:' . $user['id'], 60, 300);
        $like = str_replace(['\\', '%', '_'], ['\\\\', '\\%', '\\_'], $q);
        $stmt = $this->db->prepare(
            "SELECT id, display_name FROM fs_users
             WHERE (username_key LIKE ? ESCAPE '\\' OR username_key LIKE ? ESCAPE '\\') AND id <> ? AND blocked = 0 AND email_verified_at IS NOT NULL
             ORDER BY username_key LIMIT 10"
        );
        $stmt->execute([$like . '%', '% ' . $like . '%', $user['id']]);
        $rel = $this->relations($user['id']);
        return array_map(fn ($r) => ['id' => $r['id'], 'name' => $r['display_name'], 'status' => $rel[$r['id']] ?? 'none'], $stmt->fetchAll());
    }

    /**
     * Anfrage schicken. Liegt schon eine Anfrage der anderen Person vor, gilt das als Annehmen.
     * @param array<string,mixed> $user
     */
    public function request(array $user, string $otherId): void
    {
        $other = $this->activeUser($otherId);
        if ($other['id'] === $user['id']) {
            throw new ApiError(422, 'self', 'Du kannst dich nicht selbst als Freund hinzufügen.');
        }
        $this->auth->limit('friend_request:' . $user['id'], 30, 3600);
        $status = $this->relations($user['id'])[$other['id']] ?? 'none';
        if ($status === 'incoming') {
            $this->accept($user, $other['id']);
        } elseif ($status === 'none') {
            $this->db->prepare("INSERT INTO fs_friends (requester_id, addressee_id, status, created_at) VALUES (?, ?, 'pending', ?)")
                ->execute([$user['id'], $other['id'], Db::now()]);
        }
    }

    /** @param array<string,mixed> $user */
    public function accept(array $user, string $otherId): void
    {
        $stmt = $this->db->prepare("UPDATE fs_friends SET status = 'accepted', accepted_at = ? WHERE requester_id = ? AND addressee_id = ? AND status = 'pending'");
        $stmt->execute([Db::now(), $otherId, $user['id']]);
        if ($stmt->rowCount() !== 1) {
            throw new ApiError(404, 'request_not_found', 'Diese Anfrage gibt es nicht mehr.');
        }
    }

    /**
     * Anfrage ablehnen oder zurückziehen bzw. Freundschaft beenden.
     * @param array<string,mixed> $user
     */
    public function remove(array $user, string $otherId): void
    {
        $this->db->prepare('DELETE FROM fs_friends WHERE (requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?)')
            ->execute([$user['id'], $otherId, $otherId, $user['id']]);
    }

    public function areFriends(string $a, string $b): bool
    {
        $stmt = $this->db->prepare(
            "SELECT 1 FROM fs_friends WHERE status = 'accepted' AND ((requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?))"
        );
        $stmt->execute([$a, $b, $b, $a]);
        return $stmt->fetchColumn() !== false;
    }

    /** @return array<string,string> andere Person => friend|incoming|outgoing */
    private function relations(string $userId): array
    {
        $stmt = $this->db->prepare('SELECT requester_id, addressee_id, status FROM fs_friends WHERE requester_id = ? OR addressee_id = ?');
        $stmt->execute([$userId, $userId]);
        $out = [];
        foreach ($stmt->fetchAll() as $r) {
            $other = $r['requester_id'] === $userId ? $r['addressee_id'] : $r['requester_id'];
            $out[$other] = $r['status'] === 'accepted' ? 'friend' : ($r['addressee_id'] === $userId ? 'incoming' : 'outgoing');
        }
        return $out;
    }

    /** @return array<string,mixed> */
    private function activeUser(string $id): array
    {
        $stmt = $this->db->prepare('SELECT * FROM fs_users WHERE id = ? AND blocked = 0 AND email_verified_at IS NOT NULL');
        $stmt->execute([$id]);
        return $stmt->fetch() ?: throw new ApiError(404, 'user_not_found', 'Diese Person gibt es nicht (mehr).');
    }

    // ------------------------------------------------------------------ Admin

    /** @return array<int,array<string,mixed>> */
    public function adminUsers(): array
    {
        $rows = $this->db->query(
            "SELECT u.id, u.display_name, u.email, u.role, u.blocked, u.email_verified_at, u.created_at, u.last_login_at,
                    (SELECT COUNT(*) FROM fs_persons p JOIN fs_event_participants ep ON ep.person_id = p.id WHERE p.auth_user_id = u.id) AS events,
                    (SELECT COUNT(*) FROM fs_friends f WHERE f.status = 'accepted' AND (f.requester_id = u.id OR f.addressee_id = u.id)) AS friends,
                    (SELECT i.created_by FROM fs_invite_uses x JOIN fs_invites i ON i.code = x.code WHERE x.user_id = u.id LIMIT 1) AS invited_by_id
             FROM fs_users u ORDER BY u.created_at"
        )->fetchAll();
        $names = array_column($rows, 'display_name', 'id');
        return array_map(fn ($r) => [
            'id' => $r['id'],
            'name' => $r['display_name'],
            'email' => $r['email'],
            'role' => $r['role'],
            'blocked' => (int) $r['blocked'] === 1,
            'verified' => $r['email_verified_at'] !== null,
            'created_at' => self::iso($r['created_at']),
            'last_login_at' => $r['last_login_at'] !== null ? self::iso($r['last_login_at']) : null,
            'events' => (int) $r['events'],
            'friends' => (int) $r['friends'],
            'invited_by' => $r['invited_by_id'] !== null ? ($names[$r['invited_by_id']] ?? null) : null,
        ], $rows);
    }

    /** @param array<string,mixed> $admin */
    public function adminSetBlocked(array $admin, string $userId, bool $blocked): void
    {
        $target = $this->auth->userById($userId);
        if ($target['id'] === $admin['id']) {
            throw new ApiError(422, 'self', 'Du kannst dich nicht selbst sperren.');
        }
        $this->db->prepare('UPDATE fs_users SET blocked = ?, updated_at = ? WHERE id = ?')->execute([$blocked ? 1 : 0, Db::now(), $userId]);
        if ($blocked) {
            $this->db->prepare('DELETE FROM fs_sessions WHERE user_id = ?')->execute([$userId]);
        }
    }

    /** @param array<string,mixed> $admin */
    public function adminDelete(array $admin, string $userId): void
    {
        $target = $this->auth->userById($userId);
        if ($target['id'] === $admin['id']) {
            throw new ApiError(422, 'self', 'Dein eigenes Konto löschst du im Profil.');
        }
        $this->auth->deleteUser($userId);
    }

    private static function iso(string $dbValue): string
    {
        return str_replace(' ', 'T', substr($dbValue, 0, 19)) . 'Z';
    }
}
