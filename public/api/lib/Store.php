<?php
declare(strict_types=1);

/**
 * Geschäftslogik und Datenbankzugriffe. Jeder Zugriff ist auf genau ein Event beschränkt,
 * das über seinen geheimen Zugangscode ermittelt wurde. Angemeldete Konten sind über
 * fs_event_participants.user_id mit „ihrer“ Person im Event verknüpft.
 */
final class Store
{
    /** Kategorie-Schlüssel => [Bezeichnung, Symbol] */
    public const CATEGORIES = [
        'getraenke'  => ['Getränke', '🍹'],
        'essen'      => ['Essen', '🍕'],
        'tickets'    => ['Tickets', '🎟️'],
        'transport'  => ['Transport', '🚕'],
        'unterkunft' => ['Unterkunft', '🏨'],
        'sonstiges'  => ['Sonstiges', '🛍️'],
    ];

    /** Ohne leicht verwechselbare Zeichen (0/O, 1/I). 12 Zeichen ≈ 60 Bit Zufall. */
    private const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
    private const CODE_LENGTH = 12;
    private const MAX_AMOUNT_CENTS = 10_000_000; // 100.000,00 €
    private const MAX_PARTICIPANTS = 50;

    public function __construct(private PDO $db)
    {
    }

    public static function normalizeCode(?string $raw): ?string
    {
        if ($raw === null) {
            return null;
        }
        $code = strtoupper((string) preg_replace('/[^A-Za-z0-9]/', '', $raw));
        if (strlen($code) !== self::CODE_LENGTH || strspn($code, self::CODE_ALPHABET) !== self::CODE_LENGTH) {
            return null;
        }
        return $code;
    }

    // ------------------------------------------------------------------ Events

    /**
     * @param array<string,mixed> $in
     * @param array<string,mixed>|null $user angemeldetes Konto: wird Owner und mit der eigenen Person verknüpft
     * @return array{code:string,person_id:string}
     */
    public function createEvent(array $in, ?array $user = null): array
    {
        $errors = [];
        $name = $this->text($in, 'name', 120, true, $errors, 'Bitte gib einen Eventnamen ein.');
        $date = $this->date($in, 'date', $errors);
        $location = $this->text($in, 'location', 120, false, $errors);
        $notes = $this->text($in, 'notes', 1000, false, $errors);
        $creator = $this->text($in, 'creator_name', 60, true, $errors, 'Bitte gib deinen Namen ein.');

        $others = $in['participants'] ?? [];
        if (!is_array($others)) {
            $others = [];
        }
        $names = $creator !== null ? [$creator] : [];
        foreach ($others as $raw) {
            $clean = is_string($raw) ? $this->cleanText($raw) : '';
            if ($clean === '') {
                continue;
            }
            if (mb_strlen($clean) > 60) {
                $errors['participants'] = 'Namen dürfen höchstens 60 Zeichen lang sein.';
                break;
            }
            $names[] = $clean;
        }
        $lower = array_map(fn ($n) => mb_strtolower($n), $names);
        if (count($lower) !== count(array_unique($lower))) {
            $errors['participants'] = 'Jeder Name darf nur einmal vorkommen.';
        }
        if (count($names) > self::MAX_PARTICIPANTS) {
            $errors['participants'] = 'Ein Event kann höchstens ' . self::MAX_PARTICIPANTS . ' Teilnehmende haben.';
        }
        if ($errors) {
            throw ApiError::validation($errors);
        }

        $now = Db::now();
        $eventId = Db::id();
        $this->db->beginTransaction();
        try {
            $code = $this->insertEventWithUniqueCode($eventId, $name, $date, $location, $notes, $now);
            $creatorId = null;
            foreach ($names as $position => $personName) {
                $isCreator = $position === 0;
                $personId = $this->insertParticipant($eventId, $personName, $isCreator ? 'organizer' : 'member', $position, $now, $isCreator ? $user['id'] ?? null : null);
                $creatorId ??= $personId;
            }
            $this->db->prepare('UPDATE fs_events SET created_by_person_id = ?, owner_user_id = ? WHERE id = ?')->execute([$creatorId, $user['id'] ?? null, $eventId]);
            $this->log($eventId, $creatorId, 'event_created', sprintf('%s hat das Event „%s“ erstellt', $creator, $name));
            $this->db->commit();
        } catch (Throwable $e) {
            $this->db->rollBack();
            throw $e;
        }
        return ['code' => $code, 'person_id' => $creatorId];
    }

    /** @return array<string,mixed> */
    public function requireEvent(?string $rawCode): array
    {
        $code = self::normalizeCode($rawCode);
        $event = null;
        if ($code !== null) {
            $stmt = $this->db->prepare('SELECT * FROM fs_events WHERE access_code = ?');
            $stmt->execute([$code]);
            $event = $stmt->fetch() ?: null;
        }
        if ($event === null) {
            throw new ApiError(404, 'event_not_found', 'Zu diesem Code wurde kein Event gefunden. Bitte prüfe den Link oder Code.');
        }
        return $event;
    }

    /** @return array<string,mixed> */
    public function requireEventById(string $id): array
    {
        $stmt = $this->db->prepare('SELECT * FROM fs_events WHERE id = ?');
        $stmt->execute([$id]);
        $event = $stmt->fetch();
        if (!$event) {
            throw new ApiError(404, 'event_not_found', 'Dieses Event gibt es nicht mehr.');
        }
        return $event;
    }

