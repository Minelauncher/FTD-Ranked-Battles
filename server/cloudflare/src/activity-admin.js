import {ApiError,json,now} from './shared.js';
import {chatStub} from './chat.js';

// Parent adminRoute authenticates before this module is reached. All queries are read-only.
export async function adminActivityRoute(request,env,db,path){
  if(path!=='/admin/activity'&&path!=='/admin/activity/matches')return null;
  if(request.method!=='GET')throw new ApiError(405,'조회만 가능한 요청입니다.');
  const serverTime=now();
  if(path==='/admin/activity'){
    const rows=await db.batch([
      db.prepare(`SELECT count(*) AS accounts FROM accounts a
        WHERE NOT EXISTS(SELECT 1 FROM system_opponents s WHERE s.owner=a.id)`),
      db.prepare(`SELECT count(*) AS pendingMatches,
        coalesce(sum(json_extract(ticket,'$.expiresAt')<=?),0) AS overdueMatches
        FROM matches WHERE status='pending'`).bind(serverTime),
      db.prepare(`SELECT count(*) AS matches24h,count(DISTINCT owner) AS players24h
        FROM matches WHERE created>=?`).bind(serverTime-86400),
    ]);
    let presence={available:false,accounts:null,connections:null};
    if(env.CHAT&&env.CHAT_ENABLED==='true'){
      try{
        const response=await chatStub(env).fetch(new Request('https://chat.internal/admin/presence'));
        if(response.ok)presence={...await response.json(),available:true};
      }catch{/* Unknown presence must not hide match history or appear as zero users. */}
    }
    return json({serverTime,presence,summary:Object.assign({},...rows.map(r=>r.results[0]))});
  }
  const url=new URL(request.url),event=url.searchParams.get('tournament')||'';
  const predicates=[],args=[];
  if(event){
    if(!/^[a-z0-9][a-z0-9-]{0,63}$/.test(event))throw new ApiError(400,'대회 ID 형식이 올바르지 않습니다.');
    if(!await db.prepare('SELECT id FROM tournaments WHERE id=?').bind(event).first())throw new ApiError(404,'대회를 찾을 수 없습니다.');
    predicates.push('m.tournament=?');args.push(event);
  }
  const before=url.searchParams.get('before');
  if(before!==null){
    let cursor;try{cursor=JSON.parse(before);}catch{throw new ApiError(400,'경기 페이지 형식이 올바르지 않습니다.');}
    if(!Array.isArray(cursor)||cursor.length!==2||!Number.isFinite(cursor[0])||cursor[0]<0||typeof cursor[1]!=='string'||!/^[a-f0-9]{32}$/.test(cursor[1]))
      throw new ApiError(400,'경기 페이지 형식이 올바르지 않습니다.');
    predicates.push('(m.created,m.id)<(?,?)');args.push(...cursor);
  }
  const rows=(await db.prepare(`SELECT m.id,m.created,m.status,m.score,
    m.tournament AS tournamentId,coalesce(json_extract(m.ticket,'$.tournament.name'),t.name,m.tournament) AS tournamentName,
    coalesce(json_extract(m.ticket,'$.owner.name'),a.name,'Unknown') AS playerName,
    coalesce(json_extract(m.ticket,'$.opponent.name'),b.name,'Unknown') AS opponentName,
    coalesce(json_extract(m.ticket,'$.opponent.system'),0) AS systemOpponent,
    json_extract(m.ticket,'$.expiresAt') AS deadline,json_extract(m.receipt,'$.completed') AS completed,
    json_extract(m.receipt,'$.outcome.kind') AS outcome,json_extract(m.receipt,'$.delta') AS ratingChange,
    json_extract(m.receipt,'$.opponentDelta') AS opponentRatingChange
    FROM matches m LEFT JOIN tournaments t ON t.id=m.tournament
    LEFT JOIN accounts a ON a.id=m.owner LEFT JOIN accounts b ON b.id=m.opponent
    ${predicates.length?'WHERE '+predicates.join(' AND '):''}
    ORDER BY m.created DESC,m.id DESC LIMIT 26`).bind(...args).all()).results;
  const matches=rows.slice(0,25),last=matches.at(-1);
  return json({serverTime,matches,next:rows.length>25?JSON.stringify([last.created,last.id]):null});
}
