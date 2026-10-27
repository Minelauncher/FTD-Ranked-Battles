-- No inspection/pass cache: BP originals are inspected on every fleet submission.
UPDATE tournaments SET rules=json_set(rules,'$.bannedBlocks',json('[]'))
  WHERE json_type(rules,'$.bannedBlocks') IS NULL;
-- Old clients do not display block bans. Preserve stricter administrator policies.
UPDATE client_policy SET minimum_version='0.4.1',revision=revision+1
  WHERE minimum_version='0.4.0';
UPDATE schema_meta SET version=4 WHERE id=1;