    /**
     * Wer handelt? Angemeldet: die mit dem Konto verknüpfte Person. Ohne Anmeldung: die gewählte
     * Person (X-Person-Id), aber nur, wenn sie zum Event gehört und mit keinem Konto verknüpft ist.
     * @param array<string,mixed>|null $user
     */
    public function actor(array $event, ?array $user, ?string $personId): ?string
    {
        if ($user !== null) {
            return $this->linkedPerson($event['id'], $user['id']);
        }
        if ($personId === null) {
            return null;
        }
        $stmt = $this->db->prepare('SELECT user_id FROM fs_event_participants WHERE event_id = ? AND person_id = ?');
        $stmt->execute([$event['id'], $personId]);
        $row = $stmt->fetch();
        return $row && $row['user_id'] === null ? $personId : null;
    }

    /** Owner des Events oder Admin. */
    public function canManage(array $event, ?array $user): bool
    {
        return $user !== null && ($user['role'] === 'admin' || ($event['owner_user_id'] ?? null) === $user['id']);
    }

    // ------------------------------------------------------------------ Konten und Events

    /**
     * „Meine Events“ eines Kontos: alle Events, in denen das Konto mit einer Person verknüpft ist.
     * @return array<int,array<string,mixed>>
     */
    public function myEvents(string $userId): array
    {
        $stmt = $this->db->prepare(
            'SELECT e.access_code, e.name, e.event_date, e.location, e.updated_at, e.owner_user_id, p.display_name AS person_name,
               (SELECT COUNT(*) FROM fs_event_participants c WHERE c.event_id = e.id) AS participants
             FROM fs_event_participants ep
             JOIN fs_events e ON e.id = ep.event_id
             JOIN fs_persons p ON p.id = ep.person_id
             WHERE ep.user_id = ?
             ORDER BY e.updated_at DESC'
        );
        $stmt->execute([$userId]);
        return array_map(fn ($r) => [
            'code' => $r['access_code'],
            'name' => $r['name'],
            'date' => $r['event_date'] !== null ? substr((string) $r['event_date'], 0, 10) : null,
            'location' => $r['location'],
            'updated_at' => $this->isoUtc($r['updated_at']),
            'person_name' => $r['person_name'],
            'participants' => (int) $r['participants'],
            'is_owner' => $r['owner_user_id'] === $userId,
        ], $stmt->fetchAll());
    }

    /** Alle Events für den Admin-Bereich. */
    public function allEvents(): array
    {
        $rows = $this->db->query(
            'SELECT e.access_code, e.name, e.event_date, e.updated_at, u.display_name AS owner,
               (SELECT COUNT(*) FROM fs_event_participants c WHERE c.event_id = e.id) AS participants,
               (SELECT COUNT(*) FROM fs_event_participants c WHERE c.event_id = e.id AND c.user_id IS NOT NULL) AS linked,
               (SELECT COALESCE(SUM(x.amount_cents), 0) FROM fs_expenses x WHERE x.event_id = e.id) AS total_cents
             FROM fs_events e LEFT JOIN fs_users u ON u.id = e.owner_user_id
             ORDER BY e.updated_at DESC LIMIT 500'
        )->fetchAll();
        return array_map(fn ($r) => [
            'code' => $r['access_code'],
            'name' => $r['name'],
            'date' => $r['event_date'] !== null ? substr((string) $r['event_date'], 0, 10) : null,
            'owner' => $r['owner'],
            'participants' => (int) $r['participants'],
            'linked' => (int) $r['linked'],
            'total_cents' => (int) $r['total_cents'],
            'updated_at' => $this->isoUtc($r['updated_at']),
        ], $rows);
    }

    /**
     * Übernimmt Events, die auf einem Gerät ohne Anmeldung genutzt wurden, ins Konto.
     * Erwartet [{code, person_id}]; verknüpft die Person nur, wenn sie noch frei ist.
     * @param array<string,mixed> $in
     * @param array<string,mixed> $user
     */
    public function importLocal(array $in, array $user): array
    {
        $items = is_array($in['items'] ?? null) ? array_slice($in['items'], 0, 50) : [];
        $imported = 0;
        foreach ($items as $item) {
            $code = self::normalizeCode(is_string($item['code'] ?? null) ? $item['code'] : null);
            $personId = is_string($item['person_id'] ?? null) ? $item['person_id'] : null;
            if ($code === null || $personId === null) {
                continue;
            }
            $stmt = $this->db->prepare('SELECT * FROM fs_events WHERE access_code = ?');
            $stmt->execute([$code]);
            $event = $stmt->fetch();
            if (!$event || $this->linkedPerson($event['id'], $user['id']) !== null) {
                continue;
            }
            try {
                $this->joinEvent($event, ['person_id' => $personId], $user);
                $imported++;
            } catch (ApiError) {
                // Person gehört inzwischen jemand anderem oder wurde entfernt – überspringen.
            }
        }
        return ['imported' => $imported];
    }

