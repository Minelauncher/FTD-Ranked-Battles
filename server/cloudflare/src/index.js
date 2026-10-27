import { ApiError, json, now, publicAccount, readJson, tournamentRating, tournamentHistory, tournamentStanding } from './shared.js';
import { tournamentRoute, adminRoute } from './tournaments.js';
import { enforceClient, policy } from './client-policy.js';
import { adminPage } from './admin-page.js';
import { account, authInfo, authRoute, saveProfile } from './auth.js';
import { submitResult, surrenderMatch, expireOwner, expireMatches } from './match-results.js';
import { routedBlueprintStore } from './blueprint-store.js';
import { cleanupBlueprints, CLEANUP_CRON } from './blueprint-cleanup.js';
import { chatRoute, chatStub, adminChatSocket } from './chat.js';
import { recoveryRoute } from './email-recovery.js';
export { RankedChat } from './chat-room.js';
const SCHEMA_VERSION = 22;
async function ownMatch(db, id, owner) {
  const match = await db.prepare('SELECT * FROM matches WHERE id=? AND owner=?').bind(id, owner).first();
  if (!match) throw new ApiError(404, '이 계정의 경기가 아닙니다.');
  return match;
}
async function schemaReady(db) {
  try {
    const row = await db.prepare('SELECT version FROM schema_meta WHERE id=1').first();
    if (row?.version === SCHEMA_VERSION) return;
  } catch { /* Missing tables are a deployment problem, never create them in requests. */ }
  throw new ApiError(503, '서버 DB 마이그레이션이 필요합니다. 운영자에게 알려 주세요.');
}
async function route(request, env) {
  // Start at the primary even if read replication is enabled later. Subsequent
  // operations in this request must observe its own writes.
  const db = env.DB.withSession('first-primary');
  await schemaReady(db);
  env = { ...env, BLUEPRINTS: routedBlueprintStore(env, db) };
  const path = new URL(request.url).pathname, method = request.method;
  if (method === 'GET' && path === '/admin') return adminPage();
  if (path === '/admin/chat/socket') return adminChatSocket(request,env);
  if (method === 'GET' && path === '/health') return json({ service: 'ftd-ranked-battles', version: 3,
    schemaVersion: SCHEMA_VERSION, capabilities: ['blueprint-objects-v1', 'tournament-fleets-v1', 'blueprint-block-bans-v1', 'battlefield-worlds-v1', 'accounts-auth-v1', 'tournament-ratings-v1', 'bilateral-ratings-v1', 'rating-colors-v1', 'blueprint-shards-v1', 'blueprint-cleanup-v1'], clientPolicy: await policy(db), serverTime: now() });
  const admin = await adminRoute(request, env, db, path);
  if (admin) return admin;
  await enforceClient(request, db);
  const recovery = await recoveryRoute(request,env,db,path);
  if (recovery) return recovery;
  const auth = await authRoute(request, env, db, path);
  if (auth) return auth;
  const authorization = request.headers.get('Authorization') || '';
  let me = await account(db, authorization.startsWith('Bearer ') ? authorization.slice(7) : '',path==='/me');
  if (method === 'PUT' && path === '/me/profile') {
    const profile = await saveProfile(request, db, me);
    if (env.CHAT && env.CHAT_ENABLED === 'true') {
      // The D1 account is authoritative; a reconnect repairs a failed live notification.
      try { await chatStub(env).fetch(new Request('https://chat.internal/profile', {method:'PUT', body:JSON.stringify(profile)})); }
      catch { console.warn('Chat profile notification unavailable'); }
    }
    return json({account:profile});
  }
  const chat = await chatRoute(request,env,db,me,path);
  if (chat) return chat;
  if (await expireOwner(db, me.id)) me = await db.prepare('SELECT * FROM accounts WHERE id=?').bind(me.id).first();
  const tournaments = await tournamentRoute(request, env, db, me, path);
  if (tournaments) return tournaments;
  if (method === 'GET' && path === '/me') {
    const event = new URL(request.url).searchParams.get('tournament');
    if (event && !await db.prepare('SELECT id FROM tournaments WHERE id=?').bind(event).first())
      throw new ApiError(404, '대회를 찾을 수 없습니다.');
    const pending = await db.prepare("SELECT ticket FROM matches WHERE owner=? AND status='pending'").bind(me.id).first();
    const history = event ? await tournamentHistory(db,event,me.id) : [];
    return json({ account: publicAccount(me), auth: authInfo(me), pending: pending ? JSON.parse(pending.ticket) : null,
      tournamentId: event, rating: event ? await tournamentRating(db,event,me.id) : null,
      standing: event ? await tournamentStanding(db,event,me.id) : null, history, serverTime: now() });
  }
  const receiptRoute = /^\/matches\/([a-f0-9]{32})$/.exec(path);
  if (method === 'GET' && receiptRoute) {
    const match = await ownMatch(db, receiptRoute[1], me.id);
    return json({ matchId:match.id, status:match.status,
      receipt:match.status==='completed'?JSON.parse(match.receipt):null });
  }
  const matchRoute = /^\/matches\/([a-f0-9]{32})\/(result|cancel)$/.exec(path);
  if (method === 'POST' && matchRoute) {
    const match = await ownMatch(db, matchRoute[1], me.id);
    if (matchRoute[2] === 'result') return json(await submitResult(db, match, await readJson(request)));
    return json(await surrenderMatch(db, match));
  }
  throw new ApiError(404, '존재하지 않는 요청입니다.');
}
export default {
  async scheduled(event, env, ctx) {
    const db = env.DB.withSession('first-primary');
    await schemaReady(db);
    if (event.cron === CLEANUP_CRON) await cleanupBlueprints(env,db);
    else await expireMatches(db);
  },
  async fetch(request, env) {
    try { return await route(request, env); }
    catch (error) {
      if (/BP_UNAVAILABLE|BP_IN_USE/.test(String(error))) return json({ error: 'BP 저장 상태가 바뀌었습니다. 다시 업로드하고 제출하세요.' }, 409);
      if (error instanceof ApiError) return json({ error: error.message }, error.status);
      // Do not log request bodies, authorization, SQL parameters or tokens.
      console.error('rank_request_failed', error?.name || 'Error');
      return json({ error: '서버 처리에 실패했습니다. 같은 요청을 다시 시도하세요.' }, 503);
    }
  },
};
