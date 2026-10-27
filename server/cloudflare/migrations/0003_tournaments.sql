-- Additive: legacy accounts, matches and BP references stay intact.
CREATE TABLE tournaments (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK(status IN ('open','locked','closed')),
  revision INTEGER NOT NULL CHECK(revision > 0),
  rules TEXT NOT NULL CHECK(json_valid(rules)),
  updated REAL NOT NULL
);
CREATE TABLE blueprint_library (
  owner TEXT NOT NULL REFERENCES accounts(id),
  hash TEXT NOT NULL REFERENCES blueprints(hash),
  name TEXT NOT NULL,
  cost REAL NOT NULL CHECK(cost >= 0),
  created REAL NOT NULL,
  PRIMARY KEY(owner,hash)
);
CREATE TABLE tournament_entries (
  tournament TEXT NOT NULL REFERENCES tournaments(id),
  owner TEXT NOT NULL REFERENCES accounts(id),
  revision INTEGER NOT NULL,
  fleet TEXT NOT NULL CHECK(json_valid(fleet)),
  fingerprint TEXT NOT NULL,
  updated REAL NOT NULL,
  PRIMARY KEY(tournament,owner)
);
ALTER TABLE matches ADD COLUMN tournament TEXT REFERENCES tournaments(id);
CREATE INDEX tournament_matches ON matches(tournament,status,created);
CREATE TABLE client_policy (
  id INTEGER PRIMARY KEY CHECK(id=1),
  minimum_version TEXT NOT NULL,
  minimum_protocol INTEGER NOT NULL CHECK(minimum_protocol>0),
  revision INTEGER NOT NULL
);
INSERT INTO client_policy VALUES(1,'0.4.0',1,1);
INSERT INTO tournaments(id,name,description,status,revision,rules,updated) VALUES(
  'standard-100k','10만 마테리얼 함대전','기체 소환비와 보급 자원의 합계가 팀당 100,000인 비동기 랭크전입니다.','open',1,
  '{"teamBudget":100000,"maxUnits":20,"maxBlueprints":10,"duration":300,"distance":600,"boardEast":1.5,"boardNorth":1.5,"formationHalfWidth":500,"formationDepth":1000,"minAltitude":-100,"maxAltitude":500,"replacementSeconds":86400,"k":32,"resourceDrop":0,"tooDamagedEnabled":true,"tooDamagedFraction":0.55,"sinkingEnabled":true,"sinkingFraction":0.9,"sustainedEnabled":true,"sustainedSeconds":30}',
  unixepoch()
);
UPDATE schema_meta SET version=3 WHERE id=1;
