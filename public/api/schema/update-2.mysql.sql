-- FriendSplit – Update auf Version 2 (Benutzerkonten) für MySQL / MariaDB.
-- Nur für bestehende Installationen nötig. Die App führt dieses Update beim ersten Aufruf
-- automatisch aus; alternativ in phpMyAdmin importieren. Die Spalte owner_user_id kommt bewusst
-- zuletzt: An ihr erkennt die App, dass das Update vollständig ist.

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

ALTER TABLE fs_event_participants ADD COLUMN user_id CHAR(16) NULL;
ALTER TABLE fs_event_participants ADD UNIQUE KEY uq_participants_user (event_id, user_id);
ALTER TABLE fs_event_participants
  ADD CONSTRAINT fk_participants_user FOREIGN KEY (user_id) REFERENCES fs_users (id) ON DELETE SET NULL;

ALTER TABLE fs_events ADD COLUMN owner_user_id CHAR(16) NULL;