    /**
     * Konto mit einer Person im Event verknüpfen: vorhandene freie Person ({person_id}) oder neue
     * Person ({name}). Eine bestehende Verknüpfung im selben Event wird dabei umgehängt.
     * @param array<string,mixed> $in
     * @param array<string,mixed> $user
     */
    public function joinEvent(array $event, array $in, array $user): string
    {
        $personId = is_string($in['person_id'] ?? null) ? $in['person_id'] : null;
        $errors = [];
        $name = $personId === null ? $this->text($in, 'name', 60, true, $errors, 'Bitte gib deinen Namen ein.') : null;
        if ($errors) {
            throw ApiError::validation($errors);
        }
        return $this->transaction($event, function () use ($event, $personId, $name, $user) {
            if ($personId === null) {
                $participants = $this->participants($event['id']);
                if (count($participants) >= self::MAX_PARTICIPANTS) {
                    throw ApiError::validation(['name' => 'Ein Event kann höchstens ' . self::MAX_PARTICIPANTS . ' Teilnehmende haben.']);
                }
                $this->assertUniqueName($participants, $name, null);
                $this->db->prepare('UPDATE fs_event_participants SET user_id = NULL WHERE event_id = ? AND user_id = ?')->execute([$event['id'], $user['id']]);
                $position = $participants ? max(array_column($participants, 'position')) + 1 : 0;
                $personId = $this->insertParticipant($event['id'], $name, 'member', $position, Db::now(), $user['id']);
                $this->log($event['id'], $personId, 'participant_joined', sprintf('%s ist dem Event beigetreten', $name));
                return $personId;
            }

            $stmt = $this->db->prepare('SELECT ep.user_id, ep.role, p.display_name FROM fs_event_participants ep JOIN fs_persons p ON p.id = ep.person_id WHERE ep.event_id = ? AND ep.person_id = ?');
            $stmt->execute([$event['id'], $personId]);
            $row = $stmt->fetch();
            if (!$row) {
                throw new ApiError(404, 'person_not_found', 'Diese Person nimmt nicht (mehr) am Event teil.');
            }
            if ($row['user_id'] === $user['id']) {
                return $personId;
            }
            if ($row['user_id'] !== null) {
                throw new ApiError(409, 'person_taken', sprintf('%s ist bereits mit einem anderen Konto verknüpft.', $row['display_name']));
            }
            $this->db->prepare('UPDATE fs_event_participants SET user_id = NULL WHERE event_id = ? AND user_id = ?')->execute([$event['id'], $user['id']]);
            $this->db->prepare('UPDATE fs_event_participants SET user_id = ? WHERE event_id = ? AND person_id = ?')->execute([$user['id'], $event['id'], $personId]);
            // Wer die Organisator-Person eines Events ohne Owner übernimmt, wird Owner.
            if ($row['role'] === 'organizer') {
                $this->db->prepare('UPDATE fs_events SET owner_user_id = ? WHERE id = ? AND owner_user_id IS NULL')->execute([$user['id'], $event['id']]);
            }
            $this->log($event['id'], $personId, 'participant_linked', sprintf('%s ist jetzt mit einem Konto angemeldet', $row['display_name']));
            return $personId;
        });
    }

    /** Eigene Verknüpfung lösen: Das Event verschwindet aus „Meine Events“, die Person bleibt. */
    public function leaveEvent(array $event, array $user): void
    {
        $this->transaction($event, function () use ($event, $user) {
            $this->db->prepare('UPDATE fs_event_participants SET user_id = NULL WHERE event_id = ? AND user_id = ?')->execute([$event['id'], $user['id']]);
        });
    }

    /** Owner/Admin: Konto-Verknüpfung einer Person lösen (z. B. falsch gewählter Name). */
    public function unlinkParticipant(array $event, array $in, ?array $user, ?string $actor): void
    {
        $this->requireManage($event, $user);
        $personId = is_string($in['person_id'] ?? null) ? $in['person_id'] : '';
        $this->transaction($event, function () use ($event, $personId, $actor) {
            $name = $this->participantName($event['id'], $personId);
            if ($name === null) {
                throw new ApiError(404, 'person_not_found', 'Diese Person nimmt nicht (mehr) am Event teil.');
            }
            $this->db->prepare('UPDATE fs_event_participants SET user_id = NULL WHERE event_id = ? AND person_id = ?')->execute([$event['id'], $personId]);
            $this->log($event['id'], $actor, 'participant_unlinked', sprintf('%s hat die Konto-Verknüpfung von %s gelöst', $this->actorName($event, $actor), $name));
        });
    }

    /**
     * Owner/Admin: neuen Zugangscode erzeugen. Der alte Link funktioniert danach nicht mehr;
     * wer mit Konto beigetreten ist, behält den Zugang über „Meine Events“.
     */
    public function regenerateCode(array $event, ?array $user, ?string $actor): string
    {
        $this->requireManage($event, $user);
        return $this->transaction($event, function () use ($event, $actor) {
            $code = $this->uniqueCode();
            $this->db->prepare('UPDATE fs_events SET access_code = ? WHERE id = ?')->execute([$code, $event['id']]);
            $this->log($event['id'], $actor, 'code_regenerated', sprintf('%s hat einen neuen Zugangscode erzeugt', $this->actorName($event, $actor)));
            return $code;
        });
    }

    /** Owner/Admin: Event mit allen Ausgaben, Zahlungen und dem Verlauf endgültig löschen. */
    public function deleteEvent(array $event, ?array $user): void
    {
        $this->requireManage($event, $user);
        $this->db->beginTransaction();
        try {
            $stmt = $this->db->prepare('SELECT person_id FROM fs_event_participants WHERE event_id = ?');
            $stmt->execute([$event['id']]);
            $personIds = $stmt->fetchAll(PDO::FETCH_COLUMN);
            // Anteile verweisen auf Personen; sie werden über die Ausgaben mitgelöscht.
            $this->db->prepare('DELETE FROM fs_expenses WHERE event_id = ?')->execute([$event['id']]);
            $this->db->prepare('DELETE FROM fs_settlements WHERE event_id = ?')->execute([$event['id']]);
            $this->db->prepare('DELETE FROM fs_events WHERE id = ?')->execute([$event['id']]);
            $deletePerson = $this->db->prepare('DELETE FROM fs_persons WHERE id = ? AND NOT EXISTS (SELECT 1 FROM fs_event_participants WHERE person_id = ?)');
            foreach ($personIds as $personId) {
                $deletePerson->execute([$personId, $personId]);
            }
            $this->db->commit();
        } catch (Throwable $e) {
            $this->db->rollBack();
            throw $e;
        }
    }

