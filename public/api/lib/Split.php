<?php
declare(strict_types=1);

/**
 * Reine Berechnungslogik – ohne Datenbankzugriff, damit sie isoliert getestet werden kann.
 * Alle Beträge sind ganze Cent-Beträge (int), niemals Fließkommazahlen.
 */
final class Split
{
    /**
     * Teilt einen Betrag gleichmäßig auf die beteiligten Personen auf.
     *
     * Rundungsregel: Jede Person erhält zunächst floor(Betrag / Anzahl) Cent. Die übrigen
     * Rest-Cents (höchstens Anzahl − 1) werden einzeln verteilt – zuerst an die zahlende Person,
     * sofern sie beteiligt ist, danach in der Reihenfolge der Teilnehmendenliste des Events.
     * Die Summe der Anteile entspricht damit immer exakt dem Betrag.
     *
     * @param string[] $personIds beteiligte Personen in Reihenfolge der Teilnehmendenliste
     * @return array<string,int> person_id => share_cents
     */
    public static function equal(int $amountCents, array $personIds, ?string $payerId = null): array
    {
        $ids = array_values(array_unique($personIds));
        $count = count($ids);
        if ($count === 0) {
            throw new InvalidArgumentException('Eine Ausgabe benötigt mindestens eine beteiligte Person.');
        }
        if ($amountCents <= 0) {
            throw new InvalidArgumentException('Der Betrag muss größer als 0 sein.');
        }

        $order = $ids;
        if ($payerId !== null && in_array($payerId, $ids, true)) {
            $order = array_merge([$payerId], array_values(array_filter($ids, fn ($id) => $id !== $payerId)));
        }

        $base = intdiv($amountCents, $count);
        $rest = $amountCents % $count;
        $shares = array_fill_keys($ids, $base);
        for ($i = 0; $i < $rest; $i++) {
            $shares[$order[$i]]++;
        }
        return $shares;
    }

    /**
     * Berechnet je Person: bezahlt, Anteil, geleistete/erhaltene Ausgleichszahlungen und Saldo.
     *
     * Saldo = selbst bezahlte Ausgaben − eigener Anteil + geleistete Ausgleichszahlungen − erhaltene Ausgleichszahlungen
     *
     * @param string[] $personIds
     * @param array<int,array{paid_by:string,amount_cents:int,shares:array<string,int>}> $expenses
     * @param array<int,array{from:string,to:string,amount_cents:int}> $settlements
     * @return array<string,array{paid:int,share:int,sent:int,received:int,balance:int}>
     */
    public static function balances(array $personIds, array $expenses, array $settlements = []): array
    {
        $result = [];
        foreach ($personIds as $id) {
            $result[$id] = ['paid' => 0, 'share' => 0, 'sent' => 0, 'received' => 0, 'balance' => 0];
        }
        $ensure = function (string $id) use (&$result): void {
            if (!isset($result[$id])) {
                $result[$id] = ['paid' => 0, 'share' => 0, 'sent' => 0, 'received' => 0, 'balance' => 0];
            }
        };

        foreach ($expenses as $expense) {
            $ensure($expense['paid_by']);
            $result[$expense['paid_by']]['paid'] += $expense['amount_cents'];
            foreach ($expense['shares'] as $personId => $cents) {
                $ensure((string) $personId);
                $result[(string) $personId]['share'] += $cents;
            }
        }
        foreach ($settlements as $settlement) {
            $ensure($settlement['from']);
            $ensure($settlement['to']);
            $result[$settlement['from']]['sent'] += $settlement['amount_cents'];
            $result[$settlement['to']]['received'] += $settlement['amount_cents'];
        }
        foreach ($result as $id => $row) {
            $result[$id]['balance'] = $row['paid'] - $row['share'] + $row['sent'] - $row['received'];
        }
        return $result;
    }

    /**
     * Schlägt Ausgleichszahlungen vor: Die Person mit der größten Schuld zahlt an die Person mit dem
     * größten Guthaben, bis alle Salden 0 sind. Ergibt höchstens (Anzahl Personen − 1) Zahlungen.
     * Bei Gleichstand entscheidet die Reihenfolge in $order, damit das Ergebnis stabil bleibt.
     *
     * @param array<string,int> $balances person_id => Saldo in Cent (Summe muss 0 sein)
     * @param string[] $order Reihenfolge der Teilnehmendenliste
     * @return array<int,array{from:string,to:string,amount_cents:int}>
     */
    public static function plan(array $balances, array $order = []): array
    {
        if (array_sum($balances) !== 0) {
            throw new LogicException('Die Salden ergeben in Summe nicht 0.');
        }
        $rank = array_flip(array_values($order));
        $rankOf = fn (string $id): int => $rank[$id] ?? PHP_INT_MAX;

        $creditors = [];
        $debtors = [];
        foreach ($balances as $id => $balance) {
            if ($balance > 0) {
                $creditors[] = ['id' => (string) $id, 'amount' => $balance];
            } elseif ($balance < 0) {
                $debtors[] = ['id' => (string) $id, 'amount' => -$balance];
            }
        }
        $sort = function (array &$list) use ($rankOf): void {
            usort($list, fn ($a, $b) => [$b['amount'], $rankOf($a['id'])] <=> [$a['amount'], $rankOf($b['id'])]);
        };
        $sort($creditors);
        $sort($debtors);

        $payments = [];
        $c = 0;
        $d = 0;
        while ($c < count($creditors) && $d < count($debtors)) {
            $amount = min($creditors[$c]['amount'], $debtors[$d]['amount']);
            $payments[] = ['from' => $debtors[$d]['id'], 'to' => $creditors[$c]['id'], 'amount_cents' => $amount];
            $creditors[$c]['amount'] -= $amount;
            $debtors[$d]['amount'] -= $amount;
            if ($creditors[$c]['amount'] === 0) {
                $c++;
            }
            if ($debtors[$d]['amount'] === 0) {
                $d++;
            }
        }
        return $payments;
    }

    public static function formatEuro(int $cents): string
    {
        $sign = $cents < 0 ? '−' : '';
        $abs = abs($cents);
        return $sign . number_format(intdiv($abs, 100), 0, ',', '.') . ',' . str_pad((string) ($abs % 100), 2, '0', STR_PAD_LEFT) . ' €';
    }
}
