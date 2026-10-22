// Geschäftslogik für Events. Jeder Zugriff ist auf genau ein Event beschränkt, das über seinen
// geheimen Zugangscode ermittelt wurde. Angemeldete Konten sind über
// fs_event_participants.user_id mit „ihrer“ Person im Event verknüpft.

import { randomInt } from 'node:crypto';
import { ApiError } from './errors.js';
import { newId, now, isoUtc, sortableId } from './db.js';
import * as Split from './split.js';

/** Kategorie-Schlüssel → [Bezeichnung, Symbol] */
export const CATEGORIES = {
  getraenke: ['Getränke', '🍹'],
  essen: ['Essen', '🍕'],
  tickets: ['Tickets', '🎟️'],
  transport: ['Transport', '🚕'],
  unterkunft: ['Unterkunft', '🏨'],
  sonstiges: ['Sonstiges', '🛍️'],
};

/** Ohne leicht verwechselbare Zeichen (0/O, 1/I). 12 Zeichen ≈ 60 Bit Zufall. */
export const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const CODE_LENGTH = 12;
const MAX_AMOUNT_CENTS = 10_000_000; // 100.000,00 €
const MAX_PARTICIPANTS = 50;

/** Zufälliger Code aus CODE_ALPHABET (auch für Einladungen und Reset-Links). */
export function randomCode() {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return code;
}

/** "k7q2-mx9p-4htr" → "K7Q2MX9P4HTR"; ungültig → null */
export function normalizeCode(raw) {
  if (typeof raw !== 'string') return null;
  const code = raw.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  if (code.length !== CODE_LENGTH || [...code].some((c) => !CODE_ALPHABET.includes(c))) return null;
  return code;
}

const str = (value) => (typeof value === 'string' ? value : '');
const length = (value) => [...value].length;

export class Store {
  /** @param {import('./db.js').Database} db */
  constructor(db) {
    this.db = db;
  }

  // ------------------------------------------------------------------ Events

  /**
   * @param {object} input
   * @param {object|null} user angemeldetes Konto: wird Owner und mit der eigenen Person verknüpft
   */
  createEvent(input, user = null) {
    const errors = {};
    const name = this.text(input, 'name', 120, true, errors, 'Bitte gib einen Eventnamen ein.');
    const date = this.date(input, 'date', errors);
    const location = this.text(input, 'location', 120, false, errors);
    const notes = this.text(input, 'notes', 1000, false, errors);
    const creator = this.text(input, 'creator_name', 60, true, errors, 'Bitte gib deinen Namen ein.');

    const names = creator !== null ? [creator] : [];
    for (const raw of Array.isArray(input.participants) ? input.participants : []) {
      const clean = typeof raw === 'string' ? cleanText(raw) : '';
      if (clean === '') continue;
      if (length(clean) > 60) {
        errors.participants = 'Namen dürfen höchstens 60 Zeichen lang sein.';
        break;
      }
      names.push(clean);
    }
    const lower = names.map((n) => n.toLowerCase());
    if (new Set(lower).size !== lower.length) errors.participants = 'Jeder Name darf nur einmal vorkommen.';
    if (names.length > MAX_PARTICIPANTS) errors.participants = `Ein Event kann höchstens ${MAX_PARTICIPANTS} Teilnehmende haben.`;
    if (Object.keys(errors).length) throw ApiError.validation(errors);

    return this.db.transaction(() => {
      const timestamp = now();
      const eventId = newId();
      const code = this.uniqueCode();
      this.db.run(
        'INSERT INTO fs_events (id, access_code, name, event_date, location, notes, created_at, updated_at, owner_user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        eventId, code, name, date, location, notes, timestamp, timestamp, user?.id ?? null,
      );
      let creatorId = null;
      names.forEach((personName, position) => {
        const isCreator = position === 0;
        const personId = this.insertParticipant(eventId, personName, isCreator ? 'organizer' : 'member', position, timestamp, isCreator ? user?.id ?? null : null);
        creatorId ??= personId;
      });
      this.db.run('UPDATE fs_events SET created_by_person_id = ? WHERE id = ?', creatorId, eventId);
      this.log(eventId, creatorId, 'event_created', `${creator} hat das Event „${name}“ erstellt`);
      return { code, person_id: creatorId };
    });
  }

