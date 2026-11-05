-- FriendSplit – Update für bestehende Installationen (PayPal.me-Links der Teilnehmenden).
-- Nur nötig, wenn die Tabellen schon vor diesem Update angelegt wurden und du das Update
-- per phpMyAdmin einspielst. Einfacher: api/index.php?action=setup&key=… erneut aufrufen,
-- das rüstet die Spalte automatisch nach.
-- Meldet phpMyAdmin „Duplicate column name 'paypal_me'“, ist das Update bereits erledigt.

ALTER TABLE fs_persons ADD COLUMN paypal_me VARCHAR(40) NULL AFTER display_name;
