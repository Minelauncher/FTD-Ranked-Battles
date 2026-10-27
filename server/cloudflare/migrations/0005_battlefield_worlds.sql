-- Existing entries and pending tickets retain their rules. Missing world on old
-- tickets means Neter, the only world supported by previous clients.
UPDATE tournaments SET rules=json_set(rules,'$.world','neter')
  WHERE json_type(rules,'$.world') IS NULL;
UPDATE client_policy SET minimum_version='0.4.2',revision=revision+1
  WHERE minimum_version IN ('0.4.0','0.4.1');
UPDATE schema_meta SET version=5 WHERE id=1;
