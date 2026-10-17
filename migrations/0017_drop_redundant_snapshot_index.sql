-- idx_snapshots_entity_time duplicates the UNIQUE(entity_type,entity_id,captured_at)
-- index, which SQLite scans in either direction. Dropping it saves one write per
-- snapshot under the daily ingestion budget; no row or query result changes.
DROP INDEX IF EXISTS idx_snapshots_entity_time;
