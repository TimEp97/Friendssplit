<?php
declare(strict_types=1);

final class Db
{
    /** Aktuelle Schema-Version. Neue Versionen bekommen eine Datei schema/update-<n>.<treiber>.sql. */
    public const VERSION = 2;

    /**
     * Woran eine Version erkennbar ist: Abfragen, die erst ab dieser Version funktionieren.
     * Geprüft wird von der neuesten Version abwärts.
     */
    private const PROBES = [
        2 => ['SELECT owner_user_id FROM fs_events LIMIT 1', 'SELECT id FROM fs_users LIMIT 1'],
        1 => ['SELECT id FROM fs_events LIMIT 1'],
    ];

    /** @param array{dsn:string,user?:string|null,password?:string|null} $config */
    public static function connect(array $config): PDO
    {
        $pdo = new PDO($config['dsn'], $config['user'] ?? null, $config['password'] ?? null, [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES => false,
            PDO::ATTR_STRINGIFY_FETCHES => false,
        ]);
        if (self::driver($pdo) === 'sqlite') {
            $pdo->exec('PRAGMA foreign_keys = ON');
            $pdo->exec('PRAGMA busy_timeout = 5000');
        } else {
            $pdo->exec("SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci");
            $pdo->exec("SET time_zone = '+00:00'");
        }
        return $pdo;
    }

    public static function driver(PDO $pdo): string
    {
        return (string) $pdo->getAttribute(PDO::ATTR_DRIVER_NAME);
    }

    /** Installierte Schema-Version: 0 = noch keine Tabellen. */
    public static function version(PDO $pdo): int
    {
        foreach (self::PROBES as $version => $queries) {
            try {
                foreach ($queries as $sql) {
                    $pdo->query($sql)->closeCursor();
                }
                return $version;
            } catch (PDOException) {
                // Version noch nicht installiert – nächstältere prüfen.
            }
        }
        return 0;
    }

    /**
     * Legt alle Tabellen an bzw. bringt eine ältere Installation auf den aktuellen Stand.
     * Wird bei jedem Aufruf geprüft (zwei kleine Abfragen) und arbeitet nur, wenn etwas fehlt.
     */
    public static function migrate(PDO $pdo): void
    {
        if (self::version($pdo) >= self::VERSION) {
            return;
        }
        $driver = self::driver($pdo);
        $locked = $driver === 'mysql' && (int) $pdo->query("SELECT GET_LOCK('friendsplit_migrate', 15)")->fetchColumn() === 1;
        try {
            $version = self::version($pdo); // erneut prüfen, falls parallel schon migriert wurde
            if ($version === 0) {
                self::runFile($pdo, $driver === 'sqlite' ? 'sqlite.sql' : 'mysql.sql', false);
            } else {
                for ($v = $version + 1; $v <= self::VERSION; $v++) {
                    self::runFile($pdo, "update-$v." . ($driver === 'sqlite' ? 'sqlite' : 'mysql') . '.sql', true);
                }
            }
        } finally {
            if ($locked) {
                $pdo->query("SELECT RELEASE_LOCK('friendsplit_migrate')")->closeCursor();
            }
        }
    }

    /** @param bool $tolerant bereits vorhandene Spalten/Schlüssel überspringen (abgebrochenes Update fortsetzen) */
    private static function runFile(PDO $pdo, string $file, bool $tolerant): void
    {
        $sql = (string) file_get_contents(__DIR__ . '/../schema/' . $file);
        $sql = (string) preg_replace('/^\s*--.*$/m', '', $sql);
        foreach (array_filter(array_map('trim', explode(';', $sql))) as $statement) {
            try {
                $pdo->exec($statement);
            } catch (PDOException $e) {
                if (!$tolerant || !preg_match('/duplicate|already exists/i', $e->getMessage())) {
                    throw $e;
                }
            }
        }
    }

    public static function now(): string
    {
        return gmdate('Y-m-d H:i:s');
    }

    /** UTC-Zeitpunkt relativ zu jetzt, z. B. Db::at('+14 days'). */
    public static function at(string $modifier): string
    {
        return gmdate('Y-m-d H:i:s', (int) strtotime($modifier));
    }

    /**
     * Zufällige ID aus 16 Zeichen [a-z0-9], beginnend mit einem Buchstaben. Rein numerische IDs
     * werden so vermieden, weil PHP sie als Array-Schlüssel stillschweigend in int umwandelt.
     */
    public static function id(): string
    {
        $letters = 'abcdefghijklmnopqrstuvwxyz';
        $chars = $letters . '0123456789';
        $id = $letters[random_int(0, 25)];
        for ($i = 1; $i < 16; $i++) {
            $id .= $chars[random_int(0, 35)];
        }
        return $id;
    }
}
