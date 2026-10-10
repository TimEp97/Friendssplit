<?php
declare(strict_types=1);

final class Db
{
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

    /** Legt alle Tabellen an, falls sie noch nicht existieren. */
    public static function migrate(PDO $pdo): void
    {
        $file = __DIR__ . '/../schema/' . (self::driver($pdo) === 'sqlite' ? 'sqlite.sql' : 'mysql.sql');
        $sql = (string) file_get_contents($file);
        $sql = (string) preg_replace('/^\s*--.*$/m', '', $sql);
        foreach (array_filter(array_map('trim', explode(';', $sql))) as $statement) {
            $pdo->exec($statement);
        }
    }

    public static function now(): string
    {
        return gmdate('Y-m-d H:i:s');
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
