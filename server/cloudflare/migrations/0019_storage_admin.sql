CREATE TABLE blueprint_gc_history (
 id TEXT PRIMARY KEY,
 started REAL NOT NULL,
 finished REAL,
 status TEXT NOT NULL CHECK(status IN ('running','completed','failed','interrupted')),
 selected_count INTEGER NOT NULL DEFAULT 0,
 deleted_count INTEGER NOT NULL DEFAULT 0,
 confirmed_copies INTEGER NOT NULL DEFAULT 0,
 confirmed_bytes INTEGER NOT NULL DEFAULT 0,
 items TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(items)),
 error TEXT
);
CREATE INDEX blueprint_gc_history_time ON blueprint_gc_history(started DESC,id DESC);
CREATE INDEX blueprint_library_hash ON blueprint_library(hash,owner);
UPDATE schema_meta SET version=19 WHERE id=1;