  requireEvent(rawCode) {
    const code = normalizeCode(rawCode);
    const event = code !== null ? this.db.get('SELECT * FROM fs_events WHERE access_code = ?', code) : null;
    if (!event) throw new ApiError(404, 'event_not_found', 'Zu diesem Code wurde kein Event gefunden. Bitte prüfe den Link oder Code.');
    return event;
  }

  requireEventById(id) {
    const event = this.db.get('SELECT * FROM fs_events WHERE id = ?', id);
    if (!event) throw new ApiError(404, 'event_not_found', 'Dieses Event gibt es nicht mehr.');
    return event;
  }

  /**
   * Wer handelt? Angemeldet: die mit dem Konto verknüpfte Person. Ohne Anmeldung: die gewählte
   * Person (X-Person-Id), aber nur, wenn sie zum Event gehört und mit keinem Konto verknüpft ist.
   */
  actor(event, user, personId) {
    if (user) return this.linkedPerson(event.id, user.id);
    if (!personId) return null;
    const row = this.db.get('SELECT user_id FROM fs_event_participants WHERE event_id = ? AND person_id = ?', event.id, personId);
    return row && row.user_id === null ? personId : null;
  }

  /** Owner des Events oder Admin. */
  canManage(event, user) {
    return !!user && (user.role === 'admin' || event.owner_user_id === user.id);
  }

  updateEvent(event, input, actor) {
    const errors = {};
    const name = this.text(input, 'name', 120, true, errors, 'Bitte gib einen Eventnamen ein.');
    const date = this.date(input, 'date', errors);
    const location = this.text(input, 'location', 120, false, errors);
    const notes = this.text(input, 'notes', 1000, false, errors);
    if (Object.keys(errors).length) throw ApiError.validation(errors);
    this.transaction(event, () => {
      this.db.run('UPDATE fs_events SET name = ?, event_date = ?, location = ?, notes = ? WHERE id = ?', name, date, location, notes, event.id);
      this.log(event.id, actor, 'event_updated', `${this.actorName(event, actor)} hat die Eventdaten geändert`);
    });
  }

  // ------------------------------------------------------------------ Konten und Events

  /** „Meine Events“ eines Kontos: alle Events, in denen das Konto mit einer Person verknüpft ist. */
  myEvents(userId) {
    return this.db.all(
      `SELECT e.access_code, e.name, e.event_date, e.location, e.updated_at, e.owner_user_id, p.display_name AS person_name,
         (SELECT COUNT(*) FROM fs_event_participants c WHERE c.event_id = e.id) AS participants
       FROM fs_event_participants ep
       JOIN fs_events e ON e.id = ep.event_id
       JOIN fs_persons p ON p.id = ep.person_id
       WHERE ep.user_id = ?
       ORDER BY e.updated_at DESC`,
      userId,
    ).map((r) => ({
      code: r.access_code,
      name: r.name,
      date: r.event_date !== null ? r.event_date.slice(0, 10) : null,
      location: r.location,
      updated_at: isoUtc(r.updated_at),
      person_name: r.person_name,
      participants: r.participants,
      is_owner: r.owner_user_id === userId,
    }));
  }

  /** Alle Events für den Admin-Bereich. */
  allEvents() {
    return this.db.all(
      `SELECT e.access_code, e.name, e.event_date, e.updated_at, u.display_name AS owner,
         (SELECT COUNT(*) FROM fs_event_participants c WHERE c.event_id = e.id) AS participants,
         (SELECT COUNT(*) FROM fs_event_participants c WHERE c.event_id = e.id AND c.user_id IS NOT NULL) AS linked,
         (SELECT COALESCE(SUM(x.amount_cents), 0) FROM fs_expenses x WHERE x.event_id = e.id) AS total_cents
       FROM fs_events e LEFT JOIN fs_users u ON u.id = e.owner_user_id
       ORDER BY e.updated_at DESC LIMIT 500`,
    ).map((r) => ({
      code: r.access_code,
      name: r.name,
      date: r.event_date !== null ? r.event_date.slice(0, 10) : null,
      owner: r.owner,
      participants: r.participants,
      linked: r.linked,
      total_cents: r.total_cents,
      updated_at: isoUtc(r.updated_at),
    }));
  }

