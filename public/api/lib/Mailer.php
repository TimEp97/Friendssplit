<?php
declare(strict_types=1);

/**
 * Versand von Text-E-Mails über PHPs mail() – bei ALL-INKL.COM ohne weitere Einrichtung nutzbar,
 * solange die Absenderadresse zur eigenen Domain gehört. Für Entwicklung und Tests kann
 * 'transport' => 'log' gesetzt werden: Dann landen die Mails in einer Datei statt im Postfach.
 */
final class Mailer
{
    /** @param array{transport?:string,from?:string,from_name?:string,log_file?:string} $config */
    public function __construct(private array $config)
    {
    }

    public function send(string $to, string $subject, string $body): void
    {
        $transport = $this->config['transport'] ?? 'mail';
        if ($transport === 'log') {
            $file = $this->config['log_file'] ?? (__DIR__ . '/../../data/mail.log');
            $entry = json_encode(['to' => $to, 'subject' => $subject, 'body' => $body], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) . "\n";
            file_put_contents($file, $entry, FILE_APPEND | LOCK_EX);
            return;
        }

        $from = (string) ($this->config['from'] ?? '');
        if (!filter_var($from, FILTER_VALIDATE_EMAIL)) {
            error_log('FriendSplit: mail.from fehlt oder ist ungültig in config.php');
            throw new ApiError(503, 'mail_not_configured', 'Der E-Mail-Versand ist noch nicht eingerichtet. Bitte wende dich an die Betreiberin oder den Betreiber dieser Seite.');
        }
        $fromName = (string) ($this->config['from_name'] ?? 'FriendSplit');
        $headers = implode("\r\n", [
            'From: ' . mb_encode_mimeheader($fromName, 'UTF-8', 'Q') . " <$from>",
            'MIME-Version: 1.0',
            'Content-Type: text/plain; charset=UTF-8',
            'Content-Transfer-Encoding: 8bit',
            'Auto-Submitted: auto-generated',
        ]);
        $ok = mail($to, mb_encode_mimeheader($subject, 'UTF-8', 'Q'), str_replace("\n", "\r\n", $body), $headers, '-f' . $from);
        if (!$ok) {
            error_log("FriendSplit: mail() an $to fehlgeschlagen");
            throw new ApiError(502, 'mail_failed', 'Die E-Mail konnte gerade nicht verschickt werden. Bitte versuche es in ein paar Minuten noch einmal.');
        }
    }
}
