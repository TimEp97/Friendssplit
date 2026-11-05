-- FriendSplit – Update für bestehende Installationen per phpMyAdmin.
-- Einfacher: api/index.php?action=setup&key=… erneut aufrufen – das erledigt alles automatisch.
--
-- 1. Neue Tabellen (Benutzerkonten): einfach mysql.sql erneut importieren – alle Statements dort sind
--    idempotent (CREATE TABLE IF NOT EXISTS) und lassen bestehende Daten unverändert.
-- 2. Danach diese Datei importieren. Meldet phpMyAdmin „Duplicate column name 'paypal_me'“,
--    ist dieser Schritt bereits erledigt.

ALTER TABLE fs_persons ADD COLUMN paypal_me VARCHAR(40) NULL AFTER display_name;
