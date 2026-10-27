-- statement-break
-- Keep small historical catalog rows: completed matches still refer to hashes.
-- Only raw objects, chunks and unused library entries are garbage collected.
CREATE TABLE blueprint_lifecycle (
 hash TEXT PRIMARY KEY CHECK(length(hash)=64),
 state TEXT NOT NULL DEFAULT 'ready' CHECK(state IN ('ready','deleting','deleted')),
 generation INTEGER NOT NULL DEFAULT 1,
 unused_since REAL,
 hold_until REAL NOT NULL DEFAULT 0
);
-- statement-break
CREATE INDEX blueprint_gc_candidates ON blueprint_lifecycle(state,unused_since,hold_until);
-- statement-break
CREATE TABLE blueprint_references (
 hash TEXT NOT NULL REFERENCES blueprints(hash),
 kind TEXT NOT NULL CHECK(kind IN ('entry','match')),
 reference TEXT NOT NULL,
 PRIMARY KEY(hash,kind,reference)
);
-- statement-break
CREATE INDEX blueprint_ref_source ON blueprint_references(kind,reference);
-- statement-break
CREATE TABLE blueprint_gc_runs (
 id INTEGER PRIMARY KEY CHECK(id=1),
 token TEXT NOT NULL DEFAULT '',
 lease_until REAL NOT NULL DEFAULT 0,
 last_finished REAL,
 last_deleted INTEGER NOT NULL DEFAULT 0
);
-- statement-break
INSERT INTO blueprint_gc_runs(id) VALUES(1);
-- statement-break
INSERT INTO blueprint_lifecycle(hash,unused_since,hold_until)
 SELECT hash,unixepoch(),unixepoch()+86400 FROM blueprints;
-- statement-break
CREATE TRIGGER blueprint_catalog_created AFTER INSERT ON blueprints BEGIN
 INSERT INTO blueprint_lifecycle(hash,unused_since,hold_until)
 VALUES(NEW.hash,unixepoch(),unixepoch()+86400) ON CONFLICT DO NOTHING;
END;
-- statement-break
CREATE TRIGGER blueprint_ref_guard BEFORE INSERT ON blueprint_references BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM blueprint_lifecycle WHERE hash=NEW.hash AND state='ready')
 THEN RAISE(ABORT,'BP_UNAVAILABLE') END;
END;
-- statement-break
CREATE TRIGGER blueprint_ref_added AFTER INSERT ON blueprint_references BEGIN
 UPDATE blueprint_lifecycle SET unused_since=NULL WHERE hash=NEW.hash;
END;
-- statement-break
CREATE TRIGGER blueprint_ref_removed AFTER DELETE ON blueprint_references BEGIN
 UPDATE blueprint_lifecycle SET unused_since=unixepoch() WHERE hash=OLD.hash
 AND NOT EXISTS(SELECT 1 FROM blueprint_references WHERE hash=OLD.hash);
END;
-- statement-break
CREATE TRIGGER blueprint_gc_guard BEFORE UPDATE OF state ON blueprint_lifecycle
 WHEN NEW.state<>'ready' BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM blueprint_references WHERE hash=NEW.hash)
 THEN RAISE(ABORT,'BP_IN_USE') END;
END;
-- statement-break
CREATE TRIGGER blueprint_library_guard BEFORE INSERT ON blueprint_library BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM blueprint_lifecycle WHERE hash=NEW.hash AND state='ready')
 THEN RAISE(ABORT,'BP_UNAVAILABLE') END;
END;
-- statement-break
CREATE TRIGGER blueprint_entry_added AFTER INSERT ON tournament_entries BEGIN
 INSERT INTO blueprint_references(hash,kind,reference)
 SELECT DISTINCT json_extract(value,'$.hash'),'entry',json_array(NEW.tournament,NEW.owner)
 FROM json_each(NEW.fleet,'$.units');
END;
-- statement-break
CREATE TRIGGER blueprint_entry_changed AFTER UPDATE OF fleet,tournament,owner ON tournament_entries BEGIN
 DELETE FROM blueprint_references WHERE kind='entry' AND reference=json_array(OLD.tournament,OLD.owner);
 INSERT INTO blueprint_references(hash,kind,reference)
 SELECT DISTINCT json_extract(value,'$.hash'),'entry',json_array(NEW.tournament,NEW.owner)
 FROM json_each(NEW.fleet,'$.units');
END;
-- statement-break
CREATE TRIGGER blueprint_entry_removed AFTER DELETE ON tournament_entries BEGIN
 DELETE FROM blueprint_references WHERE kind='entry' AND reference=json_array(OLD.tournament,OLD.owner);
END;
-- statement-break
CREATE TRIGGER blueprint_match_added AFTER INSERT ON matches WHEN NEW.status='pending' BEGIN
 INSERT INTO blueprint_references(hash,kind,reference)
 SELECT hash,'match',NEW.id FROM (
 SELECT json_extract(value,'$.hash') AS hash FROM json_each(NEW.ticket,'$.ownerFleet.units')
 UNION SELECT json_extract(value,'$.hash') FROM json_each(NEW.ticket,'$.opponentFleet.units')
 UNION SELECT NEW.owner_hash UNION SELECT NEW.opponent_hash);
END;
-- statement-break
CREATE TRIGGER blueprint_match_changed AFTER UPDATE OF status,ticket,owner_hash,opponent_hash,id ON matches BEGIN
 DELETE FROM blueprint_references WHERE kind='match' AND reference=OLD.id;
 INSERT INTO blueprint_references(hash,kind,reference)
 SELECT hash,'match',NEW.id FROM (
 SELECT json_extract(value,'$.hash') AS hash FROM json_each(NEW.ticket,'$.ownerFleet.units')
 UNION SELECT json_extract(value,'$.hash') FROM json_each(NEW.ticket,'$.opponentFleet.units')
 UNION SELECT NEW.owner_hash UNION SELECT NEW.opponent_hash) WHERE NEW.status='pending';
END;
-- statement-break
CREATE TRIGGER blueprint_match_removed AFTER DELETE ON matches BEGIN
 DELETE FROM blueprint_references WHERE kind='match' AND reference=OLD.id;
END;
-- statement-break
INSERT INTO blueprint_references(hash,kind,reference)
 SELECT DISTINCT json_extract(j.value,'$.hash'),'entry',json_array(e.tournament,e.owner)
 FROM tournament_entries e,json_each(e.fleet,'$.units') j;
-- statement-break
INSERT INTO blueprint_references(hash,kind,reference)
 SELECT hash,'match',id FROM (
 SELECT m.id,json_extract(j.value,'$.hash') AS hash FROM matches m,json_each(m.ticket,'$.ownerFleet.units') j WHERE m.status='pending'
 UNION SELECT m.id,json_extract(j.value,'$.hash') FROM matches m,json_each(m.ticket,'$.opponentFleet.units') j WHERE m.status='pending'
 UNION SELECT id,owner_hash FROM matches WHERE status='pending'
 UNION SELECT id,opponent_hash FROM matches WHERE status='pending');
-- statement-break
UPDATE schema_meta SET version=18 WHERE id=1;
