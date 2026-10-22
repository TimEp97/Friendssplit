// Ausführen: node --test tests/split.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { equal, balances, plan, formatEuro } from '../server/lib/split.js';

/** Reproduzierbarer Zufallsgenerator (mulberry32). */
function seeded(seed) {
  let a = seed;
  const next = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return (min, max) => min + Math.floor(next() * (max - min + 1));
}
const sum = (values) => values.reduce((a, b) => a + b, 0);

test('60,00 € auf drei Personen = je 20,00 €', () => {
  assert.deepEqual(equal(6000, ['a', 'b', 'c']), { a: 2000, b: 2000, c: 2000 });
});

test('Nur ausgewählte Personen erhalten einen Anteil', () => {
  const shares = equal(2000, ['b', 'c'], 'b');
  assert.deepEqual(shares, { b: 1000, c: 1000 });
  assert.equal('a' in shares, false);
});

test('Rest-Cent geht zuerst an die zahlende Person, dann in Listenreihenfolge', () => {
  assert.deepEqual(equal(10000, ['a', 'b', 'c']), { a: 3334, b: 3333, c: 3333 });
  assert.deepEqual(equal(10000, ['a', 'b', 'c'], 'c'), { a: 3333, b: 3333, c: 3334 });
  assert.deepEqual(equal(2, ['a', 'b', 'c']), { a: 1, b: 1, c: 0 });
  assert.deepEqual(equal(2, ['a', 'b', 'c'], 'c'), { a: 1, b: 0, c: 1 });
  // Zahlende Person nicht beteiligt: reine Listenreihenfolge
  assert.deepEqual(equal(100, ['a', 'b', 'c'], 'x'), { a: 34, b: 33, c: 33 });
});

test('Summe der Anteile entspricht immer exakt dem Betrag (Zufallstest)', () => {
  const rand = seeded(42);
  for (let i = 0; i < 5000; i++) {
    const n = rand(1, 12);
    const ids = Array.from({ length: n }, (_, k) => `p${k + 1}`);
    const amount = rand(1, 10_000_000);
    const payer = rand(0, 1) ? ids[rand(0, n - 1)] : null;
    const shares = Object.values(equal(amount, ids, payer));
    assert.equal(sum(shares), amount);
    assert.ok(Math.max(...shares) - Math.min(...shares) <= 1, 'Anteile weichen höchstens um 1 Cent ab');
  }
});

test('Ungültige Eingaben werden abgelehnt', () => {
  assert.throws(() => equal(100, []), RangeError);
  assert.throws(() => equal(0, ['a']), RangeError);
  assert.throws(() => equal(-5, ['a']), RangeError);
  assert.throws(() => equal(1.5, ['a']), RangeError);
});

test('Beispiel aus dem Konzept: Alex, Mathis, Sam', () => {
  const people = ['alex', 'mathis', 'sam'];
  const expenses = [
    { paid_by: 'alex', amount_cents: 3000, shares: equal(3000, ['alex', 'mathis', 'sam'], 'alex') },
    { paid_by: 'mathis', amount_cents: 2000, shares: equal(2000, ['mathis', 'sam'], 'mathis') },
  ];
  const result = balances(people, expenses);
  assert.deepEqual(result.alex, { paid: 3000, share: 1000, sent: 0, received: 0, balance: 2000 });
  assert.deepEqual(result.mathis, { paid: 2000, share: 2000, sent: 0, received: 0, balance: 0 });
  assert.deepEqual(result.sam, { paid: 0, share: 2000, sent: 0, received: 0, balance: -2000 });

  const only = (b) => Object.fromEntries(Object.entries(b).map(([id, row]) => [id, row.balance]));
  assert.deepEqual(plan(only(result), people), [{ from: 'sam', to: 'alex', amount_cents: 2000 }]);

  // Nach der Ausgleichszahlung sind alle Salden 0 und es gibt keine Vorschläge mehr.
  const after = balances(people, expenses, [{ from: 'sam', to: 'alex', amount_cents: 2000 }]);
  for (const row of Object.values(after)) assert.equal(row.balance, 0);
  assert.deepEqual(plan(only(after), people), []);
});

test('Ausgleichsplan gleicht beliebige Salden vollständig aus (Zufallstest)', () => {
  const rand = seeded(7);
  for (let i = 0; i < 2000; i++) {
    const n = rand(2, 10);
    const ids = Array.from({ length: n }, (_, k) => `p${k + 1}`);
    const expenses = [];
    for (let e = 0, count = rand(0, 15); e < count; e++) {
      let involved = ids.filter(() => rand(0, 1) === 1);
      if (!involved.length) involved = [ids[0]];
      const payer = ids[rand(0, n - 1)];
      const amount = rand(1, 50000);
      expenses.push({ paid_by: payer, amount_cents: amount, shares: equal(amount, involved, payer) });
    }
    const balanceById = Object.fromEntries(Object.entries(balances(ids, expenses)).map(([id, row]) => [id, row.balance]));
    assert.equal(sum(Object.values(balanceById)), 0);
    const payments = plan(balanceById, ids);
    assert.ok(payments.length <= Math.max(0, n - 1), 'höchstens n − 1 Zahlungen');
    for (const payment of payments) {
      assert.ok(payment.amount_cents > 0);
      assert.notEqual(payment.from, payment.to);
      balanceById[payment.from] += payment.amount_cents;
      balanceById[payment.to] -= payment.amount_cents;
    }
    for (const balance of Object.values(balanceById)) assert.equal(balance, 0);
  }
});

test('Euro-Formatierung', () => {
  assert.equal(formatEuro(4250), '42,50 €');
  assert.equal(formatEuro(5), '0,05 €');
  assert.equal(formatEuro(123456), '1.234,56 €');
  assert.equal(formatEuro(1234567890), '12.345.678,90 €');
  assert.equal(formatEuro(-2000), '−20,00 €');
});
