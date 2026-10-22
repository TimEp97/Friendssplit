// Reine Berechnungslogik – ohne Datenbankzugriff, damit sie isoliert getestet werden kann.
// Alle Beträge sind ganze Cent-Beträge (Integer), niemals Fließkommazahlen.

/**
 * Teilt einen Betrag gleichmäßig auf die beteiligten Personen auf.
 *
 * Rundungsregel: Jede Person erhält zunächst floor(Betrag / Anzahl) Cent. Die übrigen
 * Rest-Cents (höchstens Anzahl − 1) werden einzeln verteilt – zuerst an die zahlende Person,
 * sofern sie beteiligt ist, danach in der Reihenfolge der Teilnehmendenliste des Events.
 * Die Summe der Anteile entspricht damit immer exakt dem Betrag.
 *
 * @param {number} amountCents
 * @param {string[]} personIds beteiligte Personen in Reihenfolge der Teilnehmendenliste
 * @param {string|null} payerId
 * @returns {Record<string, number>} person_id → share_cents
 */
export function equal(amountCents, personIds, payerId = null) {
  const ids = [...new Set(personIds)];
  if (ids.length === 0) throw new RangeError('Eine Ausgabe benötigt mindestens eine beteiligte Person.');
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) throw new RangeError('Der Betrag muss größer als 0 sein.');

  const order = payerId !== null && ids.includes(payerId) ? [payerId, ...ids.filter((id) => id !== payerId)] : ids;
  const base = Math.floor(amountCents / ids.length);
  const rest = amountCents % ids.length;
  const shares = Object.fromEntries(ids.map((id) => [id, base]));
  for (let i = 0; i < rest; i++) shares[order[i]]++;
  return shares;
}

const emptyRow = () => ({ paid: 0, share: 0, sent: 0, received: 0, balance: 0 });

/**
 * Berechnet je Person: bezahlt, Anteil, geleistete/erhaltene Ausgleichszahlungen und Saldo.
 * Saldo = selbst bezahlt − eigener Anteil + geleistete Ausgleichszahlungen − erhaltene Ausgleichszahlungen
 *
 * @param {string[]} personIds
 * @param {{paid_by: string, amount_cents: number, shares: Record<string, number>}[]} expenses
 * @param {{from: string, to: string, amount_cents: number}[]} settlements
 */
export function balances(personIds, expenses, settlements = []) {
  const result = {};
  const ensure = (id) => (result[id] ??= emptyRow());
  personIds.forEach(ensure);
  for (const expense of expenses) {
    ensure(expense.paid_by).paid += expense.amount_cents;
    for (const [personId, cents] of Object.entries(expense.shares)) ensure(personId).share += cents;
  }
  for (const settlement of settlements) {
    ensure(settlement.from).sent += settlement.amount_cents;
    ensure(settlement.to).received += settlement.amount_cents;
  }
  for (const row of Object.values(result)) row.balance = row.paid - row.share + row.sent - row.received;
  return result;
}

/**
 * Schlägt Ausgleichszahlungen vor: Die Person mit der größten Schuld zahlt an die Person mit dem
 * größten Guthaben, bis alle Salden 0 sind. Ergibt höchstens (Anzahl Personen − 1) Zahlungen.
 * Bei Gleichstand entscheidet die Reihenfolge in `order`, damit das Ergebnis stabil bleibt.
 *
 * @param {Record<string, number>} balanceById person_id → Saldo in Cent (Summe muss 0 sein)
 * @param {string[]} order Reihenfolge der Teilnehmendenliste
 */
export function plan(balanceById, order = []) {
  const values = Object.values(balanceById);
  if (values.reduce((a, b) => a + b, 0) !== 0) throw new Error('Die Salden ergeben in Summe nicht 0.');
  const rank = new Map(order.map((id, i) => [id, i]));
  const rankOf = (id) => rank.get(id) ?? Number.MAX_SAFE_INTEGER;
  const byAmount = (a, b) => b.amount - a.amount || rankOf(a.id) - rankOf(b.id);

  const creditors = [];
  const debtors = [];
  for (const [id, balance] of Object.entries(balanceById)) {
    if (balance > 0) creditors.push({ id, amount: balance });
    else if (balance < 0) debtors.push({ id, amount: -balance });
  }
  creditors.sort(byAmount);
  debtors.sort(byAmount);

  const payments = [];
  let c = 0;
  let d = 0;
  while (c < creditors.length && d < debtors.length) {
    const amount = Math.min(creditors[c].amount, debtors[d].amount);
    payments.push({ from: debtors[d].id, to: creditors[c].id, amount_cents: amount });
    creditors[c].amount -= amount;
    debtors[d].amount -= amount;
    if (creditors[c].amount === 0) c++;
    if (debtors[d].amount === 0) d++;
  }
  return payments;
}

/** 123456 → "1.234,56 €" (für Verlaufseinträge auf dem Server). */
export function formatEuro(cents) {
  const sign = cents < 0 ? '−' : '';
  const abs = Math.abs(cents);
  const euros = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${sign}${euros},${String(abs % 100).padStart(2, '0')} €`;
}
