CREATE TABLE IF NOT EXISTS batches (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  file_name TEXT NOT NULL,
  periodicity TEXT NOT NULL,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved')),
  row_count INTEGER NOT NULL,
  duplicate_count INTEGER NOT NULL DEFAULT 0,
  out_of_period_count INTEGER NOT NULL DEFAULT 0,
  imported_at TEXT NOT NULL,
  approved_at TEXT,
  rule_version TEXT NOT NULL DEFAULT 'v1'
);

CREATE TABLE IF NOT EXISTS records (
  id TEXT PRIMARY KEY NOT NULL,
  batch_id TEXT NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  fingerprint TEXT NOT NULL UNIQUE,
  event_date TEXT NOT NULL,
  branch TEXT NOT NULL DEFAULT '',
  process TEXT NOT NULL DEFAULT '',
  client_code TEXT NOT NULL,
  client_name TEXT NOT NULL,
  destination_code TEXT NOT NULL,
  destination_name TEXT NOT NULL,
  weight REAL NOT NULL DEFAULT 0,
  value REAL NOT NULL,
  FOREIGN KEY (batch_id) REFERENCES batches(id)
);

CREATE INDEX IF NOT EXISTS idx_records_batch_id ON records(batch_id);
CREATE INDEX IF NOT EXISTS idx_records_client_destination ON records(client_code, destination_code);
CREATE INDEX IF NOT EXISTS idx_records_event_date ON records(event_date);

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  direction TEXT NOT NULL,
  status TEXT NOT NULL,
  message TEXT,
  created_at TEXT NOT NULL
);
