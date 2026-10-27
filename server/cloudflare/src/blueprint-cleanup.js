import { ApiError, now, randomId } from './shared.js';
import { storageBinding } from './blueprint-store.js';

export const BLUEPRINT_GRACE_SECONDS = 86400;
export const CLEANUP_CRON = '*/15 * * * *';
const placeholders = values => values.map(() => '?').join(',');

// Before any object access, reserve a day for this upload. A generation fences
// requests that stall across deletion and a later re-upload of the same hash.
export async function holdBlueprint(db, hash, timestamp = now()) {
  const row = await db.prepare(`INSERT INTO blueprint_lifecycle(hash,unused_since,hold_until) VALUES(?,?,?)
    ON CONFLICT(hash) DO UPDATE SET state='ready',
    generation=blueprint_lifecycle.generation+CASE WHEN blueprint_lifecycle.state='deleted' THEN 1 ELSE 0 END,
    hold_until=max(blueprint_lifecycle.hold_until,excluded.hold_until),
    unused_since=CASE WHEN blueprint_lifecycle.state='deleted' THEN excluded.unused_since ELSE blueprint_lifecycle.unused_since END
    WHERE blueprint_lifecycle.state<>'deleting' RETURNING generation`)
    .bind(hash,timestamp,timestamp+BLUEPRINT_GRACE_SECONDS).first();
  if (!row) throw new ApiError(409, 'BP 저장소를 정리 중입니다. 잠시 후 다시 업로드하세요.');
  return row.generation;
}

export async function cleanupBlueprints(env, db = env.DB.withSession('first-primary'), timestamp = now()) {
  if (env.BLUEPRINT_CLEANUP !== 'true') return { disabled:true };
  const token=randomId();
  const lock=await db.prepare(`UPDATE blueprint_gc_runs SET token=?,lease_until=?
    WHERE id=1 AND lease_until<=? RETURNING id`).bind(token,timestamp+3600,timestamp).first();
  if (!lock) return { busy:true };
  // One-hour lease outlives the 15-minute maximum scheduled invocation. Keep it
  // on failure so remote deletes cannot overlap a subsequent collector.
  let stage='start',copies=0,bytes=0;
  const trim=()=>db.prepare(`DELETE FROM blueprint_gc_history WHERE id IN
    (SELECT id FROM blueprint_gc_history ORDER BY started DESC,id DESC LIMIT -1 OFFSET 100)`);
  try {
    await db.batch([
      db.prepare("UPDATE blueprint_gc_history SET status='interrupted',finished=?,error='interrupted' WHERE status='running'").bind(timestamp),
      db.prepare("INSERT INTO blueprint_gc_history(id,started,status) VALUES(?,?,'running')").bind(token,timestamp),
    ]);
    stage='claim';
    const candidates=(await db.prepare(`UPDATE blueprint_lifecycle SET state='deleting'
      WHERE hash IN (SELECT hash FROM blueprint_lifecycle
        WHERE state='deleting' OR (state='ready' AND unused_since<=? AND hold_until<=?)
        ORDER BY CASE state WHEN 'deleting' THEN 0 ELSE 1 END,unused_since,hash LIMIT 20)
      AND NOT EXISTS(SELECT 1 FROM blueprint_references r WHERE r.hash=blueprint_lifecycle.hash)
      RETURNING hash`).bind(timestamp-BLUEPRINT_GRACE_SECONDS,timestamp).all()).results.map(r=>r.hash);
    const finish=[];
    if(candidates.length) {
      const keys=candidates.map(hash=>'blueprints/'+hash+'.blueprint'),marks=placeholders(keys);
      stage='inspect';
      const items=(await db.prepare(`SELECT l.hash,b.size,
        coalesce((SELECT min(name) FROM blueprint_library WHERE hash=l.hash),'BP '||substr(l.hash,1,12)) AS name
        FROM blueprint_lifecycle l LEFT JOIN blueprints b ON b.hash=l.hash WHERE l.hash IN (${marks}) ORDER BY l.hash`)
        .bind(...candidates).all()).results;
      await db.prepare('UPDATE blueprint_gc_history SET selected_count=?,items=? WHERE id=?')
        .bind(candidates.length,JSON.stringify(items),token).run();
      const locations=(await db.prepare(`SELECT DISTINCT storage FROM blueprint_locations WHERE key IN (${marks})`).bind(...keys).all()).results;
      const bindings=Object.keys(env).filter(name=>storageBinding(name)&&env[name]);
      for(const row of locations)if(!bindings.includes(row.storage))throw Error('Missing BP binding during cleanup');
      stage='delete';
      for(const binding of bindings) {
        const storage=binding==='DB'?db:env[binding].withSession('first-primary');
        const removed=await storage.prepare(`DELETE FROM blueprint_objects WHERE key IN (${marks}) RETURNING key,compressed_size`).bind(...keys).run();
        copies+=removed.results.length;bytes+=removed.results.reduce((sum,r)=>sum+r.compressed_size,0);
        // Confirmed compressed payload bytes, not a claim about physical DB
        // shrinkage. Retrying a partial deletion counts only remaining copies.
        await db.prepare('UPDATE blueprint_gc_history SET confirmed_copies=?,confirmed_bytes=? WHERE id=?')
          .bind(copies,bytes,token).run();
      }
      finish.push(
        db.prepare(`DELETE FROM blueprint_library WHERE hash IN (${marks})`).bind(...candidates),
        db.prepare(`DELETE FROM blueprint_locations WHERE key IN (${marks})`).bind(...keys),
        db.prepare(`UPDATE blueprint_lifecycle SET state='deleted' WHERE hash IN (${marks}) AND state='deleting'`).bind(...candidates),
        db.prepare("UPDATE blueprint_gc_history SET status='completed',finished=?,deleted_count=? WHERE id=?")
          .bind(Math.max(timestamp,now()),candidates.length,token));
    }else finish.push(db.prepare('DELETE FROM blueprint_gc_history WHERE id=?').bind(token));
    stage='finalize';
    finish.push(db.prepare(`UPDATE blueprint_gc_runs SET lease_until=0,last_finished=?,last_deleted=?
      WHERE id=1 AND token=?`).bind(timestamp,candidates.length,token),trim());
    await db.batch(finish);
    return { deleted:candidates.length };
  }catch(error){
    try {
      await db.batch([db.prepare(`UPDATE blueprint_gc_history SET status='failed',finished=?,error=?,confirmed_copies=?,confirmed_bytes=?
        WHERE id=? AND status='running'`).bind(Math.max(timestamp,now()),stage,copies,bytes,token),trim()]);
    }catch { /* Leave the running row for the next collector to mark interrupted. */ }
    throw error;
  }
}
