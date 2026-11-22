-- FriendSplit – Datenbankschema für MySQL / MariaDB (z. B. ALL-INKL.COM)
-- Import über phpMyAdmin oder über api/index.php?action=setup&key=… (siehe README).
-- Alle Statements sind idempotent (IF NOT EXISTS) und können gefahrlos erneut ausgeführt werden.

CREATE TABLE IF NOT EXISTS fs_events (
  id                   CHAR(16)     NOT NULL,
  access_code          CHAR(12)     NOT NULL,
  name                 VARCHAR(120) NOT NULL,
  event_date           DATE         NULL,
  location             VARCHAR(120) NULL,
  notes                TEXT         NULL,
  created_by_person_id CHAR(16)     NULL,
  created_at           DATETIME     NOT NULL,
  updated_at           DATETIME     NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_events_access_code (access_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS fs_persons (
  id           CHAR(16)    NOT NULL,
  display_name VARCHAR(60) NOT NULL,
  paypal_me    VARCHAR(40) NULL,
  auth_user_id VARCHAR(64) NULL,
  created_at   DATETIME    NOT NULL,
  PRIMARY KEY (id),
  KEY idx_persons_user (auth_user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS fs_event_participants (
  event_id  CHAR(16)    NOT NULL,
  person_id CHAR(16)    NOT NULL,
  role      VARCHAR(20) NOT NULL DEFAULT 'member',
  position  INT         NOT NULL DEFAULT 0,
  joined_at DATETIME    NOT NULL,
  PRIMARY KEY (event_id, person_id),
  KEY idx_participants_person (person_id),
  CONSTRAINT fk_participants_event  FOREIGN KEY (event_id)  REFERENCES fs_events (id)  ON DELETE CASCADE,
  CONSTRAINT fk_participants_person FOREIGN KEY (person_id) REFERENCES fs_persons (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS fs_expenses (
  id                   CHAR(16)     NOT NULL,
  event_id             CHAR(16)     NOT NULL,
  description          VARCHAR(140) NOT NULL,
  amount_cents         INT          NOT NULL,
  category             VARCHAR(20)  NOT NULL,
  icon                 VARCHAR(16)  NOT NULL,
  paid_by_person_id    CHAR(16)     NOT NULL,
  spent_at             DATETIME     NOT NULL,
  notes                TEXT         NULL,
  client_token         VARCHAR(64)  NULL,
  version              INT          NOT NULL DEFAULT 1,
  created_by_person_id CHAR(16)     NULL,
  updated_by_person_id CHAR(16)     NULL,
  created_at           DATETIME     NOT NULL,
  updated_at           DATETIME     NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_expenses_client_token (event_id, client_token),
  KEY idx_expenses_event (event_id, spent_at),
  CONSTRAINT fk_expenses_event FOREIGN KEY (event_id) REFERENCES fs_events (id) ON DELETE CASCADE,
  CONSTRAINT fk_expenses_payer FOREIGN KEY (paid_by_person_id) REFERENCES fs_persons (id),
  CONSTRAINT chk_expenses_amount CHECK (amount_cents > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS fs_expense_shares (
  expense_id  CHAR(16) NOT NULL,
  person_id   CHAR(16) NOT NULL,
  share_cents INT      NOT NULL,
  PRIMARY KEY (expense_id, person_id),
  KEY idx_shares_person (person_id),
  CONSTRAINT fk_shares_expense FOREIGN KEY (expense_id) REFERENCES fs_expenses (id) ON DELETE CASCADE,
  CONSTRAINT fk_shares_person  FOREIGN KEY (person_id)  REFERENCES fs_persons (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS fs_settlements (
  id                   CHAR(16)    NOT NULL,
  event_id             CHAR(16)    NOT NULL,
  from_person_id       CHAR(16)    NOT NULL,
  to_person_id         CHAR(16)    NOT NULL,
  amount_cents         INT         NOT NULL,
  status               VARCHAR(12) NOT NULL DEFAULT 'erledigt',
  paid_at              DATETIME    NULL,
  created_by_person_id CHAR(16)    NULL,
  created_at           DATETIME    NOT NULL,
  PRIMARY KEY (id),
  KEY idx_settlements_event (event_id),
  CONSTRAINT fk_settlements_event FOREIGN KEY (event_id) REFERENCES fs_events (id) ON DELETE CASCADE,
  CONSTRAINT fk_settlements_from  FOREIGN KEY (from_person_id) REFERENCES fs_persons (id),
  CONSTRAINT fk_settlements_to    FOREIGN KEY (to_person_id)   REFERENCES fs_persons (id),
  CONSTRAINT chk_settlements_amount CHECK (amount_cents > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS fs_activity (
  id         CHAR(16)     NOT NULL,
  event_id   CHAR(16)     NOT NULL,
  person_id  CHAR(16)     NULL,
  action     VARCHAR(30)  NOT NULL,
  summary    VARCHAR(255) NOT NULL,
  created_at DATETIME     NOT NULL,
  PRIMARY KEY (id),
  KEY idx_activity_event (event_id, created_at),
  CONSTRAINT fk_activity_event FOREIGN KEY (event_id) REFERENCES fs_events (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Benutzerkonten (nur mit Einladung; Anmeldung mit Name oder E-Mail und Passwort)
CREATE TABLE IF NOT EXISTS fs_users (
  id                CHAR(16)     NOT NULL,
  display_name      VARCHAR(32)  NOT NULL,
  username_key      VARCHAR(32)  NOT NULL,
  email             VARCHAR(190) NOT NULL,
  pending_email     VARCHAR(190) NULL,
  password_hash     VARCHAR(255) NOT NULL,
  role              VARCHAR(10)  NOT NULL DEFAULT 'user',
  paypal_me         VARCHAR(40)  NULL,
  email_verified_at DATETIME     NULL,
  blocked           TINYINT      NOT NULL DEFAULT 0,
  last_login_at     DATETIME     NULL,
  created_at        DATETIME     NOT NULL,
  updated_at        DATETIME     NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_email (email),
  UNIQUE KEY uq_users_name (username_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Angemeldete Sitzungen. Gespeichert wird nur der SHA-256-Hash des Cookie-Werts.
CREATE TABLE IF NOT EXISTS fs_sessions (
  token_hash CHAR(64) NOT NULL,
  user_id    CHAR(16) NOT NULL,
  created_at DATETIME NOT NULL,
  expires_at DATETIME NOT NULL,
  PRIMARY KEY (token_hash),
  KEY idx_sessions_user (user_id),
  CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES fs_users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Bekannte Geräte: dort ist beim Anmelden kein Code aus der E-Mail nötig (Hash des Geräte-Cookies).
CREATE TABLE IF NOT EXISTS fs_devices (
  token_hash   CHAR(64) NOT NULL,
  user_id      CHAR(16) NOT NULL,
  created_at   DATETIME NOT NULL,
  last_used_at DATETIME NOT NULL,
  PRIMARY KEY (token_hash),
  KEY idx_devices_user (user_id),
  CONSTRAINT fk_devices_user FOREIGN KEY (user_id) REFERENCES fs_users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Offene 6-stellige Codes aus der E-Mail (purpose: verify = E-Mail bestätigen, login = neues Gerät).
CREATE TABLE IF NOT EXISTS fs_codes (
  token_hash CHAR(64)    NOT NULL,
  user_id    CHAR(16)    NOT NULL,
  purpose    VARCHAR(8)  NOT NULL,
  code_hash  CHAR(64)    NOT NULL,
  attempts   INT         NOT NULL DEFAULT 0,
  sends      INT         NOT NULL DEFAULT 1,
  sent_at    DATETIME    NOT NULL,
  expires_at DATETIME    NOT NULL,
  PRIMARY KEY (token_hash),
  KEY idx_codes_user (user_id),
  CONSTRAINT fk_codes_user FOREIGN KEY (user_id) REFERENCES fs_users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Links aus E-Mails (purpose: reset = Passwort zurücksetzen, email = neue Adresse bestätigen). Nur Hashes.
CREATE TABLE IF NOT EXISTS fs_user_tokens (
  token_hash CHAR(64)    NOT NULL,
  user_id    CHAR(16)    NOT NULL,
  purpose    VARCHAR(16) NOT NULL,
  expires_at DATETIME    NOT NULL,
  created_at DATETIME    NOT NULL,
  PRIMARY KEY (token_hash),
  KEY idx_user_tokens_user (user_id, purpose),
  CONSTRAINT fk_user_tokens_user FOREIGN KEY (user_id) REFERENCES fs_users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Einladungen: Registrieren geht nur mit Code. max_uses 1 = für eine Person, mehr = Gruppenlink.
CREATE TABLE IF NOT EXISTS fs_invites (
  code       CHAR(12)     NOT NULL,
  created_by CHAR(16)     NOT NULL,
  note       VARCHAR(100) NOT NULL DEFAULT '',
  created_at DATETIME     NOT NULL,
  expires_at DATETIME     NOT NULL,
  max_uses   INT          NOT NULL DEFAULT 1,
  uses       INT          NOT NULL DEFAULT 0,
  PRIMARY KEY (code),
  KEY idx_invites_creator (created_by)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS fs_invite_uses (
  code    CHAR(12) NOT NULL,
  user_id CHAR(16) NOT NULL,
  used_at DATETIME NOT NULL,
  PRIMARY KEY (code, user_id),
  CONSTRAINT fk_invite_uses_user FOREIGN KEY (user_id) REFERENCES fs_users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Freundschaften (status: pending = angefragt, accepted = befreundet)
CREATE TABLE IF NOT EXISTS fs_friends (
  requester_id CHAR(16)    NOT NULL,
  addressee_id CHAR(16)    NOT NULL,
  status       VARCHAR(10) NOT NULL,
  created_at   DATETIME    NOT NULL,
  accepted_at  DATETIME    NULL,
  PRIMARY KEY (requester_id, addressee_id),
  KEY idx_friends_addressee (addressee_id),
  CONSTRAINT fk_friends_requester FOREIGN KEY (requester_id) REFERENCES fs_users (id) ON DELETE CASCADE,
  CONSTRAINT fk_friends_addressee FOREIGN KEY (addressee_id) REFERENCES fs_users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Begrenzung von Anmeldeversuchen und E-Mails (Schutz vor Durchprobieren und Spam)
CREATE TABLE IF NOT EXISTS fs_rate_limits (
  bucket       VARCHAR(120) NOT NULL,
  hits         INT          NOT NULL,
  window_start DATETIME     NOT NULL,
  PRIMARY KEY (bucket)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Schema-Version: Die App prüft sie bei jedem Aufruf und richtet fehlende Tabellen selbst ein.
CREATE TABLE IF NOT EXISTS fs_meta (
  k VARCHAR(32)  NOT NULL,
  v VARCHAR(255) NOT NULL,
  PRIMARY KEY (k)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
