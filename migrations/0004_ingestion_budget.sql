CREATE TABLE IF NOT EXISTS ingestion_budget (
  day_key TEXT PRIMARY KEY,
  reserved_writes INTEGER NOT NULL DEFAULT 0 CHECK(reserved_writes >= 0),
  tick_count INTEGER NOT NULL DEFAULT 0 CHECK(tick_count >= 0),
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ingestion_lock (
  id TEXT PRIMARY KEY CHECK(id='global'),
  owner TEXT,
  lease_until TEXT
);
INSERT OR IGNORE INTO ingestion_lock(id,owner,lease_until) VALUES('global',NULL,NULL);