  /**
   * Übernimmt Events, die auf einem Gerät ohne Anmeldung genutzt wurden, ins Konto.
   * Erwartet [{code, person_id}]; verknüpft die Person nur, wenn sie noch frei ist.
   */
  importLocal(input, user) {
    const items = Array.isArray(input.items) ? input.items.slice(0, 50) : [];
    let imported = 0;
    for (const item of items) {
      const code = normalizeCode(item?.code);
      const personId = typeof item?.person_id === 'string' ? item.person_id : null;
      if (code === null || personId === null) continue;
      const event = this.db.get('SELECT * FROM fs_events WHERE access_code = ?', code);
      if (!event || this.linkedPerson(event.id, user.id) !== null) continue;
      try {
        this.joinEvent(event, { person_id: personId }, user);
        imported++;
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        // Person gehört inzwischen jemand anderem oder wurde entfernt – überspringen.
      }
    }
    return { imported };
  }

  /**
   * Konto mit einer Person im Event verknüpfen: vorhandene freie Person ({person_id}) oder neue
   * Person ({name}). Eine bestehende Verknüpfung im selben Event wird dabei umgehängt.
   */
  joinEvent(event, input, user) {
    const personId = typeof input.person_id === 'string' ? input.person_id : null;
    const errors = {};
    const name = personId === null ? this.text(input, 'name', 60, true, errors, 'Bitte gib deinen Namen ein.') : null;
    if (Object.keys(errors).length) throw ApiError.validation(errors);

    return this.transaction(event, () => {
      if (personId === null) {
        const participants = this.participants(event.id);
        if (participants.length >= MAX_PARTICIPANTS) {
          throw ApiError.validation({ name: `Ein Event kann höchstens ${MAX_PARTICIPANTS} Teilnehmende haben.` });
        }
        this.assertUniqueName(participants, name, null);
        this.db.run('UPDATE fs_event_participants SET user_id = NULL WHERE event_id = ? AND user_id = ?', event.id, user.id);
        const position = participants.length ? Math.max(...participants.map((p) => p.position)) + 1 : 0;
        const newPersonId = this.insertParticipant(event.id, name, 'member', position, now(), user.id);
        this.log(event.id, newPersonId, 'participant_joined', `${name} ist dem Event beigetreten`);
        return newPersonId;
      }

      const row = this.db.get(
        `SELECT ep.user_id, ep.role, p.display_name FROM fs_event_participants ep JOIN fs_persons p ON p.id = ep.person_id
         WHERE ep.event_id = ? AND ep.person_id = ?`,
        event.id, personId,
      );
      if (!row) throw new ApiError(404, 'person_not_found', 'Diese Person nimmt nicht (mehr) am Event teil.');
      if (row.user_id === user.id) return personId;
      if (row.user_id !== null) throw new ApiError(409, 'person_taken', `${row.display_name} ist bereits mit einem anderen Konto verknüpft.`);
      this.db.run('UPDATE fs_event_participants SET user_id = NULL WHERE event_id = ? AND user_id = ?', event.id, user.id);
      this.db.run('UPDATE fs_event_participants SET user_id = ? WHERE event_id = ? AND person_id = ?', user.id, event.id, personId);
      // Wer die Organisator-Person eines Events ohne Owner übernimmt, wird Owner.
      if (row.role === 'organizer') {
        this.db.run('UPDATE fs_events SET owner_user_id = ? WHERE id = ? AND owner_user_id IS NULL', user.id, event.id);
      }
      this.log(event.id, personId, 'participant_linked', `${row.display_name} ist jetzt mit einem Konto angemeldet`);
      return personId;
    });
  }

  /** Eigene Verknüpfung lösen: Das Event verschwindet aus „Meine Events“, die Person bleibt. */
  leaveEvent(event, user) {
    this.transaction(event, () => {
      this.db.run('UPDATE fs_event_participants SET user_id = NULL WHERE event_id = ? AND user_id = ?', event.id, user.id);
    });
  }

  /** Owner/Admin: Konto-Verknüpfung einer Person lösen (z. B. falsch gewählter Name). */
  unlinkParticipant(event, input, user, actor) {
    this.requireManage(event, user);
    const personId = str(input.person_id);
    this.transaction(event, () => {
      const name = this.participantName(event.id, personId);
      if (name === null) throw new ApiError(404, 'person_not_found', 'Diese Person nimmt nicht (mehr) am Event teil.');
      this.db.run('UPDATE fs_event_participants SET user_id = NULL WHERE event_id = ? AND person_id = ?', event.id, personId);
      this.log(event.id, actor, 'participant_unlinked', `${this.actorName(event, actor)} hat die Konto-Verknüpfung von ${name} gelöst`);
    });
  }

