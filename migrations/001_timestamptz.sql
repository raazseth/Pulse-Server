-- Migration 001: Ensure all timestamp columns are TIMESTAMPTZ
--
-- Safe to run against any existing Pulse HUD Postgres database.
-- New databases created after the S-13 DDL fix already have the correct types
-- and the ALTER will be a no-op. Running this script is always idempotent:
-- Postgres silently skips ALTER COLUMN when the target type already matches.
--
-- Run order matters: child tables before the cast so FK constraints are not
-- involved in the type change; auth tables are independent of hud tables.
--
-- Usage:
--   psql "$DATABASE_URL" -f migrations/001_timestamptz.sql
--   node migrations/run.js  (see run.js for programmatic usage)

BEGIN;

-- ── auth_users ───────────────────────────────────────────────────────────────
ALTER TABLE auth_users
  ALTER COLUMN created_at TYPE TIMESTAMPTZ
    USING created_at AT TIME ZONE 'UTC';

-- ── auth_refresh_tokens ──────────────────────────────────────────────────────
ALTER TABLE auth_refresh_tokens
  ALTER COLUMN expires_at TYPE TIMESTAMPTZ
    USING expires_at AT TIME ZONE 'UTC',
  ALTER COLUMN created_at TYPE TIMESTAMPTZ
    USING created_at AT TIME ZONE 'UTC';

-- ── hud_sessions ─────────────────────────────────────────────────────────────
ALTER TABLE hud_sessions
  ALTER COLUMN created_at TYPE TIMESTAMPTZ
    USING created_at AT TIME ZONE 'UTC',
  ALTER COLUMN updated_at TYPE TIMESTAMPTZ
    USING updated_at AT TIME ZONE 'UTC';

-- ── hud_transcript_entries ───────────────────────────────────────────────────
ALTER TABLE hud_transcript_entries
  ALTER COLUMN timestamp TYPE TIMESTAMPTZ
    USING timestamp AT TIME ZONE 'UTC';

-- ── hud_prompt_suggestions ───────────────────────────────────────────────────
ALTER TABLE hud_prompt_suggestions
  ALTER COLUMN timestamp TYPE TIMESTAMPTZ
    USING timestamp AT TIME ZONE 'UTC';

-- ── hud_tags ─────────────────────────────────────────────────────────────────
ALTER TABLE hud_tags
  ALTER COLUMN created_at TYPE TIMESTAMPTZ
    USING created_at AT TIME ZONE 'UTC';

-- ── hud_events ───────────────────────────────────────────────────────────────
ALTER TABLE hud_events
  ALTER COLUMN timestamp TYPE TIMESTAMPTZ
    USING timestamp AT TIME ZONE 'UTC';

COMMIT;
