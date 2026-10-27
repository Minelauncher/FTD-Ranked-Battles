-- Existing pending tickets get at least 30 minutes from this upgrade. Their
-- opponent, seed, fleet and rating snapshots remain unchanged.
UPDATE matches SET ticket=json_set(ticket,'$.expiresAt',max(
  created+max(1800,coalesce(json_extract(ticket,'$.rules.duration'),json_extract(ticket,'$.duration'),600)*3),
  unixepoch()+1800)) WHERE status='pending' AND json_extract(ticket,'$.expiresAt') IS NULL;
CREATE INDEX IF NOT EXISTS pending_match_deadlines ON matches(json_extract(ticket,'$.expiresAt')) WHERE status='pending';
WITH parts AS (
  SELECT id,CAST(minimum_version AS INTEGER) AS major,
    substr(minimum_version,instr(minimum_version,'.')+1) AS rest FROM client_policy
), versions AS (
  SELECT id,major,CAST(rest AS INTEGER) AS minor,
    CAST(substr(rest,instr(rest,'.')+1) AS INTEGER) AS patch FROM parts
)
UPDATE client_policy SET minimum_version='0.6.3',revision=revision+1
  WHERE id IN (SELECT id FROM versions WHERE major=0 AND (minor<6 OR (minor=6 AND patch<3)));
UPDATE schema_meta SET version=13 WHERE id=1;
