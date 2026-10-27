import { adminStorageRoute } from './storage-admin.js';
import { adminActivityRoute } from './activity-admin.js';
import { holdBlueprint } from './blueprint-cleanup.js';
import { BP_LIMIT, encoder, ApiError, json, now, randomId, objectKey, sha256, publicAccount, readJson, tournamentRating, ensureTournamentRating, tournamentHistory, tournamentStanding, tournamentLadderSql } from './shared.js';
import { policy, updatePolicy, atLeast } from './client-policy.js';
import { adminChatRoute } from './chat.js';
import { bannedBlocksChecked, enforceBlockBans } from './block-bans.js';
import { blockCatalog } from './block-catalog.js';
import { battlefields, battlefieldChecked } from './battlefields.js';
import { adminAccountRoute } from './auth.js';
import { systemOpponentRoute, ensureDefaultOpponents } from './system-opponents.js';
import { submissionDeadline } from './match-results.js';
import { resultPolicy } from './battle-outcome.js';

// These are protocol/engine safety ceilings, not tournament defaults.
const numericRules = {
  teamBudget: [1, 1000000000], maxUnits: [1, 100], maxBlueprints: [1, 100],
  duration: [1, 86400], distance: [50, 10000], boardEast: [-100, 100], boardNorth: [-100, 100],
  formationHalfWidth: [0, 5000], formationDepth: [0, 5000], minAltitude: [-10000, 10000], maxAltitude: [-10000, 10000],
  replacementSeconds: [0, 31536000], k: [0, 128], resourceDrop: [0, 1],
  tooDamagedFraction: [0, 1], sinkingFraction: [0, 1], sustainedSeconds: [0, 3600],
};
const booleanRules = ['tooDamagedEnabled', 'sinkingEnabled', 'sustainedEnabled'];
const round = n => Math.round(n * 1000) / 1000;
function number(value, min, max, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max)
    throw new ApiError(400, `${label}: ${min}~${max} 범위의 수가 필요합니다.`);
  return round(value);
}
function rulesChecked(rules, validatePosition = true) {
  if (!rules || typeof rules !== 'object' || Array.isArray(rules)) throw new ApiError(400, '대회 규칙이 필요합니다.');
  const result = {};
  for (const key of Object.keys(rules)) if (!(key in numericRules) && !booleanRules.includes(key) && key !== 'bannedBlocks' && key !== 'world')
    throw new ApiError(400, `지원하지 않는 규칙: ${key}`);
  for (const [key, [min, max]] of Object.entries(numericRules)) result[key] = number(rules[key], min, max, key);
  for (const key of ['maxUnits', 'maxBlueprints', 'replacementSeconds'])
    if (!Number.isInteger(result[key])) throw new ApiError(400, `${key} 값은 정수여야 합니다.`);
  for (const key of booleanRules) {
    if (typeof rules[key] !== 'boolean') throw new ApiError(400, `${key} 값은 true/false여야 합니다.`);
    result[key] = rules[key];
  }
  result.bannedBlocks = bannedBlocksChecked(rules.bannedBlocks);
  result.world = battlefieldChecked({ ...result, world: rules.world }, validatePosition);
  if (result.minAltitude > result.maxAltitude || result.maxBlueprints > result.maxUnits)
    throw new ApiError(400, '고도 범위 또는 기체 종류 제한이 잘못되었습니다.');
  return result;
}
function cleanText(value, max, label, empty = false) {
  if (typeof value !== 'string' || (!empty && !value.trim()) || value.length > max || /[\x00-\x1f\x7f]/.test(value))
    throw new ApiError(400, `${label} 형식이 올바르지 않습니다.`);
  return value.trim();
}
function publicTournament(t) {
  return { id: t.id, name: t.name, description: t.description, status: t.status, revision: t.revision,
    rules: JSON.parse(t.rules), updated: t.updated, resultPolicy };
}
async function tournament(db, id) {
  const t = await db.prepare('SELECT * FROM tournaments WHERE id=?').bind(id).first();
  if (!t) throw new ApiError(404, '대회를 찾을 수 없습니다.');
  return t;
}
function entryFor(e, t) {
  return e ? { revision: e.revision, fleet: JSON.parse(e.fleet), updated: e.updated,
    compositionUpdated: e.composition_updated,
    replaceAt: e.composition_updated + JSON.parse(t.rules).replacementSeconds, current: e.revision === t.revision } : null;
}
export async function adminRoute(request, env, db, path) {
  if (!path.startsWith('/admin/')) return null;
  const supplied = request.headers.get('Authorization') || '';
  if (!env.ADMIN_TOKEN || supplied !== 'Bearer ' + env.ADMIN_TOKEN) throw new ApiError(403, '관리자 인증이 필요합니다.');
  const url = new URL(request.url);
  if (url.protocol !== 'https:' && !['localhost','127.0.0.1','[::1]'].includes(url.hostname))
    throw new ApiError(400, '관리자 요청에는 HTTPS 서버 주소가 필요합니다.');
  const activity = await adminActivityRoute(request,env,db,path);
  if (activity) return activity;
  const chat = await adminChatRoute(request,env,path);
  if (chat) return chat;
  const storage = await adminStorageRoute(request, env, db, path);
  if (storage) return storage;
  const accounts = await adminAccountRoute(request, env, db, path);
  if (accounts) return accounts;
  const opponents = await systemOpponentRoute(request, env, db, path, validateFleet, uploadLibrary);
  if (opponents) return opponents;
  if (path === '/admin/block-catalog' && request.method === 'GET') return json({ blocks: blockCatalog });
  if (path === '/admin/client-policy' && request.method === 'PUT') return updatePolicy(request, db);
  if (path === '/admin/tournaments' && request.method === 'GET') {
    await ensureDefaultOpponents(env, db, validateFleet, uploadLibrary);
    const rows = await db.prepare('SELECT * FROM tournaments ORDER BY updated DESC,id LIMIT 100').all();
    return json({ tournaments: rows.results.map(publicTournament), numericRules, booleanRules, battlefields, clientPolicy: await policy(db) });
  }
  const route = /^\/admin\/tournaments\/([a-z0-9][a-z0-9-]{0,63})$/.exec(path);
  if (!route || request.method !== 'PUT') throw new ApiError(404, '존재하지 않는 관리자 요청입니다.');
  const data = await readJson(request), name = cleanText(data.name, 100, '대회 이름');
  const description = cleanText(data.description ?? '', 1000, '대회 설명', true), rules = rulesChecked(data.rules);
  if (!['open', 'locked', 'closed'].includes(data.status)) throw new ApiError(400, '대회 상태는 open/locked/closed 중 하나입니다.');
  if (!Number.isInteger(data.expectedRevision) || data.expectedRevision < 0) throw new ApiError(400, 'expectedRevision이 필요합니다. 새 대회는 0입니다.');
  const previous = await db.prepare('SELECT * FROM tournaments WHERE id=?').bind(route[1]).first();
  if ((previous?.revision ?? 0) !== data.expectedRevision) throw new ApiError(409, '대회가 변경되었습니다. 최신 정보를 다시 읽으세요.');
  // Battlefield/time/cooldown changes keep valid registrations; fleet constraints require resubmission.
  // Old versions allowed out-of-map coordinates. Let admins correct those rows.
  const previousRules = previous ? rulesChecked(JSON.parse(previous.rules), false) : null;
  const changed = !previous || JSON.stringify(rules) !== JSON.stringify(previousRules);
  const revision = (previous?.revision ?? 0) + (changed ? 1 : 0);
  const entryPreservingRules = new Set(['world','boardEast','boardNorth','duration','distance','replacementSeconds']);
  const carryEntries = previous && changed && Object.keys(rules).every(key => entryPreservingRules.has(key) || JSON.stringify(rules[key]) === JSON.stringify(previousRules[key]));
  const statements = [];
  if (carryEntries) statements.push(db.prepare(`UPDATE tournament_entries SET revision=?
    WHERE tournament=? AND revision=? AND EXISTS(SELECT 1 FROM tournaments WHERE id=? AND revision=? AND updated=?)`)
    .bind(revision, previous.id, previous.revision, previous.id, previous.revision, previous.updated));
  statements.push(db.prepare(`INSERT INTO tournaments(id,name,description,status,revision,rules,updated)
    VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,description=excluded.description,
    status=excluded.status,revision=excluded.revision,rules=excluded.rules,updated=excluded.updated
    WHERE tournaments.revision=? AND tournaments.updated=? RETURNING *`)
    .bind(route[1], name, description, data.status, revision, JSON.stringify(rules), now(), data.expectedRevision, previous?.updated ?? -1));
  // One transaction keeps registrations and the tournament revision in sync, including rollback.
  const results = await db.batch(statements), result = results[results.length - 1];
  if (!result.results.length) throw new ApiError(409, '다른 관리자가 먼저 수정했습니다. 다시 읽으세요.');
  return json({ tournament: publicTournament(result.results[0]), serverTime: now() });
}
async function uploadLibrary(request, env, db, me) {
  const hash = request.headers.get('X-Blueprint-Sha256') || '';
  let name;
  try { name = decodeURIComponent(request.headers.get('X-Blueprint-Name') || ''); }
  catch { throw new ApiError(400, '기체 이름 형식이 잘못되었습니다.'); }
  name = cleanText(name, 100, '기체 이름');
  const costHeader = request.headers.get('X-Blueprint-Cost');
  if (!costHeader || !costHeader.trim()) throw new ApiError(400, '게임이 계산한 기체 비용이 필요합니다.');
  const cost = number(Number(costHeader), 0, 1000000000, '기체 비용');
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new ApiError(400, 'BP SHA-256 값이 필요합니다.');
  const sizeHeader = request.headers.get('Content-Length');
  if (!sizeHeader || !/^\d+$/.test(sizeHeader)) throw new ApiError(411, 'BP 파일 크기가 필요합니다.');
  const size = Number(sizeHeader);
  if (!Number.isSafeInteger(size) || size < 1 || size > BP_LIMIT || !request.body) throw new ApiError(413, 'BP 파일 크기는 최대 8 MiB입니다.');
  const old = await db.prepare('SELECT * FROM blueprint_library WHERE owner=? AND hash=?').bind(me.id, hash).first();
  const limit = Number(env.MAX_LIBRARY_BLUEPRINTS || 200);
  if (!Number.isInteger(limit) || limit < 1) throw new ApiError(503, '서버 BP 보관 제한 설정이 잘못되었습니다.');
  if (!old && (await db.prepare('SELECT count(*) AS n FROM blueprint_library WHERE owner=?').bind(me.id).first()).n >= limit)
    throw new ApiError(409, '계정의 BP 보관 한도에 도달했습니다.');
  const generation = await holdBlueprint(db,hash);
  const object = await env.BLUEPRINTS.head(objectKey(hash));
  if (object && object.size !== size) throw new ApiError(400, 'BP 파일 크기가 일치하지 않습니다.');
  if (!object) {
    try { await env.BLUEPRINTS.put(objectKey(hash), request.body, { sha256: hash, size, generation }); }
    catch (e) { if (/checksum|digest|hash mismatch/i.test(String(e))) throw new ApiError(400, 'BP 해시가 일치하지 않습니다.'); throw e; }
  }
  const timestamp = now();
  const result = await db.batch([
    db.prepare('INSERT INTO blueprints(hash,size,created) VALUES(?,?,?) ON CONFLICT DO NOTHING').bind(hash, size, timestamp),
    // BP bytes remain immutable, but game/mod price updates can change metadata.
    // Previously submitted fleets and issued tickets keep their copied costs.
    db.prepare(`INSERT INTO blueprint_library(owner,hash,name,cost,created) SELECT ?,?,?,?,?
      WHERE (EXISTS(SELECT 1 FROM blueprint_library WHERE owner=? AND hash=?)
      OR (SELECT count(*) FROM blueprint_library WHERE owner=?)<?)
      AND EXISTS(SELECT 1 FROM blueprint_lifecycle WHERE hash=? AND state='ready' AND generation=?)
      ON CONFLICT(owner,hash) DO UPDATE SET name=excluded.name,cost=excluded.cost`)
      .bind(me.id, hash, name, cost, timestamp, me.id, hash, me.id, limit, hash, generation),
    db.prepare("SELECT hash,name,cost FROM blueprint_library WHERE owner=? AND hash=? AND EXISTS(SELECT 1 FROM blueprint_lifecycle WHERE hash=? AND state='ready' AND generation=?)").bind(me.id, hash, hash, generation),
  ]);
  const bp = result[2].results[0];
  if (!bp || bp.cost !== cost || bp.name !== name) throw new ApiError(409, 'BP 보관 상태가 바뀌었습니다. 다시 확인하세요.');
  return json({ blueprint: bp });
}
async function validateFleet(env, db, owner, data, rules) {
  if (!Array.isArray(data.units) || data.units.length < 1 || data.units.length > rules.maxUnits)
    throw new ApiError(400, `기체는 1~${rules.maxUnits}개 배치할 수 있습니다.`);
  const hashes = [...new Set(data.units.map(u => u?.hash))];
  if (hashes.length > rules.maxBlueprints || hashes.some(h => typeof h !== 'string' || !/^[a-f0-9]{64}$/.test(h)))
    throw new ApiError(400, 'BP 종류 수 또는 BP 해시가 올바르지 않습니다.');
  const blueprints = [];
  // Stay below D1's bind limit even for tournaments allowing 100 distinct BPs.
  for (let i = 0; i < hashes.length; i += 40) {
    const part = hashes.slice(i, i + 40);
    const rows = await db.prepare(`SELECT hash,name,cost FROM blueprint_library WHERE owner=? AND hash IN (${part.map(() => '?').join(',')})`)
      .bind(owner, ...part).all();
    blueprints.push(...rows.results);
  }
  const bps = new Map(blueprints.map(r => [r.hash, r]));
  const units = data.units.map(u => {
    const bp = bps.get(u.hash);
    if (!bp) throw new ApiError(400, '먼저 모든 BP 파일을 업로드하세요.');
    return { ...bp, x: number(u.x, -rules.formationHalfWidth, rules.formationHalfWidth, '좌우 위치'),
      z: number(u.z, -rules.formationDepth, 0, '앞뒤 위치'),
      altitude: number(u.altitude, rules.minAltitude, rules.maxAltitude, '고도'), yaw: number(u.yaw, -180, 180, '방향') };
  });
  const spawnCost = round(units.reduce((sum, u) => sum + u.cost, 0));
  if (spawnCost > rules.teamBudget) throw new ApiError(400, '기체 소환비가 팀 예산을 초과했습니다.');
  // Every submission, including an identical retry, re-reads the original BPs.
  // Repeated placements of one BP share this request's scan only.
  await enforceBlockBans(env, blueprints, rules.bannedBlocks);
  const fleet = { units, spawnCost, supply: round(rules.teamBudget - spawnCost), budget: rules.teamBudget };
  if (data.fleetName !== undefined) {
    if (typeof data.fleetName !== 'string') throw new ApiError(400, '함대 이름을 입력하세요.');
    const name = data.fleetName.normalize('NFKC').trim();
    if (!name || Array.from(name).length > 40 || /[\x00-\x1f\x7f]/.test(name))
      throw new ApiError(400, '함대 이름: 1~40자 / Fleet name: 1–40 characters.');
    fleet.name = name;
  }
  return fleet;
}
async function submit(env, db, me, t, data) {
  if (t.status !== 'open') throw new ApiError(409, '지금은 함대를 제출할 수 없습니다.');
  if (data.revision !== t.revision) throw new ApiError(409, '대회 규칙이 바뀌었습니다. 다시 불러오세요.');
  // Older clients omit the optional name; preserve an existing name on their edits.
  if (data.fleetName === undefined) {
    const previous = await db.prepare('SELECT fleet FROM tournament_entries WHERE tournament=? AND owner=?').bind(t.id, me.id).first();
    const name = previous ? JSON.parse(previous.fleet).name : undefined;
    if (name !== undefined) data = { ...data, fleetName: name };
  }
  const rules = JSON.parse(t.rules), fleet = await validateFleet(env, db, me.id, data, rules);
  const serialized = JSON.stringify(fleet), fingerprint = await sha256(encoder.encode(serialized)), timestamp = now();
  // Sorted hashes retain duplicates: BP identity and per-BP counts only. The full
  // fingerprint still includes formation/metadata for immutable match snapshots.
  const composition = fleet.units.map(u => u.hash).sort().join(',');
  // Compare against the row at write time, not a pre-validation/read snapshot.
  // Only an exact retry may succeed while the owner has a pending battle.
  const result = await db.prepare(`INSERT INTO tournament_entries(tournament,owner,revision,fleet,fingerprint,updated,composition_key,composition_updated)
    SELECT ?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM tournaments WHERE id=? AND revision=? AND status='open')
    AND (NOT EXISTS(SELECT 1 FROM matches WHERE owner=? AND status='pending')
      OR EXISTS(SELECT 1 FROM tournament_entries WHERE tournament=? AND owner=? AND revision=? AND fingerprint=?))
    ON CONFLICT(tournament,owner) DO UPDATE SET revision=excluded.revision,fleet=excluded.fleet,
      fingerprint=excluded.fingerprint,
      updated=CASE WHEN tournament_entries.revision=excluded.revision AND tournament_entries.fingerprint=excluded.fingerprint
        THEN tournament_entries.updated ELSE excluded.updated END,
      composition_key=excluded.composition_key,
      composition_updated=CASE WHEN tournament_entries.composition_key=excluded.composition_key
        THEN tournament_entries.composition_updated ELSE excluded.composition_updated END
    WHERE tournament_entries.composition_key=excluded.composition_key
      OR tournament_entries.revision<>excluded.revision OR tournament_entries.composition_updated<=?
    RETURNING *`).bind(t.id, me.id, t.revision, serialized, fingerprint, timestamp, composition, timestamp,
      t.id, t.revision, me.id, t.id, me.id, t.revision, fingerprint,
      timestamp - rules.replacementSeconds).all();
  if (!result.results.length) throw new ApiError(409, 'BP·수량 교체 대기, 진행 중인 경기 또는 변경된 대회 접수 상태·규칙을 확인하세요. 진형만 수정하면 교체 대기는 적용되지 않습니다.');
  await ensureTournamentRating(db,t.id,me.id);
  return json({ entry: entryFor(result.results[0], t), serverTime: timestamp });
}
export async function findFleetOpponents(db, t, me) {
  // Humans and stock fleets share the same five nearest rating slots.
  const rows = await db.prepare(`SELECT a.id,a.name,a.nickname_color,r.rating,r.games,e.fleet,e.fingerprint,s.revision AS system_revision
    FROM tournament_entries e JOIN accounts a ON a.id=e.owner
    JOIN tournament_ratings r ON r.owner=a.id AND r.tournament=e.tournament
    LEFT JOIN system_opponents s ON s.owner=a.id
    WHERE e.tournament=? AND e.revision=? AND a.id<>?
      AND (s.owner IS NULL OR (s.tournament=e.tournament AND s.enabled=1))
    ORDER BY abs(r.rating-?),a.id LIMIT 5`).bind(t.id,t.revision,me.id,me.rating).all();
  return rows.results;
}
async function createFleetMatch(request, env, db, me, t) {
  await ensureDefaultOpponents(env, db, validateFleet, uploadLibrary);
  for (let attempt = 0; attempt < 3; attempt++) {
    const pending = await db.prepare("SELECT * FROM matches WHERE owner=? AND status='pending'").bind(me.id).first();
    if (pending) {
      if (pending.tournament !== t.id) throw new ApiError(409, '다른 대회의 진행 중인 경기를 먼저 마치거나 항복하세요.');
      return json(JSON.parse(pending.ticket));
    }
    // New scoring needs a supporting client. Previously issued tickets/results
    // stay accessible, so updating the server cannot strand an ongoing battle.
    if (!atLeast(request.headers.get('X-FTD-Rank-Version'),'0.7.6'))
      throw new ApiError(426, '모드 업데이트가 필요합니다. 서버 최소 버전: 0.7.6 / 통신 규격: 1');
    t = await tournament(db, t.id);
    if (t.status === 'closed') throw new ApiError(409, '종료된 대회입니다.');
    const own = await db.prepare('SELECT * FROM tournament_entries WHERE tournament=? AND owner=? AND revision=?').bind(t.id, me.id, t.revision).first();
    if (!own) throw new ApiError(409, '최신 대회 규칙으로 함대를 제출하세요.');
    await ensureTournamentRating(db,t.id,me.id);
    me = { ...me, ...await tournamentRating(db,t.id,me.id) };
    const candidates = await findFleetOpponents(db, t, me);
    if (!candidates.length) throw new ApiError(409, '이 대회에 매칭 가능한 다른 함대가 없습니다.');
    const random = crypto.getRandomValues(new Uint32Array(2)), other = candidates[random[0] % candidates.length];
    const rules = JSON.parse(t.rules), ownerFleet = JSON.parse(own.fleet), opponentFleet = JSON.parse(other.fleet);
    const ticket = { id: randomId(), created: now(), tournament: publicTournament(t), rules,
      owner: { ...publicAccount(me), rating:me.rating, games:me.games, standing:await tournamentStanding(db,t.id,me.id) }, opponent: { ...publicAccount(other), rating:other.rating, games:other.games, system: other.system_revision != null, standing:await tournamentStanding(db,t.id,other.id) }, ownerFleet, opponentFleet,
      seed: random[1] % 2147483647, duration: rules.duration, distance: rules.distance, k: rules.k, resultPolicy };
    ticket.expiresAt = submissionDeadline(ticket.created, ticket.duration);
    const result = await db.prepare(`INSERT INTO matches(id,owner,opponent,created,status,ticket,owner_hash,opponent_hash,tournament)
      SELECT ?,a.id,b.id,?,'pending',?,?,?,? FROM accounts a,accounts b,tournament_entries ea,tournament_entries eb,tournaments t,tournament_ratings ra,tournament_ratings rb
      WHERE a.id=? AND ra.games=? AND b.id=? AND rb.games=?
      AND ra.owner=a.id AND ra.tournament=t.id AND rb.owner=b.id AND rb.tournament=t.id
      AND ea.owner=a.id AND ea.tournament=t.id AND ea.revision=t.revision AND ea.fingerprint=?
      AND eb.owner=b.id AND eb.tournament=t.id AND eb.revision=t.revision AND eb.fingerprint=?
      AND ((? IS NULL AND NOT EXISTS(SELECT 1 FROM system_opponents WHERE owner=b.id))
        OR EXISTS(SELECT 1 FROM system_opponents WHERE owner=b.id AND tournament=t.id AND enabled=1 AND revision=?))
      AND t.id=? AND t.revision=? AND t.status<>'closed'
      AND NOT EXISTS(SELECT 1 FROM matches WHERE owner=a.id AND status='pending') ON CONFLICT DO NOTHING RETURNING id`)
      .bind(ticket.id, ticket.created, JSON.stringify(ticket), ownerFleet.units[0].hash, opponentFleet.units[0].hash, t.id,
        me.id, me.games, other.id, other.games, own.fingerprint, other.fingerprint,
        other.system_revision, other.system_revision, t.id, t.revision).all();
    if (result.results.length) return json(ticket);
  }
  throw new ApiError(409, '매칭 상태가 변경되었습니다. 다시 시도하세요.');
}
export async function tournamentRoute(request, env, db, me, path) {
  const method = request.method;
  if (method === 'GET' && path === '/tournaments') {
    await ensureDefaultOpponents(env, db, validateFleet, uploadLibrary);
    const rows = await db.prepare('SELECT * FROM tournaments ORDER BY updated DESC,id LIMIT 100').all();
    return json({ tournaments: rows.results.map(publicTournament), serverTime: now() });
  }
  if (method === 'POST' && path === '/blueprints/raw') return uploadLibrary(request, env, db, me);
  const route = /^\/tournaments\/([a-z0-9][a-z0-9-]{0,63})(?:\/(entry|matches|ladder))?$/.exec(path);
  if (route) {
    const t = await tournament(db, route[1]);
    if (method === 'GET' && !route[2]) {
      const entry = await db.prepare('SELECT * FROM tournament_entries WHERE tournament=? AND owner=?').bind(t.id, me.id).first();
      return json({ tournament: publicTournament(t), entry: entryFor(entry, t), rating: await tournamentRating(db,t.id,me.id), standing:await tournamentStanding(db,t.id,me.id), history:await tournamentHistory(db,t.id,me.id), serverTime: now() });
    }
    if (method === 'GET' && route[2] === 'ladder') {
      const query = new URL(request.url).searchParams;
      const requested = query.get('page') ?? '1';
      if (query.getAll('page').length > 1 || !/^[1-9][0-9]{0,6}$/.test(requested) || Number(requested) > 1000000)
        throw new ApiError(400, 'Invalid ranking page.');
      const pageSize = 100;
      // Rank the entire event, then select one page. Clamp the offset within the
      // same read snapshot so a shrinking ladder cannot leave an empty last page.
      const rows = await db.prepare(tournamentLadderSql + `
        SELECT * FROM ladder ORDER BY rating DESC,id LIMIT ${pageSize}
        OFFSET (SELECT MIN(?,MAX(0,COALESCE(MAX(total),0)-1)/${pageSize})*${pageSize} FROM ladder)`)
        .bind(t.id, Number(requested) - 1).all();
      const total = rows.results[0]?.total ?? 0;
      const totalPages = Math.max(1, Math.ceil(total / pageSize));
      return json({ tournamentId:t.id, page:Math.min(Number(requested),totalPages), pageSize, total, totalPages, accounts:rows.results });
    }
    if (method === 'PUT' && route[2] === 'entry') return submit(env, db, me, t, await readJson(request, 65536));
    if (method === 'POST' && route[2] === 'matches') return createFleetMatch(request, env, db, me, t);
  }
  const bpRoute = /^\/matches\/([a-f0-9]{32})\/fleet-blueprints\/([a-f0-9]{64})$/.exec(path);
  if (method === 'GET' && bpRoute) {
    const match = await db.prepare('SELECT ticket,status FROM matches WHERE id=? AND owner=?').bind(bpRoute[1], me.id).first();
    if (!match) throw new ApiError(404, '이 계정의 경기가 아닙니다.');
    if (match.status !== 'pending') throw new ApiError(410, '종료된 경기의 BP는 더 이상 제공하지 않습니다.');
    const ticket = JSON.parse(match.ticket), hash = bpRoute[2];
    if (![...(ticket.ownerFleet?.units ?? []), ...(ticket.opponentFleet?.units ?? [])].some(u => u.hash === hash))
      throw new ApiError(404, '이 경기의 BP가 아닙니다.');
    const object = await env.BLUEPRINTS.get(objectKey(hash));
    if (!object) throw new ApiError(503, '경기 BP 파일이 없습니다. 운영자에게 알려 주세요.');
    return new Response(object.body, { headers: { 'Content-Type': 'application/json', 'Content-Length': String(object.size),
      'X-Blueprint-Sha256': hash, 'Cache-Control': 'private, no-store' } });
  }
  return null;
}
