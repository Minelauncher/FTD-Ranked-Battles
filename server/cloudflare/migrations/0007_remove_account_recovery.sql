-- Remove automated recovery while retaining IDs, credentials, sessions and game data.
ALTER TABLE accounts DROP COLUMN recovery_hash;
UPDATE client_policy SET minimum_version='0.5.1',revision=revision+1
 WHERE minimum_version IN ('0.4.0','0.4.1','0.4.2','0.4.3','0.5.0');
UPDATE schema_meta SET version=7 WHERE id=1;
