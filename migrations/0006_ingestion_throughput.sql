CREATE TABLE IF NOT EXISTS player_census_state (
  country_id TEXT PRIMARY KEY REFERENCES countries(id),
  cursor TEXT,
  next_run_at TEXT NOT NULL,
  last_scanned_at TEXT NOT NULL,
  records_observed INTEGER NOT NULL DEFAULT 0,
  completed_sweeps INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_census_due ON player_census_state(next_run_at,last_scanned_at);
ALTER TABLE ingestion_runs ADD COLUMN rows_written INTEGER;
ALTER TABLE ingestion_runs ADD COLUMN reserved_writes INTEGER;
-- Resume sources paused by the former fixed reservation. Keep today's budget
-- intact: old reservations remain a conservative charge, never reset usage.
UPDATE ingestion_cursors SET next_run_at='1970-01-01T00:00:00.000Z'
 WHERE lease_until IS NULL AND source_id IN
 (SELECT id FROM source_registry WHERE status='quota-paused');
UPDATE source_registry SET status='pending',last_error=NULL WHERE status='quota-paused';
