-- Security hardening (2026-07-06 audit).
--
-- 1. rate_limits — fixed-window counters for login / signup / invite-accept attempts.
--    One row per (scope, key); the window rolls in place, so the table stays tiny.
CREATE TABLE IF NOT EXISTS rate_limits (
  scope        TEXT    NOT NULL,          -- 'login' | 'signup' | 'accept'
  key          TEXT    NOT NULL,          -- ip / ip:email / user id (per scope)
  window_start INTEGER NOT NULL,          -- unix seconds, aligned to the scope's window
  count        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (scope, key)
);

-- 2. Refresh-token families — reuse detection (OAuth2 BCP). A rotated token is now
--    MARKED used (kept until expiry) instead of deleted; presenting a used token is
--    proof of theft/replay and revokes the whole family.
ALTER TABLE refresh_tokens ADD COLUMN family_id TEXT;
ALTER TABLE refresh_tokens ADD COLUMN used_at INTEGER;
CREATE INDEX IF NOT EXISTS idx_refresh_family ON refresh_tokens(family_id);

-- 3. Coach-link invite codes now expire (checked in /links/accept).
ALTER TABLE coach_links ADD COLUMN code_expires_at INTEGER;
