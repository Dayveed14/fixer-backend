-- =====================================================================
-- 2026-10-23 (d): session versions and password changes
-- Every JWT carries the user's token_version ("tv"). Changing the
-- password bumps it, which signs the user out everywhere else.
-- Safe to run once; the app also works before it's applied (it falls
-- back to role-only session checks).
-- Rollback: migrations/rollback/2026-10-23d_sessions_passwords.down.sql
-- =====================================================================

ALTER TABLE users
  ADD COLUMN token_version       INT      NOT NULL DEFAULT 0,
  ADD COLUMN password_changed_at DATETIME NULL;
