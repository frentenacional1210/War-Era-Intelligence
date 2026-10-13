-- Public WarEra company, country election, and government records. Existing rows and cursors are retained.
CREATE TABLE IF NOT EXISTS elections (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, country_id TEXT NOT NULL,
  election_type TEXT, status TEXT, votes_count INTEGER CHECK(votes_count >= 0),
  is_active INTEGER CHECK(is_active IN (0,1)), votes_start_at TEXT, votes_end_at TEXT,
  elected_count INTEGER CHECK(elected_count >= 0),
  source_url TEXT NOT NULL, updated_at TEXT NOT NULL, first_seen TEXT NOT NULL,
  hash TEXT NOT NULL, data_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS governments (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, country_id TEXT NOT NULL,
  president_id TEXT, vice_president_id TEXT, congress_count INTEGER CHECK(congress_count >= 0),
  source_url TEXT NOT NULL, updated_at TEXT NOT NULL, first_seen TEXT NOT NULL,
  hash TEXT NOT NULL, data_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_elections_country_dates ON elections(country_id,votes_start_at DESC,id);
CREATE INDEX IF NOT EXISTS idx_governments_country ON governments(country_id,updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_companies_owner ON companies(owner_id,id);
CREATE INDEX IF NOT EXISTS idx_companies_item ON companies(item_code,id);
CREATE TRIGGER IF NOT EXISTS count_companies_insert AFTER INSERT ON companies BEGIN UPDATE source_registry SET record_count=record_count+1 WHERE id='companies'; END;
CREATE TRIGGER IF NOT EXISTS count_companies_delete AFTER DELETE ON companies BEGIN UPDATE source_registry SET record_count=MAX(0,record_count-1) WHERE id='companies'; END;
CREATE TRIGGER IF NOT EXISTS count_elections_insert AFTER INSERT ON elections BEGIN UPDATE source_registry SET record_count=record_count+1 WHERE id='elections'; END;
CREATE TRIGGER IF NOT EXISTS count_elections_delete AFTER DELETE ON elections BEGIN UPDATE source_registry SET record_count=MAX(0,record_count-1) WHERE id='elections'; END;
CREATE TRIGGER IF NOT EXISTS count_governments_insert AFTER INSERT ON governments BEGIN UPDATE source_registry SET record_count=record_count+1 WHERE id='governments'; END;
CREATE TRIGGER IF NOT EXISTS count_governments_delete AFTER DELETE ON governments BEGIN UPDATE source_registry SET record_count=MAX(0,record_count-1) WHERE id='governments'; END;

UPDATE source_registry SET endpoint='company.getCompanies + company.getById',status='pending',interval_seconds=86400,enabled=1
 WHERE id='companies' AND status='unavailable-unverified';
INSERT OR IGNORE INTO source_registry(id,endpoint,status,interval_seconds,enabled) VALUES
 ('elections','election.getElections(countryId)','pending',86400,1),
 ('governments','government.getByCountryId','pending',86400,1);
INSERT OR IGNORE INTO ingestion_cursors(source_id,next_run_at)
 SELECT id,'1970-01-01T00:00:00.000Z' FROM source_registry WHERE id IN ('companies','elections','governments');
UPDATE source_registry SET record_count=(SELECT COUNT(*) FROM companies) WHERE id='companies';
UPDATE source_registry SET record_count=(SELECT COUNT(*) FROM elections) WHERE id='elections';
UPDATE source_registry SET record_count=(SELECT COUNT(*) FROM governments) WHERE id='governments';
