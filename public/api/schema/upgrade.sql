-- FriendSplit – Update für bestehende Installationen per phpMyAdmin.
-- Einfacher: api/index.php?action=setup&key=… erneut aufrufen – das erledigt alles automatisch.
--
-- 1. Neue Tabellen (Benutzerkonten): einfach mysql.sql erneut importieren – alle Statements dort sind
--    idempotent (CREATE TABLE IF NOT EXISTS) und lassen bestehende Daten unverändert.
-- 2. Danach diese Datei importieren. Meldet phpMyAdmin „Duplicate column name 'paypal_me'“,
--    ist dieser Schritt bereits erledigt.

ALTER TABLE fs_persons ADD COLUMN paypal_me VARCHAR(40) NULL AFTER display_name;

-- 3. Nur falls fs_users schon vor dem Update „Profil bearbeiten“ existierte
--    (Fehler „Duplicate column name 'pending_email'“ = bereits erledigt):
ALTER TABLE fs_users ADD COLUMN pending_email VARCHAR(190) NULL AFTER email;
