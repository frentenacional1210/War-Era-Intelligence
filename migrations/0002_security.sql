CREATE TABLE IF NOT EXISTS admin_sessions (
  id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON admin_sessions(expires_at);
CREATE TABLE IF NOT EXISTS request_limits (
  bucket TEXT PRIMARY KEY, hits INTEGER NOT NULL DEFAULT 0, reset_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_limits_expiry ON request_limits(reset_at);
