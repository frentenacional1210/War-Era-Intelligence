PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS countries (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, country_id TEXT, code TEXT,
  source_url TEXT NOT NULL, updated_at TEXT NOT NULL, first_seen TEXT NOT NULL,
  hash TEXT NOT NULL, data_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS regions (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, country_id TEXT, code TEXT,
  source_url TEXT NOT NULL, updated_at TEXT NOT NULL, first_seen TEXT NOT NULL,
  hash TEXT NOT NULL, data_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS players (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, country_id TEXT,
  level INTEGER, experience INTEGER, last_active_at TEXT, party_id TEXT, military_unit_id TEXT,
  source_url TEXT NOT NULL, updated_at TEXT NOT NULL, first_seen TEXT NOT NULL,
  hash TEXT NOT NULL, data_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS parties (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, country_id TEXT,
  leader_id TEXT, member_count INTEGER,
  source_url TEXT NOT NULL, updated_at TEXT NOT NULL, first_seen TEXT NOT NULL,
  hash TEXT NOT NULL, data_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS military_units (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, country_id TEXT,
  leader_id TEXT, member_count INTEGER, level INTEGER,
  source_url TEXT NOT NULL, updated_at TEXT NOT NULL, first_seen TEXT NOT NULL,
  hash TEXT NOT NULL, data_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS battles (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, country_id TEXT,
  is_active INTEGER, attacker_country_id TEXT, defender_country_id TEXT, region_id TEXT,
  source_url TEXT NOT NULL, updated_at TEXT NOT NULL, first_seen TEXT NOT NULL,
  hash TEXT NOT NULL, data_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS articles (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, country_id TEXT,
  title TEXT NOT NULL, author_id TEXT, published_at TEXT, language TEXT, category TEXT,
  source_url TEXT NOT NULL, updated_at TEXT NOT NULL, first_seen TEXT NOT NULL,
  hash TEXT NOT NULL, data_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS companies (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, country_id TEXT,
  owner_id TEXT, item_code TEXT, level INTEGER,
  source_url TEXT NOT NULL, updated_at TEXT NOT NULL, first_seen TEXT NOT NULL,
  hash TEXT NOT NULL, data_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS market_items (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, country_id TEXT,
  source_url TEXT NOT NULL, updated_at TEXT NOT NULL, first_seen TEXT NOT NULL,
  hash TEXT NOT NULL, data_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS market_prices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id TEXT NOT NULL REFERENCES market_items(id), country_id TEXT,
  price REAL NOT NULL CHECK (price >= 0), captured_at TEXT NOT NULL,
  source_url TEXT NOT NULL,
  UNIQUE(item_id, country_id, captured_at)
);
CREATE TABLE IF NOT EXISTS entity_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
  captured_at TEXT NOT NULL, hash TEXT NOT NULL, data_json TEXT NOT NULL,
  UNIQUE(entity_type, entity_id, captured_at)
);
CREATE TABLE IF NOT EXISTS source_registry (
  id TEXT PRIMARY KEY, endpoint TEXT NOT NULL, status TEXT NOT NULL,
  last_success TEXT, last_attempt TEXT, last_error TEXT,
  interval_seconds INTEGER NOT NULL CHECK(interval_seconds >= 60),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  record_count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS ingestion_cursors (
  source_id TEXT PRIMARY KEY REFERENCES source_registry(id),
  cursor TEXT, next_run_at TEXT NOT NULL, lease_until TEXT
);
CREATE TABLE IF NOT EXISTS ingestion_runs (
  id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES source_registry(id),
  started_at TEXT NOT NULL, finished_at TEXT, status TEXT NOT NULL,
  records_count INTEGER NOT NULL DEFAULT 0, error TEXT, duration_ms INTEGER
);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, country_id TEXT, event_type TEXT,
  source_url TEXT NOT NULL, updated_at TEXT NOT NULL, first_seen TEXT NOT NULL,
  hash TEXT NOT NULL, data_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS alerts (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, country_id TEXT, severity TEXT,
  source_url TEXT NOT NULL, updated_at TEXT NOT NULL, first_seen TEXT NOT NULL,
  hash TEXT NOT NULL, data_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_players_country_name ON players(country_id,name);
CREATE INDEX IF NOT EXISTS idx_players_level ON players(level DESC);
CREATE INDEX IF NOT EXISTS idx_regions_country ON regions(country_id);
CREATE INDEX IF NOT EXISTS idx_parties_country ON parties(country_id,name);
CREATE INDEX IF NOT EXISTS idx_units_country ON military_units(country_id,name);
CREATE INDEX IF NOT EXISTS idx_battles_active ON battles(is_active,updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_articles_published ON articles(published_at DESC);
CREATE INDEX IF NOT EXISTS idx_articles_author ON articles(author_id,published_at DESC);
CREATE INDEX IF NOT EXISTS idx_market_prices_item_time ON market_prices(item_id,captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_snapshots_entity_time ON entity_snapshots(entity_type,entity_id,captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_cursors_due ON ingestion_cursors(next_run_at,lease_until);
CREATE INDEX IF NOT EXISTS idx_runs_source_time ON ingestion_runs(source_id,started_at DESC);

CREATE VIEW IF NOT EXISTS player_snapshots AS
 SELECT entity_id player_id,captured_at,hash,data_json FROM entity_snapshots WHERE entity_type='players';
CREATE VIEW IF NOT EXISTS battle_snapshots AS
 SELECT entity_id battle_id,captured_at,hash,data_json FROM entity_snapshots WHERE entity_type='battles';
CREATE VIEW IF NOT EXISTS party_snapshots AS
 SELECT entity_id party_id,captured_at,hash,data_json FROM entity_snapshots WHERE entity_type='parties';
CREATE VIEW IF NOT EXISTS military_unit_snapshots AS
 SELECT entity_id unit_id,captured_at,hash,data_json FROM entity_snapshots WHERE entity_type='military-units';

INSERT OR IGNORE INTO source_registry(id,endpoint,status,interval_seconds,enabled) VALUES
 ('countries','country.getAllCountries','pending',86400,1),
 ('regions','region.getRegionsObject','pending',21600,1),
 ('players','user.getUsersByCountry + user.getUserLite','pending',3600,1),
 ('parties','party.getManyPaginated','pending',3600,1),
 ('military-units','mu.getManyPaginated','pending',3600,1),
 ('battles','battle.getBattles','pending',120,1),
 ('articles','article.getArticlesPaginated','pending',300,1),
 ('markets','itemTrading.getPrices','pending',600,1),
 ('events','none','derived-not-implemented',86400,0),
 ('alerts','none','derived-not-implemented',86400,0),
 ('companies','company.getCompanies','unavailable-unverified',86400,0);
INSERT OR IGNORE INTO ingestion_cursors(source_id,next_run_at)
 SELECT id, '1970-01-01T00:00:00.000Z' FROM source_registry;