  /**
   * Owner/Admin: neuen Zugangscode erzeugen. Der alte Link funktioniert danach nicht mehr;
   * wer mit Konto beigetreten ist, behält den Zugang über „Meine Events“.
   */
  regenerateCode(event, user, actor) {
    this.requireManage(event, user);
    return this.transaction(event, () => {
      const code = this.uniqueCode();
      this.db.run('UPDATE fs_events SET access_code = ? WHERE id = ?', code, event.id);
      this.log(event.id, actor, 'code_regenerated', `${this.actorName(event, actor)} hat einen neuen Zugangscode erzeugt`);
      return code;
    });
  }

  /** Owner/Admin: Event mit allen Ausgaben, Zahlungen und dem Verlauf endgültig löschen. */
  deleteEvent(event, user) {
    this.requireManage(event, user);
    this.db.transaction(() => {
      const personIds = this.db.all('SELECT person_id FROM fs_event_participants WHERE event_id = ?', event.id).map((r) => r.person_id);
      // Anteile verweisen auf Personen; sie werden über die Ausgaben mitgelöscht.
      this.db.run('DELETE FROM fs_expenses WHERE event_id = ?', event.id);
      this.db.run('DELETE FROM fs_settlements WHERE event_id = ?', event.id);
      this.db.run('DELETE FROM fs_events WHERE id = ?', event.id);
      for (const personId of personIds) {
        this.db.run('DELETE FROM fs_persons WHERE id = ? AND NOT EXISTS (SELECT 1 FROM fs_event_participants WHERE person_id = ?)', personId, personId);
      }
    });
  }

  // ------------------------------------------------------------------ Teilnehmende

  addParticipant(event, input, actor) {
    const errors = {};
    const name = this.text(input, 'name', 60, true, errors, 'Bitte gib einen Namen ein.');
    if (Object.keys(errors).length) throw ApiError.validation(errors);
    return this.transaction(event, () => {
      const participants = this.participants(event.id);
      if (participants.length >= MAX_PARTICIPANTS) {
        throw ApiError.validation({ name: `Ein Event kann höchstens ${MAX_PARTICIPANTS} Teilnehmende haben.` });
      }
      this.assertUniqueName(participants, name, null);
      const position = participants.length ? Math.max(...participants.map((p) => p.position)) + 1 : 0;
      const personId = this.insertParticipant(event.id, name, 'member', position, now());
      this.log(event.id, actor ?? personId, 'participant_added', actor !== null
        ? `${this.actorName(event, actor)} hat ${name} hinzugefügt`
        : `${name} ist dem Event beigetreten`);
      return personId;
    });
  }

  renameParticipant(event, input, actor) {
    const errors = {};
    const personId = str(input.person_id);
    const name = this.text(input, 'name', 60, true, errors, 'Bitte gib einen Namen ein.');
    if (Object.keys(errors).length) throw ApiError.validation(errors);
    this.transaction(event, () => {
      const old = this.participantName(event.id, personId);
      if (old === null) throw new ApiError(404, 'person_not_found', 'Diese Person nimmt nicht (mehr) am Event teil.');
      this.assertUniqueName(this.participants(event.id), name, personId);
      this.db.run('UPDATE fs_persons SET display_name = ? WHERE id = ?', name, personId);
      this.log(event.id, actor, 'participant_renamed', `${this.actorName(event, actor)} hat ${old} in ${name} umbenannt`);
    });
  }

  removeParticipant(event, input, actor) {
    const personId = str(input.person_id);
    this.transaction(event, () => {
      const name = this.participantName(event.id, personId);
      if (name === null) throw new ApiError(404, 'person_not_found', 'Diese Person nimmt nicht (mehr) am Event teil.');
      const used = this.db.value(
        `SELECT
           (SELECT COUNT(*) FROM fs_expenses WHERE event_id = ? AND paid_by_person_id = ?)
         + (SELECT COUNT(*) FROM fs_expense_shares s JOIN fs_expenses x ON x.id = s.expense_id WHERE x.event_id = ? AND s.person_id = ?)
         + (SELECT COUNT(*) FROM fs_settlements WHERE event_id = ? AND (from_person_id = ? OR to_person_id = ?))`,
        event.id, personId, event.id, personId, event.id, personId, personId,
      );
      if (used > 0) {
        throw new ApiError(409, 'person_in_use', `${name} hat bezahlt oder ist an Ausgaben bzw. Ausgleichszahlungen beteiligt und kann deshalb nicht entfernt werden. Entferne ${name} zuerst aus diesen Einträgen.`);
      }
      // Namen vor dem Löschen ermitteln, falls jemand sich selbst entfernt.
      const actorName = actor === personId ? name : this.actorName(event, actor);
      this.db.run('DELETE FROM fs_event_participants WHERE event_id = ? AND person_id = ?', event.id, personId);
      this.db.run('DELETE FROM fs_persons WHERE id = ? AND NOT EXISTS (SELECT 1 FROM fs_event_participants WHERE person_id = ?)', personId, personId);
      this.log(event.id, actor === personId ? null : actor, 'participant_removed', `${actorName} hat ${name} entfernt`);
    });
  }

