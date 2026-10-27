CREATE INDEX opponent_event_history ON matches(opponent,tournament,status,created DESC,id);
WITH p AS (SELECT id,CAST(minimum_version AS INTEGER) major,substr(minimum_version,instr(minimum_version,'.')+1) rest FROM client_policy)
UPDATE client_policy SET minimum_version='0.6.10',revision=revision+1 WHERE id IN
 (SELECT id FROM p WHERE major=0 AND (CAST(rest AS INTEGER)<6 OR
 (CAST(rest AS INTEGER)=6 AND CAST(substr(rest,instr(rest,'.')+1) AS INTEGER)<10)));
UPDATE schema_meta SET version=16 WHERE id=1;
