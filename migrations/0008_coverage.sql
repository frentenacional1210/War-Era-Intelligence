-- Additive progress counters. Never reset a cursor or rewrite a game record.
CREATE TABLE IF NOT EXISTS coverage_country_counts (
  country_id TEXT PRIMARY KEY, players_registered INTEGER NOT NULL DEFAULT 0,
  last_profile_at TEXT
);
INSERT OR IGNORE INTO coverage_country_counts(country_id,players_registered,last_profile_at)
  SELECT country_id,COUNT(*),MAX(updated_at) FROM players WHERE country_id IS NOT NULL GROUP BY country_id;

CREATE TABLE IF NOT EXISTS ingestion_daily_stats (
  day_key TEXT NOT NULL, source_id TEXT NOT NULL,
  new_rows INTEGER NOT NULL DEFAULT 0, updated_rows INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(day_key,source_id)
);
CREATE TABLE IF NOT EXISTS observability_config (
  id TEXT PRIMARY KEY, value TEXT NOT NULL
);
INSERT OR IGNORE INTO observability_config(id,value) VALUES('change_counter_since',strftime('%Y-%m-%dT%H:%M:%fZ','now'));
ALTER TABLE ingestion_budget ADD COLUMN measured_reads INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ingestion_budget ADD COLUMN reserved_reads INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ingestion_budget ADD COLUMN measured_writes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ingestion_budget ADD COLUMN database_bytes INTEGER;
ALTER TABLE ingestion_runs ADD COLUMN rows_read INTEGER;
ALTER TABLE ingestion_runs ADD COLUMN collector_mode TEXT;
ALTER TABLE player_census_state ADD COLUMN recent_tokens TEXT NOT NULL DEFAULT '[]';
CREATE INDEX IF NOT EXISTS idx_runs_time_status ON ingestion_runs(started_at,status);
CREATE INDEX IF NOT EXISTS idx_players_party ON players(party_id,name);
CREATE INDEX IF NOT EXISTS idx_players_unit ON players(military_unit_id,name);
CREATE INDEX IF NOT EXISTS idx_players_activity ON players(last_active_at);

CREATE TRIGGER IF NOT EXISTS coverage_players_insert AFTER INSERT ON players WHEN NEW.country_id IS NOT NULL BEGIN
  INSERT INTO coverage_country_counts(country_id,players_registered,last_profile_at) VALUES(NEW.country_id,1,NEW.updated_at)
  ON CONFLICT(country_id) DO UPDATE SET players_registered=players_registered+1,last_profile_at=MAX(COALESCE(last_profile_at,''),excluded.last_profile_at);
END;
CREATE TRIGGER IF NOT EXISTS coverage_players_delete AFTER DELETE ON players WHEN OLD.country_id IS NOT NULL BEGIN
  UPDATE coverage_country_counts SET players_registered=MAX(0,players_registered-1) WHERE country_id=OLD.country_id;
END;
CREATE TRIGGER IF NOT EXISTS coverage_players_move AFTER UPDATE OF country_id ON players WHEN OLD.country_id IS NOT NEW.country_id BEGIN
  UPDATE coverage_country_counts SET players_registered=MAX(0,players_registered-1) WHERE country_id=OLD.country_id;
  INSERT INTO coverage_country_counts(country_id,players_registered,last_profile_at)
    SELECT NEW.country_id,1,NEW.updated_at WHERE NEW.country_id IS NOT NULL
    ON CONFLICT(country_id) DO UPDATE SET players_registered=players_registered+1,last_profile_at=MAX(COALESCE(last_profile_at,''),excluded.last_profile_at);
END;
CREATE TRIGGER IF NOT EXISTS coverage_players_change AFTER UPDATE ON players WHEN OLD.hash<>NEW.hash AND OLD.country_id IS NEW.country_id BEGIN
  UPDATE coverage_country_counts SET last_profile_at=MAX(COALESCE(last_profile_at,''),NEW.updated_at) WHERE country_id=NEW.country_id;
END;

