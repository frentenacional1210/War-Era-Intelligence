INSERT OR IGNORE INTO source_registry(id,endpoint,status,interval_seconds,enabled) VALUES
 ('events','none','derived-not-implemented',86400,0),
 ('alerts','none','derived-not-implemented',86400,0);
INSERT OR IGNORE INTO ingestion_cursors(source_id,next_run_at)
 SELECT id, '1970-01-01T00:00:00.000Z' FROM source_registry WHERE id IN ('events','alerts');
