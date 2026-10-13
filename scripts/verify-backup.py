"""Verify an ignored SQL backup in an isolated in-memory SQLite database."""
from pathlib import Path
import hashlib
import json
import sqlite3
import sys
from datetime import datetime, timezone

path = Path(sys.argv[1] if len(sys.argv) > 1 else "artifacts/private/backups/pre-continuation.sql")
allowed = Path("artifacts/private/backups").resolve()
if not path.resolve().is_relative_to(allowed):
    raise ValueError("Backup must remain in the ignored private backup directory")
raw = path.read_bytes()
with sqlite3.connect(":memory:") as db:
    db.executescript(raw.decode("utf-8"))
    if db.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
        raise RuntimeError("Restored backup failed SQLite integrity check")
    if db.execute("PRAGMA foreign_key_check").fetchall():
        raise RuntimeError("Restored backup failed foreign key check")
    tables = ["countries", "regions", "players", "parties", "military_units", "battles", "articles", "entity_snapshots", "market_prices", "ingestion_cursors", "player_census_state"]
    counts = {table: db.execute("SELECT COUNT(*) FROM " + table).fetchone()[0] for table in tables}
evidence = {"verifiedAt": datetime.now(timezone.utc).isoformat(), "restoredInMemory": True, "integrity": "ok", "foreignKeys": "ok", "bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest(), "counts": counts, "productionUnchanged": True}
Path("artifacts/validation/backup.json").write_text(json.dumps(evidence, indent=2) + "\n", encoding="utf-8", newline="\n")
print(json.dumps(evidence))