INSERT OR IGNORE INTO ingestion_daily_stats(day_key,source_id,new_rows,updated_rows) SELECT substr(first_seen,1,10),'countries',COUNT(*),0 FROM countries GROUP BY substr(first_seen,1,10);
CREATE TRIGGER IF NOT EXISTS stats_countries_insert AFTER INSERT ON countries  BEGIN
 INSERT INTO ingestion_daily_stats(day_key,source_id,new_rows) VALUES(strftime('%Y-%m-%d','now'),'countries',1) ON CONFLICT(day_key,source_id) DO UPDATE SET new_rows=new_rows+1;
END;
CREATE TRIGGER IF NOT EXISTS stats_countries_update AFTER UPDATE ON countries WHEN OLD.hash<>NEW.hash BEGIN
 INSERT INTO ingestion_daily_stats(day_key,source_id,updated_rows) VALUES(strftime('%Y-%m-%d','now'),'countries',1) ON CONFLICT(day_key,source_id) DO UPDATE SET updated_rows=updated_rows+1;
END;

INSERT OR IGNORE INTO ingestion_daily_stats(day_key,source_id,new_rows,updated_rows) SELECT substr(first_seen,1,10),'regions',COUNT(*),0 FROM regions GROUP BY substr(first_seen,1,10);
CREATE TRIGGER IF NOT EXISTS stats_regions_insert AFTER INSERT ON regions  BEGIN
 INSERT INTO ingestion_daily_stats(day_key,source_id,new_rows) VALUES(strftime('%Y-%m-%d','now'),'regions',1) ON CONFLICT(day_key,source_id) DO UPDATE SET new_rows=new_rows+1;
END;
CREATE TRIGGER IF NOT EXISTS stats_regions_update AFTER UPDATE ON regions WHEN OLD.hash<>NEW.hash BEGIN
 INSERT INTO ingestion_daily_stats(day_key,source_id,updated_rows) VALUES(strftime('%Y-%m-%d','now'),'regions',1) ON CONFLICT(day_key,source_id) DO UPDATE SET updated_rows=updated_rows+1;
END;

INSERT OR IGNORE INTO ingestion_daily_stats(day_key,source_id,new_rows,updated_rows) SELECT substr(first_seen,1,10),'players',COUNT(*),0 FROM players GROUP BY substr(first_seen,1,10);
CREATE TRIGGER IF NOT EXISTS stats_players_insert AFTER INSERT ON players  BEGIN
 INSERT INTO ingestion_daily_stats(day_key,source_id,new_rows) VALUES(strftime('%Y-%m-%d','now'),'players',1) ON CONFLICT(day_key,source_id) DO UPDATE SET new_rows=new_rows+1;
END;
CREATE TRIGGER IF NOT EXISTS stats_players_update AFTER UPDATE ON players WHEN OLD.hash<>NEW.hash BEGIN
 INSERT INTO ingestion_daily_stats(day_key,source_id,updated_rows) VALUES(strftime('%Y-%m-%d','now'),'players',1) ON CONFLICT(day_key,source_id) DO UPDATE SET updated_rows=updated_rows+1;
END;

INSERT OR IGNORE INTO ingestion_daily_stats(day_key,source_id,new_rows,updated_rows) SELECT substr(first_seen,1,10),'parties',COUNT(*),0 FROM parties GROUP BY substr(first_seen,1,10);
CREATE TRIGGER IF NOT EXISTS stats_parties_insert AFTER INSERT ON parties  BEGIN
 INSERT INTO ingestion_daily_stats(day_key,source_id,new_rows) VALUES(strftime('%Y-%m-%d','now'),'parties',1) ON CONFLICT(day_key,source_id) DO UPDATE SET new_rows=new_rows+1;
END;
CREATE TRIGGER IF NOT EXISTS stats_parties_update AFTER UPDATE ON parties WHEN OLD.hash<>NEW.hash BEGIN
 INSERT INTO ingestion_daily_stats(day_key,source_id,updated_rows) VALUES(strftime('%Y-%m-%d','now'),'parties',1) ON CONFLICT(day_key,source_id) DO UPDATE SET updated_rows=updated_rows+1;
END;

