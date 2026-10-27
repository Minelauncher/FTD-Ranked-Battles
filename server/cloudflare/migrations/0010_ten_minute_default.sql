-- Only the stock five-minute tournament is extended. Administrator-defined
-- durations and other tournaments are preserved. Issued tickets are immutable.
-- Duration alone does not invalidate a fleet: carry current entries forward,
-- without changing their content, rating, submission time or replacement clock.
UPDATE tournament_entries SET revision=revision+1
  WHERE tournament='standard-100k' AND revision=(
    SELECT revision FROM tournaments WHERE id='standard-100k'
      AND json_extract(rules,'$.duration')=300
  );
UPDATE tournaments SET rules=json_set(rules,'$.duration',600),
  revision=revision+1,updated=unixepoch()
  WHERE id='standard-100k' AND json_extract(rules,'$.duration')=300;
UPDATE schema_meta SET version=10 WHERE id=1;
