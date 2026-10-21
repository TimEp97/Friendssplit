<?php
declare(strict_types=1);

/** Fehler, der als verständliche JSON-Antwort an die App geht. */
final class ApiError extends RuntimeException
{
    /**
     * @param array<string,string> $fields Feldname => Fehlermeldung (für Formulare)
     * @param array<string,mixed>|null $data zusätzliche Daten, z. B. aktuelle Version bei Konflikten
     */
    public function __construct(
        public readonly int $status,
        public readonly string $errorCode,
        string $message,
        public readonly array $fields = [],
        public readonly ?array $data = null,
    ) {
        parent::__construct($message);
    }

    /** @param array<string,string> $fields */
    public static function validation(array $fields): self
    {
        return new self(422, 'validation', 'Bitte prüfe die markierten Eingaben.', $fields);
    }
}

final class Http
{
    /** @param mixed $data */
    public static function ok($data, int $status = 200): never
    {
        self::send($status, ['ok' => true, 'data' => $data]);
    }

    public static function error(ApiError $e): never
    {
        $error = ['code' => $e->errorCode, 'message' => $e->getMessage()];
        if ($e->fields) {
            $error['fields'] = $e->fields;
        }
        if ($e->data !== null) {
            $error['data'] = $e->data;
        }
        self::send($e->status, ['ok' => false, 'error' => $error]);
    }

    /** @param array<string,mixed> $payload */
    private static function send(int $status, array $payload): never
    {
        http_response_code($status);
        header('Content-Type: application/json; charset=utf-8');
        header('Cache-Control: no-store');
        header('X-Content-Type-Options: nosniff');
        header('Referrer-Policy: no-referrer');
        echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR);
        exit;
    }

    /** @return array<string,mixed> */
    public static function jsonBody(): array
    {
        $raw = file_get_contents('php://input');
        if ($raw === false || $raw === '') {
            return [];
        }
        if (strlen($raw) > 64 * 1024) {
            throw new ApiError(413, 'too_large', 'Die Anfrage ist zu groß.');
        }
        try {
            $data = json_decode($raw, true, 16, JSON_THROW_ON_ERROR);
        } catch (JsonException) {
            throw new ApiError(400, 'bad_json', 'Die Anfrage konnte nicht gelesen werden.');
        }
        if (!is_array($data)) {
            throw new ApiError(400, 'bad_json', 'Die Anfrage konnte nicht gelesen werden.');
        }
        return $data;
    }

    public static function header(string $name): ?string
    {
        $key = 'HTTP_' . strtoupper(str_replace('-', '_', $name));
        $value = $_SERVER[$key] ?? null;
        return is_string($value) && $value !== '' ? $value : null;
    }

    public static function isHttps(): bool
    {
        $https = strtolower((string) ($_SERVER['HTTPS'] ?? ''));
        return ($https !== '' && $https !== 'off')
            || (string) ($_SERVER['SERVER_PORT'] ?? '') === '443'
            || strtolower((string) ($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '')) === 'https';
    }

    /** Setzt (oder löscht mit $value = null) ein HttpOnly-Cookie, das nur an die API geschickt wird. */
    public static function cookie(string $name, ?string $value, int $expires = 0): void
    {
        $path = rtrim(str_replace('\\', '/', dirname((string) ($_SERVER['SCRIPT_NAME'] ?? '/'))), '/') . '/';
        setcookie($name, $value ?? '', [
            'expires' => $value === null ? 1 : $expires,
            'path' => $path,
            'secure' => self::isHttps(),
            'httponly' => true,
            'samesite' => 'Lax',
        ]);
    }

    public static function clientIp(): string
    {
        return (string) ($_SERVER['REMOTE_ADDR'] ?? '');
    }
}
