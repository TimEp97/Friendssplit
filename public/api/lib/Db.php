<?php
declare(strict_types=1);

final class Db
{
    /** @param array{dsn:string,user?:string|null,password?:string|null} $config */
    public static function connect(array $config): PDO
    {
        $options = [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES => false,
            PDO::ATTR_STRINGIFY_FETCHES => false,
        ];
        $mysql = str_starts_with($config['dsn'], 'mysql:');
        if ($mysql) {
            // Zeichensatz und Zeitzone gleich beim Verbinden setzen – eine Abfrage statt zwei zusätzlicher.
            $options[PDO::MYSQL_ATTR_INIT_COMMAND] = "SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci, time_zone = '+00:00'";
        }
        $pdo = new PDO($config['dsn'], $config['user'] ?? null, $config['password'] ?? null, $options);
        if (!$mysql) {
            $pdo->exec('PRAGMA foreign_keys = ON');
            $pdo->exec('PRAGMA busy_timeout = 5000');
        }
        return $pdo;
    }

    public static function driver(PDO $pdo): string
    {
        return (string) $pdo->getAttribute(PDO::ATTR_DRIVER_NAME);
    }

    /** Stand des Datenbankschemas. Erhöhen, wenn sich schema/*.sql ändert. */
    public const SCHEMA_VERSION = 3;

    /**
     * Legt fehlende Tabellen an und rüstet Spalten nach. Prüft zuerst die gespeicherte
     * Schema-Version, sodass bei aktuellem Stand nur eine einzige Abfrage anfällt.
     */
    public static function migrate(PDO $pdo, bool $force = false): void
    {
        if (!$force) {
            try {
                $version = (int) $pdo->query("SELECT v FROM fs_meta WHERE k = 'schema'")->fetchColumn();
                if ($version >= self::SCHEMA_VERSION) {
                    return;
                }
            } catch (PDOException) {
                // Tabelle fehlt noch → einrichten
            }
        }
        $file = __DIR__ . '/../schema/' . (self::driver($pdo) === 'sqlite' ? 'sqlite.sql' : 'mysql.sql');
        $sql = (string) file_get_contents($file);
        $sql = (string) preg_replace('/^\s*--.*$/m', '', $sql);
        foreach (array_filter(array_map('trim', explode(';', $sql))) as $statement) {
            $pdo->exec($statement);
        }
        // Spalte aus dem PayPal-Update für Installationen der ersten Version nachrüsten.
        // Abrechnung abschließen (Schema 3)
        $datetime = self::driver($pdo) === 'sqlite' ? 'TEXT' : 'DATETIME';
        $idType = self::driver($pdo) === 'sqlite' ? 'TEXT' : 'CHAR(16)';
        if (!self::hasColumn($pdo, 'fs_events', 'closed_at')) {
            $pdo->exec("ALTER TABLE fs_events ADD COLUMN closed_at $datetime NULL");
        }
        if (!self::hasColumn($pdo, 'fs_events', 'closed_by_person_id')) {
            $pdo->exec("ALTER TABLE fs_events ADD COLUMN closed_by_person_id $idType NULL");
        }
        if (!self::hasColumn($pdo, 'fs_persons', 'paypal_me')) {
            $pdo->exec('ALTER TABLE fs_persons ADD COLUMN paypal_me ' . (self::driver($pdo) === 'sqlite' ? 'TEXT' : 'VARCHAR(40)') . ' NULL');
        }
        $pdo->prepare('DELETE FROM fs_meta WHERE k = ?')->execute(['schema']);
        $pdo->prepare('INSERT INTO fs_meta (k, v) VALUES (?, ?)')->execute(['schema', (string) self::SCHEMA_VERSION]);
    }

    private static function hasColumn(PDO $pdo, string $table, string $column): bool
    {
        if (self::driver($pdo) === 'sqlite') {
            $columns = array_column($pdo->query("PRAGMA table_info($table)")->fetchAll(), 'name');
            return in_array($column, $columns, true);
        }
        $stmt = $pdo->prepare('SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?');
        $stmt->execute([$table, $column]);
        return (int) $stmt->fetchColumn() > 0;
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
