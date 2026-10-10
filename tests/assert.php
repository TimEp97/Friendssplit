<?php
declare(strict_types=1);

// Minimale Test-Hilfen ohne externe Abhängigkeiten (kein Composer nötig).

$GLOBALS['__tests'] = ['passed' => 0, 'failed' => 0];

function test(string $name, callable $fn): void
{
    try {
        $fn();
        $GLOBALS['__tests']['passed']++;
        echo "  ✓ $name\n";
    } catch (Throwable $e) {
        $GLOBALS['__tests']['failed']++;
        echo "  ✗ $name\n      " . $e->getMessage() . "\n      " . $e->getFile() . ':' . $e->getLine() . "\n";
    }
}

function assertSame(mixed $expected, mixed $actual, string $message = ''): void
{
    if ($expected !== $actual) {
        throw new RuntimeException(($message ? "$message: " : '') . 'erwartet ' . var_export($expected, true) . ', erhalten ' . var_export($actual, true));
    }
}

function assertTrue(mixed $value, string $message = 'Bedingung nicht erfüllt'): void
{
    if ($value !== true) {
        throw new RuntimeException($message);
    }
}

function assertFalse(mixed $value, string $message = 'Bedingung sollte falsch sein'): void
{
    if ($value !== false) {
        throw new RuntimeException($message);
    }
}

function assertThrows(callable $fn, string $class): void
{
    try {
        $fn();
    } catch (Throwable $e) {
        if ($e instanceof $class) {
            return;
        }
        throw new RuntimeException("erwartet $class, erhalten " . get_class($e) . ': ' . $e->getMessage());
    }
    throw new RuntimeException("erwartet $class, aber keine Ausnahme");
}

function finish(): void
{
    ['passed' => $passed, 'failed' => $failed] = $GLOBALS['__tests'];
    echo "\n$passed bestanden, $failed fehlgeschlagen\n";
    exit($failed > 0 ? 1 : 0);
}
