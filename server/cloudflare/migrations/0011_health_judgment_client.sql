-- New tickets use a fixed total-health decision. Do not rewrite old tickets,
-- tournament settings, fleet submissions or ratings. Preserve stricter policies.
WITH parts AS (
  SELECT id,CAST(minimum_version AS INTEGER) AS major,
    substr(minimum_version,instr(minimum_version,'.')+1) AS rest FROM client_policy
), versions AS (
  SELECT id,major,CAST(rest AS INTEGER) AS minor,
    CAST(substr(rest,instr(rest,'.')+1) AS INTEGER) AS patch FROM parts
)
UPDATE client_policy SET minimum_version='0.6.2',revision=revision+1
  WHERE id IN (SELECT id FROM versions WHERE major=0 AND (minor<6 OR (minor=6 AND patch<2)));
UPDATE schema_meta SET version=11 WHERE id=1;