  // ------------------------------------------------------------------ Ausgaben

  /** Legt eine Ausgabe an (ohne id) oder ändert sie (mit id und version). */
  saveExpense(event, input, actor) {
    const errors = {};
    const id = typeof input.id === 'string' && input.id !== '' ? input.id : null;
    const version = input.version ?? null;
    if (id !== null && (!Number.isInteger(version) || version < 1)) {
      throw new ApiError(400, 'bad_request', 'Die Version der Ausgabe fehlt. Bitte lade die Seite neu.');
    }

    let amount = input.amount_cents ?? null;
    if (typeof amount === 'string' && /^\d+$/.test(amount)) amount = Number(amount);
    if (!Number.isInteger(amount) || amount <= 0) errors.amount = 'Bitte gib einen Betrag größer als 0,00 € ein.';
    else if (amount > MAX_AMOUNT_CENTS) errors.amount = `Der Betrag darf höchstens ${Split.formatEuro(MAX_AMOUNT_CENTS)} betragen.`;

    let category = str(input.category);
    if (!Object.hasOwn(CATEGORIES, category)) {
      errors.category = 'Bitte wähle eine Kategorie.';
      category = 'sonstiges';
    }
    const description = this.text(input, 'description', 140, false, errors) ?? CATEGORIES[category][0];
    const notes = this.text(input, 'notes', 500, false, errors);
    const spentAt = this.dateTime(input, 'spent_at', errors);

    let clientToken = typeof input.client_token === 'string' ? input.client_token : null;
    if (clientToken !== null && !/^[A-Za-z0-9-]{8,64}$/.test(clientToken)) clientToken = null;

    const participantIds = this.participants(event.id).map((p) => p.id);
    const paidBy = str(input.paid_by);
    if (!participantIds.includes(paidBy)) errors.paid_by = 'Bitte wähle aus, wer bezahlt hat. Die Person muss am Event teilnehmen.';
    const selected = Array.isArray(input.participants) ? [...new Set(input.participants.filter((p) => typeof p === 'string'))] : [];
    if (selected.length === 0) errors.participants = 'Bitte wähle mindestens eine beteiligte Person aus.';
    else if (selected.some((p) => !participantIds.includes(p))) errors.participants = 'Mindestens eine ausgewählte Person nimmt nicht (mehr) am Event teil. Bitte lade die Seite neu.';
    if (Object.keys(errors).length) throw ApiError.validation(errors);

    // Anteile in der Reihenfolge der Teilnehmendenliste berechnen (siehe Split.equal).
    const ordered = participantIds.filter((pid) => selected.includes(pid));
    const shares = Split.equal(amount, ordered, paidBy);
    const icon = CATEGORIES[category][1];
    const actorName = this.actorName(event, actor);

    return this.transaction(event, () => {
      const timestamp = now();
      let expenseId = id;
      let action;
      let verb;
      if (expenseId === null) {
        if (clientToken !== null) {
          const existing = this.db.value('SELECT id FROM fs_expenses WHERE event_id = ? AND client_token = ?', event.id, clientToken);
          if (existing !== null) return existing; // bereits gespeichert (z. B. doppelt abgeschickt)
        }
        expenseId = newId();
        this.db.run(
          `INSERT INTO fs_expenses (id, event_id, description, amount_cents, category, icon, paid_by_person_id, spent_at, notes,
             client_token, version, created_by_person_id, updated_by_person_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
          expenseId, event.id, description, amount, category, icon, paidBy, spentAt, notes, clientToken, actor, actor, timestamp, timestamp,
        );
        action = 'expense_created';
        verb = 'hinzugefügt';
      } else {
        const result = this.db.run(
          `UPDATE fs_expenses SET description = ?, amount_cents = ?, category = ?, icon = ?, paid_by_person_id = ?, spent_at = ?,
             notes = ?, updated_by_person_id = ?, updated_at = ?, version = version + 1
           WHERE id = ? AND event_id = ? AND version = ?`,
          description, amount, category, icon, paidBy, spentAt, notes, actor, timestamp, expenseId, event.id, version,
        );
        if (result.changes === 0) {
          this.throwExpenseConflict(event, expenseId, 'Diese Ausgabe wurde inzwischen von jemand anderem geändert. Deine Änderungen wurden nicht gespeichert.');
        }
        this.db.run('DELETE FROM fs_expense_shares WHERE expense_id = ?', expenseId);
        action = 'expense_updated';
        verb = 'geändert';
      }
      for (const [personId, cents] of Object.entries(shares)) {
        this.db.run('INSERT INTO fs_expense_shares (expense_id, person_id, share_cents) VALUES (?, ?, ?)', expenseId, personId, cents);
      }
      this.log(event.id, actor, action, `${actorName} hat „${description}“ (${Split.formatEuro(amount)}) ${verb}`);
      return expenseId;
    });
  }

  deleteExpense(event, input, actor) {
    const id = str(input.id);
    if (!Number.isInteger(input.version)) throw new ApiError(400, 'bad_request', 'Die Version der Ausgabe fehlt. Bitte lade die Seite neu.');
    this.transaction(event, () => {
      const row = this.db.get('SELECT description, amount_cents FROM fs_expenses WHERE id = ? AND event_id = ? AND version = ?', id, event.id, input.version);
      if (!row) this.throwExpenseConflict(event, id, 'Diese Ausgabe wurde inzwischen geändert. Bitte prüfe sie erneut, bevor du sie löschst.');
      this.db.run('DELETE FROM fs_expenses WHERE id = ? AND event_id = ?', id, event.id);
      this.log(event.id, actor, 'expense_deleted', `${this.actorName(event, actor)} hat „${row.description}“ (${Split.formatEuro(row.amount_cents)}) gelöscht`);
    });
  }

  // ------------------------------------------------------------------ Ausgleichszahlungen

  addSettlement(event, input, actor) {
    const from = str(input.from);
    const to = str(input.to);
    const amount = input.amount_cents;
    const fromName = this.participantName(event.id, from);
    const toName = this.participantName(event.id, to);
    if (fromName === null || toName === null || from === to) {
      throw new ApiError(422, 'validation', 'Zahlende und empfangende Person müssen verschiedene Teilnehmende sein.');
    }
    if (!Number.isInteger(amount) || amount <= 0 || amount > MAX_AMOUNT_CENTS) {
      throw new ApiError(422, 'validation', 'Der Betrag der Zahlung ist ungültig.');
    }
    this.transaction(event, () => {
      const timestamp = now();
      this.db.run(
        `INSERT INTO fs_settlements (id, event_id, from_person_id, to_person_id, amount_cents, status, paid_at, created_by_person_id, created_at)
         VALUES (?, ?, ?, ?, ?, 'erledigt', ?, ?, ?)`,
        newId(), event.id, from, to, amount, timestamp, actor, timestamp,
      );
      this.log(event.id, actor, 'settlement_added', `${this.actorName(event, actor)} hat markiert: ${fromName} hat ${toName} ${Split.formatEuro(amount)} gezahlt`);
    });
  }

  deleteSettlement(event, input, actor) {
    const id = str(input.id);
    this.transaction(event, () => {
      const result = this.db.run('DELETE FROM fs_settlements WHERE id = ? AND event_id = ?', id, event.id);
      if (result.changes === 0) throw new ApiError(404, 'settlement_not_found', 'Diese Zahlung wurde bereits zurückgenommen.');
      this.log(event.id, actor, 'settlement_deleted', `${this.actorName(event, actor)} hat eine erledigte Zahlung zurückgenommen`);
    });
  }

  // ------------------------------------------------------------------ Gesamtzustand

  /** @param {object|null} user angemeldetes Konto (für „viewer“) */
  state(event, user = null) {
    const participants = this.participants(event.id);
    const order = participants.map((p) => p.id);
    const rank = new Map(order.map((id, i) => [id, i]));
    const rankOf = (id) => rank.get(id) ?? Number.MAX_SAFE_INTEGER;

    const expenseRows = this.db.all('SELECT * FROM fs_expenses WHERE event_id = ? ORDER BY spent_at DESC, created_at DESC, id DESC', event.id);
    const sharesByExpense = new Map();
    for (const row of this.db.all(
      'SELECT s.expense_id, s.person_id, s.share_cents FROM fs_expense_shares s JOIN fs_expenses e ON e.id = s.expense_id WHERE e.event_id = ?',
      event.id,
    )) {
      if (!sharesByExpense.has(row.expense_id)) sharesByExpense.set(row.expense_id, {});
      sharesByExpense.get(row.expense_id)[row.person_id] = row.share_cents;
    }

    const expenses = [];
    const forBalance = [];
    for (const row of expenseRows) {
      const raw = sharesByExpense.get(row.id) ?? {};
      const shares = Object.fromEntries(Object.entries(raw).sort(([a], [b]) => rankOf(a) - rankOf(b)));
      expenses.push(formatExpense(row, shares));
      forBalance.push({ paid_by: row.paid_by_person_id, amount_cents: row.amount_cents, shares });
    }

    const settlements = this.db.all('SELECT * FROM fs_settlements WHERE event_id = ? ORDER BY created_at DESC', event.id).map((r) => ({
      id: r.id,
      from: r.from_person_id,
      to: r.to_person_id,
      amount_cents: r.amount_cents,
      status: r.status,
      paid_at: r.paid_at !== null ? isoUtc(r.paid_at) : null,
      created_by: r.created_by_person_id,
    }));

    const people = Split.balances(order, forBalance, settlements);
    const plan = Split.plan(Object.fromEntries(Object.entries(people).map(([id, b]) => [id, b.balance])), order);

    const activity = this.db.all(
      'SELECT person_id, action, summary, created_at FROM fs_activity WHERE event_id = ? ORDER BY created_at DESC, id DESC LIMIT 50',
      event.id,
    ).map((r) => ({ person_id: r.person_id, action: r.action, summary: r.summary, at: isoUtc(r.created_at) }));

    return {
      event: {
        code: event.access_code,
        name: event.name,
        date: event.event_date !== null ? event.event_date.slice(0, 10) : null,
        location: event.location,
        notes: event.notes,
        created_by: event.created_by_person_id,
        created_at: isoUtc(event.created_at),
        updated_at: isoUtc(event.updated_at),
      },
      participants: participants.map((p) => ({ id: p.id, name: p.name, role: p.role, linked: p.user_id !== null })),
      expenses,
      settlements,
      summary: {
        total_cents: forBalance.reduce((sum, e) => sum + e.amount_cents, 0),
        open_cents: Object.values(people).reduce((sum, b) => sum + Math.max(0, b.balance), 0),
        people,
        plan,
      },
      activity,
      viewer: {
        person_id: user ? this.linkedPerson(event.id, user.id) : null,
        can_manage: this.canManage(event, user),
        has_owner: event.owner_user_id !== null,
      },
    };
  }

  // ------------------------------------------------------------------ Hilfsfunktionen

  /**
   * Führt fn in einer Transaktion aus und aktualisiert dabei updated_at des Events
   * („zuletzt geändert“ in den Listen).
   */
  transaction(event, fn) {
    return this.db.transaction(() => {
      this.db.run('UPDATE fs_events SET updated_at = ? WHERE id = ?', now(), event.id);
      return fn();
    });
  }

  throwExpenseConflict(event, id, message) {
    const row = this.db.get('SELECT * FROM fs_expenses WHERE id = ? AND event_id = ?', id, event.id);
    if (!row) throw new ApiError(404, 'expense_not_found', 'Diese Ausgabe wurde inzwischen gelöscht.');
    const shares = Object.fromEntries(this.db.all('SELECT person_id, share_cents FROM fs_expense_shares WHERE expense_id = ?', id).map((s) => [s.person_id, s.share_cents]));
    throw new ApiError(409, 'conflict', message, { data: { expense: formatExpense(row, shares) } });
  }

  participants(eventId) {
    return this.db.all(
      `SELECT p.id, p.display_name AS name, ep.role, ep.position, ep.user_id
       FROM fs_event_participants ep JOIN fs_persons p ON p.id = ep.person_id
       WHERE ep.event_id = ? ORDER BY ep.position, ep.joined_at`,
      eventId,
    );
  }

  participantName(eventId, personId) {
    return this.db.value(
      'SELECT p.display_name FROM fs_event_participants ep JOIN fs_persons p ON p.id = ep.person_id WHERE ep.event_id = ? AND ep.person_id = ?',
      eventId, personId,
    );
  }

  linkedPerson(eventId, userId) {
    return this.db.value('SELECT person_id FROM fs_event_participants WHERE event_id = ? AND user_id = ?', eventId, userId);
  }

  requireManage(event, user) {
    if (!this.canManage(event, user)) {
      throw new ApiError(403, 'forbidden', user
        ? 'Das kann nur, wer das Event erstellt hat, oder ein Admin.'
        : 'Bitte melde dich an. Nur wer das Event erstellt hat, oder ein Admin kann das.');
    }
  }

  actorName(event, actor) {
    return (actor !== null ? this.participantName(event.id, actor) : null) ?? 'Jemand';
  }

  assertUniqueName(participants, name, exceptId) {
    const clash = participants.find((p) => p.id !== exceptId && p.name.toLowerCase() === name.toLowerCase());
    if (clash) throw ApiError.validation({ name: `Es gibt bereits eine Person namens ${clash.name} in diesem Event.` });
  }

  uniqueCode() {
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = randomCode();
      if (this.db.get('SELECT 1 FROM fs_events WHERE access_code = ?', code) === null) return code;
    }
    throw new Error('Konnte keinen eindeutigen Zugangscode erzeugen.');
  }

  insertParticipant(eventId, name, role, position, timestamp, userId = null) {
    const personId = newId();
    this.db.run('INSERT INTO fs_persons (id, display_name, created_at) VALUES (?, ?, ?)', personId, name, timestamp);
    this.db.run(
      'INSERT INTO fs_event_participants (event_id, person_id, role, position, joined_at, user_id) VALUES (?, ?, ?, ?, ?, ?)',
      eventId, personId, role, position, timestamp, userId,
    );
    return personId;
  }

  log(eventId, personId, action, summary) {
    this.db.run(
      'INSERT INTO fs_activity (id, event_id, person_id, action, summary, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      sortableId(), eventId, personId, action, [...summary].slice(0, 255).join(''), now(),
    );
  }

  /** Text aus der Eingabe: bereinigt, Pflichtfeld- und Längenprüfung. Leer → null. */
  text(input, key, max, required, errors, requiredMessage = '') {
    const value = typeof input[key] === 'string' ? cleanText(input[key]) : '';
    if (value === '') {
      if (required) errors[key] = requiredMessage;
      return null;
    }
    if (length(value) > max) errors[key] = `Höchstens ${max} Zeichen erlaubt.`;
    return value;
  }

  /** 'YYYY-MM-DD' oder leer → null */
  date(input, key, errors) {
    const value = input[key];
    if (value === undefined || value === null || value === '') return null;
    if (typeof value !== 'string' || !isValidDate(value)) {
      errors[key] = 'Bitte gib ein gültiges Datum an.';
      return null;
    }
    return value;
  }

  /** 'YYYY-MM-DDTHH:MM' → 'YYYY-MM-DD HH:MM:00' */
  dateTime(input, key, errors) {
    const value = typeof input[key] === 'string' ? input[key].slice(0, 16).replace(' ', 'T') : '';
    const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/.exec(value);
    if (!match || !isValidDate(match[1]) || Number(match[2]) > 23 || Number(match[3]) > 59) {
      errors[key] = 'Bitte gib ein gültiges Datum mit Uhrzeit an.';
      return '1970-01-01 00:00:00';
    }
    return `${match[1]} ${match[2]}:${match[3]}:00`;
  }
}

/** Steuerzeichen entfernen (Zeilenumbrüche bleiben erlaubt), Leerraum am Rand kürzen. */
export function cleanText(value) {
  return value.replace(/[\x00-\x09\x0B\x0C\x0E-\x1F\x7F]/g, '').trim();
}

function isValidDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function formatExpense(row, shares) {
  return {
    id: row.id,
    description: row.description,
    amount_cents: row.amount_cents,
    category: row.category,
    icon: row.icon,
    paid_by: row.paid_by_person_id,
    spent_at: row.spent_at.slice(0, 16).replace(' ', 'T'),
    notes: row.notes,
    version: row.version,
    created_by: row.created_by_person_id,
    updated_by: row.updated_by_person_id,
    created_at: isoUtc(row.created_at),
    updated_at: isoUtc(row.updated_at),
    shares: Object.entries(shares).map(([personId, cents]) => ({ person_id: personId, share_cents: cents })),
  };
}
