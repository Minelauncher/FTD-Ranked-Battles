const BP_LIMIT = 8 * 1024 * 1024;
const COOLDOWN = 86400;
const encoder = new TextEncoder();
class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const json = (value, status = 200) => Response.json(value, {
  status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
});
const now = () => Date.now() / 1000;
const randomId = () => crypto.randomUUID().replaceAll('-', '');
const objectKey = hash => `blueprints/${hash}.blueprint`;
async function sha256(bytes) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
}
function publicAccount(a) {
  return { id: a.id, name: a.name, nicknameColor: a.nickname_color ?? null };
}
async function tournamentRating(db, tournament, owner) {
  return await db.prepare('SELECT rating,games FROM tournament_ratings WHERE tournament=? AND owner=?').bind(tournament,owner).first()
    ?? { rating: 1000, games: 0 };
}
// Rank the whole human ladder before limiting the visible list. Equal ratings
// share a rank and colour; stock fleets remain matchmaking opponents only.
const tournamentLadderSql = `WITH ranked AS (
  SELECT a.id,a.name,a.nickname_color AS nicknameColor,r.rating,r.games,rank() OVER(ORDER BY r.rating DESC) AS rank,count(*) OVER() AS total
  FROM tournament_ratings r JOIN accounts a ON a.id=r.owner
  WHERE r.tournament=? AND NOT EXISTS(SELECT 1 FROM system_opponents s WHERE s.owner=a.id)
), ladder AS (
  SELECT *,CASE WHEN total>1 AND games>0 THEN 100.0*(total-rank)/(total-1) ELSE NULL END AS percentile FROM ranked
)`;
async function tournamentStanding(db, tournament, owner) {
  return await db.prepare(tournamentLadderSql + ' SELECT rank,total,percentile FROM ladder WHERE id=?').bind(tournament,owner).first();
}
async function ensureTournamentRating(db, tournament, owner) {
  await db.prepare('INSERT INTO tournament_ratings(tournament,owner) VALUES(?,?) ON CONFLICT DO NOTHING').bind(tournament,owner).run();
}
async function tournamentHistory(db, event, viewer) {
  const rows=await db.prepare(`SELECT owner,opponent,ticket,receipt,
    (SELECT nickname_color FROM accounts WHERE id=matches.owner) AS owner_color,
    (SELECT nickname_color FROM accounts WHERE id=matches.opponent) AS opponent_color FROM matches WHERE tournament=? AND status='completed'
    AND (owner=? OR (opponent=? AND json_type(receipt,'$.opponentAfter') IS NOT NULL))
    ORDER BY created DESC,id LIMIT 20`).bind(event,viewer,viewer).all();
  return rows.results.map(row=>{
    const r=JSON.parse(row.receipt);
    if(row.owner===viewer) return {...r,opponentNicknameColor:row.opponent_color};
    const ticket=JSON.parse(row.ticket), outcome={...r.outcome};
    if(outcome.remaining) outcome.remaining=[...outcome.remaining].reverse();
    if(outcome.eliminated) outcome.eliminated=[...outcome.eliminated].reverse();
    if(outcome.materials) outcome.materials=[...outcome.materials].reverse();
    if(outcome.kind==='surrender') outcome.kind='opponent-surrender';
    if(outcome.kind==='submission-expired') outcome.kind='opponent-expired';
    return {...r,initiated:false,opponentId:row.owner,opponentName:ticket.owner.name,opponentNicknameColor:row.owner_color,opponentRating:ticket.owner.rating,
      before:r.opponentBefore,after:r.opponentAfter,delta:r.opponentDelta,games:r.opponentGames,
      opponentBefore:r.before,opponentAfter:r.after,opponentDelta:r.delta,opponentGames:r.games,
      ownerMatchRating:ticket.opponent.rating,expected:1-r.expected,systemOpponent:false,score:1-r.score,outcome};
  });
}
async function readJson(request, limit = 16384) {
  const declared = Number(request.headers.get('Content-Length'));
  if (declared > limit) throw new ApiError(413, '요청이 너무 큽니다.');
  // Also bound chunked requests instead of trusting Content-Length alone.
  const reader = request.body?.getReader();
  if (!reader) return {};
  const chunks = []; let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) { await reader.cancel(); throw new ApiError(413, '요청이 너무 큽니다.'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try {
    const body = size ? JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) : {};
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body;
  } catch { throw new ApiError(400, 'JSON 객체가 필요합니다.'); }
}

export { BP_LIMIT, COOLDOWN, encoder, ApiError, json, now, randomId, objectKey, sha256, publicAccount, readJson, tournamentRating, ensureTournamentRating, tournamentHistory, tournamentStanding, tournamentLadderSql };
