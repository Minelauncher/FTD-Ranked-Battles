CREATE TABLE tournament_ratings (
  tournament TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  owner TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  rating REAL NOT NULL DEFAULT 1000 CHECK(rating >= 0),
  games INTEGER NOT NULL DEFAULT 0 CHECK(games >= 0),
  PRIMARY KEY(tournament,owner)
);
CREATE INDEX tournament_ladder ON tournament_ratings(tournament,rating DESC,owner);
-- One-time transfer. Stock belongs to its own event; human trial ratings belong
-- to the original 100k event. New events start from 1000 independently.
INSERT INTO tournament_ratings(tournament,owner,rating,games)
 SELECT 'standard-100k',a.id,a.rating,a.games FROM accounts a
 WHERE NOT EXISTS(SELECT 1 FROM system_opponents s WHERE s.owner=a.id)
 AND EXISTS(SELECT 1 FROM tournaments WHERE id='standard-100k');
INSERT INTO tournament_ratings(tournament,owner,rating,games)
 SELECT s.tournament,a.id,a.rating,a.games FROM system_opponents s JOIN accounts a ON a.id=s.owner;
INSERT INTO tournament_ratings(tournament,owner)
 SELECT tournament,owner FROM tournament_entries WHERE 1 ON CONFLICT DO NOTHING;
-- Pre-event trial history is assigned once, not supported as a second live ladder.
UPDATE matches SET tournament='standard-100k' WHERE tournament IS NULL;
UPDATE matches SET ticket=json_set(ticket,'$.tournament.id',tournament),
 receipt=CASE WHEN receipt IS NULL THEN NULL ELSE json_set(receipt,'$.tournamentId',tournament) END;
DROP INDEX ranked_accounts;
DROP INDEX eligible_opponents;
DROP INDEX accounts_bp;
ALTER TABLE accounts DROP COLUMN rating;
ALTER TABLE accounts DROP COLUMN games;
ALTER TABLE accounts DROP COLUMN bp_hash;
ALTER TABLE accounts DROP COLUMN bp_name;
ALTER TABLE accounts DROP COLUMN bp_updated;
CREATE INDEX tournament_history ON matches(owner,tournament,status,created DESC,id);
WITH p AS (SELECT id,CAST(minimum_version AS INTEGER) major,substr(minimum_version,instr(minimum_version,'.')+1) rest FROM client_policy)
UPDATE client_policy SET minimum_version='0.6.9',revision=revision+1 WHERE id IN
 (SELECT id FROM p WHERE major=0 AND (CAST(rest AS INTEGER)<6 OR
 (CAST(rest AS INTEGER)=6 AND CAST(substr(rest,instr(rest,'.')+1) AS INTEGER)<9)));
UPDATE schema_meta SET version=15 WHERE id=1;
