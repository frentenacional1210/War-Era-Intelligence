-- Latest observed public top of book only. These listings are not trades or a complete order book.
CREATE TABLE IF NOT EXISTS orderbook_snapshots (
  id TEXT PRIMARY KEY REFERENCES market_items(id),
  name TEXT NOT NULL, country_id TEXT,
  source_url TEXT NOT NULL, updated_at TEXT NOT NULL, first_seen TEXT NOT NULL,
  hash TEXT NOT NULL, data_json TEXT NOT NULL
);
INSERT OR IGNORE INTO source_registry(id,endpoint,status,interval_seconds,enabled)
  VALUES('orderbooks','tradingOrder.getTopOrders','pending',86400,1);
INSERT OR IGNORE INTO ingestion_cursors(source_id,next_run_at)
  VALUES('orderbooks','1970-01-01T00:00:00.000Z');
UPDATE source_registry SET record_count=(SELECT COUNT(*) FROM orderbook_snapshots) WHERE id='orderbooks';
CREATE TRIGGER IF NOT EXISTS count_orderbooks_insert AFTER INSERT ON orderbook_snapshots BEGIN
  UPDATE source_registry SET record_count=record_count+1 WHERE id='orderbooks';
END;
CREATE TRIGGER IF NOT EXISTS count_orderbooks_delete AFTER DELETE ON orderbook_snapshots BEGIN
  UPDATE source_registry SET record_count=MAX(0,record_count-1) WHERE id='orderbooks';
END;