    /** @param array<string,mixed> $in */
    public function updateEvent(array $event, array $in, ?string $actor): void
    {
        $errors = [];
        $name = $this->text($in, 'name', 120, true, $errors, 'Bitte gib einen Eventnamen ein.');
        $date = $this->date($in, 'date', $errors);
        $location = $this->text($in, 'location', 120, false, $errors);
        $notes = $this->text($in, 'notes', 1000, false, $errors);
        if ($errors) {
            throw ApiError::validation($errors);
        }
        $this->transaction($event, function () use ($event, $name, $date, $location, $notes, $actor) {
            $this->db->prepare('UPDATE fs_events SET name = ?, event_date = ?, location = ?, notes = ? WHERE id = ?')
                ->execute([$name, $date, $location, $notes, $event['id']]);
            $this->log($event['id'], $actor, 'event_updated', sprintf('%s hat die Eventdaten geändert', $this->actorName($event, $actor)));
        });
    }

    // ------------------------------------------------------------------ Teilnehmende

    /** @param array<string,mixed> $in */
    public function addParticipant(array $event, array $in, ?string $actor): string
    {
        $errors = [];
        $name = $this->text($in, 'name', 60, true, $errors, 'Bitte gib einen Namen ein.');
        if ($errors) {
            throw ApiError::validation($errors);
        }
        return $this->transaction($event, function () use ($event, $name, $actor) {
            $participants = $this->participants($event['id']);
            if (count($participants) >= self::MAX_PARTICIPANTS) {
                throw ApiError::validation(['name' => 'Ein Event kann höchstens ' . self::MAX_PARTICIPANTS . ' Teilnehmende haben.']);
            }
            $this->assertUniqueName($participants, $name, null);
            $position = $participants ? max(array_column($participants, 'position')) + 1 : 0;
            $personId = $this->insertParticipant($event['id'], $name, 'member', $position, Db::now());
            $who = $actor !== null ? $this->actorName($event, $actor) : $name;
            $this->log($event['id'], $actor ?? $personId, 'participant_added', $actor !== null
                ? sprintf('%s hat %s hinzugefügt', $who, $name)
                : sprintf('%s ist dem Event beigetreten', $name));
            return $personId;
        });
    }

    /** @param array<string,mixed> $in */
    public function renameParticipant(array $event, array $in, ?string $actor): void
    {
        $errors = [];
        $personId = is_string($in['person_id'] ?? null) ? $in['person_id'] : '';
        $name = $this->text($in, 'name', 60, true, $errors, 'Bitte gib einen Namen ein.');
        if ($errors) {
            throw ApiError::validation($errors);
        }
        $this->transaction($event, function () use ($event, $personId, $name, $actor) {
            $old = $this->participantName($event['id'], $personId);
            if ($old === null) {
                throw new ApiError(404, 'person_not_found', 'Diese Person nimmt nicht (mehr) am Event teil.');
            }
            $this->assertUniqueName($this->participants($event['id']), $name, $personId);
            $this->db->prepare('UPDATE fs_persons SET display_name = ? WHERE id = ?')->execute([$name, $personId]);
            $this->log($event['id'], $actor, 'participant_renamed', sprintf('%s hat %s in %s umbenannt', $this->actorName($event, $actor), $old, $name));
        });
    }

    /** @param array<string,mixed> $in */
    public function removeParticipant(array $event, array $in, ?string $actor): void
    {
        $personId = is_string($in['person_id'] ?? null) ? $in['person_id'] : '';
        $this->transaction($event, function () use ($event, $personId, $actor) {
            $name = $this->participantName($event['id'], $personId);
            if ($name === null) {
                throw new ApiError(404, 'person_not_found', 'Diese Person nimmt nicht (mehr) am Event teil.');
            }
            $stmt = $this->db->prepare(
                'SELECT
                   (SELECT COUNT(*) FROM fs_expenses WHERE event_id = ? AND paid_by_person_id = ?)
                 + (SELECT COUNT(*) FROM fs_expense_shares s JOIN fs_expenses x ON x.id = s.expense_id WHERE x.event_id = ? AND s.person_id = ?)
                 + (SELECT COUNT(*) FROM fs_settlements WHERE event_id = ? AND (from_person_id = ? OR to_person_id = ?))'
            );
            $stmt->execute([$event['id'], $personId, $event['id'], $personId, $event['id'], $personId, $personId]);
            if ((int) $stmt->fetchColumn() > 0) {
                throw new ApiError(409, 'person_in_use', sprintf(
                    '%s hat bezahlt oder ist an Ausgaben bzw. Ausgleichszahlungen beteiligt und kann deshalb nicht entfernt werden. Entferne %s zuerst aus diesen Einträgen.',
                    $name,
                    $name
                ));
            }
            $this->db->prepare('DELETE FROM fs_event_participants WHERE event_id = ? AND person_id = ?')->execute([$event['id'], $personId]);
            $this->db->prepare('DELETE FROM fs_persons WHERE id = ? AND NOT EXISTS (SELECT 1 FROM fs_event_participants WHERE person_id = ?)')
                ->execute([$personId, $personId]);
            $actorName = $actor === $personId ? $name : $this->actorName($event, $actor);
            $this->log($event['id'], $actor === $personId ? null : $actor, 'participant_removed', sprintf('%s hat %s entfernt', $actorName, $name));
        });
    }

    // ------------------------------------------------------------------ Ausgaben

