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
-- Content-hash de-duplication index (auto-promotion to the Master Catalog).
--
-- Every upload is keyed by the SHA-256 of its bytes. Once the SAME content has
-- been uploaded PROMOTE_THRESHOLD (3) times, the file is stored once in the
-- permanent Master Catalog and every later identical upload returns that link
-- instantly — no re-upload, no extra storage.
--
-- Uses IF NOT EXISTS so re-running this script (to (re)create xerox_queue) does
-- NOT wipe the accumulated catalog index.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS catalog (
  file_hash        TEXT    PRIMARY KEY,        -- SHA-256 hex of the file content
  file_name        TEXT    NOT NULL,           -- last-seen display name
  hit_count        INTEGER NOT NULL DEFAULT 0, -- how many times this content was uploaded
  promoted         INTEGER NOT NULL DEFAULT 0 CHECK (promoted IN (0, 1)),
  catalog_url      TEXT,                        -- Drive link of the permanent copy (when promoted)
  catalog_file_id  TEXT,                        -- Drive file id of the permanent copy
  created_at       TEXT    DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%S', 'NOW', 'localtime')),
  updated_at       TEXT    DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%S', 'NOW', 'localtime'))
);
