-- RunCoachAI cloud schema (D1 / SQLite).
-- Derived rows only (runs, daily metrics, plans). HealthKit caches are never synced —
-- they recompute on-device. `json` columns hold the app's existing
-- RunWorkout / CoachSnapshot / CoachPlan blobs verbatim, so types can evolve freely.

-- Users — athletes and coaches share one table; `role` distinguishes capability.
CREATE TABLE IF NOT EXISTS users (
  id         TEXT PRIMARY KEY,
  email      TEXT NOT NULL UNIQUE,
  pw_hash    TEXT NOT NULL,                       -- pbkdf2$<iters>$<salt>$<hash>
  role       TEXT NOT NULL DEFAULT 'athlete',     -- 'athlete' | 'coach'
  name       TEXT,
  created_at INTEGER NOT NULL                      -- unix seconds
);

-- Refresh tokens — stored HASHED (sha-256), rotated on every use.
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_refresh_user ON refresh_tokens(user_id);

-- Coach <-> athlete links (used from Milestone 2).
CREATE TABLE IF NOT EXISTS coach_links (
  id          TEXT PRIMARY KEY,
  coach_id    TEXT,
  athlete_id  TEXT,
  status      TEXT NOT NULL DEFAULT 'pending',     -- 'pending' | 'accepted'
  invite_code TEXT UNIQUE,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_links_coach   ON coach_links(coach_id);
CREATE INDEX IF NOT EXISTS idx_links_athlete ON coach_links(athlete_id);

-- One row per athlete per run (full RunWorkout/analysis blob in json).
CREATE TABLE IF NOT EXISTS runs (
  id         TEXT NOT NULL,                        -- HealthKit uuid
  athlete_id TEXT NOT NULL,
  date       TEXT NOT NULL,                        -- ISO start
  json       TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (athlete_id, id)
);
CREATE INDEX IF NOT EXISTS idx_runs_athlete_date ON runs(athlete_id, date);

-- One row per athlete per day: derived daily metrics + full blob in json.
CREATE TABLE IF NOT EXISTS athlete_days (
  athlete_id TEXT NOT NULL,
  date       TEXT NOT NULL,                        -- YYYY-MM-DD
  recovery   REAL,
  strain     REAL,
  ctl        REAL,
  atl        REAL,
  tsb        REAL,
  sleep_min  INTEGER,
  hrv        REAL,
  rhr        REAL,
  json       TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (athlete_id, date)
);

-- One prescription per athlete per day (CoachPlan + WatchWorkout blob in json).
CREATE TABLE IF NOT EXISTS plans (
  athlete_id TEXT NOT NULL,
  date       TEXT NOT NULL,                        -- YYYY-MM-DD
  source     TEXT NOT NULL DEFAULT 'coach',        -- 'self' (LLM) | 'coach'
  author_id  TEXT,
  json       TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (athlete_id, date)
);
