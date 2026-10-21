-- FriendSplit – Datenbankschema für MySQL / MariaDB (z. B. ALL-INKL.COM)
-- Import über phpMyAdmin oder über api/index.php?action=setup&key=… (siehe README).
-- Alle Statements sind idempotent (IF NOT EXISTS) und können gefahrlos erneut ausgeführt werden.
-- Für eine bestehende Installation (Version 1, ohne Benutzerkonten) stattdessen update-2.mysql.sql
-- importieren – oder einfach die App aufrufen: Sie führt fehlende Updates automatisch aus.

CREATE TABLE IF NOT EXISTS fs_users (
  id            CHAR(16)     NOT NULL,
  username      VARCHAR(40)  NOT NULL,
  display_name  VARCHAR(60)  NOT NULL,
  email         VARCHAR(190) NULL,
  password_hash VARCHAR(255) NOT NULL,
  role          VARCHAR(10)  NOT NULL DEFAULT 'member',
  status        VARCHAR(10)  NOT NULL DEFAULT 'active',
  created_at    DATETIME     NOT NULL,
  last_login_at DATETIME     NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_username (username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS fs_sessions (
  id           CHAR(16)     NOT NULL,
  user_id      CHAR(16)     NOT NULL,
  token_hash   CHAR(64)     NOT NULL,
  remember     TINYINT(1)   NOT NULL DEFAULT 0,
  created_at   DATETIME     NOT NULL,
  last_seen_at DATETIME     NOT NULL,
  expires_at   DATETIME     NOT NULL,
  user_agent   VARCHAR(190) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_sessions_token (token_hash),
  KEY idx_sessions_user (user_id),
  CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES fs_users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Einladungen (kind = 'invite') und Links zum Zurücksetzen des Passworts (kind = 'reset')
CREATE TABLE IF NOT EXISTS fs_tokens (
  id         CHAR(16)     NOT NULL,
  kind       VARCHAR(10)  NOT NULL,
  token_hash CHAR(64)     NOT NULL,
  user_id    CHAR(16)     NULL,
  created_by CHAR(16)     NULL,
  note       VARCHAR(120) NULL,
  max_uses   INT          NOT NULL DEFAULT 1,
  uses       INT          NOT NULL DEFAULT 0,
  expires_at DATETIME     NOT NULL,
  created_at DATETIME     NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_tokens_hash (token_hash),
  CONSTRAINT fk_tokens_user FOREIGN KEY (user_id) REFERENCES fs_users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS fs_login_attempts (
  id           CHAR(16)    NOT NULL,
  username     VARCHAR(40) NOT NULL,
  ip_hash      CHAR(64)    NOT NULL,
  attempted_at DATETIME    NOT NULL,
  PRIMARY KEY (id),
  KEY idx_attempts_user (username, attempted_at),
  KEY idx_attempts_ip (ip_hash, attempted_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

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
  owner_user_id        CHAR(16)     NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_events_access_code (access_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS fs_persons (
  id           CHAR(16)    NOT NULL,
  display_name VARCHAR(60) NOT NULL,
  auth_user_id VARCHAR(64) NULL,
  created_at   DATETIME    NOT NULL,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS fs_event_participants (
  event_id  CHAR(16)    NOT NULL,
  person_id CHAR(16)    NOT NULL,
  role      VARCHAR(20) NOT NULL DEFAULT 'member',
  position  INT         NOT NULL DEFAULT 0,
  joined_at DATETIME    NOT NULL,
  user_id   CHAR(16)    NULL,
  PRIMARY KEY (event_id, person_id),
  UNIQUE KEY uq_participants_user (event_id, user_id),
  KEY idx_participants_person (person_id),
  CONSTRAINT fk_participants_event  FOREIGN KEY (event_id)  REFERENCES fs_events (id)  ON DELETE CASCADE,
  CONSTRAINT fk_participants_person FOREIGN KEY (person_id) REFERENCES fs_persons (id) ON DELETE CASCADE,
  CONSTRAINT fk_participants_user   FOREIGN KEY (user_id)   REFERENCES fs_users (id)   ON DELETE SET NULL
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
