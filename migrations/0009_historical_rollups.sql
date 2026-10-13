-- Archiving is incremental: no existing snapshot or price is rewritten here.
CREATE TABLE IF NOT EXISTS history_rollups (
  resource TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  grain TEXT NOT NULL CHECK(grain IN ('day','week','month')),
  bucket_start TEXT NOT NULL,
  first_at TEXT NOT NULL,
  last_at TEXT NOT NULL,
  first_metrics_json TEXT NOT NULL,
  last_metrics_json TEXT NOT NULL,
  observations INTEGER NOT NULL CHECK(observations > 0),
  PRIMARY KEY(resource,entity_id,grain,bucket_start)
);
CREATE INDEX IF NOT EXISTS idx_history_rollups_retention ON history_rollups(grain,bucket_start);

CREATE TABLE IF NOT EXISTS history_baselines (
  resource TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  first_at TEXT NOT NULL,
  metrics_json TEXT NOT NULL,
  PRIMARY KEY(resource,entity_id)
);

-- The old cleanup has no time-leading index. These indexes keep each small
-- archiving batch bounded even when recent raw tables become large.
CREATE INDEX IF NOT EXISTS idx_snapshots_archive_due ON entity_snapshots(captured_at,id);
CREATE INDEX IF NOT EXISTS idx_market_prices_archive_due ON market_prices(captured_at,id);

-- A separate maintenance budget prevents historical compaction from consuming
-- the ingestion reserve. Both reservations share the account's D1 free quota.
CREATE TABLE IF NOT EXISTS history_maintenance_budget (
  day_key TEXT PRIMARY KEY,
  reserved_writes INTEGER NOT NULL DEFAULT 0 CHECK(reserved_writes>=0),
  reserved_reads INTEGER NOT NULL DEFAULT 0 CHECK(reserved_reads>=0),
  measured_writes INTEGER NOT NULL DEFAULT 0 CHECK(measured_writes>=0),
  measured_reads INTEGER NOT NULL DEFAULT 0 CHECK(measured_reads>=0),
  archived_snapshots INTEGER NOT NULL DEFAULT 0 CHECK(archived_snapshots>=0),
  archived_prices INTEGER NOT NULL DEFAULT 0 CHECK(archived_prices>=0),
  tick_count INTEGER NOT NULL DEFAULT 0 CHECK(tick_count>=0),
  updated_at TEXT NOT NULL,
  last_status TEXT,
  last_error TEXT
);
CREATE TABLE IF NOT EXISTS history_maintenance_lock (
  id TEXT PRIMARY KEY CHECK(id='global'), owner TEXT, lease_until TEXT
);
INSERT OR IGNORE INTO history_maintenance_lock(id,owner,lease_until) VALUES('global',NULL,NULL);
