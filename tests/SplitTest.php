<?php
declare(strict_types=1);

// Ausführen: php tests/SplitTest.php

require __DIR__ . '/../public/api/lib/Split.php';
require __DIR__ . '/assert.php';

test('60,00 € auf drei Personen = je 20,00 €', function () {
    assertSame(['a' => 2000, 'b' => 2000, 'c' => 2000], Split::equal(6000, ['a', 'b', 'c']));
});

test('Nur ausgewählte Personen erhalten einen Anteil', function () {
    $shares = Split::equal(2000, ['b', 'c'], 'b');
    assertSame(['b' => 1000, 'c' => 1000], $shares);
    assertFalse(isset($shares['a']));
});

test('Rest-Cent geht zuerst an die zahlende Person, dann in Listenreihenfolge', function () {
    assertSame(['a' => 3334, 'b' => 3333, 'c' => 3333], Split::equal(10000, ['a', 'b', 'c']));
    assertSame(['a' => 3333, 'b' => 3333, 'c' => 3334], Split::equal(10000, ['a', 'b', 'c'], 'c'));
    assertSame(['a' => 1, 'b' => 1, 'c' => 0], Split::equal(2, ['a', 'b', 'c']));
    assertSame(['a' => 1, 'b' => 0, 'c' => 1], Split::equal(2, ['a', 'b', 'c'], 'c'));
    // Zahlende Person nicht beteiligt: reine Listenreihenfolge
    assertSame(['a' => 34, 'b' => 33, 'c' => 33], Split::equal(100, ['a', 'b', 'c'], 'x'));
});

test('Summe der Anteile entspricht immer exakt dem Betrag (Zufallstest)', function () {
    mt_srand(42);
    for ($i = 0; $i < 5000; $i++) {
        $n = mt_rand(1, 12);
        $ids = array_map(fn ($k) => "p$k", range(1, $n));
        $amount = mt_rand(1, 10_000_000);
        $payer = mt_rand(0, 1) ? $ids[mt_rand(0, $n - 1)] : null;
        $shares = Split::equal($amount, $ids, $payer);
        assertSame($amount, array_sum($shares));
        assertTrue(max($shares) - min($shares) <= 1, 'Anteile weichen höchstens um 1 Cent ab');
    }
});

test('Ungültige Eingaben werden abgelehnt', function () {
    assertThrows(fn () => Split::equal(100, []), InvalidArgumentException::class);
    assertThrows(fn () => Split::equal(0, ['a']), InvalidArgumentException::class);
    assertThrows(fn () => Split::equal(-5, ['a']), InvalidArgumentException::class);
});

test('Beispiel aus dem Konzept (Abschnitt 12): Alex, Mathis, Sam', function () {
    $people = ['alex', 'mathis', 'sam'];
    $expenses = [
        ['paid_by' => 'alex', 'amount_cents' => 3000, 'shares' => Split::equal(3000, ['alex', 'mathis', 'sam'], 'alex')],
        ['paid_by' => 'mathis', 'amount_cents' => 2000, 'shares' => Split::equal(2000, ['mathis', 'sam'], 'mathis')],
    ];
    $balances = Split::balances($people, $expenses);
    assertSame(['paid' => 3000, 'share' => 1000, 'sent' => 0, 'received' => 0, 'balance' => 2000], $balances['alex']);
    assertSame(['paid' => 2000, 'share' => 2000, 'sent' => 0, 'received' => 0, 'balance' => 0], $balances['mathis']);
    assertSame(['paid' => 0, 'share' => 2000, 'sent' => 0, 'received' => 0, 'balance' => -2000], $balances['sam']);

    $plan = Split::plan(array_map(fn ($b) => $b['balance'], $balances), $people);
    assertSame([['from' => 'sam', 'to' => 'alex', 'amount_cents' => 2000]], $plan);

    // Nach der Ausgleichszahlung sind alle Salden 0 und es gibt keine Vorschläge mehr.
    $after = Split::balances($people, $expenses, [['from' => 'sam', 'to' => 'alex', 'amount_cents' => 2000]]);
    foreach ($after as $row) {
        assertSame(0, $row['balance']);
    }
    assertSame([], Split::plan(array_map(fn ($b) => $b['balance'], $after), $people));
});

test('Ausgleichsplan gleicht beliebige Salden vollständig aus (Zufallstest)', function () {
    mt_srand(7);
    for ($i = 0; $i < 2000; $i++) {
        $n = mt_rand(2, 10);
        $ids = array_map(fn ($k) => "p$k", range(1, $n));
        $expenses = [];
        for ($e = 0, $count = mt_rand(0, 15); $e < $count; $e++) {
            $involved = array_values(array_filter($ids, fn () => mt_rand(0, 1) === 1)) ?: [$ids[0]];
            $payer = $ids[mt_rand(0, $n - 1)];
            $amount = mt_rand(1, 50000);
            $expenses[] = ['paid_by' => $payer, 'amount_cents' => $amount, 'shares' => Split::equal($amount, $involved, $payer)];
        }
        $balances = array_map(fn ($b) => $b['balance'], Split::balances($ids, $expenses));
        assertSame(0, array_sum($balances));
        $plan = Split::plan($balances, $ids);
        assertTrue(count($plan) <= max(0, $n - 1), 'höchstens n − 1 Zahlungen');
        foreach ($plan as $payment) {
            assertTrue($payment['amount_cents'] > 0);
            assertTrue($payment['from'] !== $payment['to']);
            $balances[$payment['from']] += $payment['amount_cents'];
            $balances[$payment['to']] -= $payment['amount_cents'];
        }
        foreach ($balances as $balance) {
            assertSame(0, $balance);
        }
    }
});

test('Euro-Formatierung', function () {
    assertSame('42,50 €', Split::formatEuro(4250));
    assertSame('0,05 €', Split::formatEuro(5));
    assertSame('1.234,56 €', Split::formatEuro(123456));
    assertSame('−20,00 €', Split::formatEuro(-2000));
});

finish();