INSERT OR IGNORE INTO ingestion_daily_stats(day_key,source_id,new_rows,updated_rows) SELECT substr(first_seen,1,10),'military-units',COUNT(*),0 FROM military_units GROUP BY substr(first_seen,1,10);
CREATE TRIGGER IF NOT EXISTS stats_military_units_insert AFTER INSERT ON military_units  BEGIN
 INSERT INTO ingestion_daily_stats(day_key,source_id,new_rows) VALUES(strftime('%Y-%m-%d','now'),'military-units',1) ON CONFLICT(day_key,source_id) DO UPDATE SET new_rows=new_rows+1;
END;
CREATE TRIGGER IF NOT EXISTS stats_military_units_update AFTER UPDATE ON military_units WHEN OLD.hash<>NEW.hash BEGIN
 INSERT INTO ingestion_daily_stats(day_key,source_id,updated_rows) VALUES(strftime('%Y-%m-%d','now'),'military-units',1) ON CONFLICT(day_key,source_id) DO UPDATE SET updated_rows=updated_rows+1;
END;

INSERT OR IGNORE INTO ingestion_daily_stats(day_key,source_id,new_rows,updated_rows) SELECT substr(first_seen,1,10),'battles',COUNT(*),0 FROM battles GROUP BY substr(first_seen,1,10);
CREATE TRIGGER IF NOT EXISTS stats_battles_insert AFTER INSERT ON battles  BEGIN
 INSERT INTO ingestion_daily_stats(day_key,source_id,new_rows) VALUES(strftime('%Y-%m-%d','now'),'battles',1) ON CONFLICT(day_key,source_id) DO UPDATE SET new_rows=new_rows+1;
END;
CREATE TRIGGER IF NOT EXISTS stats_battles_update AFTER UPDATE ON battles WHEN OLD.hash<>NEW.hash BEGIN
 INSERT INTO ingestion_daily_stats(day_key,source_id,updated_rows) VALUES(strftime('%Y-%m-%d','now'),'battles',1) ON CONFLICT(day_key,source_id) DO UPDATE SET updated_rows=updated_rows+1;
END;

INSERT OR IGNORE INTO ingestion_daily_stats(day_key,source_id,new_rows,updated_rows) SELECT substr(first_seen,1,10),'articles',COUNT(*),0 FROM articles GROUP BY substr(first_seen,1,10);
CREATE TRIGGER IF NOT EXISTS stats_articles_insert AFTER INSERT ON articles  BEGIN
 INSERT INTO ingestion_daily_stats(day_key,source_id,new_rows) VALUES(strftime('%Y-%m-%d','now'),'articles',1) ON CONFLICT(day_key,source_id) DO UPDATE SET new_rows=new_rows+1;
END;
CREATE TRIGGER IF NOT EXISTS stats_articles_update AFTER UPDATE ON articles WHEN OLD.hash<>NEW.hash BEGIN
 INSERT INTO ingestion_daily_stats(day_key,source_id,updated_rows) VALUES(strftime('%Y-%m-%d','now'),'articles',1) ON CONFLICT(day_key,source_id) DO UPDATE SET updated_rows=updated_rows+1;
END;

INSERT OR IGNORE INTO ingestion_daily_stats(day_key,source_id,new_rows,updated_rows) SELECT substr(first_seen,1,10),'markets',COUNT(*),0 FROM market_items GROUP BY substr(first_seen,1,10);
CREATE TRIGGER IF NOT EXISTS stats_market_items_insert AFTER INSERT ON market_items  BEGIN
 INSERT INTO ingestion_daily_stats(day_key,source_id,new_rows) VALUES(strftime('%Y-%m-%d','now'),'markets',1) ON CONFLICT(day_key,source_id) DO UPDATE SET new_rows=new_rows+1;
END;
CREATE TRIGGER IF NOT EXISTS stats_market_items_update AFTER UPDATE ON market_items WHEN OLD.hash<>NEW.hash BEGIN
 INSERT INTO ingestion_daily_stats(day_key,source_id,updated_rows) VALUES(strftime('%Y-%m-%d','now'),'markets',1) ON CONFLICT(day_key,source_id) DO UPDATE SET updated_rows=updated_rows+1;
END;
