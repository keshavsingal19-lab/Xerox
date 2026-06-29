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
