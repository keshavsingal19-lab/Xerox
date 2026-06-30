-- Campus Xerox Token & Print system :: Cloudflare D1 (SQLite) schema
-- Run this once against your D1 database:  npm run db:init
-- (which expands to:  wrangler d1 execute xerox_db --file=./schema.sql)
--
-- Fixed table. Do NOT add columns. Because file_name / file_size are NOT
-- columns, those values live INSIDE the print_specifications JSON string.

DROP TABLE IF EXISTS xerox_queue;

CREATE TABLE xerox_queue (
  token_id            INTEGER PRIMARY KEY CHECK (token_id BETWEEN 100 AND 999),
  student_id          TEXT    NOT NULL,
  drive_viewer_url    TEXT    NOT NULL,
  print_specifications TEXT   NOT NULL,
  calculated_price    REAL    NOT NULL,
  is_printed          INTEGER DEFAULT 0 CHECK (is_printed IN (0, 1)),
  created_at          TEXT    DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%S', 'NOW', 'localtime'))
);

CREATE INDEX idx_created_at ON xerox_queue (created_at);

-- ---------------------------------------------------------------------------
-- Content-hash de-duplication / reuse index.
--
-- Every upload is keyed by the SHA-256 of its bytes:
--   * On first upload the file is parked in Daily Pending and becomes a reusable
--     "master" for 2 HOURS (tier='pending', expires_at = now + 2h). Within that
--     window an identical upload by anyone is served INSTANTLY (no re-upload).
--   * On the 3rd upload of the same content the file is copied into the Master
--     Catalog and kept for 3 DAYS (tier='promoted', expires_at = now + 3 days).
--
-- This table is transient (2h / 3-day lifetimes), so it is DROPPED and recreated
-- on db:init. expires_at / *_seen are local-time 'YYYY-MM-DD HH:MM:SS' strings.
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS catalog;
CREATE TABLE catalog (
  file_hash      TEXT    PRIMARY KEY,            -- SHA-256 hex of the file content
  file_name      TEXT    NOT NULL,
  hit_count      INTEGER NOT NULL DEFAULT 0,     -- total uploads of this content
  drive_url      TEXT,                            -- currently reusable Drive link
  drive_file_id  TEXT,                            -- Drive file id behind that link
  tier           TEXT    NOT NULL DEFAULT 'pending' CHECK (tier IN ('pending','promoted')),
  first_seen     TEXT    DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%S','NOW','localtime')),
  last_seen      TEXT    DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%S','NOW','localtime')),
  expires_at     TEXT                             -- reuse stops being valid after this
);
CREATE INDEX IF NOT EXISTS idx_catalog_expires ON catalog (expires_at);

-- ---------------------------------------------------------------------------
-- Key/value settings — currently holds the shopkeeper-editable pricing model
-- under key='pricing'. PERSISTS across db:init (IF NOT EXISTS) so configured
-- prices survive a schema refresh.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%S','NOW','localtime'))
);
