-- Disabled by default. All model access is gated by this row and AI_ENABLED.
CREATE TABLE IF NOT EXISTS ai_config (
  id TEXT PRIMARY KEY CHECK (id='global'),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),
  updated_at TEXT NOT NULL
);
INSERT OR IGNORE INTO ai_config(id,enabled,updated_at) VALUES('global',0,'1970-01-01T00:00:00.000Z');

CREATE TABLE IF NOT EXISTS ai_daily_budget (
  day_key TEXT PRIMARY KEY,
  reserved_neurons INTEGER NOT NULL DEFAULT 0 CHECK (reserved_neurons >= 0),
  request_count INTEGER NOT NULL DEFAULT 0 CHECK (request_count >= 0),
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ai_answer_cache (
  cache_key TEXT PRIMARY KEY,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_cache_expiry ON ai_answer_cache(expires_at);
