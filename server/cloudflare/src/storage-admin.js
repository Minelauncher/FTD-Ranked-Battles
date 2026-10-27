import { ApiError, json, now, objectKey } from './shared.js';
import { storageBinding } from './blueprint-store.js';
import { BLUEPRINT_GRACE_SECONDS } from './blueprint-cleanup.js';

const DB_LIMIT = 500000000;
export async function storageOverview(env, db) {
  const databases=[];
  for(const binding of Object.keys(env).filter(n=>storageBinding(n)&&env[n]).sort((a,b)=>a==='DB'?-1:b==='DB'?1:a.localeCompare(b))) {
    try {
      const source=binding==='DB'?db:env[binding].withSession('first-primary');
      const result=await source.prepare('SELECT count(*) AS objects FROM blueprint_objects').all();
      const bytes=result.meta?.size_after;
      const known=Number.isSafeInteger(bytes)&&bytes>=0;
      databases.push({binding,role:binding==='DB'?'main':'blueprints',writer:binding===(env.BLUEPRINT_WRITE_DB??'DB'),
        available:true,bytes:known?bytes:null,remaining:known?Math.max(0,DB_LIMIT-bytes):null,
        limit:DB_LIMIT,objects:result.results[0].objects});
    }catch{
      databases.push({binding,role:binding==='DB'?'main':'blueprints',writer:binding===(env.BLUEPRINT_WRITE_DB??'DB'),
        available:false,bytes:null,remaining:null,limit:DB_LIMIT,objects:null});
    }
  }
  const stamp=now();
  const [last,counts,history]=await db.batch([
    db.prepare('SELECT lease_until,last_finished,last_deleted FROM blueprint_gc_runs WHERE id=1'),
    db.prepare(`SELECT count(*) AS stored,
      coalesce(sum(CASE WHEN unused_since IS NULL THEN 1 ELSE 0 END),0) AS inUse,
      coalesce(sum(CASE WHEN state='deleting' THEN 1 ELSE 0 END),0) AS deleting,
      coalesce(sum(CASE WHEN state='ready' AND unused_since<=? AND hold_until<=? THEN 1 ELSE 0 END),0) AS eligible
      FROM blueprint_lifecycle WHERE state<>'deleted'`).bind(stamp-BLUEPRINT_GRACE_SECONDS,stamp),
    db.prepare('SELECT * FROM blueprint_gc_history ORDER BY started DESC,id DESC LIMIT 100'),
  ]);
  const complete=databases.length>0&&databases.every(d=>d.bytes!==null);
  return {serverTime:stamp,databases,total:{limit:databases.length*DB_LIMIT,
    bytes:complete?databases.reduce((n,d)=>n+d.bytes,0):null,
    remaining:complete?databases.reduce((n,d)=>n+d.remaining,0):null},
    cleanup:{enabled:env.BLUEPRINT_CLEANUP==='true',graceHours:24,intervalMinutes:15,batchLimit:20,
      historyLimit:100,...last.results[0],...counts.results[0],
      history:history.results.map(r=>({...r,items:JSON.parse(r.items)}))}};
}

async function blueprintList(request,env,db) {
  const url=new URL(request.url),q=(url.searchParams.get('q')??'').trim(),after=url.searchParams.get('after')??'';
  if(q.length>100||/[\x00-\x1f\x7f]/.test(q)||after&&!/^[a-f0-9]{64}$/.test(after))
    throw new ApiError(400,'BP 검색어 또는 페이지 정보가 잘못되었습니다.');
  const rows=(await db.prepare(`SELECT b.hash,b.size,l.state,l.unused_since,l.hold_until,
    coalesce((SELECT min(name) FROM blueprint_library WHERE hash=b.hash),'BP '||substr(b.hash,1,12)) AS name,
    (SELECT min(a.name) FROM blueprint_library bl JOIN accounts a ON a.id=bl.owner WHERE bl.hash=b.hash) AS ownerName,
    (SELECT count(*) FROM blueprint_library WHERE hash=b.hash) AS owners,
    (SELECT count(*) FROM blueprint_references WHERE hash=b.hash AND kind='entry') AS fleets,
    (SELECT count(*) FROM blueprint_references WHERE hash=b.hash AND kind='match') AS matches,
    coalesce(s.storage,'DB') AS storage
    FROM blueprints b JOIN blueprint_lifecycle l ON l.hash=b.hash
    LEFT JOIN blueprint_locations s ON s.key='blueprints/'||b.hash||'.blueprint'
    WHERE l.state<>'deleted' AND b.hash>? AND (?='' OR instr(b.hash,lower(?))>0
      OR EXISTS(SELECT 1 FROM blueprint_library bl JOIN accounts a ON a.id=bl.owner
        WHERE bl.hash=b.hash AND (instr(lower(bl.name),lower(?))>0 OR instr(lower(a.name),lower(?))>0)))
    ORDER BY b.hash LIMIT 26`).bind(after,q,q,q,q).all()).results;
  const page=rows.slice(0,25);
  return json({blueprints:page.map(r=>({...r,downloadable:r.state==='ready'&&!!env[r.storage]})),
    next:rows.length>25?page.at(-1).hash:null,serverTime:now()});
}

async function downloadBlueprint(hash,env,db) {
  // Read-only admin browsing does not affect retention. An actual download gets
  // a short hold; it never revives a deleted BP or races the collector's claim.
  const held=await db.prepare(`UPDATE blueprint_lifecycle SET hold_until=max(hold_until,?)
    WHERE hash=? AND state='ready' RETURNING hash`).bind(now()+300,hash).first();
  if(!held) {
    const found=await db.prepare('SELECT state FROM blueprint_lifecycle WHERE hash=?').bind(hash).first();
    throw new ApiError(found?410:404,found?'정리 중이거나 이미 삭제된 BP입니다.':'BP를 찾을 수 없습니다.');
  }
  const object=await env.BLUEPRINTS.get(objectKey(hash));
  if(!object)throw new ApiError(503,'BP 원본을 읽을 수 없습니다. 저장소 상태를 확인하세요.');
  const name=await db.prepare('SELECT min(name) AS name FROM blueprint_library WHERE hash=?').bind(hash).first('name');
  const safe=(name??'BP-'+hash.slice(0,12)).replace(/[\x00-\x1f\x7f<>:"/\\|?*]/g,'_').replace(/\.blueprint$/i,'').slice(0,100)||'Blueprint';
  const filename=encodeURIComponent(safe+'.blueprint').replace(/[!'()*]/g,c=>'%'+c.charCodeAt(0).toString(16).toUpperCase());
  return new Response(object.body,{headers:{'Content-Type':'application/octet-stream','Content-Length':String(object.size),
    'Content-Disposition':`attachment; filename="${hash.slice(0,12)}.blueprint"; filename*=UTF-8''${filename}`,
    'X-Blueprint-Sha256':hash,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});
}

// Called only after the common admin authentication and HTTPS checks.
export async function adminStorageRoute(request,env,db,path) {
  if(request.method!=='GET')return null;
  if(path==='/admin/storage')return json(await storageOverview(env,db));
  if(path==='/admin/blueprints')return blueprintList(request,env,db);
  const match=/^\/admin\/blueprints\/([a-f0-9]{64})\/download$/.exec(path);
  return match?downloadBlueprint(match[1],env,db):null;
}