    /**
     * Legt eine Ausgabe an (ohne id) oder ändert sie (mit id und version).
     * @param array<string,mixed> $in
     */
    public function saveExpense(array $event, array $in, ?string $actor): string
    {
        $errors = [];
        $id = is_string($in['id'] ?? null) && $in['id'] !== '' ? $in['id'] : null;
        $version = $in['version'] ?? null;
        if ($id !== null && (!is_int($version) || $version < 1)) {
            throw new ApiError(400, 'bad_request', 'Die Version der Ausgabe fehlt. Bitte lade die Seite neu.');
        }

        $amount = $in['amount_cents'] ?? null;
        if (is_string($amount) && ctype_digit($amount)) {
            $amount = (int) $amount;
        }
        if (!is_int($amount) || $amount <= 0) {
            $errors['amount'] = 'Bitte gib einen Betrag größer als 0,00 € ein.';
        } elseif ($amount > self::MAX_AMOUNT_CENTS) {
            $errors['amount'] = 'Der Betrag darf höchstens ' . Split::formatEuro(self::MAX_AMOUNT_CENTS) . ' betragen.';
        }

        $category = is_string($in['category'] ?? null) ? $in['category'] : '';
        if (!isset(self::CATEGORIES[$category])) {
            $errors['category'] = 'Bitte wähle eine Kategorie.';
            $category = 'sonstiges';
        }
        $description = $this->text($in, 'description', 140, false, $errors) ?? self::CATEGORIES[$category][0];
        $notes = $this->text($in, 'notes', 500, false, $errors);
        $spentAt = $this->dateTime($in, 'spent_at', $errors);

        $clientToken = is_string($in['client_token'] ?? null) ? $in['client_token'] : null;
        if ($clientToken !== null && !preg_match('/^[A-Za-z0-9-]{8,64}$/', $clientToken)) {
            $clientToken = null;
        }

        $participants = $this->participants($event['id']);
        $participantIds = array_column($participants, 'id');

        $paidBy = is_string($in['paid_by'] ?? null) ? $in['paid_by'] : '';
        if (!in_array($paidBy, $participantIds, true)) {
            $errors['paid_by'] = 'Bitte wähle aus, wer bezahlt hat. Die Person muss am Event teilnehmen.';
        }
        $selected = $in['participants'] ?? [];
        $selected = is_array($selected) ? array_values(array_unique(array_filter($selected, 'is_string'))) : [];
        if ($selected === []) {
            $errors['participants'] = 'Bitte wähle mindestens eine beteiligte Person aus.';
        } elseif (array_diff($selected, $participantIds)) {
            $errors['participants'] = 'Mindestens eine ausgewählte Person nimmt nicht (mehr) am Event teil. Bitte lade die Seite neu.';
        }
        if ($errors) {
            throw ApiError::validation($errors);
        }

        // Anteile in der Reihenfolge der Teilnehmendenliste berechnen (siehe Split::equal).
        $ordered = array_values(array_filter($participantIds, fn ($pid) => in_array($pid, $selected, true)));
        $shares = Split::equal($amount, $ordered, $paidBy);
        [$label, $icon] = self::CATEGORIES[$category];
        $actorName = $this->actorName($event, $actor);

        return $this->transaction($event, function () use (
            $event, $id, $version, $amount, $category, $icon, $description, $notes, $spentAt, $clientToken, $paidBy, $shares, $actor, $actorName
        ) {
            // Erneut innerhalb der Transaktion prüfen, falls parallel jemand entfernt wurde.
            $currentIds = array_column($this->participants($event['id']), 'id');
            if (!in_array($paidBy, $currentIds, true) || array_diff(array_keys($shares), $currentIds)) {
                throw ApiError::validation(['participants' => 'Die Teilnehmendenliste hat sich gerade geändert. Bitte prüfe deine Auswahl.']);
            }
            $now = Db::now();
            if ($id === null) {
                if ($clientToken !== null) {
                    $stmt = $this->db->prepare('SELECT id FROM fs_expenses WHERE event_id = ? AND client_token = ?');
                    $stmt->execute([$event['id'], $clientToken]);
                    $existing = $stmt->fetchColumn();
                    if ($existing !== false) {
                        return (string) $existing; // bereits gespeichert (z. B. doppelt abgeschickt)
                    }
                }
                $id = Db::id();
                $this->db->prepare(
                    'INSERT INTO fs_expenses (id, event_id, description, amount_cents, category, icon, paid_by_person_id, spent_at, notes,
                       client_token, version, created_by_person_id, updated_by_person_id, created_at, updated_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)'
                )->execute([$id, $event['id'], $description, $amount, $category, $icon, $paidBy, $spentAt, $notes, $clientToken, $actor, $actor, $now, $now]);
                $action = 'expense_created';
                $verb = 'hinzugefügt';
            } else {
                $stmt = $this->db->prepare(
                    'UPDATE fs_expenses SET description = ?, amount_cents = ?, category = ?, icon = ?, paid_by_person_id = ?, spent_at = ?,
                       notes = ?, updated_by_person_id = ?, updated_at = ?, version = version + 1
                     WHERE id = ? AND event_id = ? AND version = ?'
                );
                $stmt->execute([$description, $amount, $category, $icon, $paidBy, $spentAt, $notes, $actor, $now, $id, $event['id'], $version]);
                if ($stmt->rowCount() === 0) {
                    $this->throwExpenseConflict($event, $id, 'Diese Ausgabe wurde inzwischen von jemand anderem geändert. Deine Änderungen wurden nicht gespeichert.');
                }
                $this->db->prepare('DELETE FROM fs_expense_shares WHERE expense_id = ?')->execute([$id]);
                $action = 'expense_updated';
                $verb = 'geändert';
            }
            $insert = $this->db->prepare('INSERT INTO fs_expense_shares (expense_id, person_id, share_cents) VALUES (?, ?, ?)');
            foreach ($shares as $personId => $cents) {
                $insert->execute([$id, $personId, $cents]);
            }
            $this->log($event['id'], $actor, $action, sprintf('%s hat „%s“ (%s) %s', $actorName, $description, Split::formatEuro($amount), $verb));
            return $id;
        });
    }

    /** @param array<string,mixed> $in */
    public function deleteExpense(array $event, array $in, ?string $actor): void
    {
        $id = is_string($in['id'] ?? null) ? $in['id'] : '';
        $version = $in['version'] ?? null;
        if (!is_int($version)) {
            throw new ApiError(400, 'bad_request', 'Die Version der Ausgabe fehlt. Bitte lade die Seite neu.');
        }
        $this->transaction($event, function () use ($event, $id, $version, $actor) {
            $stmt = $this->db->prepare('SELECT description, amount_cents FROM fs_expenses WHERE id = ? AND event_id = ? AND version = ?');
            $stmt->execute([$id, $event['id'], $version]);
            $row = $stmt->fetch();
            if (!$row) {
                $this->throwExpenseConflict($event, $id, 'Diese Ausgabe wurde inzwischen geändert. Bitte prüfe sie erneut, bevor du sie löschst.');
            }
            $this->db->prepare('DELETE FROM fs_expenses WHERE id = ? AND event_id = ?')->execute([$id, $event['id']]);
            $this->log($event['id'], $actor, 'expense_deleted', sprintf(
                '%s hat „%s“ (%s) gelöscht',
                $this->actorName($event, $actor),
                $row['description'],
                Split::formatEuro((int) $row['amount_cents'])
            ));
        });
    }

    // ------------------------------------------------------------------ Ausgleichszahlungen

    /** @param array<string,mixed> $in */
    public function addSettlement(array $event, array $in, ?string $actor): void
    {
        $from = is_string($in['from'] ?? null) ? $in['from'] : '';
        $to = is_string($in['to'] ?? null) ? $in['to'] : '';
        $amount = $in['amount_cents'] ?? null;
        $fromName = $this->participantName($event['id'], $from);
        $toName = $this->participantName($event['id'], $to);
        if ($fromName === null || $toName === null || $from === $to) {
            throw new ApiError(422, 'validation', 'Zahlende und empfangende Person müssen verschiedene Teilnehmende sein.');
        }
        if (!is_int($amount) || $amount <= 0 || $amount > self::MAX_AMOUNT_CENTS) {
            throw new ApiError(422, 'validation', 'Der Betrag der Zahlung ist ungültig.');
        }
        $this->transaction($event, function () use ($event, $from, $to, $amount, $actor, $fromName, $toName) {
            $now = Db::now();
            $this->db->prepare(
                'INSERT INTO fs_settlements (id, event_id, from_person_id, to_person_id, amount_cents, status, paid_at, created_by_person_id, created_at)
                 VALUES (?, ?, ?, ?, ?, \'erledigt\', ?, ?, ?)'
            )->execute([Db::id(), $event['id'], $from, $to, $amount, $now, $actor, $now]);
            $this->log($event['id'], $actor, 'settlement_added', sprintf(
                '%s hat markiert: %s hat %s %s gezahlt',
                $this->actorName($event, $actor),
                $fromName,
                $toName,
                Split::formatEuro($amount)
            ));
        });
    }

    /** @param array<string,mixed> $in */
    public function deleteSettlement(array $event, array $in, ?string $actor): void
    {
        $id = is_string($in['id'] ?? null) ? $in['id'] : '';
        $this->transaction($event, function () use ($event, $id, $actor) {
            $stmt = $this->db->prepare('DELETE FROM fs_settlements WHERE id = ? AND event_id = ?');
            $stmt->execute([$id, $event['id']]);
            if ($stmt->rowCount() === 0) {
                throw new ApiError(404, 'settlement_not_found', 'Diese Zahlung wurde bereits zurückgenommen.');
            }
            $this->log($event['id'], $actor, 'settlement_deleted', sprintf('%s hat eine erledigte Zahlung zurückgenommen', $this->actorName($event, $actor)));
        });
    }

    // ------------------------------------------------------------------ Gesamtzustand

    /**
     * @param array<string,mixed>|null $user angemeldetes Konto (für „viewer“)
     * @return array<string,mixed>
     */
    public function state(array $event, ?array $user = null): array
    {
        $eventId = $event['id'];
        $participants = $this->participants($eventId);
        $order = array_column($participants, 'id');

        $stmt = $this->db->prepare('SELECT * FROM fs_expenses WHERE event_id = ? ORDER BY spent_at DESC, created_at DESC, id DESC');
        $stmt->execute([$eventId]);
        $expenseRows = $stmt->fetchAll();

        $stmt = $this->db->prepare(
            'SELECT s.expense_id, s.person_id, s.share_cents FROM fs_expense_shares s
             JOIN fs_expenses e ON e.id = s.expense_id WHERE e.event_id = ?'
        );
        $stmt->execute([$eventId]);
        $sharesByExpense = [];
        foreach ($stmt->fetchAll() as $row) {
            $sharesByExpense[$row['expense_id']][$row['person_id']] = (int) $row['share_cents'];
        }

        $rank = array_flip($order);
        $expenses = [];
        $forBalance = [];
        foreach ($expenseRows as $row) {
            $shares = $sharesByExpense[$row['id']] ?? [];
            uksort($shares, fn ($a, $b) => ($rank[$a] ?? PHP_INT_MAX) <=> ($rank[$b] ?? PHP_INT_MAX));
            $expenses[] = $this->formatExpense($row, $shares);
            $forBalance[] = ['paid_by' => $row['paid_by_person_id'], 'amount_cents' => (int) $row['amount_cents'], 'shares' => $shares];
        }

        $stmt = $this->db->prepare('SELECT * FROM fs_settlements WHERE event_id = ? ORDER BY created_at DESC');
        $stmt->execute([$eventId]);
        $settlements = array_map(fn ($r) => [
            'id' => $r['id'],
            'from' => $r['from_person_id'],
            'to' => $r['to_person_id'],
            'amount_cents' => (int) $r['amount_cents'],
            'status' => $r['status'],
            'paid_at' => $r['paid_at'] !== null ? $this->isoUtc($r['paid_at']) : null,
            'created_by' => $r['created_by_person_id'],
        ], $stmt->fetchAll());

        $balances = Split::balances($order, $forBalance, $settlements);
        $plan = Split::plan(array_map(fn ($b) => $b['balance'], $balances), $order);

        $stmt = $this->db->prepare('SELECT person_id, action, summary, created_at FROM fs_activity WHERE event_id = ? ORDER BY created_at DESC, id DESC LIMIT 50');
        $stmt->execute([$eventId]);
        $activity = array_map(fn ($r) => [
            'person_id' => $r['person_id'],
            'action' => $r['action'],
            'summary' => $r['summary'],
            'at' => $this->isoUtc($r['created_at']),
        ], $stmt->fetchAll());

        return [
            'event' => [
                'code' => $event['access_code'],
                'name' => $event['name'],
                'date' => $event['event_date'] !== null ? substr((string) $event['event_date'], 0, 10) : null,
                'location' => $event['location'],
                'notes' => $event['notes'],
                'created_by' => $event['created_by_person_id'],
                'created_at' => $this->isoUtc($event['created_at']),
                'updated_at' => $this->isoUtc($event['updated_at']),
            ],
            'participants' => array_map(fn ($p) => ['id' => $p['id'], 'name' => $p['name'], 'role' => $p['role'], 'linked' => $p['user_id'] !== null], $participants),
            'expenses' => $expenses,
            'settlements' => $settlements,
            'summary' => [
                'total_cents' => array_sum(array_column($forBalance, 'amount_cents')),
                'open_cents' => array_sum(array_map(fn ($b) => max(0, $b['balance']), $balances)),
                'people' => $balances,
                'plan' => $plan,
            ],
            'activity' => $activity,
            'viewer' => [
                'person_id' => $user !== null ? $this->linkedPerson($eventId, $user['id']) : null,
                'can_manage' => $this->canManage($event, $user),
                'has_owner' => ($event['owner_user_id'] ?? null) !== null,
            ],
        ];
    }

    // ------------------------------------------------------------------ Hilfsfunktionen

    /**
     * Führt $fn in einer Transaktion aus. Das Aktualisieren von updated_at sperrt die Event-Zeile
     * (MySQL) bzw. die Datenbank (SQLite), sodass Schreibvorgänge pro Event nacheinander ablaufen.
     */
    private function transaction(array $event, callable $fn): mixed
    {
        $this->db->beginTransaction();
        try {
            $this->db->prepare('UPDATE fs_events SET updated_at = ? WHERE id = ?')->execute([Db::now(), $event['id']]);
            $result = $fn();
            $this->db->commit();
            return $result;
        } catch (Throwable $e) {
            if ($this->db->inTransaction()) {
                $this->db->rollBack();
            }
            throw $e;
        }
    }

    private function throwExpenseConflict(array $event, string $id, string $message): never
    {
        $stmt = $this->db->prepare('SELECT * FROM fs_expenses WHERE id = ? AND event_id = ?');
        $stmt->execute([$id, $event['id']]);
        $row = $stmt->fetch();
        if (!$row) {
            throw new ApiError(404, 'expense_not_found', 'Diese Ausgabe wurde inzwischen gelöscht.');
        }
        $stmt = $this->db->prepare('SELECT person_id, share_cents FROM fs_expense_shares WHERE expense_id = ?');
        $stmt->execute([$id]);
        $shares = [];
        foreach ($stmt->fetchAll() as $s) {
            $shares[$s['person_id']] = (int) $s['share_cents'];
        }
        throw new ApiError(409, 'conflict', $message, [], ['expense' => $this->formatExpense($row, $shares)]);
    }

    /** @param array<string,int> $shares */
    private function formatExpense(array $row, array $shares): array
    {
        return [
            'id' => $row['id'],
            'description' => $row['description'],
            'amount_cents' => (int) $row['amount_cents'],
            'category' => $row['category'],
            'icon' => $row['icon'],
            'paid_by' => $row['paid_by_person_id'],
            'spent_at' => str_replace(' ', 'T', substr((string) $row['spent_at'], 0, 16)),
            'notes' => $row['notes'],
            'version' => (int) $row['version'],
            'created_by' => $row['created_by_person_id'],
            'updated_by' => $row['updated_by_person_id'],
            'created_at' => $this->isoUtc($row['created_at']),
            'updated_at' => $this->isoUtc($row['updated_at']),
            'shares' => array_map(fn ($pid, $cents) => ['person_id' => $pid, 'share_cents' => $cents], array_keys($shares), $shares),
        ];
    }

    /** @return array<int,array{id:string,name:string,role:string,position:int,user_id:?string}> */
    private function participants(string $eventId): array
    {
        $stmt = $this->db->prepare(
            'SELECT p.id, p.display_name AS name, ep.role, ep.position, ep.user_id
             FROM fs_event_participants ep JOIN fs_persons p ON p.id = ep.person_id
             WHERE ep.event_id = ? ORDER BY ep.position, ep.joined_at'
        );
        $stmt->execute([$eventId]);
        return array_map(fn ($r) => [
            'id' => $r['id'],
            'name' => $r['name'],
            'role' => $r['role'],
            'position' => (int) $r['position'],
            'user_id' => $r['user_id'],
        ], $stmt->fetchAll());
    }

    private function linkedPerson(string $eventId, string $userId): ?string
    {
        $stmt = $this->db->prepare('SELECT person_id FROM fs_event_participants WHERE event_id = ? AND user_id = ?');
        $stmt->execute([$eventId, $userId]);
        $id = $stmt->fetchColumn();
        return $id === false ? null : (string) $id;
    }

    private function requireManage(array $event, ?array $user): void
    {
        if (!$this->canManage($event, $user)) {
            throw new ApiError(403, 'forbidden', $user === null
                ? 'Bitte melde dich an. Nur wer das Event erstellt hat, oder ein Admin kann das.'
                : 'Das kann nur, wer das Event erstellt hat, oder ein Admin.');
        }
    }

    private function participantName(string $eventId, string $personId): ?string
    {
        $stmt = $this->db->prepare(
            'SELECT p.display_name FROM fs_event_participants ep JOIN fs_persons p ON p.id = ep.person_id
             WHERE ep.event_id = ? AND ep.person_id = ?'
        );
        $stmt->execute([$eventId, $personId]);
        $name = $stmt->fetchColumn();
        return $name === false ? null : (string) $name;
    }

    private function actorName(array $event, ?string $actor): string
    {
        return ($actor !== null ? $this->participantName($event['id'], $actor) : null) ?? 'Jemand';
    }

    /** @param array<int,array{id:string,name:string}> $participants */
    private function assertUniqueName(array $participants, string $name, ?string $exceptId): void
    {
        foreach ($participants as $p) {
            if ($p['id'] !== $exceptId && mb_strtolower($p['name']) === mb_strtolower($name)) {
                throw ApiError::validation(['name' => sprintf('Es gibt bereits eine Person namens %s in diesem Event.', $p['name'])]);
            }
        }
    }

    private function insertEventWithUniqueCode(string $id, string $name, ?string $date, ?string $location, ?string $notes, string $now): string
    {
        $code = $this->uniqueCode();
        $this->db->prepare(
            'INSERT INTO fs_events (id, access_code, name, event_date, location, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        )->execute([$id, $code, $name, $date, $location, $notes, $now, $now]);
        return $code;
    }

    private function uniqueCode(): string
    {
        $check = $this->db->prepare('SELECT 1 FROM fs_events WHERE access_code = ?');
        for ($attempt = 0; $attempt < 5; $attempt++) {
            $code = '';
            for ($i = 0; $i < self::CODE_LENGTH; $i++) {
                $code .= self::CODE_ALPHABET[random_int(0, strlen(self::CODE_ALPHABET) - 1)];
            }
            $check->execute([$code]);
            if ($check->fetchColumn() === false) {
                return $code;
            }
        }
        throw new RuntimeException('Konnte keinen eindeutigen Zugangscode erzeugen.');
    }

    private function insertParticipant(string $eventId, string $name, string $role, int $position, string $now, ?string $userId = null): string
    {
        $personId = Db::id();
        $this->db->prepare('INSERT INTO fs_persons (id, display_name, created_at) VALUES (?, ?, ?)')->execute([$personId, $name, $now]);
        $this->db->prepare('INSERT INTO fs_event_participants (event_id, person_id, role, position, joined_at, user_id) VALUES (?, ?, ?, ?, ?, ?)')
            ->execute([$eventId, $personId, $role, $position, $now, $userId]);
        return $personId;
    }

    private function log(string $eventId, ?string $personId, string $action, string $summary): void
    {
        // Zeitlich sortierbare ID (Mikrosekunden in Base36 + Zufall), damit der Verlauf auch
        // innerhalb derselben Sekunde in der richtigen Reihenfolge erscheint.
        $micro = str_pad(base_convert((string) (int) (microtime(true) * 1_000_000), 10, 36), 11, '0', STR_PAD_LEFT);
        $id = $micro . substr(Db::id(), 0, 5);
        $this->db->prepare('INSERT INTO fs_activity (id, event_id, person_id, action, summary, created_at) VALUES (?, ?, ?, ?, ?, ?)')
            ->execute([$id, $eventId, $personId, $action, mb_substr($summary, 0, 255), Db::now()]);
    }

    private function cleanText(string $value): string
    {
        // Steuerzeichen entfernen (Zeilenumbrüche bleiben erlaubt), Leerraum am Rand kürzen.
        return trim((string) preg_replace('/[\x00-\x09\x0B\x0C\x0E-\x1F\x7F]/u', '', $value));
    }

    /** @param array<string,string> $errors */
    private function text(array $in, string $key, int $max, bool $required, array &$errors, string $requiredMessage = ''): ?string
    {
        $value = $in[$key] ?? null;
        $value = is_string($value) ? $this->cleanText($value) : '';
        if ($value === '') {
            if ($required) {
                $errors[$key] = $requiredMessage;
            }
            return null;
        }
        if (mb_strlen($value) > $max) {
            $errors[$key] = "Höchstens $max Zeichen erlaubt.";
        }
        return $value;
    }

    /** @param array<string,string> $errors */
    private function date(array $in, string $key, array &$errors): ?string
    {
        $value = $in[$key] ?? null;
        if ($value === null || $value === '') {
            return null;
        }
        $parsed = is_string($value) ? DateTimeImmutable::createFromFormat('!Y-m-d', $value) : false;
        if ($parsed === false || $parsed->format('Y-m-d') !== $value) {
            $errors[$key] = 'Bitte gib ein gültiges Datum an.';
            return null;
        }
        return $value;
    }

    /** @param array<string,string> $errors */
    private function dateTime(array $in, string $key, array &$errors): string
    {
        $value = is_string($in[$key] ?? null) ? str_replace(' ', 'T', substr($in[$key], 0, 16)) : '';
        $parsed = DateTimeImmutable::createFromFormat('!Y-m-d\TH:i', $value);
        if ($parsed === false || $parsed->format('Y-m-d\TH:i') !== $value) {
            $errors[$key] = 'Bitte gib ein gültiges Datum mit Uhrzeit an.';
            return '1970-01-01 00:00:00';
        }
        return $parsed->format('Y-m-d H:i:00');
    }

    private function isoUtc(string $dbValue): string
    {
        return str_replace(' ', 'T', substr($dbValue, 0, 19)) . 'Z';
    }
}
