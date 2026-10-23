-- Reverses 2026-10-23d. Safe: the app falls back to role-only session
-- checks without these columns. Existing sessions keep working.
ALTER TABLE users
  DROP COLUMN password_changed_at,
  DROP COLUMN token_version;
