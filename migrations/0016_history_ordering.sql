-- Existing rollups have no recoverable source row IDs. NULL keeps their
-- recorded value on equal-time conflicts; new rollups track exact ordering.
ALTER TABLE history_rollups ADD COLUMN first_sort_id INTEGER;
ALTER TABLE history_rollups ADD COLUMN last_sort_id INTEGER;
ALTER TABLE history_baselines ADD COLUMN first_sort_id INTEGER;

-- Resume bounded scans past raw snapshots that cannot be projected.
ALTER TABLE history_maintenance_lock ADD COLUMN snapshot_scan_at TEXT;
ALTER TABLE history_maintenance_lock ADD COLUMN snapshot_scan_id INTEGER;
