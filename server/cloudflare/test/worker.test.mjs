import { cleanupBlueprints, holdBlueprint, CLEANUP_CRON } from '../src/blueprint-cleanup.js';
import { storageOverview } from '../src/storage-admin.js';
import { migrationStatements } from '../tools/migration-statements.mjs';
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import { Script } from 'node:vm';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { campaignPresets, campaignCalibration } from '../src/campaign-presets.js';
import { blueprintStore } from '../src/blueprint-store.js';
import { blueprintSql } from '../tools/blueprint-sql.mjs';
import { expireMatches, submissionDeadline, submitResult } from '../src/match-results.js';
import worker from '../src/index.js';
import { findFleetOpponents } from '../src/tournaments.js';
import { applyCampaignRatings } from '../src/system-opponents.js';
import { copyAndRoute } from '../tools/storage-copy.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
let mf, db, bucket, dir, baseTournament;
const hash = value => createHash('sha256').update(value).digest('hex');
const blueprint = (name = 'Marauder', extra = '') => JSON.stringify({ Name: name,
  Blueprint: { BlockIds: [1] }, ItemDictionary: { '1': '11111111-1111-1111-1111-111111111111' }, extra });
const key = bytes => `blueprints/${hash(bytes)}.blueprint`;
async function start(bindings = {}, extraDatabases = {}) {
  mf = new Miniflare({ ...convertV4MiniflareOptions({ name: 'rank-test', modules: ['index.js','activity-admin.js','activity-admin-ui.js','chat.js','chat-room.js','chat-admin-ui.js','storage-admin.js','storage-admin-ui.js','blueprint-cleanup.js','match-results.js','blueprint-store.js','battle-outcome.js','account-mail.js','email-recovery.js','auth.js','shared.js','tournaments.js','system-opponents.js','campaign-presets.js','opponent-admin.js','client-policy.js','admin-page.js','blueprint-inspector.js','block-bans.js','block-catalog.js','battlefields.js','battlefield-maps.js','map-picker.js'].map(file => ({ type: 'ESModule', path: path.join(root, 'src', file) })), compatibilityDate: '2026-10-22',
    d1Databases: { DB: 'rank-test', ...extraDatabases },
    bindings: { AUTH_PEPPER: 'isolated-test-pepper-never-use-in-production-2026', REGISTRATION_OPEN: 'true', DEFAULT_OPPONENTS: 'false', MAX_ACCOUNTS: '1000', ADMIN_TOKEN: 'local-test-admin-only', ...bindings } }), resourcePersistencePath: dir });
  db = await mf.getD1Database('DB'); bucket = blueprintStore(db);
}
async function migrate(name) {
  const sql = await readFile(path.join(root, 'migrations', name), 'utf8');
  const statements = migrationStatements(sql);
  await db.batch(statements.map(s => db.prepare(s)));
}
async function api(method, route, account, body, expected = 200) {
  const response = await clientFetch('https://rank.test' + route, { method,
    headers: { ...(account ? { Authorization: 'Bearer ' + account.token } : {}), 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const value = await response.json();
  assert.equal(response.status, expected, JSON.stringify(value)); return value;
}
let sequence = 0;
const testPassword = 'test-only-password-2026';
const register = name => api('POST', '/auth/register', null, { username: 'test_user_' + (++sequence), nickname: 'Pilot ' + sequence, password: testPassword });

test('admin activity is authenticated, read-only and distinguishes missing presence from zero',async()=>{
  const {a,b}=await pair(),m=await match(a);await result(a,m,1);
  const pending=await match(b);
  await db.prepare("UPDATE matches SET ticket=json_set(ticket,'$.expiresAt',?) WHERE id=?").bind(Date.now()/1000-5,pending.id).run();
  const before=(await db.prepare('SELECT * FROM matches ORDER BY id').all()).results;
  const ratings=(await db.prepare('SELECT * FROM tournament_ratings ORDER BY owner').all()).results;
  for(const route of ['/admin/activity','/admin/activity/matches']){
    await api('GET',route,null,undefined,403);await api('GET',route,a,undefined,403);
    await api('POST',route,admin,{},405);
  }
  const overview=await api('GET','/admin/activity',admin);
  assert.deepEqual(overview.presence,{available:false,accounts:null,connections:null});
  assert.deepEqual(overview.summary,{accounts:2,pendingMatches:1,overdueMatches:1,matches24h:2,players24h:2});
  const data=await api('GET','/admin/activity/matches',admin);
  assert.equal(data.matches.length,2);assert.equal(data.next,null);
  const completed=data.matches.find(x=>x.id===m.id);assert.equal(completed.playerName,m.owner.name);
  assert.equal(completed.opponentName,m.opponent.name);assert.equal(completed.score,1);
  assert.equal(completed.ratingChange,-completed.opponentRatingChange);
  for(const key of ['token','username','password','owner_hash','ticket','receipt'])assert(!JSON.stringify(data).includes('"'+key+'"'));
  assert.deepEqual((await db.prepare('SELECT * FROM matches ORDER BY id').all()).results,before);
  assert.deepEqual((await db.prepare('SELECT * FROM tournament_ratings ORDER BY owner').all()).results,ratings);
});

test('admin history cursor handles timestamp ties, event filters and uses indexed queries',async()=>{
  const {a}=await pair(),m=await match(a);await result(a,m,0);
  await db.prepare("INSERT INTO tournaments SELECT 'second-cup','Second','',status,revision,rules,updated FROM tournaments WHERE id='standard-100k'").run();
  const timestamp=Date.now()/1000;
  for(let i=0;i<28;i++)await db.prepare(`INSERT INTO matches(id,owner,opponent,created,status,ticket,owner_hash,opponent_hash,score,receipt,tournament)
    SELECT ?,owner,opponent,?,'completed',ticket,owner_hash,opponent_hash,score,receipt,? FROM matches WHERE id=?`)
    .bind(i.toString(16).padStart(32,'0'),timestamp,i===27?'second-cup':'standard-100k',m.id).run();
  const first=await api('GET','/admin/activity/matches',admin);assert.equal(first.matches.length,25);assert(first.next);
  const second=await api('GET','/admin/activity/matches?before='+encodeURIComponent(first.next),admin);
  assert.equal(second.matches.length,4);assert.equal(second.next,null);
  assert.equal(new Set([...first.matches,...second.matches].map(m=>m.id)).size,29);
  const filtered=await api('GET','/admin/activity/matches?tournament=second-cup',admin);
  assert.equal(filtered.matches.length,1);assert.equal(filtered.matches[0].tournamentId,'second-cup');
  for(const before of ['null','{}','[0]','["0","'+m.id+'"]','[-1,"'+m.id+'"]','[0,"bad"]'])
    await api('GET','/admin/activity/matches?before='+encodeURIComponent(before),admin,undefined,400);
  await api('GET','/admin/activity/matches?tournament=missing',admin,undefined,404);
  await api('GET','/admin/activity/matches?tournament=%27',admin,undefined,400);
  for(const [sql,index] of [
    ['SELECT id FROM matches ORDER BY created DESC,id DESC LIMIT 26','admin_recent_matches'],
    ["SELECT id FROM matches WHERE tournament='standard-100k' AND (created,id)<(9999999999,'ffffffffffffffffffffffffffffffff') ORDER BY created DESC,id DESC LIMIT 26",'admin_event_matches'],
  ]){const plan=JSON.stringify((await db.prepare('EXPLAIN QUERY PLAN '+sql).all()).results);assert(plan.includes(index));assert(!plan.includes('TEMP B-TREE'));}
});
test('match receipts can be recovered only by their owner without applying ratings again', async () => {
  const a=await register('A'), b=await register('B');
  await submitFleet(a,[unit(await library(a,'Recover A',10000))]);
  await submitFleet(b,[unit(await library(b,'Recover B',10000))]);
  const ticket=await api('POST','/tournaments/standard-100k/matches',a,{});
  const route='/matches/'+ticket.id;
  assert.deepEqual(await api('GET',route,a),{matchId:ticket.id,status:'pending',receipt:null});
  await api('GET',route,null,undefined,401);
  await api('GET',route,b,undefined,404);
  const receipt=await api('POST',route+'/cancel',a,{});
  const saved=await api('GET',route,a);
  assert.equal(saved.status,'completed');assert.deepEqual(saved.receipt,receipt);
  assert.equal((await api('GET','/me?tournament=standard-100k',a)).rating.games,1);
});
test('nickname colors are authenticated, validated, persistent and public across match surfaces', async () => {
  const a=await register('A'), b=await register('B');
  await api('PUT','/me/profile',null,{nicknameColor:'#66CCFF'},401);
  for(const nicknameColor of [undefined,123,'red','#abc','#12345678','#GGGGGG','<color=#FFFFFF>'])
    await api('PUT','/me/profile',a,{nicknameColor},400);
  const profile=await api('PUT','/me/profile',a,{nicknameColor:'#66ccff',id:b.account.id});
  assert.equal(profile.account.nicknameColor,'#66CCFF');
  assert.equal((await api('GET','/me',b)).account.nicknameColor,null);
  assert.equal((await api('GET','/me',a)).account.nicknameColor,'#66CCFF');
  await api('PUT','/me/profile',a,{nicknameColor:'#66CCFF'}); // Idempotent retry has no write.
  await api('PUT','/me/profile',a,{nicknameColor:'#FF4488'},429);
  await submitFleet(a,[unit(await library(a,'Color A',10000))]);
  await submitFleet(b,[unit(await library(b,'Color B',10000))]);
  const ladder=await api('GET','/tournaments/standard-100k/ladder',b);
  assert.equal(ladder.accounts.find(r=>r.id===a.account.id).nicknameColor,'#66CCFF');
  const ticket=await api('POST','/tournaments/standard-100k/matches',b,{});
  assert.equal(ticket.opponent.nicknameColor,'#66CCFF');
  const receipt=await api('POST','/matches/'+ticket.id+'/cancel',b,{});
  assert.equal(receipt.opponentNicknameColor,'#66CCFF');
  assert.equal((await api('GET','/me?tournament=standard-100k',b)).history[0].opponentNicknameColor,'#66CCFF');
  await db.prepare('UPDATE accounts SET color_updated=0 WHERE id=?').bind(a.account.id).run();
  await api('PUT','/me/profile',a,{nicknameColor:null});
  assert.equal((await api('GET','/me?tournament=standard-100k',b)).history[0].opponentNicknameColor,null);
  assert.equal((await api('GET','/me?tournament=standard-100k',a)).history[0].opponentNicknameColor,null);
});
test('public nicknames are required, normalized and distinct from private login IDs', async () => {
  for (const nickname of [undefined, '', 'a', 'x'.repeat(25), 'a\nb', '<b>admin</b>', 'a\u200bb', '...']) {
    await api('POST','/auth/register',null,{username:'private_id',nickname,password:testPassword},400);
  }
  const a = await api('POST','/auth/register',null,{username:'private_id',nickname:'  함대   Pilot  ',password:testPassword});
  assert.equal(a.account.name,'함대 Pilot');
  assert.equal(a.auth.username,'private_id');
  const stored = await db.prepare('SELECT nickname_key FROM accounts WHERE id=?').bind(a.account.id).first();
  assert.equal(stored.nickname_key,'함대 pilot');
  await submitFleet(a,[unit(await library(a,'Privacy BP',10000))]);
  const ladder = await api('GET','/tournaments/standard-100k/ladder',a);
  assert.equal(ladder.accounts[0].name,'함대 Pilot');
  assert.ok(!JSON.stringify(ladder).includes('private_id'));
  const login=await api('POST','/auth/login',null,{username:'PRIVATE_ID',password:testPassword});
  assert.equal(login.account.name,a.account.name);
  for (const nickname of ['함대 pilot','  함대  PILOT  ','함대 Ｐｉｌｏｔ'])
    await api('POST','/auth/register',null,{username:'other_id',nickname,password:testPassword},409);
  const b=await api('POST','/auth/register',null,{username:'other_id',nickname:'가'.repeat(24),password:testPassword});
  assert.equal(b.account.name.length,24);
  await assert.rejects(db.prepare('UPDATE accounts SET nickname_key=? WHERE id=?').bind(stored.nickname_key,b.account.id).run());
});

test('simultaneous duplicate nicknames accept exactly one account with different login IDs', async () => {
  const responses=await Promise.all(['Captain',' captain ','ＣＡＰＴＡＩＮ'].map((nickname,i)=>clientFetch('https://rank.test/auth/register',{
    method:'POST',body:JSON.stringify({username:'unique_id_'+i,nickname,password:testPassword})
  })));
  assert.deepEqual(responses.map(r=>r.status).sort(),[200,409,409]);
  assert.equal(await db.prepare('SELECT count(*) n FROM accounts').first('n'),1);
});
const lookup = q => api('GET', '/admin/accounts?q=' + encodeURIComponent(q), admin);
const resetBody = a => ({ expectedRevision: a.authRevision, confirmUsername: a.username });
const resetPath = a => '/admin/accounts/' + encodeURIComponent(a.id) + '/password-reset';

test('admin account lookup and reset require admin authorization, HTTPS and return no-store responses', async () => {
  const a = await register('A'), route = resetPath(a.account);
  for (const caller of [null, a, { token: 'wrong-admin-token' }]) {
    await api('GET', '/admin/accounts', caller, undefined, 403);
    await api('POST', route, caller, {}, 403);
  }
  const response = await mf.dispatchFetch('https://rank.test/admin/accounts', { headers: { Authorization: 'Bearer ' + admin.token } });
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  const listing = await response.json(); assert.equal(listing.accounts.length, 1);
  assert.deepEqual(Object.keys(listing.accounts[0]).sort(), ['authRevision','canResetPassword','id','name','username']);
  for (const method of ['GET','POST']) {
    const r = await mf.dispatchFetch('http://rank.test' + (method === 'GET' ? '/admin/accounts' : route), { method,
      headers: { Authorization: 'Bearer ' + admin.token }, ...(method === 'POST' ? { body: '{}' } : {}) });
    assert.equal(r.status, 400);
  }
  await api('GET', route, admin, undefined, 404);
  await api('POST', '/admin/accounts', admin, {}, 404);
  await me(a);
});

test('admin lookup searches login ID, display name and account ID literally and paginates without duplicates', async () => {
  await db.batch(Array.from({ length: 30 }, (_, i) => db.prepare('INSERT INTO accounts(id,token_hash,name,username) VALUES(?,?,?,?)')
    .bind('roster-' + String(i).padStart(2, '0'), hash('roster-token-' + i), i === 3 ? '기존 함장 <img>' : 'Fleet ' + i, 'roster_' + String(i).padStart(2, '0'))));
  const first = await lookup('ROSTER_'); assert.equal(first.accounts.length, 25); assert.equal(first.next, 'roster-24');
  const second = await api('GET', '/admin/accounts?q=roster_&after=' + first.next, admin);
  assert.equal(second.accounts.length, 5); assert.equal(second.next, null);
  assert.equal(new Set([...first.accounts,...second.accounts].map(a => a.id)).size, 30);
  assert.equal((await lookup('roster_03')).accounts[0].id, 'roster-03');
  assert.equal((await lookup('기존 함장')).accounts[0].username, 'roster_03');
  assert.equal((await lookup('roster-03')).accounts[0].name, '기존 함장 <img>');
  for (const q of ['%', "' OR 1=1 --", 'absent']) assert.equal((await lookup(q)).accounts.length, 0);
  assert.equal((await lookup('')).accounts.length, 25);
  await api('GET', '/admin/accounts?q=' + 'x'.repeat(101), admin, undefined, 400);
  await api('GET', '/admin/accounts?after=' + 'x'.repeat(129), admin, undefined, 400);
  await api('GET', '/admin/accounts?q=%00', admin, undefined, 400);
});

test('admin reset revokes credentials and session, preserves game data and returns the new password only once', async () => {
  const { a, b } = await fleets(); await result(a, await fleetMatch(a), 1);
  const pending = await fleetMatch(a), before = await me(a), opponent = await me(b);
  const entry = (await api('GET', '/tournaments/standard-100k', a)).entry;
  const old = await db.prepare('SELECT * FROM accounts WHERE id=?').bind(a.account.id).first();
  const selected = (await lookup(a.account.id)).accounts[0];
  const raw = await mf.dispatchFetch('https://rank.test' + resetPath(selected), { method: 'POST',
    headers: { Authorization: 'Bearer ' + admin.token }, body: JSON.stringify(resetBody(selected)) });
  assert.equal(raw.status, 200); assert.equal(raw.headers.get('cache-control'), 'no-store');
  const reset = await raw.json(); assert.match(reset.temporaryPassword, /^[a-f0-9]{32}$/);
  assert.equal(reset.sessionsRevoked, true); assert.equal(reset.token, undefined);
  const saved = await db.prepare('SELECT * FROM accounts WHERE id=?').bind(a.account.id).first();
  assert.notEqual(saved.password_salt, old.password_salt); assert.notEqual(saved.password_hash, old.password_hash);
  assert.notEqual(saved.token_hash, old.token_hash); assert.equal(saved.token_expires, 0);
  assert.equal(saved.auth_revision, old.auth_revision + 1);
  assert.ok(!JSON.stringify(saved).includes(reset.temporaryPassword));
  const again = await lookup(a.account.id); assert.ok(!JSON.stringify(again).includes(reset.temporaryPassword));
  assert.equal(again.accounts[0].authRevision, selected.authRevision + 1);
  await api('GET', '/me', a, undefined, 401);
  await api('POST', '/auth/login', null, { username: a.auth.username, password: testPassword }, 401);
  const login = await api('POST', '/auth/login', null, { username: a.auth.username, password: reset.temporaryPassword });
  const after = await me(login);
  assert.deepEqual(after.account, before.account); assert.deepEqual(after.history, before.history); assert.deepEqual(after.pending, pending);
  assert.deepEqual((await api('GET', '/tournaments/standard-100k', login)).entry, entry);
  const otherAfter = await me(b); delete opponent.serverTime; delete otherAfter.serverTime; assert.deepEqual(otherAfter, opponent);
  const changed = await api('POST', '/auth/password', login, { password: reset.temporaryPassword, newPassword: 'my-new-private-password' });
  await api('POST', '/auth/login', null, { username: a.auth.username, password: reset.temporaryPassword }, 401);
  await result(changed, pending, .5);
});

test('admin reset rejects wrong confirmation, stale views, legacy accounts and malformed requests without mutation', async () => {
  const a = await register('A'), selected = (await lookup(a.account.id)).accounts[0], route = resetPath(selected);
  const before = await db.prepare('SELECT * FROM accounts WHERE id=?').bind(a.account.id).first();
  for (const body of [{}, { ...resetBody(selected), confirmUsername: 'someone_else' }, { ...resetBody(selected), expectedRevision: -1 },
    { ...resetBody(selected), expectedRevision: '0' }, { ...resetBody(selected), expectedRevision: 1.5 }]) await api('POST', route, admin, body, 400);
  await api('POST', route, admin, { ...resetBody(selected), expectedRevision: 99 }, 409);
  await api('POST', '/admin/accounts/missing/password-reset', admin, resetBody(selected), 404);
  await api('POST', route, admin, { ...resetBody(selected), padding: 'x'.repeat(5000) }, 413);
  assert.deepEqual(await db.prepare('SELECT * FROM accounts WHERE id=?').bind(a.account.id).first(), before);
  const login = await api('POST', '/auth/login', null, { username: a.auth.username, password: testPassword });
  await api('POST', route, admin, resetBody(selected), 409); await me(login);
  await db.prepare('INSERT INTO accounts(id,token_hash,name) VALUES(?,?,?)').bind('legacy-admin-test', hash('legacy-token'), '이전 함장').run();
  const legacy = (await lookup('legacy-admin-test')).accounts[0]; assert.equal(legacy.canResetPassword, false);
  await api('POST', resetPath(legacy), admin, { expectedRevision: 0, confirmUsername: '' }, 409);
});

test('concurrent or replayed admin resets accept only one new password', async () => {
  const a = await register('A'), selected = (await lookup(a.account.id)).accounts[0];
  const responses = await Promise.all(Array.from({ length: 3 }, () => mf.dispatchFetch('https://rank.test' + resetPath(selected), {
    method: 'POST', headers: { Authorization: 'Bearer ' + admin.token }, body: JSON.stringify(resetBody(selected)) })));
  assert.deepEqual(responses.map(r => r.status).sort(), [200,409,409]);
  const winner = await responses.find(r => r.status === 200).json();
  const login = await api('POST', '/auth/login', null, { username: selected.username, password: winner.temporaryPassword });
  assert.equal(login.account.id, a.account.id);
  await api('POST', resetPath(selected), admin, resetBody(selected), 409); await me(login);
});

test('admin reset clears only the selected user login budget and rolls back completely if that operation fails', async () => {
  const a = await register('A'), selected = (await lookup(a.account.id)).accounts[0];
  for (let i = 0; i < 10; i++) await api('POST', '/auth/login', null, { username: a.auth.username, password: 'wrong-pass' }, 401);
  const rateKey = kind => createHmac('sha256', 'isolated-test-pepper-never-use-in-production-2026').update('rate:/auth/login:' + kind).digest('hex');
  const ipKey = rateKey('ip:local'), userKey = rateKey('user:' + a.auth.username);
  const ipBefore = await db.prepare('SELECT * FROM auth_attempts WHERE key=?').bind(ipKey).first();
  const accountBefore = await db.prepare('SELECT * FROM accounts WHERE id=?').bind(a.account.id).first();
  await db.exec("CREATE TRIGGER reset_failure BEFORE DELETE ON auth_attempts BEGIN SELECT RAISE(ABORT,'reset test failure'); END;");
  try { await api('POST', resetPath(selected), admin, resetBody(selected), 503); }
  finally { await db.exec('DROP TRIGGER reset_failure'); }
  assert.deepEqual(await db.prepare('SELECT * FROM accounts WHERE id=?').bind(a.account.id).first(), accountBefore);
  const reset = await api('POST', resetPath(selected), admin, resetBody(selected));
  assert.equal(await db.prepare('SELECT * FROM auth_attempts WHERE key=?').bind(userKey).first(), null);
  assert.deepEqual(await db.prepare('SELECT * FROM auth_attempts WHERE key=?').bind(ipKey).first(), ipBefore);
  await api('POST', '/auth/login', null, { username: a.auth.username, password: reset.temporaryPassword });
});

test('missing admin token or password pepper cannot perform an admin reset', async () => {
  const a = await register('A'), selected = (await lookup(a.account.id)).accounts[0];
  try {
    await mf.dispose(); await start({ ADMIN_TOKEN: '' });
    await api('GET', '/admin/accounts', admin, undefined, 403);
    await api('POST', resetPath(selected), admin, resetBody(selected), 403);
    await mf.dispose(); await start({ AUTH_PEPPER: '' });
    await api('POST', resetPath(selected), admin, resetBody(selected), 503);
  } finally { await mf.dispose(); await start(); }
  await me(a);
  await api('POST', '/auth/login', null, { username: a.auth.username, password: testPassword });
});

test('credentials are salted and peppered; only account owner sees auth metadata', async () => {
  const a = await register('A'), b = await register('B');
  const rows = (await db.prepare('SELECT * FROM accounts').all()).results;
  assert.notEqual(rows[0].password_salt, rows[1].password_salt);
  assert.notEqual(rows[0].password_hash, rows[1].password_hash);
  assert.equal(rows[0].password_hash.length, 64);
  const derived = pbkdf2Sync(testPassword, Buffer.from(rows[0].password_salt, 'hex'), 100000, 32, 'sha256').toString('hex');
  assert.equal(rows[0].password_hash, createHmac('sha256', 'isolated-test-pepper-never-use-in-production-2026').update('password-v1:' + derived).digest('hex'));
  const serialized = JSON.stringify(rows);
  for (const value of [testPassword, a.token, b.token]) assert.ok(!serialized.includes(value));
  assert.equal(a.recoveryCode, undefined); assert.equal(b.recoveryCode, undefined);
  assert.ok(rows.every(row => !Object.hasOwn(row, 'recovery_hash')));
  assert.equal(a.auth.needsCredentials, false);
  await submitFleet(a,[unit(await library(a,'Privacy BP',10000))]);
  const ladder = await api('GET', '/tournaments/standard-100k/ladder', a);
  for (const row of ladder.accounts) for (const key of ['username','password_hash','password_salt','recovery_hash','token_hash','auth']) assert.equal(row[key], undefined);
});

test('login is case insensitive, rotates and expires the single session; logout revokes it', async () => {
  const a = await register('A'), username = a.auth.username.toUpperCase();
  await api('POST', '/auth/login', null, { username, password: 'wrong-pass' }, 401);
  await api('POST', '/auth/login', null, { username: 'not_registered', password: 'wrong-pass' }, 401);
  const login = await api('POST', '/auth/login', null, { username, nickname: 'Pilot ' + username, password: testPassword });
  assert.equal(login.account.id, a.account.id); assert.notEqual(login.token, a.token);
  assert.equal(login.recoveryCode, undefined);
  await api('GET', '/me', a, undefined, 401); await me(login);
  await db.prepare('UPDATE accounts SET token_expires=1 WHERE id=?').bind(a.account.id).run();
  await api('GET', '/me', login, undefined, 401);
  const again = await api('POST', '/auth/login', null, { username, nickname: 'Pilot ' + username, password: testPassword });
  await api('POST', '/auth/logout', again, {});
  await api('GET', '/me', again, undefined, 401);
});

test('authenticated password change preserves fleet, pending ticket, history and rating', async () => {
  const { a, units } = await fleets();
  await result(a, await fleetMatch(a), 1);
  const pending = await fleetMatch(a), before = await me(a), entry = (await api('GET', '/tournaments/standard-100k', a)).entry;
  const body = { password: testPassword, newPassword: 'new-password-2026' };
  await api('POST', '/auth/password', null, body, 401);
  await api('POST', '/auth/password', a, { ...body, password: 'wrong-pass' }, 401);
  await api('POST', '/auth/password', a, { ...body, expectedAccountId: 'different' }, 409);
  const changed = await api('POST', '/auth/password', a, body);
  assert.equal(changed.account.id, a.account.id); assert.equal(changed.recoveryCode, undefined);
  await api('GET', '/me', a, undefined, 401);
  await api('POST', '/auth/login', null, { username: a.auth.username, password: testPassword }, 401);
  const after = await me(changed);
  assert.deepEqual(after.account, before.account); assert.deepEqual(after.history, before.history); assert.deepEqual(after.pending, pending);
  assert.deepEqual((await api('GET', '/tournaments/standard-100k', changed)).entry, entry);
  assert.equal(entry.fleet.units.length, units.length);
  await result(changed, pending, .5);
});

test('automated recovery endpoint is absent for anonymous and authenticated callers', async () => {
  const a = await register('A'), before = await me(a);
  for (const caller of [null, a]) await api('POST', '/auth/recover', caller,
    { username: a.auth.username, recoveryCode: 'formerly-issued-code', password: 'replacement-password' }, 404);
  const after = await me(a); delete before.serverTime; delete after.serverTime; assert.deepEqual(after, before);
});



test('legacy token account can claim credentials once without losing its ID or ledger', async () => {
  const token = 'legacy-private-token';
  await db.prepare('INSERT INTO accounts(id,token_hash,name) VALUES(?,?,?)').bind('legacy-id', hash(token), '기존 참가자').run();
  await db.prepare("INSERT INTO tournament_ratings(tournament,owner,rating,games) VALUES('standard-100k','legacy-id',1234,7)").run();
  const old = { token }; assert.equal((await me(old)).auth.needsCredentials, true);
  const a = await api('POST', '/auth/claim', old, { username: 'legacy_captain', nickname: '기존 참가자', password: testPassword });
  assert.equal(a.account.id, 'legacy-id'); assert.equal(a.account.name, '기존 참가자'); assert.deepEqual((await me(a)).rating,{rating:1234,games:7});
  await api('GET', '/me', old, undefined, 401);
  await api('POST', '/auth/claim', a, { username: 'different', password: testPassword }, 409);
  const login = await api('POST', '/auth/login', null, { username: 'legacy_captain', nickname: '기존 참가자', password: testPassword });
  assert.equal(login.account.id, 'legacy-id');
});

test('registration validation, duplicate usernames and legacy signup are rejected', async () => {
  for (const username of ['', 'ab', 'x'.repeat(7), '한글아이디', 'x'.repeat(33), 'a b', '_abcdefg'])
    await api('POST', '/auth/register', null, { username, nickname: 'Pilot ' + username, password: testPassword }, 400);
  for (const password of ['', 'x'.repeat(7), 'x'.repeat(33), '🚀'.repeat(7), '🚀'.repeat(33), 'aaaaaaaaaaa\n'])
    await api('POST', '/auth/register', null, { username: 'valid_user', nickname: 'Valid pilot', password }, 400);
  const a = await register('A');
  await api('POST', '/auth/register', null, { username: a.auth.username.toUpperCase(), nickname: 'Other pilot', password: testPassword }, 409);
  await api('POST', '/accounts', null, { name: 'Old' }, 410);
  const large = 'x'.repeat(5000);
  await api('POST', '/auth/login', null, { username: 'valid_user', password: large }, 413);
});

test('persistent login attempt limits survive worker restart and expire', async () => {
  const a = await register('A');
  for (let i = 0; i < 10; i++) await api('POST', '/auth/login', null, { username: a.auth.username, password: 'wrong-pass' }, 401);
  await mf.dispose(); await start();
  await api('POST', '/auth/login', null, { username: a.auth.username, password: testPassword }, 429);
  await db.exec('UPDATE auth_attempts SET window=0');
  await api('POST', '/auth/login', null, { username: a.auth.username, password: testPassword });
});

test('username and password boundaries apply to signup, login, claim and change without exceptions', async () => {
  for (const length of [8, 32]) {
    const username = 'u'.repeat(length), password = '🚀'.repeat(length);
    const a = await api('POST', '/auth/register', null, {username, nickname:'Pilot '+length, password});
    const login = await api('POST', '/auth/login', null, {username: username.toUpperCase(), password});
    assert.equal(login.account.id, a.account.id);
    for (const invalid of ['x'.repeat(7), 'x'.repeat(33)]) {
      await api('POST', '/auth/login', null, {username, password: invalid}, 400);
      await api('POST', '/auth/password', login, {password, newPassword: invalid}, 400);
      await me(login);
    }
    const changed = await api('POST', '/auth/password', login, {password, newPassword: 'eight888'});
    assert.equal((await api('POST', '/auth/login', null, {username, password:'eight888'})).account.id, changed.account.id);
  }
  for (const username of ['short', 'x'.repeat(33)])
    await api('POST', '/auth/login', null, {username, password:testPassword}, 400);
  const token = 'boundary-claim-token', account = {token};
  await db.prepare('INSERT INTO accounts(id,token_hash,name) VALUES(?,?,?)').bind('boundary-claim', hash(token), 'Claim').run();
  await api('POST', '/auth/claim', account, {username:'short', password:testPassword},400);
  await api('POST', '/auth/claim', account, {username:'claim888', nickname:'Claim', password:'x'.repeat(33)},400);
  const claimed = await api('POST', '/auth/claim', account, {username:'claim888', nickname:'Claim', password:'eight888'});
  assert.equal(claimed.account.id,'boundary-claim');
});

test('concurrent password changes accept a single update and invalidate stale sessions', async () => {
  const a = await register('A');
  const responses = await Promise.all(Array.from({ length: 3 }, () => clientFetch('https://rank.test/auth/password', {
    method: 'POST', headers: { Authorization: 'Bearer ' + a.token }, body: JSON.stringify({ password: testPassword, newPassword: 'new-password-2026' }) })));
  assert.equal(responses.filter(r => r.status === 200).length, 1);
  assert.ok(responses.every(r => [200,401,409].includes(r.status)));
});

test('registration closure and missing pepper fail closed; account ceiling is atomic', async () => {
  try {
    await mf.dispose(); await start({ REGISTRATION_OPEN: 'false' });
    await api('POST', '/auth/register', null, { username: 'new_user', password: testPassword }, 403);
    await mf.dispose(); await start({ AUTH_PEPPER: '' });
    await api('POST', '/auth/register', null, { username: 'new_user', password: testPassword }, 503);
    await mf.dispose(); await start({ MAX_ACCOUNTS: '1' });
    const responses = await Promise.all(['first_user','second_user'].map(username => clientFetch('https://rank.test/auth/register', { method: 'POST', body: JSON.stringify({ username, nickname: 'Pilot ' + username, password: testPassword }) })));
    assert.deepEqual(responses.map(r => r.status).sort(), [200,409]);
    assert.equal((await db.prepare('SELECT count(*) n FROM accounts').first()).n, 1);
  } finally { await mf.dispose(); await start(); }
});
async function upload(account, bp = blueprint(), expected = 200, digest = hash(bp)) {
  const response = await clientFetch('https://rank.test/blueprints/raw', { method: 'POST',
    headers: { Authorization: 'Bearer ' + account.token, 'Content-Type': 'application/octet-stream',
      'Content-Length': String(Buffer.byteLength(bp)), 'X-Blueprint-Sha256': digest,
      'X-Blueprint-Name': encodeURIComponent(JSON.parse(bp).Name), 'X-Blueprint-Cost':'20000' }, body: bp });
  const value = await response.json(); assert.equal(response.status, expected, JSON.stringify(value)); return value;
}
async function pair() {
  const a = await register('Alpha'), b = await register('Bravo');
  await upload(a); await upload(b, blueprint('Corsair')); await submitFleet(a,[unit(hash(blueprint()))]); await submitFleet(b,[unit(hash(blueprint('Corsair')))]); return { a, b };
}
const match = a => fleetMatch(a);
const resultBody = (m, score) => m.resultPolicy ? { score, outcome: {
  kind: score === .5 ? 'timeout-draw' : 'elimination', remaining: score === .5 ? [.6,.6] : score === 1 ? [.6,0] : [0,.6],
  eliminated: score === .5 ? [false,false] : score === 1 ? [false,true] : [true,false], seconds: score === .5 ? m.duration : 10,
  ...(m.resultPolicy==='remaining-materials-v1'?{materials:(score===.5?[60000,60000]:score===1?[60000,0]:[0,60000]).map(vehicle=>({vehicle,supply:0,total:vehicle}))}:{}) } } : { score };
const result = (a, m, score, expected = 200) => api('POST', `/matches/${m.id}/result`, a, resultBody(m, score), expected);
const me = (a,event='standard-100k') => api('GET', '/me?tournament='+event, a);

async function secondEvent(a,b) {
  const t=await getTournament(a);
  await api('PUT','/admin/tournaments/second-cup',admin,{...t,id:'second-cup',name:'Second cup',expectedRevision:0});
  for(const player of [a,b]) {
    const entry=(await api('GET','/tournaments/standard-100k',player)).entry;
    await api('PUT','/tournaments/second-cup/entry',player,{revision:1,units:entry.fleet.units,fleetName:'Second fleet'});
  }
}

test('event ratings, match snapshots, ladders and history remain independent across wins and expiry',async()=>{
  const {a,b}=await pair();
  await result(a,await match(a),1);
  await secondEvent(a,b);
  assert.deepEqual((await me(a)).rating,{rating:1016,games:1});
  assert.deepEqual((await me(a,'second-cup')).rating,{rating:1000,games:0});
  assert.deepEqual((await api('GET','/tournaments/second-cup',a)).history,[]);
  const m=await api('POST','/tournaments/second-cup/matches',a,{});
  assert.equal(m.owner.rating,1000); assert.equal(m.owner.games,0); assert.equal(m.opponent.rating,1000);
  await api('POST','/tournaments/standard-100k/matches',a,{},409);
  const r=await result(a,m,0); assert.equal(r.tournamentId,'second-cup'); assert.equal(r.after,984);
  assert.deepEqual((await me(a)).rating,{rating:1016,games:1});
  assert.deepEqual((await me(a,'second-cup')).rating,{rating:984,games:1});
  for(const id of ['standard-100k','second-cup']) {
    assert.deepEqual((await me(b,id)).rating,{rating:id==='standard-100k'?984:1016,games:1});
    const h=(await me(a,id)).history; assert.equal(h.length,1); assert.equal(h[0].tournamentId,id);
  }
  assert.equal((await api('GET','/tournaments/standard-100k/ladder',a)).accounts[0].id,a.account.id);
  assert.equal((await api('GET','/tournaments/second-cup/ladder',a)).accounts[0].id,b.account.id);
  const abandoned=await api('POST','/tournaments/second-cup/matches',a,{});
  await expireMatches(db,abandoned.expiresAt);
  assert.deepEqual((await me(a)).rating,{rating:1016,games:1});
  assert.equal((await me(a,'second-cup')).rating.games,2);
  assert.equal((await result(a,abandoned,1)).outcome.kind,'submission-expired');
  const anonymousEvent=await api('GET','/me',a);
  assert.equal(anonymousEvent.rating,null); assert.deepEqual(anonymousEvent.history,[]);
  assert.deepEqual(Object.keys(anonymousEvent.account).sort(),['id','name','nicknameColor']);
});

test('ladder colours use the whole event, preserve ties, and exclude stock fleets',async()=>{
  const {a,b}=await pair();
  await secondEvent(a,b);
  await db.batch([
    db.prepare("UPDATE tournament_ratings SET rating=2000,games=1 WHERE owner=? AND tournament='standard-100k'").bind(a.account.id),
    db.prepare("UPDATE tournament_ratings SET rating=1900,games=1 WHERE owner=? AND tournament='standard-100k'").bind(b.account.id),
    ...Array.from({length:100},(_,i)=>[
      db.prepare('INSERT INTO accounts(id,token_hash,name) VALUES(?,?,?)').bind('colour-'+i,hash('colour-token-'+i),'Colour '+i),
      db.prepare("INSERT INTO tournament_ratings(tournament,owner,rating,games) VALUES('standard-100k',?,?,1)").bind('colour-'+i,1800-i)
    ]).flat()
  ]);
  const stock=await api('POST','/admin/tournaments/standard-100k/opponents',admin,{name:'Colour stock',rating:3000});
  const ladder=(await api('GET','/tournaments/standard-100k/ladder',a)).accounts;
  assert.equal(ladder.length,100);
  assert.equal(ladder[0].total,102); assert.equal(ladder[0].rank,1); assert.equal(ladder[0].percentile,100);
  assert.equal(ladder[99].rank,100); assert.ok(ladder[99].percentile>0); // two more rows beyond the visible page
  assert.ok(!ladder.some(r=>r.id===stock.opponent.id));
  const live=(await me(a)).standing;
  assert.deepEqual(live,{rank:1,total:102,percentile:100});
  assert.deepEqual((await api('GET','/tournaments/standard-100k',a)).standing,live);
  const ticket=await match(a); assert.deepEqual(ticket.owner.standing,live);
  await result(a,ticket,0);
  assert.equal((await me(a)).standing.total,102);
  await db.prepare("UPDATE tournament_ratings SET rating=2000 WHERE tournament='standard-100k' AND owner IN (?,?)").bind(a.account.id,b.account.id).run();
  const tied=(await api('GET','/tournaments/standard-100k/ladder',a)).accounts;
  assert.deepEqual(tied.slice(0,3).map(r=>r.rank),[1,1,3]);
  assert.equal(tied[0].percentile,tied[1].percentile);
  assert.deepEqual((await me(a,'second-cup')).standing,{rank:1,total:2,percentile:null}); // unplayed stays neutral
});

test('ladder pages cover every player, keep global tied ranks, and clamp shrinking or empty events',async()=>{
  const viewer=await register('Page viewer');
  const route='/tournaments/standard-100k/ladder';
  const seed=Array.from({length:205},(_,i)=>({id:'page-'+String(i).padStart(4,'0'),rating:i===100||i===101?1901:2000-i}));
  await db.batch(seed.flatMap(({id,rating},i)=>[
    db.prepare('INSERT INTO accounts(id,token_hash,name,nickname_color) VALUES(?,?,?,?)').bind(id,hash(id),'Player '+i,'#66CCFF'),
    db.prepare("INSERT INTO tournament_ratings(tournament,owner,rating,games) VALUES('standard-100k',?,?,?)").bind(id,rating,i===204?0:1)
  ]));
  const stock=await api('POST','/admin/tournaments/standard-100k/opponents',admin,{name:'Page stock',rating:5000});
  const before=(await db.prepare('SELECT * FROM tournament_ratings ORDER BY tournament,owner').all()).results;
  const pages=[];
  for(let page=1;page<=3;page++){
    const data=await api('GET',route+'?page='+page,viewer);
    assert.deepEqual({page:data.page,pageSize:data.pageSize,total:data.total,totalPages:data.totalPages},
      {page,pageSize:100,total:205,totalPages:3});
    assert.equal(data.tournamentId,'standard-100k');
    assert.equal(data.accounts.length,page===3?5:100);
    assert(data.accounts.every(a=>a.total===205&&a.nicknameColor==='#66CCFF'));
    pages.push(data);
  }
  const all=pages.flatMap(p=>p.accounts);
  assert.deepEqual(all.map(a=>a.id),seed.map(s=>s.id)); // no omissions or duplicates, including ties at the page boundary
  assert(!all.some(a=>a.id===stock.opponent.id));
  assert.deepEqual(all.slice(99,103).map(a=>a.rank),[100,100,100,103]);
  assert.equal(all[100].percentile,100*(205-100)/204);
  assert.equal(all[99].percentile,all[101].percentile);
  assert.equal(all[204].percentile,null);
  assert.deepEqual(await api('GET',route,viewer),pages[0]);
  assert.deepEqual(await api('GET',route+'?page=1000000',viewer),pages[2]);
  for(const page of ['0','-1','1.5','abc','1e2','01','','1000001','1&page=2'])
    await api('GET',route+'?page='+page,viewer,undefined,400);
  await api('GET',route,null,undefined,401);
  assert.deepEqual((await db.prepare('SELECT * FROM tournament_ratings ORDER BY tournament,owner').all()).results,before);
  // Another event has its own page count and ordering.
  await db.prepare("INSERT INTO tournaments SELECT 'page-cup','Page cup','',status,revision,rules,updated FROM tournaments WHERE id='standard-100k'").run();
  await db.prepare("INSERT INTO tournament_ratings VALUES('page-cup',?,5000,5)").bind(seed[204].id).run();
  const separate=await api('GET','/tournaments/page-cup/ladder?page=3',viewer);
  assert.equal(separate.page,1); assert.equal(separate.total,1); assert.equal(separate.accounts[0].rank,1);
  assert.equal(separate.accounts[0].id,seed[204].id);
  await db.prepare("DELETE FROM tournament_ratings WHERE tournament='standard-100k' AND owner>='page-0200' AND owner<='page-0204'").run();
  const shrunk=await api('GET',route+'?page=3',viewer);
  assert.equal(shrunk.page,2); assert.equal(shrunk.totalPages,2); assert.equal(shrunk.accounts.length,100);
  await db.prepare("DELETE FROM tournament_ratings WHERE tournament='standard-100k' AND owner LIKE 'page-%'").run();
  assert.deepEqual(await api('GET',route+'?page=3',viewer),
    {tournamentId:'standard-100k',page:1,pageSize:100,total:0,totalPages:1,accounts:[]});
});

test('unsubmitted and lone players have no percentile colour',async()=>{
  const a=await register('Solo');
  assert.equal((await me(a)).standing,null);
  await submitFleet(a,[unit(await library(a,'Solo BP',10000))]);
  await db.prepare('UPDATE tournament_ratings SET games=5 WHERE owner=?').bind(a.account.id).run();
  assert.deepEqual((await me(a)).standing,{rank:1,total:1,percentile:null});
  assert.equal((await api('GET','/tournaments/standard-100k/ladder',a)).accounts[0].percentile,null);
});

test('only event APIs expose ratings; retired global and single-BP paths are absent',async()=>{
  const a=await register('No compatibility');
  for(const [method,path] of [['GET','/ladder'],['POST','/matches'],['POST','/blueprint'],['POST','/blueprint/raw']])
    await api(method,path,a,method==='GET'?undefined:{},404);
  const columns=(await db.prepare('PRAGMA table_info(accounts)').all()).results.map(c=>c.name);
  for(const name of ['rating','games','bp_hash','bp_name','bp_updated']) assert.ok(!columns.includes(name));
  await api('GET','/me?tournament=missing-cup',a,undefined,404);
});

test('stock changes and cancellation settle solely in the ticket event',async()=>{
  const {a,p,m}=await stockBattle();
  await result(a,m,1);
  const t=await getTournament(a);
  await api('PUT','/admin/tournaments/second-cup',admin,{...t,id:'second-cup',expectedRevision:0});
  const own=(await api('GET','/tournaments/standard-100k',a)).entry.fleet.units;
  await api('PUT','/tournaments/second-cup/entry',a,{revision:1,units:own});
  const stock=(await api('POST','/admin/tournaments/second-cup/opponents',admin,{name:'Other event stock',rating:1500})).opponent;
  const h=await stockLibrary(stock,'Other stock',20000);
  await api('PUT','/admin/opponents/'+stock.id,admin,{name:stock.name,rating:1500,enabled:true,expectedRevision:0,tournamentRevision:1,units:[unit(h)]});
  const pending=await api('POST','/tournaments/second-cup/matches',a,{});
  assert.equal(pending.opponent.rating,1500); assert.equal(pending.owner.rating,1000);
  const receipts=await Promise.all(Array.from({length:6},()=>api('POST','/matches/'+pending.id+'/cancel',a,{})));
  assert.ok(receipts.every(r=>r.games===1 && r.tournamentId==='second-cup'));
  assert.deepEqual((await me(a)).rating,{rating:1016,games:1});
  assert.deepEqual(await db.prepare('SELECT rating,games FROM tournament_ratings WHERE owner=?').bind(p.id).first(),{rating:984,games:1});
  const other=await db.prepare('SELECT rating,games FROM tournament_ratings WHERE owner=?').bind(stock.id).first();
  assert.equal(other.games,1); assert.equal(other.rating,1500-receipts[0].delta);
});

test('schema 14 upgrades once to event ledgers while preserving identities, fleets and ticket ratings',async()=>{
  const original={mf,db,bucket,dir};
  dir=await mkdtemp(path.join(tmpdir(),'ftd-rating-migration-'));
  let isolated;
  try {
    await start(); isolated=mf;
    for(const file of (await readdir(path.join(root,'migrations'))).sort().filter(f=>f<'0015')) await migrate(file);
    await db.exec("INSERT INTO accounts(id,token_hash,name,rating,games,username,nickname_key) VALUES('pilot','opaque-token','Pilot',1234,7,'private_id','pilot'),('stock','opaque-stock','Stock',800,3,NULL,NULL); INSERT INTO tournaments SELECT 'second-cup','Second','',status,revision,rules,updated FROM tournaments WHERE id='standard-100k'; INSERT INTO system_opponents(owner,tournament) VALUES('stock','second-cup');");
    const digest='a'.repeat(64);
    await db.prepare('INSERT INTO blueprints VALUES(?,?,?)').bind(digest,1,0).run();
    await db.prepare('INSERT INTO tournament_entries(tournament,owner,revision,fleet,fingerprint,updated,composition_key,composition_updated) VALUES(?,?,?,?,?,?,?,?)')
      .bind('second-cup','pilot',1,'{"units":[]}','saved-fingerprint',100,'saved-composition',90).run();
    const ticket={owner:{id:'pilot',rating:1234,games:7},opponent:{id:'stock',rating:800,games:3},seed:123,expiresAt:9999999999};
    await db.prepare("INSERT INTO matches(id,owner,opponent,created,status,ticket,owner_hash,opponent_hash) VALUES('pending','pilot','stock',100,'pending',?,?,?)").bind(JSON.stringify(ticket),digest,digest).run();
    const identity=await db.prepare('SELECT id,token_hash,name,username,nickname_key FROM accounts WHERE id=?').bind('pilot').first();
    const entry=await db.prepare('SELECT * FROM tournament_entries').first();
    await db.exec("UPDATE client_policy SET minimum_version='0.10.0';");
    await api('GET','/health',null,undefined,503);
    await migrate('0015_tournament_ratings.sql');
    assert.deepEqual(await db.prepare('SELECT rating,games FROM tournament_ratings WHERE owner=? AND tournament=?').bind('pilot','standard-100k').first(),{rating:1234,games:7});
    assert.deepEqual(await db.prepare('SELECT rating,games FROM tournament_ratings WHERE owner=? AND tournament=?').bind('pilot','second-cup').first(),{rating:1000,games:0});
    assert.deepEqual(await db.prepare('SELECT rating,games FROM tournament_ratings WHERE owner=?').bind('stock').first(),{rating:800,games:3});
    assert.equal(await db.prepare('SELECT count(*) n FROM tournament_ratings').first('n'),3);
    assert.deepEqual(await db.prepare('SELECT id,token_hash,name,username,nickname_key FROM accounts WHERE id=?').bind('pilot').first(),identity);
    assert.deepEqual(await db.prepare('SELECT * FROM tournament_entries').first(),entry);
    const pending=await db.prepare('SELECT * FROM matches').first();
    assert.equal(pending.tournament,'standard-100k');
    assert.deepEqual(JSON.parse(pending.ticket),{...ticket,tournament:{id:'standard-100k'}});
    await migrate('0016_bilateral_ratings.sql');
    await migrate('0017_blueprint_locations.sql');
    await migrate('0018_blueprint_cleanup.sql');
    await migrate('0019_storage_admin.sql');
    await migrate('0020_nickname_colors.sql');
    await migrate('0021_admin_activity_indexes.sql');
    await migrate('0022_email_recovery.sql');
    assert.deepEqual((await db.prepare('SELECT hash,kind,reference FROM blueprint_references').all()).results,
      [{hash:digest,kind:'match',reference:'pending'}]);
    const health=await api('GET','/health'); assert.equal(health.schemaVersion,22); assert.equal(health.clientPolicy.minimumVersion,'0.10.0');
  } finally {
    if(isolated) await isolated.dispose();
    await rm(dir,{recursive:true,force:true});
    ({mf,db,bucket,dir}=original);
  }
});

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'ftd-cloudflare-')); await start();
  for (const file of (await readdir(path.join(root, 'migrations'))).sort()) await migrate(file);
  baseTournament = await db.prepare('SELECT * FROM tournaments WHERE id=?').bind('standard-100k').first();
  assert.equal(JSON.parse(baseTournament.rules).duration, 600);
  assert.equal(baseTournament.revision, 2); // Fresh install includes the 0010 rule revision.
  // Existing scenarios use revision 1 as their fixture baseline, independently
  // of how many data migrations created the production default tournament.
  baseTournament.revision = 1;
});
after(async () => { if (mf) await mf.dispose(); if (dir) await rm(dir, { recursive: true, force: true }); });
beforeEach(async () => {
  await db.batch(['DELETE FROM blueprint_gc_history', 'DELETE FROM matches', 'DELETE FROM system_defaults', 'DELETE FROM system_opponents', 'DELETE FROM tournament_entries', 'DELETE FROM blueprint_library',
    'DELETE FROM auth_attempts', 'DELETE FROM accounts', 'DELETE FROM blueprint_objects', 'DELETE FROM blueprint_locations', 'DELETE FROM blueprint_lifecycle', 'DELETE FROM blueprints', 'DELETE FROM tournaments'].map(s => db.prepare(s)));
  await db.prepare("UPDATE blueprint_gc_runs SET lease_until=0,token='',last_finished=NULL,last_deleted=0").run();
  const t = baseTournament;
  await db.prepare('INSERT INTO tournaments VALUES(?,?,?,?,?,?,?)').bind(t.id,t.name,t.description,t.status,t.revision,t.rules,t.updated).run();
  await db.prepare("UPDATE client_policy SET minimum_version='0.6.10',minimum_protocol=1,revision=1 WHERE id=1").run();
});

test('health advertises schema and object API; unauthenticated access rejected', async () => {
  const health = await api('GET', '/health'); assert.equal(health.schemaVersion, 22);
  assert.deepEqual(health.capabilities, ['blueprint-objects-v1', 'tournament-fleets-v1', 'blueprint-block-bans-v1', 'battlefield-worlds-v1', 'accounts-auth-v1', 'tournament-ratings-v1', 'bilateral-ratings-v1', 'rating-colors-v1', 'blueprint-shards-v1', 'blueprint-cleanup-v1']);
  await api('GET', '/me', null, undefined, 401);
});


test('both participants update without overwriting results received after a ticket was issued', async () => {
  const {a,b}=await pair(),ma=await match(a),mb=await match(b);
  await result(b,mb,1);
  assert.deepEqual((await me(a)).rating,{rating:984,games:1});
  const receipt=await result(a,ma,1);
  assert.equal(receipt.ownerMatchRating,1000); assert.equal(receipt.opponentRating,1000);
  assert.equal(receipt.before,984); assert.equal(receipt.after,1000);
  assert.equal(receipt.opponentBefore,1016); assert.equal(receipt.opponentAfter,1000);
  for(const player of [a,b]) {
    const current=await me(player);
    assert.deepEqual(current.rating,{rating:1000,games:2}); assert.equal(current.history.length,2);
    assert.equal(current.history.filter(r=>r.initiated===false).length,1);
  }
});
test('concurrent result retries increment once and return the same durable receipt', async () => {
  const { a } = await pair(), m = await match(a);
  const receipts = await Promise.all(Array.from({ length: 12 }, () => result(a, m, 1)));
  for (const r of receipts) assert.deepEqual(r, receipts[0]);
  assert.equal((await me(a)).rating.games, 1); await result(a, m, 0, 409);
});
test('concurrent opposing tickets and repeated submissions update both human ledgers exactly once',async()=>{
  const {a,b}=await pair(),ma=await match(a),mb=await match(b);
  const receipts=await Promise.all(Array.from({length:12},(_,i)=>i%2?result(a,ma,1):result(b,mb,1)));
  for(const id of [ma.id,mb.id]) {
    const group=receipts.filter(r=>r.matchId===id);
    assert.equal(group.length,6); assert.ok(group.every(r=>JSON.stringify(r)===JSON.stringify(group[0])));
  }
  for(const player of [a,b]) {
    const m=await me(player); assert.deepEqual(m.rating,{rating:1000,games:2});
    assert.equal(m.history.length,2); assert.deepEqual(m.history.map(r=>r.score).sort(),[0,1]);
  }
});
test('second human ledger failure rolls back the match and both players before a successful retry',async()=>{
  const {a,b}=await pair(),m=await match(a);
  await db.exec(`CREATE TRIGGER second_ledger_failure BEFORE UPDATE ON tournament_ratings WHEN OLD.owner='${b.account.id}' BEGIN SELECT RAISE(ABORT,'test'); END;`);
  try { await result(a,m,1,503); } finally { await db.exec('DROP TRIGGER second_ledger_failure'); }
  for(const player of [a,b]) assert.deepEqual((await me(player)).rating,{rating:1000,games:0});
  assert.equal((await me(a)).pending.id,m.id);
  await result(a,m,1);
  assert.deepEqual((await me(a)).rating,{rating:1016,games:1});
  assert.deepEqual((await me(b)).rating,{rating:984,games:1});
});
test('rating floor bounds the shared transfer without creating points',async()=>{
  const {a,b}=await pair();
  await db.prepare('UPDATE tournament_ratings SET rating=1 WHERE owner=?').bind(a.account.id).run();
  await db.prepare('UPDATE tournament_ratings SET rating=0 WHERE owner=?').bind(b.account.id).run();
  const loss=await result(a,await match(a),0);
  assert.equal(loss.delta,-1); assert.equal(loss.opponentDelta,1);
  assert.equal(loss.after,0); assert.equal(loss.opponentAfter,1);
  const win=await result(a,await match(a),1);
  assert.equal(win.delta,1); assert.equal(win.after,1); assert.equal(win.opponentAfter,0);
});
test('forfeits appear as wins for the passive opponent and historical one-sided receipts do not invent opponent games',async()=>{
  const {a,b}=await pair(),m=await match(a);
  await api('POST','/matches/'+m.id+'/cancel',a,{});
  let passive=(await me(b)).history[0];
  assert.equal(passive.score,1); assert.equal(passive.outcome.kind,'opponent-surrender'); assert.equal(passive.delta,16);
  const expired=await match(a); await expireMatches(db,expired.expiresAt);
  passive=(await me(b)).history[0]; assert.equal(passive.outcome.kind,'opponent-expired');
  await db.prepare("UPDATE matches SET receipt=json_remove(receipt,'$.opponentAfter') WHERE id=?").bind(m.id).run();
  assert.equal((await me(b)).history.length,1); assert.equal((await me(a)).history.length,2);
});
test('concurrent match requests reuse one reservation', async () => {
  const { a } = await pair(); const tickets = await Promise.all(Array.from({ length: 8 }, () => match(a)));
  assert.equal(new Set(tickets.map(t => t.id)).size, 1);
});

test('server deadline survives restart and rematching cannot reroll an unfinished opponent', async () => {
  const { a } = await fleets(), m = await fleetMatch(a);
  assert.equal(m.expiresAt, m.created + 1800);
  assert.equal(submissionDeadline(100, 3600), 10900);
  await mf.dispose(); await start();
  assert.deepEqual(await fleetMatch(a), m);
  assert.equal((await me(a)).pending.expiresAt, m.expiresAt);
  const row = await db.prepare('SELECT * FROM matches WHERE id=?').bind(m.id).first();
  assert.equal((await submitResult(db, row, resultBody(m, 1), m.expiresAt - .001)).score, 1);
});

test('offline expiry settles the owner once and a late fabricated win returns the authoritative loss', async () => {
  const { a, b } = await fleets(), m = await fleetMatch(a);
  const opponentBefore = (await me(b)).account;
  assert.equal(await expireMatches(db, m.expiresAt - .001), 0);
  assert.equal(await expireMatches(db, m.expiresAt), 1);
  assert.equal(await expireMatches(db, m.expiresAt), 0);
  await mf.dispose(); await start();
  const receipt = await result(a, m, 1);
  assert.equal(receipt.score, 0); assert.equal(receipt.outcome.kind, 'submission-expired');
  assert.equal(receipt.games, 1); assert.equal(receipt.after, 984);
  assert.deepEqual((await me(b)).account, opponentBefore);
  assert.deepEqual(await api('POST', `/matches/${m.id}/cancel`, a, {}), receipt);
  assert.equal((await me(a)).rating.games, 1);
});

test('overdue owners are settled before new matching or normal authenticated access', async () => {
  const { a } = await fleets(), m = await fleetMatch(a);
  await db.prepare("UPDATE matches SET ticket=json_set(ticket,'$.expiresAt',0) WHERE id=?").bind(m.id).run();
  const next = await fleetMatch(a);
  assert.notEqual(next.id, m.id); assert.equal(next.owner.games, 1); assert.equal(next.owner.rating, 984);
  const receipt = await result(a, m, 1); assert.equal(receipt.outcome.kind, 'submission-expired');
  assert.equal((await me(a)).pending.id, next.id);
});

test('surrender is an idempotent loss and a client cannot forge a server-forfeit outcome', async () => {
  const { a, b } = await pair(), m = await match(a);
  await api('POST', `/matches/${m.id}/result`, a, {score:0,outcome:{kind:'submission-expired'}},400);
  const receipts = await Promise.all(Array.from({length:8},()=>api('POST', `/matches/${m.id}/cancel`, a, {})));
  for (const r of receipts) assert.deepEqual(r, receipts[0]);
  assert.equal(receipts[0].outcome.kind, 'surrender'); assert.equal(receipts[0].score, 0);
  assert.equal((await me(a)).rating.games, 1); assert.equal((await me(b)).rating.games, 1);
});

test('expiry/result/surrender races and transaction failures never double-count a match', async () => {
  const { a } = await pair(), m = await match(a);
  await db.exec("CREATE TRIGGER fail_expiry BEFORE UPDATE OF status ON matches WHEN NEW.status='completed' BEGIN SELECT RAISE(ABORT,'expiry failure'); END;");
  try { await assert.rejects(expireMatches(db,m.expiresAt)); }
  finally { await db.exec('DROP TRIGGER fail_expiry;'); }
  assert.equal((await me(a)).rating.games,0); assert.equal((await me(a)).pending.id,m.id);
  await Promise.all([
    expireMatches(db,m.expiresAt),
    result(a,m,1),
    api('POST',`/matches/${m.id}/cancel`,a,{})
  ]);
  assert.equal((await me(a)).rating.games,1);
  assert.equal((await me(a)).history.length,1);
});



test('scheduled handler processes a bounded backlog without a player connection', async () => {
  const {a,b}=await pair(), m=await match(a);
  await db.prepare("UPDATE matches SET ticket=json_set(ticket,'$.expiresAt',0) WHERE id=?").bind(m.id).run();
  for(let i=0;i<15;i++) {
    const id='offline-'+i, mid=hash(id).slice(0,32), ticket={...m,id:mid,owner:{...m.owner,id},expiresAt:0};
    await db.batch([
      db.prepare('INSERT INTO accounts(id,token_hash,name) VALUES(?,?,?)').bind(id,hash(id),'offline'),
      db.prepare("INSERT INTO tournament_ratings(tournament,owner) VALUES('standard-100k',?)").bind(id),
      db.prepare(`INSERT INTO matches(id,owner,opponent,created,status,ticket,owner_hash,opponent_hash,tournament)
        VALUES(?,?,?,0,'pending',?,?,?,'standard-100k')`).bind(mid,id,b.account.id,JSON.stringify(ticket),m.ownerFleet.units[0].hash,m.opponentFleet.units[0].hash)
    ]);
  }
  await worker.scheduled({}, {DB:db}, {});
  assert.equal(await db.prepare("SELECT count(*) AS n FROM matches WHERE status='pending'").first('n'),7);
  await worker.scheduled({}, {DB:db}, {});
  assert.equal(await db.prepare("SELECT count(*) AS n FROM matches WHERE status='pending'").first('n'),0);
  assert.equal(await db.prepare('SELECT sum(games) AS n FROM tournament_ratings').first('n'),32);
});
test('surrender/result races settle once with the winning transaction result', async () => {
  const { a } = await pair(), m = await match(a);
  const calls = [['result', resultBody(m,1)], ['cancel', {}]].map(async ([action, body]) => {
    const r = await clientFetch(`https://rank.test/matches/${m.id}/${action}`, { method: 'POST',
      headers: { Authorization: 'Bearer ' + a.token }, body: JSON.stringify(body) });
    assert.ok([200, 409].includes(r.status)); return r.json();
  });
  await Promise.all(calls);
  const row = await db.prepare('SELECT * FROM matches WHERE id=?').bind(m.id).first();
  const account = (await me(a)).rating;
  assert.equal(row.status, 'completed'); assert.equal(account.games, 1);
  assert.equal(account.rating, row.score === 1 ? 1016 : 984);
});
test('loss, draw, invalid results, cancellation and ownership', async () => {
  const { a, b } = await pair();
  assert.equal((await result(a, await match(a), .5)).after, 1000);
  assert.equal((await result(a, await match(a), 0)).after, 984);
  const m = await match(a);
  for (const score of [true, null, '1', -1, 2]) await result(a, m, score, 400);
  await result(b, m, 1, 404); await api('GET', `/matches/${m.id}/fleet-blueprints/${m.ownerFleet.units[0].hash}`, b, undefined, 404);
  await api('POST', `/matches/${m.id}/cancel`, a, {});
  assert.equal((await result(a, m, 1)).outcome.kind, 'surrender'); assert.equal((await me(a)).rating.games, 3);
});


test('large BP is compressed in D1 and survives restart byte for byte', async () => {
  const { a } = await pair();
  await db.prepare('UPDATE tournament_entries SET composition_updated=0 WHERE owner=?').bind(a.account.id).run();
  const bp = blueprint('큰 기체', 'x'.repeat(3 * 1024 * 1024)); await upload(a, bp); await submitFleet(a,[unit(hash(bp))]);
  assert.equal((await bucket.head(key(bp))).size, Buffer.byteLength(bp));
  assert.ok((await bucket.head(key(bp))).compressed_size < 10000);
  const m = await match(a); await mf.dispose(); await start();
  assert.equal((await me(a)).pending.id, m.id);
  const r = await clientFetch('https://rank.test' + `/matches/${m.id}/fleet-blueprints/${m.ownerFleet.units[0].hash}`, { headers: { Authorization: 'Bearer ' + a.token } });
  assert.equal(await r.text(), bp);
  const receipt = await result(a, m, 1); await mf.dispose(); await start();
  assert.deepEqual(await result(a, m, 1), receipt);
});

test('D1 chunks preserve an incompressible 8 MiB BP and deduplicate concurrent uploads', async () => {
  const bytes = randomBytes(8 * 1024 * 1024), objectKey = key(bytes);
  await Promise.all([bucket.put(objectKey, bytes), bucket.put(objectKey, bytes)]);
  const manifest = await bucket.head(objectKey);
  assert.equal(manifest.size, bytes.length);
  const chunks = (await db.prepare('SELECT part,length(data) AS size FROM blueprint_chunks WHERE key=? ORDER BY part').bind(objectKey).all()).results;
  assert.equal(chunks.length, 17); assert.ok(chunks.every(c => c.size <= 699052));
  assert.equal(await db.prepare('SELECT count(*) AS n FROM blueprint_objects').first('n'), 1);
  assert.deepEqual(Buffer.from(await (await bucket.get(objectKey)).arrayBuffer()), bytes);
});

test('published BP storage changes preserve issued tickets, downloads, login and bilateral settlement',async()=>{
  const original={mf,db,bucket,dir};dir=await mkdtemp(path.join(tmpdir(),'ftd-shard-e2e-'));let isolated;
  try{
    await start({BLUEPRINT_WRITE_DB:'BP_DB_01'},{BP_DB_01:'bp-one',BP_DB_02:'bp-two'});isolated=mf;
    for(const file of (await readdir(path.join(root,'migrations'))).sort())await migrate(file);
    await db.prepare('UPDATE tournaments SET revision=1').run();
    const one=await mf.getD1Database('BP_DB_01'),two=await mf.getD1Database('BP_DB_02');
    const schema=await readFile(path.join(root,'storage-migrations/0001_blueprints.sql'),'utf8');
    const statements=schema.replace(/--[^\n]*/g,'').split(';').map(s=>s.trim()).filter(Boolean);
    for(const shard of [one,two])await shard.batch(statements.map(s=>shard.prepare(s)));
    const {a,b,h1}=await fleets(),m=await fleetMatch(a);
    const identities=(await db.prepare('SELECT * FROM accounts ORDER BY id').all()).results;
    const entries=(await db.prepare('SELECT * FROM tournament_entries ORDER BY owner').all()).results;
    const adapter=d=>({query:async s=>(await d.prepare(s).all()).results,batch:async s=>d.batch(s.map(q=>d.prepare(q)))});
    const objectKey='blueprints/'+h1+'.blueprint';
    await copyAndRoute({main:adapter(db),source:adapter(one),target:adapter(two),from:'BP_DB_01',to:'BP_DB_02',key:objectKey});
    // Simulate retiring the original copy after the separately tested grace period.
    await blueprintStore(one).delete(objectKey);
    const response=await clientFetch('https://rank.test'+`/matches/${m.id}/fleet-blueprints/${h1}`,{headers:{Authorization:'Bearer '+a.token}});
    assert.equal(response.status,200);assert.equal(await response.text(),blueprint('Flagship'));
    assert.deepEqual((await me(a)).pending,m);
    assert.deepEqual((await db.prepare('SELECT * FROM accounts ORDER BY id').all()).results,identities);
    assert.deepEqual((await db.prepare('SELECT * FROM tournament_entries ORDER BY owner').all()).results,entries);
    const receipt=await result(a,m,1);assert.equal(receipt.after,1016);assert.equal((await me(b)).rating.rating,984);
    const login=await api('POST','/auth/login',null,{username:a.auth.username,password:testPassword});assert.equal(login.account.id,a.account.id);
  }finally{
    if(isolated)await isolated.dispose();
    const resolved=path.resolve(dir),prefix=path.resolve(tmpdir())+path.sep+'ftd-shard-e2e-';
    if(!resolved.startsWith(prefix))throw Error('Unexpected test cleanup path');await rm(resolved,{recursive:true,force:true});
    ({mf,db,bucket,dir}=original);
  }
});

test('D1 BP writes are atomic and corrupted chunks fail closed', async () => {
  const bytes = randomBytes(1024 * 1024), objectKey = key(bytes);
  await db.exec("CREATE TRIGGER fail_bp_chunk BEFORE INSERT ON blueprint_chunks WHEN NEW.part=1 BEGIN SELECT RAISE(ABORT,'chunk failure'); END;");
  try { await assert.rejects(bucket.put(objectKey, bytes)); }
  finally { await db.exec('DROP TRIGGER fail_bp_chunk;'); }
  assert.equal(await bucket.head(objectKey), null);
  assert.equal(await db.prepare('SELECT count(*) AS n FROM blueprint_chunks').first('n'), 0);
  await bucket.put(objectKey, bytes);
  await db.prepare('DELETE FROM blueprint_chunks WHERE key=? AND part=1').bind(objectKey).run();
  await assert.rejects(bucket.get(objectKey), e => e.status === 503);
});

test('D1 BP store rejects mismatched size, hash, empty and oversized actual bodies', async () => {
  const bytes = Buffer.from('original BP');
  await assert.rejects(bucket.put(key(bytes), bytes, { size: 1 }));
  await assert.rejects(bucket.put(key(bytes), Buffer.from('different')));
  await assert.rejects(bucket.put(key(Buffer.alloc(0)), Buffer.alloc(0)));
  const tooLarge = Buffer.alloc(8 * 1024 * 1024 + 1);
  await assert.rejects(bucket.put(key(tooLarge), tooLarge));
  assert.equal(await db.prepare('SELECT count(*) AS n FROM blueprint_objects').first('n'), 0);
});

test('legacy import SQL stores gzip chunks readable by the deployed D1 adapter', async () => {
  const bytes = randomBytes(2 * 1024 * 1024), statements = blueprintSql(bytes);
  assert.ok(statements.length > 17);
  assert.ok(statements.every(s => Buffer.byteLength(s) < 100000));
  await db.batch(statements.map(s => db.prepare(s)));
  assert.deepEqual(Buffer.from(await (await bucket.get(key(bytes))).arrayBuffer()), bytes);
});
test('checksum mismatch and oversized requests do not publish BP references', async () => {
  const a = await register('Alpha');
  await upload(a, blueprint('bad'), 400, 'f'.repeat(64));
  assert.equal(await db.prepare('SELECT count(*) n FROM blueprint_library WHERE owner=?').bind(a.account.id).first('n'),0);
  const r = await clientFetch('https://rank.test/blueprints/raw', { method: 'POST',
    headers: { Authorization: 'Bearer ' + a.token, 'Content-Length': String(9 * 1024 * 1024),
      'X-Blueprint-Sha256': 'a'.repeat(64), 'X-Blueprint-Name':'Oversized', 'X-Blueprint-Cost':'10000' } });
  assert.equal(r.status, 413);
});
test('D1 settlement failure rolls back account update, allowing retry', async () => {
  const { a } = await pair(), m = await match(a);
  await db.exec("CREATE TRIGGER test_fail BEFORE UPDATE OF status ON matches WHEN NEW.status='completed' BEGIN SELECT RAISE(ABORT, 'test failure'); END;");
  try { await result(a, m, 1, 503); assert.equal((await me(a)).rating.games, 0); }
  finally { await db.exec('DROP TRIGGER test_fail;'); }
  assert.equal((await result(a, m, 1)).games, 1);
});


test('missing BP keeps the same ticket available; explicit surrender records a loss', async () => {
  const { a } = await pair(), m = await match(a);
  await bucket.delete(key(blueprint()));
  await api('GET', `/matches/${m.id}/fleet-blueprints/${m.ownerFleet.units[0].hash}`, a, undefined, 503);
  assert.equal((await me(a)).pending.id, m.id);
  await api('POST', `/matches/${m.id}/cancel`, a, {});
  assert.equal((await me(a)).rating.games, 1);
});


const tournamentId = 'standard-100k';
const admin = { token: 'local-test-admin-only' };
async function getTournament(a, id = tournamentId) { return (await api('GET', '/tournaments/' + id, a)).tournament; }
async function configure(a, changes = {}, id = tournamentId) {
  const t = await getTournament(a, id);
  return (await api('PUT', '/admin/tournaments/' + id, admin, { ...t, expectedRevision: t.revision,
    ...changes, rules: { ...t.rules, ...changes.rules } })).tournament;
}
async function library(a, name, cost, expected = 200, bp = blueprint(name)) {
  const digest = hash(bp);
  const r = await clientFetch('https://rank.test/blueprints/raw', { method: 'POST', body: bp,
    headers: { Authorization: 'Bearer ' + a.token, 'Content-Length': String(Buffer.byteLength(bp)),
      'X-Blueprint-Sha256': digest, 'X-Blueprint-Name': encodeURIComponent(name), 'X-Blueprint-Cost': String(cost) } });
  const result = await r.json(); assert.equal(r.status, expected, JSON.stringify(result)); return digest;
}
const unit = (hash, x = 0, z = 0) => ({ hash, x, z, altitude: 0, yaw: 0 });
async function submitFleet(a, units, revision = 1, expected = 200) {
  return api('PUT', `/tournaments/${tournamentId}/entry`, a, { revision, units }, expected);
}
const fleetMatch = a => api('POST', `/tournaments/${tournamentId}/matches`, a, {});

const gcEnv = () => ({DB:db,BLUEPRINT_CLEANUP:'true'});
const bpKey = h => 'blueprints/'+h+'.blueprint';
const gcAge = () => db.prepare('UPDATE blueprint_lifecycle SET hold_until=0,unused_since=CASE WHEN unused_since IS NULL THEN NULL ELSE 0 END').run();
const life = h => db.prepare('SELECT * FROM blueprint_lifecycle WHERE hash=?').bind(h).first();

test('storage admin APIs require admin authorization and HTTPS; summaries expose no credentials',async()=>{
  const a=await register('Storage access'),h=await library(a,'Storage test',1000);
  const routes=['/admin/storage','/admin/blueprints','/admin/blueprints/'+h+'/download'];
  for(const route of routes){
    for(const caller of [null,a,{token:'wrong'}])await api('GET',route,caller,undefined,403);
    const r=await mf.dispatchFetch('http://rank.test'+route,{headers:{Authorization:'Bearer '+admin.token}});assert.equal(r.status,400);
    await api('POST',route,admin,{},404);
  }
  const before=await life(h),response=await mf.dispatchFetch('https://rank.test/admin/storage',{headers:{Authorization:'Bearer '+admin.token}});
  assert.equal(response.headers.get('cache-control'),'no-store');
  const summary=await response.json();assert.equal(summary.databases.length,1);
  assert.equal(summary.databases[0].limit,500000000);assert(summary.databases[0].bytes>0);
  assert.equal(summary.total.remaining,500000000-summary.total.bytes);
  assert.equal(summary.databases[0].objects,1);assert.deepEqual(await life(h),before);
  const serialized=JSON.stringify(summary);for(const secret of [a.token,a.auth.username,admin.token,'password_hash'])assert(!serialized.includes(secret));
});

test('storage admin supports additional DBs and reports missing size or failed storage as unknown instead of zero',async()=>{
  const shard={withSession(){return {prepare(){return {async all(){return {meta:{size_after:120000000},results:[{objects:3}]};}};}};}};
  const missingSize={withSession(){return {prepare(){return {async all(){return {meta:{},results:[{objects:0}]};}};}};}};
  const broken={withSession(){throw Error('private binding error');}};
  let report=await storageOverview({...gcEnv(),BP_DB_01:shard,BLUEPRINT_WRITE_DB:'BP_DB_01'},db);
  assert.equal(report.databases.length,2);assert.equal(report.databases[1].remaining,380000000);assert(report.databases[1].writer);
  assert.equal(report.total.limit,1000000000);assert(report.total.bytes>120000000);
  report=await storageOverview({...gcEnv(),BP_DB_01:missingSize,BP_DB_02:broken},db);
  assert.equal(report.total.bytes,null);assert.equal(report.total.remaining,null);
  assert.equal(report.databases[1].bytes,null);assert.equal(report.databases[2].available,false);
  assert(!JSON.stringify(report).includes('private binding error'));
});

test('admin BP search paginates without duplicates and treats wildcard and SQL characters literally',async()=>{
  const a=await register('Search');
  for(let i=0;i<27;i++)await library(a,i===4?'Percent%_ BP':'Stored '+i,1000);
  const first=await api('GET','/admin/blueprints',admin),second=await api('GET','/admin/blueprints?after='+first.next,admin);
  assert.equal(first.blueprints.length,25);assert.equal(second.blueprints.length,2);assert.equal(second.next,null);
  const all=[...first.blueprints,...second.blueprints];assert.equal(new Set(all.map(b=>b.hash)).size,27);
  const special=await api('GET','/admin/blueprints?q='+encodeURIComponent('%_'),admin);assert.equal(special.blueprints.length,1);
  assert.equal(special.blueprints[0].name,'Percent%_ BP');
  assert.equal((await api('GET','/admin/blueprints?q='+special.blueprints[0].hash,admin)).blueprints.length,1);
  assert.equal((await api('GET','/admin/blueprints?q='+encodeURIComponent(a.account.name),admin)).blueprints.length,25);
  assert.equal((await api('GET','/admin/blueprints?q='+encodeURIComponent("' OR 1=1 --"),admin)).blueprints.length,0);
  await api('GET','/admin/blueprints?after=bad',admin,undefined,400);
  await api('GET','/admin/blueprints?q='+encodeURIComponent('a\nb'),admin,undefined,400);
});

test('admin download returns verified original BP with safe Unicode filename and protects it from cleanup',async()=>{
  const a=await register('Download'),raw=blueprint('Download source'),h=await library(a,'한국 기체/試験.blueprint',1000,200,raw);
  await gcAge();
  const response=await mf.dispatchFetch('https://rank.test/admin/blueprints/'+h+'/download',{headers:{Authorization:'Bearer '+admin.token}});
  assert.equal(response.status,200);assert.equal(response.headers.get('x-blueprint-sha256'),h);
  assert.equal(response.headers.get('cache-control'),'private, no-store');assert.match(response.headers.get('content-disposition'),/^attachment;/);
  assert(response.headers.get('content-disposition').includes(encodeURIComponent('한국 기체_試験.blueprint')));
  assert.equal(await response.text(),raw);assert((await life(h)).hold_until>Date.now()/1000);
  assert.equal((await cleanupBlueprints(gcEnv(),db)).deleted,0);
  await gcAge();assert.equal((await cleanupBlueprints(gcEnv(),db)).deleted,1);
  await api('GET','/admin/blueprints/'+h+'/download',admin,undefined,410);
  assert.equal((await life(h)).state,'deleted');assert.equal((await api('GET','/admin/blueprints',admin)).blueprints.length,0);
  await api('GET','/admin/blueprints/'+'f'.repeat(64)+'/download',admin,undefined,404);
});

test('cleanup history records exact confirmed copies, failures and interrupted attempts without empty-run noise',async()=>{
  const a=await register('History'),h=await library(a,'History BP',1000);await gcAge();
  const bytes=(await bucket.head(bpKey(h))).compressed_size;
  const broken={withSession(){throw Error('do not expose private secret');}};
  const stamp=Date.now()/1000;
  await assert.rejects(cleanupBlueprints({...gcEnv(),BP_DB_01:broken},db,stamp));
  let records=(await api('GET','/admin/storage',admin)).cleanup.history;
  assert.equal(records.length,1);assert.equal(records[0].status,'failed');assert.equal(records[0].error,'delete');
  assert.equal(records[0].confirmed_bytes,bytes);assert.equal(records[0].confirmed_copies,1);assert.equal(records[0].deleted_count,0);
  assert.equal(records[0].items[0].name,'History BP');assert(!JSON.stringify(records).includes('private secret'));
  await api('GET','/admin/blueprints/'+h+'/download',admin,undefined,410);
  assert.equal((await cleanupBlueprints(gcEnv(),db,stamp+3601)).deleted,1);
  records=(await api('GET','/admin/storage',admin)).cleanup.history;
  assert.equal(records[0].status,'completed');assert.equal(records[0].deleted_count,1);assert.equal(records[0].confirmed_bytes,0);
  await db.prepare("INSERT INTO blueprint_gc_history(id,started,status) VALUES('aborted',?,'running')").bind(stamp-3601).run();
  await cleanupBlueprints(gcEnv(),db,stamp+3602);
  const interrupted=await db.prepare("SELECT * FROM blueprint_gc_history WHERE id='aborted'").first();assert.equal(interrupted.status,'interrupted');
  assert.equal(await db.prepare('SELECT count(*) n FROM blueprint_gc_history').first('n'),3);
});

test('cleanup history retains at most the newest 100 records',async()=>{
  await db.batch(Array.from({length:110},(_,i)=>db.prepare("INSERT INTO blueprint_gc_history(id,started,finished,status) VALUES(?,?,?,'completed')")
    .bind('old-'+String(i).padStart(3,'0'),i,i)));
  await cleanupBlueprints(gcEnv(),db);
  assert.equal(await db.prepare('SELECT count(*) n FROM blueprint_gc_history').first('n'),100);
  const records=(await api('GET','/admin/storage',admin)).cleanup.history;
  assert.equal(records[0].id,'old-109');assert.equal(records.at(-1).id,'old-010');
});

test('BP cleanup gives unsubmitted uploads a full day, refreshes it on retry and supports re-upload',async()=>{
  const a=await register('Draft'),h=await library(a,'Draft BP',1000),created=await life(h);
  assert.equal((await cleanupBlueprints(gcEnv(),db,created.hold_until-1)).deleted,0);
  await library(a,'Draft BP',1000);const refreshed=await life(h);
  assert.ok(refreshed.hold_until>=created.hold_until);
  assert.equal((await cleanupBlueprints(gcEnv(),db,refreshed.hold_until+1)).deleted,1);
  assert.equal(await bucket.head(bpKey(h)),null);
  assert.equal(await db.prepare('SELECT count(*) n FROM blueprint_library').first('n'),0);
  assert.equal((await life(h)).state,'deleted');
  assert.equal((await cleanupBlueprints(gcEnv(),db,refreshed.hold_until+2)).deleted,0);
  await library(a,'Draft BP',1000);await submitFleet(a,[unit(h)]);
  assert.equal((await life(h)).generation,created.generation+1);
  assert.equal(await(await bucket.get(bpKey(h))).text(),blueprint('Draft BP'));
});

test('BP cleanup preserves every pending fleet hash after replacement, then deletes bytes without changing history or ratings',async()=>{
  const {a,b,h1,h2}=await fleets(),m=await fleetMatch(b);
  const replacement=await library(a,'Replacement',30000);
  await db.prepare('UPDATE tournament_entries SET composition_updated=0 WHERE owner=?').bind(a.account.id).run();
  await submitFleet(a,[unit(replacement)]);await gcAge();
  assert.equal((await cleanupBlueprints(gcEnv(),db)).deleted,0);
  for(const h of [h1,h2]) {
    const r=await clientFetch(`https://rank.test/matches/${m.id}/fleet-blueprints/${h}`,{headers:{Authorization:'Bearer '+b.token}});
    assert.equal(r.status,200);assert.equal(hash(await r.text()),h);
  }
  await result(b,m,1);
  const before=(await db.prepare('SELECT * FROM matches').all()).results;
  const ratings=(await db.prepare('SELECT * FROM tournament_ratings ORDER BY owner').all()).results;
  const identities=(await db.prepare('SELECT * FROM accounts ORDER BY id').all()).results;
  assert.equal((await cleanupBlueprints(gcEnv(),db)).deleted,0); // Day starts when the final match ends.
  const unused=(await life(h2)).unused_since;
  assert.equal((await cleanupBlueprints(gcEnv(),db,unused+86401)).deleted,2);
  for(const h of [h1,h2])assert.equal(await bucket.head(bpKey(h)),null);
  assert.deepEqual((await db.prepare('SELECT * FROM matches').all()).results,before);
  assert.deepEqual((await db.prepare('SELECT * FROM tournament_ratings ORDER BY owner').all()).results,ratings);
  assert.deepEqual((await db.prepare('SELECT * FROM accounts ORDER BY id').all()).results,identities);
  assert.equal((await me(b)).history[0].score,1);
  await api('GET',`/matches/${m.id}/fleet-blueprints/${h1}`,b,undefined,410);
});

test('BP cleanup keeps shared users, other events, stale entries and disabled stock fleets',async()=>{
  const {a,b,h1,h2}=await fleets();
  await library(b,'Shared flagship',50000,200,blueprint('Flagship'));
  await db.prepare('UPDATE tournament_entries SET composition_updated=0 WHERE owner=?').bind(b.account.id).run();
  await submitFleet(b,[unit(h1)]);
  const t=await getTournament(a);
  await api('PUT','/admin/tournaments/other-cup',admin,{...t,id:'other-cup',name:'Other',expectedRevision:0});
  await api('PUT','/tournaments/other-cup/entry',a,{revision:1,units:[unit(h2)]});
  const replacement=await library(a,'New flagship',1000);
  await db.prepare('UPDATE tournament_entries SET composition_updated=0 WHERE owner=?').bind(a.account.id).run();
  await submitFleet(a,[unit(replacement)]);
  const stock=await newOpponent(),sh=await stockLibrary(stock,'Disabled stock',1000);
  await saveOpponent(stock,[unit(sh)],{enabled:false});
  await db.prepare("UPDATE tournament_entries SET revision=0 WHERE tournament='other-cup'").run();
  await gcAge();await cleanupBlueprints(gcEnv(),db);
  for(const h of [h1,h2,sh,replacement])assert(await bucket.head(bpKey(h)));
  await assert.rejects(db.prepare("UPDATE blueprint_lifecycle SET state='deleting' WHERE hash=?").bind(h2).run(),/BP_IN_USE/);
});

test('BP cleanup atomically blocks stale submissions and uploads after claiming deletion',async()=>{
  const a=await register('Race'),h=await library(a,'Race BP',1000);await gcAge();
  let checked=false;
  const wrapped={batch:s=>db.batch(s),prepare(sql){
    const stmt=db.prepare(sql);
    if(!sql.startsWith('DELETE FROM blueprint_objects'))return stmt;
    return {bind(...args){return {async run(){
      checked=true;assert.equal((await life(h)).state,'deleting');
      await submitFleet(a,[unit(h)],1,409);
      await library(a,'Race BP',1000,409);
      return stmt.bind(...args).run();
    }};}};
  }};
  assert.equal((await cleanupBlueprints(gcEnv(),wrapped)).deleted,1);assert(checked);
  assert.equal(await db.prepare('SELECT count(*) n FROM tournament_entries').first('n'),0);
  await library(a,'Race BP',1000);await submitFleet(a,[unit(h)]);
});

test('BP cleanup overlapping collectors share an exclusive lease and submissions win before a claim',async()=>{
  const a=await register('Overlap'),h=await library(a,'Overlap BP',1000);await gcAge();
  const wrapped={batch:s=>db.batch(s),prepare(sql){
    const stmt=db.prepare(sql);
    if(!sql.startsWith('DELETE FROM blueprint_objects'))return stmt;
    return {bind(...args){return {async run(){
      assert.deepEqual(await cleanupBlueprints(gcEnv(),db),{busy:true});
      return stmt.bind(...args).run();
    }};}};
  }};
  assert.equal((await cleanupBlueprints(gcEnv(),wrapped)).deleted,1);
  await library(a,'Overlap BP',1000);await submitFleet(a,[unit(h)]);await gcAge();
  assert.equal((await cleanupBlueprints(gcEnv(),db)).deleted,0);assert(await bucket.head(bpKey(h)));
});

test('BP cleanup resumes failed multi-DB deletion, cleans duplicate copies and rejects uploads until finished',async()=>{
  const original={mf,db,bucket,dir};dir=await mkdtemp(path.join(tmpdir(),'ftd-gc-e2e-'));let isolated;
  try{
    await start({BLUEPRINT_WRITE_DB:'BP_DB_01'},{BP_DB_01:'gc-one',BP_DB_02:'gc-two'});isolated=mf;
    for(const file of (await readdir(path.join(root,'migrations'))).sort())await migrate(file);
    const one=await mf.getD1Database('BP_DB_01'),two=await mf.getD1Database('BP_DB_02');
    const statements=migrationStatements(await readFile(path.join(root,'storage-migrations/0001_blueprints.sql'),'utf8'));
    for(const shard of [one,two])await shard.batch(statements.map(s=>shard.prepare(s)));
    const a=await register('Shards'),raw=blueprint('Sharded BP'),h=await library(a,'Sharded BP',1000),k=bpKey(h);
    await bucket.put(k,Buffer.from(raw));await blueprintStore(two).put(k,Buffer.from(raw));await gcAge();
    const bad={withSession(){return {prepare(){throw Error('simulated shard unavailable');}};}};
    const env={...gcEnv(),BP_DB_01:one,BP_DB_02:two};
    const stamp=Date.now()/1000;
    await assert.rejects(cleanupBlueprints({...env,BP_DB_02:bad},db,stamp),/simulated/);
    assert.equal((await life(h)).state,'deleting');assert(await blueprintStore(two).head(k));
    await library(a,'Sharded BP',1000,409);
    assert.deepEqual(await cleanupBlueprints(env,db,stamp+1),{busy:true});
    assert.equal((await cleanupBlueprints(env,db,stamp+3601)).deleted,1);
    for(const store of [bucket,blueprintStore(one),blueprintStore(two)])assert.equal(await store.head(k),null);
    assert.equal(await db.prepare('SELECT count(*) n FROM blueprint_locations').first('n'),0);
    await library(a,'Sharded BP',1000);assert(await blueprintStore(one).head(k));
  }finally{
    if(isolated)await isolated.dispose();
    const resolved=path.resolve(dir),prefix=path.resolve(tmpdir())+path.sep+'ftd-gc-e2e-';
    if(!resolved.startsWith(prefix))throw Error('Unexpected test cleanup path');await rm(resolved,{recursive:true,force:true});
    ({mf,db,bucket,dir}=original);
  }
});

test('BP cleanup runs in bounded separate scheduled batches and leaves unpublished partial uploads retryable',async()=>{
  const a=await register('Batch');
  for(let i=0;i<21;i++)await library(a,'Unused '+i,1000);
  // A failed upload can have bytes without a catalog/library row. Its reservation
  // is also collectible; no scan of all compressed objects is required.
  const raw=Buffer.from(blueprint('Failed publish')),h=hash(raw);
  await holdBlueprint(db,h);await bucket.put(bpKey(h),raw);await gcAge();
  await worker.scheduled({cron:CLEANUP_CRON},gcEnv(),{});
  assert.equal(await db.prepare('SELECT last_deleted FROM blueprint_gc_runs').first('last_deleted'),20);
  assert.equal(await db.prepare('SELECT count(*) n FROM blueprint_objects').first('n'),2);
  await worker.scheduled({cron:CLEANUP_CRON},gcEnv(),{});
  assert.equal(await db.prepare('SELECT count(*) n FROM blueprint_objects').first('n'),0);
  assert.equal(await db.prepare('SELECT count(*) n FROM blueprint_chunks').first('n'),0);
  assert.equal(await db.prepare('SELECT count(*) n FROM blueprint_library').first('n'),0);
});
test('fleet names persist across edits and logins without composition cooldown and freeze in match snapshots', async () => {
  const {a,b}=await fleets();
  const initial=(await api('GET','/tournaments/'+tournamentId,a)).entry;
  const units=initial.fleet.units;
  const named=(await api('PUT','/tournaments/'+tournamentId+'/entry',a,{revision:1,units,fleetName:'  Ａ 항공 편대  '})).entry;
  assert.equal(named.fleet.name,'A 항공 편대'); assert.equal(named.replaceAt,initial.replaceAt);
  assert.equal(named.compositionUpdated,initial.compositionUpdated);
  for(const fleetName of ['', ' ', 'a\nb', 'x'.repeat(41), 12, null])
    await api('PUT','/tournaments/'+tournamentId+'/entry',a,{revision:1,units,fleetName},400);
  const renamed=(await api('PUT','/tournaments/'+tournamentId+'/entry',a,{revision:1,units,fleetName:'새 편대'})).entry;
  assert.equal(renamed.replaceAt,initial.replaceAt);
  assert.equal((await submitFleet(a,units)).entry.fleet.name,'새 편대'); // Older client omits the name.
  const login=await api('POST','/auth/login',null,{username:a.auth.username,password:testPassword});
  assert.equal((await api('GET','/tournaments/'+tournamentId,login)).entry.fleet.name,'새 편대');
  const other=(await api('GET','/tournaments/'+tournamentId,b)).entry;
  await api('PUT','/tournaments/'+tournamentId+'/entry',b,{revision:1,units:other.fleet.units,fleetName:'상대 편대'});
  const m=await fleetMatch(login);assert.equal(m.ownerFleet.name,'새 편대');assert.equal(m.opponentFleet.name,'상대 편대');
  await api('PUT','/tournaments/'+tournamentId+'/entry',login,{revision:1,units,fleetName:'진행 중 이름 변경'},409);
  await api('PUT','/tournaments/'+tournamentId+'/entry',b,{revision:1,units:other.fleet.units,fleetName:'상대 새 이름'});
  assert.equal((await me(login)).pending.opponentFleet.name,'상대 편대');
});
const opponentList = () => api('GET', `/admin/tournaments/${tournamentId}/opponents`, admin);
const newOpponent = async (name = 'Test fleet') => (await api('POST', `/admin/tournaments/${tournamentId}/opponents`, admin, { name, rating: 1100 })).opponent;
async function stockLibrary(p, name, cost, raw = blueprint(name), expected = 200) {
  const h = hash(raw), response = await mf.dispatchFetch(`https://rank.test/admin/opponents/${p.id}/blueprints/raw`, {
    method: 'POST', body: raw, headers: { Authorization: 'Bearer ' + admin.token, 'Content-Length': String(Buffer.byteLength(raw)),
      'X-Blueprint-Sha256': h, 'X-Blueprint-Name': encodeURIComponent(name), 'X-Blueprint-Cost': String(cost) } });
  const value = await response.json(); assert.equal(response.status, expected, JSON.stringify(value)); return h;
}
const saveOpponent = (p, units, changes = {}, expected = 200) => api('PUT', '/admin/opponents/' + p.id, admin,
  { name: p.name, rating: p.rating, expectedRevision: p.revision, tournamentRevision: 1, enabled: true, units, ...changes }, expected);

async function stockBattle() {
  const a=await register('Human'), h=await library(a,'Human',50000); await submitFleet(a,[unit(h)]);
  let p=await newOpponent(); const ph=await stockLibrary(p,'Stock',50000);
  p=(await saveOpponent(p,[unit(ph)],{rating:1000})).opponent;
  return {a,p,m:await fleetMatch(a)};
}
test('stock Elo moves both ways, counts draws and rejects stale admin edits', async () => {
  const {a,p,m}=await stockBattle();
  const win=await result(a,m,1); assert.equal(win.after,1016); assert.equal(win.systemOpponent,true);
  let stock=await db.prepare("SELECT rating,games FROM tournament_ratings WHERE tournament='standard-100k' AND owner=?").bind(p.id).first();
  assert.deepEqual(stock,{rating:984,games:1});
  await saveOpponent(p,p.fleet.units,{},409);
  const loss=await result(a,await fleetMatch(a),0);
  stock=await db.prepare("SELECT rating,games FROM tournament_ratings WHERE tournament='standard-100k' AND owner=?").bind(p.id).first();
  assert.ok(Math.abs(stock.rating-(984-loss.delta))<1e-9); assert.equal(stock.games,2);
  const draw=await result(a,await fleetMatch(a),.5);
  const end=await db.prepare("SELECT rating,games FROM tournament_ratings WHERE tournament='standard-100k' AND owner=?").bind(p.id).first();
  assert.ok(Math.abs(end.rating-(stock.rating-draw.delta))<1e-9); assert.equal(end.games,3);
  assert.equal((await opponentList()).opponents[0].revision,p.revision+3);
});
test('duplicate stock results and concurrent players apply additive deltas exactly once', async () => {
  const {a,p,m}=await stockBattle();
  const b=await register('Second'), bh=await library(b,'Second',50000); await submitFleet(b,[unit(bh)]);
  // Force the second independent ticket to the same stock, excluding the first human entry.
  await db.prepare('UPDATE tournament_entries SET revision=0 WHERE owner=?').bind(a.account.id).run();
  const mb=await fleetMatch(b); assert.equal(mb.opponent.id,p.id);
  const receipts=await Promise.all([...Array.from({length:6},()=>result(a,m,1)),result(b,mb,1)]);
  assert.ok(receipts.every(r=>r.after===1016));
  assert.deepEqual(await db.prepare("SELECT rating,games FROM tournament_ratings WHERE tournament='standard-100k' AND owner=?").bind(p.id).first(),{rating:968,games:2});
  assert.equal((await opponentList()).opponents[0].revision,p.revision+2);
});
test('stock settlement rolls back both ledgers on failure and handles forfeits once', async () => {
  const {a,p,m}=await stockBattle();
  await db.exec("CREATE TRIGGER stock_settlement_failure BEFORE UPDATE OF receipt ON matches BEGIN SELECT RAISE(ABORT,'fixture'); END;");
  try { await result(a,m,1,503); } finally { await db.exec('DROP TRIGGER stock_settlement_failure'); }
  assert.equal((await me(a)).rating.games,0);
  assert.deepEqual(await db.prepare("SELECT rating,games FROM tournament_ratings WHERE tournament='standard-100k' AND owner=?").bind(p.id).first(),{rating:1000,games:0});
  assert.equal((await opponentList()).opponents[0].revision,p.revision);
  await api('POST',`/matches/${m.id}/cancel`,a,{});
  await api('POST',`/matches/${m.id}/cancel`,a,{});
  assert.deepEqual(await db.prepare("SELECT rating,games FROM tournament_ratings WHERE tournament='standard-100k' AND owner=?").bind(p.id).first(),{rating:1016,games:1});
  const next=await fleetMatch(a); await expireMatches(db,next.expiresAt);
  await result(a,next,1);
  assert.equal(await db.prepare('SELECT games FROM tournament_ratings WHERE owner=?').bind(p.id).first('games'),2);
});
test('one real participant can fight bundled campaign fleets; defaults are durable and excluded from user accounts', async () => {
  await mf.dispose(); await start({ DEFAULT_OPPONENTS: 'true', MAX_ACCOUNTS: '2' });
  try {
    const a = await register('Only human'); await api('GET', '/tournaments', a);
    const stocks = (await opponentList()).opponents;
    assert.equal(stocks.length, 3);
    assert.deepEqual(stocks.map(p => [p.rating, p.fleet.units.length, p.fleet.spawnCost, p.fleet.supply]),
      [[720,4,32210,67790], [1130,3,88391.7,11608.3], [1150,1,84881.977,15118.023]]);
    assert.ok(stocks.every(p => p.enabled && p.current && p.fleet.budget === 100000));
    assert.deepEqual(stocks.map(p => [...new Set(p.fleet.units.map(u => u.altitude))]), [[100], [150], [150]]);
    assert.deepEqual(stocks.map(p => p.fleet.units[0].name), ['Duster', 'Falcon', 'FlyingSquirrel']);
    for (const preset of campaignPresets) {
      const object = await bucket.get(key(preset.blueprint)); assert.equal(await object.text(), preset.blueprint);
    }
    const h = await library(a, 'Human', 50000); await submitFleet(a, [unit(h)]);
    const m = await fleetMatch(a); assert.equal(m.opponent.system, true); assert.match(m.opponent.name, /^\[Stock\]/);
    const oldStock = await db.prepare('SELECT * FROM accounts WHERE id=?').bind(m.opponent.id).first();
    const settled = await result(a, m, 1);
    assert.deepEqual(await db.prepare('SELECT * FROM accounts WHERE id=?').bind(m.opponent.id).first(), oldStock);
    assert.deepEqual(await db.prepare('SELECT rating,games FROM tournament_ratings WHERE owner=?').bind(m.opponent.id).first(),{rating:m.opponent.rating-settled.delta,games:1});
    const selected = (await opponentList()).opponents.find(p => p.id === m.opponent.id);
    await api('PUT', '/admin/opponents/' + selected.id + '/enabled', admin, { enabled: false, expectedRevision: selected.revision });
    await mf.dispose(); await start({ DEFAULT_OPPONENTS: 'true', MAX_ACCOUNTS: '2' });
    await api('GET', '/tournaments', a);
    const restored = (await opponentList()).opponents; assert.equal(restored.length, 3); assert.equal(restored.find(p => p.id === selected.id).enabled, false);
    assert.deepEqual((await api('GET', '/tournaments/standard-100k/ladder', a)).accounts.map(a => a.id), [a.account.id]);
    assert.equal((await lookup('')).accounts.length, 1);
    await register('Second human'); // Three defaults do not consume participant quota.
  } finally { await mf.dispose(); await start(); }
});
test('humans and stock share the five nearest rating slots without reserved places or a stock cap', async () => {
  const a = await register('Matching owner'), h = await library(a, 'Owner', 50000); await submitFleet(a, [unit(h)]);
  const humans = [], stocks = [];
  for (let i = 0; i < 5; i++) {
    const b = await register('Human ' + i), bh = await library(b, 'Human BP ' + i, 50000);
    await submitFleet(b, [unit(bh)]); humans.push(b.account.id);
    let p = await newOpponent('Stock ' + i), ph = await stockLibrary(p, 'Stock BP ' + i, 50000);
    p = (await saveOpponent(p, [unit(ph)])).opponent; stocks.push(p.id);
  }
  const t = await getTournament(a);
  const scenarios = [
    { ratings: [1010,1020,1030,1040,1050,1500,1600,1700,1800,1900], expected: humans },
    { ratings: [1500,1600,1700,1800,1900,1010,1020,1030,1040,1050], expected: stocks },
    { ratings: [990,1030,1500,1600,1700,1020,960,1050,1800,1900], expected: [humans[0],stocks[0],humans[1],stocks[1],stocks[2]] },
    { ratings: Array(10).fill(1000), expected: [...humans,...stocks].sort().slice(0,5) },
  ];
  for (const scenario of scenarios) {
    await db.prepare('UPDATE tournament_ratings SET rating=1000 WHERE owner=?').bind(a.account.id).run();
    await db.batch([...humans,...stocks].map((id, i) => db.prepare('UPDATE tournament_ratings SET rating=? WHERE owner=?').bind(scenario.ratings[i],id)));
    const pool = await findFleetOpponents(db, t, {...a.account,rating:1000});
    assert.deepEqual(pool.map(p => p.id), scenario.expected);
    const m = await fleetMatch(a); assert.ok(scenario.expected.includes(m.opponent.id));
    assert.equal(m.opponent.system, stocks.includes(m.opponent.id));
    await api('POST', `/matches/${m.id}/cancel`, a, {});
  }
});
test('unified candidates exclude self, missing and stale entries, disabled stock and other tournaments', async () => {
  const a = await register('Owner'), h = await library(a, 'Owner', 50000); await submitFleet(a, [unit(h)]);
  await register('No entry');
  const b = await register('Stale human'), bh = await library(b, 'Stale', 50000); await submitFleet(b, [unit(bh)]);
  await db.prepare('UPDATE tournament_entries SET revision=0 WHERE owner=?').bind(b.account.id).run();
  const profiles = [];
  for (const name of ['Active','Disabled','Stale','Foreign']) {
    let p = await newOpponent(name), ph = await stockLibrary(p, name, 50000);
    p = (await saveOpponent(p, [unit(ph)])).opponent; profiles.push(p);
  }
  await api('PUT', '/admin/opponents/' + profiles[1].id + '/enabled', admin, { enabled:false,expectedRevision:profiles[1].revision });
  await db.prepare('UPDATE tournament_entries SET revision=0 WHERE owner=?').bind(profiles[2].id).run();
  const t = await getTournament(a);
  await api('PUT', '/admin/tournaments/other-cup', admin, { ...t,id:'other-cup',expectedRevision:0 });
  await db.prepare("UPDATE tournament_entries SET tournament='other-cup' WHERE owner=?").bind(profiles[3].id).run();
  await db.prepare("UPDATE system_opponents SET tournament='other-cup' WHERE owner=?").bind(profiles[3].id).run();
  assert.deepEqual((await findFleetOpponents(db,t,{...a.account,rating:1000})).map(p => p.id), [profiles[0].id]);
  const m = await fleetMatch(a); assert.equal(m.opponent.id, profiles[0].id);
});
test('admin edits stock BP counts, formation and rating atomically; issued battles retain old snapshots', async () => {
  const a = await register('Human'), h = await library(a, 'Human', 50000); await submitFleet(a, [unit(h)]);
  let p = await newOpponent(), b1 = await stockLibrary(p, 'First', 20000), b2 = await stockLibrary(p, 'Second', 30000);
  const placed = [unit(b1, -180, -220), { ...unit(b1, 180, -220), altitude: 80, yaw: 45 }];
  p = (await saveOpponent(p, placed)).opponent;
  const pending = await fleetMatch(a); assert.equal(pending.opponent.rating, 1100);
  const replacement = placed.map(u => ({ ...u, hash: b2 })); replacement.push(unit(b2, 0, -400));
  const updated = (await saveOpponent(p, replacement, { name: 'Updated', rating: 1400 })).opponent;
  assert.equal(updated.fleet.spawnCost, 90000); assert.equal(updated.fleet.supply, 10000);
  assert.equal(updated.fleet.units[1].yaw, 45); assert.equal(updated.fleet.units[1].altitude, 80);
  assert.deepEqual((await me(a)).pending, pending);
  const oldBp = await clientFetch(`https://rank.test/matches/${pending.id}/fleet-blueprints/${b1}`, { headers: { Authorization: 'Bearer ' + a.token } });
  assert.equal(await oldBp.text(), blueprint('First'));
  const receipt = await result(a, pending, 1); assert.equal(receipt.opponentRating, 1100);
  const next = await fleetMatch(a); assert.equal(next.opponent.rating, 1400-receipt.delta); assert.equal(next.opponentFleet.units.length, 3);
  await api('PUT', '/admin/opponents/' + updated.id + '/enabled', admin, { enabled: false, expectedRevision: updated.revision+1 });
  assert.deepEqual((await me(a)).pending, next); await result(a, next, .5);
  await api('POST', '/tournaments/standard-100k/matches', a, {}, 409);
});
test('stock administration rejects participants, insecure requests, wrong ownership, invalid budgets, banned blocks and stale versions', async () => {
  const a = await register('Human'); let p = await newOpponent(); const other = await newOpponent('Other');
  for (const [method, url, body] of [['GET','/admin/tournaments/standard-100k/opponents'], ['POST','/admin/tournaments/standard-100k/opponents',{}],
    ['POST','/admin/tournaments/standard-100k/opponents/defaults',{}], ['PUT','/admin/opponents/' + p.id,{}],
    ['GET','/admin/opponents/' + p.id + '/blueprints'], ['POST','/admin/opponents/' + p.id + '/blueprints/raw',{}], ['PUT','/admin/opponents/' + p.id + '/enabled',{}]]) {
    await api(method, url, a, body, 403); await api(method, url, null, body, 403);
    const insecure = await mf.dispatchFetch('http://rank.test' + url, { method, headers: { Authorization: 'Bearer ' + admin.token }, ...(body ? { body: '{}' } : {}) }); assert.equal(insecure.status, 400);
  }
  const h = await stockLibrary(p, 'Stock', 60000), foreign = await stockLibrary(other, 'Foreign', 100);
  await saveOpponent(p, [unit(foreign)], {}, 400); await saveOpponent(p, [unit(h),unit(h)], {}, 400);
  await saveOpponent(p, [unit(h, 501)], {}, 400); await saveOpponent(p, [], {}, 400);
  await saveOpponent(p, [unit(h)], { rating: -1 }, 400); await saveOpponent(p, [unit(h)], { expectedRevision: 99 }, 409);
  p = (await saveOpponent(p, [unit(h)])).opponent;
  const t = await configure(a, { rules: { bannedBlocks: [{ guid: '11111111-1111-1111-1111-111111111111', name: 'Banned' }] } });
  await saveOpponent(p, [unit(h)], {}, 409);
  await saveOpponent(p, [unit(h)], { tournamentRevision: t.revision }, 400);
  assert.equal((await opponentList()).opponents.find(o => o.id === p.id).current, false);
  await api('PUT', '/admin/opponents/' + p.id + '/enabled', admin, { enabled: false, expectedRevision: p.revision });
});
test('stock save races accept one edit and failed batches preserve the entire fleet and rating', async () => {
  let p = await newOpponent(), h = await stockLibrary(p, 'Stock', 10000); p = (await saveOpponent(p, [unit(h)])).opponent;
  const outcomes = await Promise.all([1200,1300].map(async rating => {
    const response = await mf.dispatchFetch('https://rank.test/admin/opponents/' + p.id, { method:'PUT', headers:{ Authorization:'Bearer '+admin.token },
      body:JSON.stringify({ name:p.name, rating, expectedRevision:p.revision, tournamentRevision:1, enabled:true, units:[unit(h,rating-1100)] }) });
    return response.status;
  })); assert.deepEqual(outcomes.sort(), [200,409]);
  p = (await opponentList()).opponents[0]; assert.equal(p.fleet.units[0].x, p.rating - 1100);
  await db.exec("CREATE TRIGGER stock_failure BEFORE UPDATE ON accounts WHEN OLD.id LIKE 'sys-%' BEGIN SELECT RAISE(ABORT,'test'); END;");
  try { await saveOpponent(p, [unit(h,300)], { rating:1500 }, 503); }
  finally { await db.exec('DROP TRIGGER stock_failure'); }
  assert.deepEqual((await opponentList()).opponents[0], p);
});
test('system identities cannot log in, claim credentials or receive password resets even with a known token', async () => {
  const p = await newOpponent(), token = 'known-only-for-isolated-test';
  await db.prepare('UPDATE accounts SET token_hash=? WHERE id=?').bind(hash(token), p.id).run();
  const fake = { token };
  await api('GET', '/me', fake, undefined, 401);
  await api('POST', '/auth/claim', fake, { username:'stock_login',password:testPassword }, 401);
  await api('POST', '/admin/accounts/' + p.id + '/password-reset', admin, { expectedRevision:0,confirmUsername:'stock_login' }, 404);
});
test('campaign default installation is idempotent under races and never re-enables or resets edited stock', async () => {
  const calls = await Promise.all(Array.from({ length: 3 }, () => api('POST', '/admin/tournaments/standard-100k/opponents/defaults', admin, {})));
  assert.ok(calls.every(c => c.opponents.length === 3));
  let p = calls[0].opponents[0]; p = (await saveOpponent(p, p.fleet.units, { name:'Edited preset',rating:1750,enabled:false })).opponent;
  const again = await api('POST', '/admin/tournaments/standard-100k/opponents/defaults', admin, {});
  assert.deepEqual(again.opponents.find(o => o.id === p.id), p);
});
test('aircraft pack upgrade retires old presets once while preserving edited fleets, manual opponents and pending battles', async () => {
  const a = await register('Human'), h = await library(a, 'Human', 50000); await submitFleet(a, [unit(h)]);
  const old = [];
  for (const seed of ['dwg-dusters', 'dwg-marauders', 'dwg-corsairs']) {
    let p = await newOpponent('Edited ' + seed), bp = await stockLibrary(p, seed, 20000);
    await db.prepare('UPDATE system_opponents SET seed_key=? WHERE owner=?').bind(seed, p.id).run();
    p = (await saveOpponent(p, [unit(bp, -200, -100)], { rating: 1105 })).opponent; old.push(p);
  }
  await db.prepare('INSERT INTO system_defaults(key) VALUES(?)').bind('standard-100k:campaign-v1').run();
  const pending = await fleetMatch(a); assert.ok(old.some(p => p.id === pending.opponent.id));
  let manual = await newOpponent('Custom fleet'), bp = await stockLibrary(manual, 'Custom', 25000);
  manual = (await saveOpponent(manual, [unit(bp)])).opponent;
  await Promise.all([1,2].map(() => api('POST', '/admin/tournaments/standard-100k/opponents/defaults', admin, {})));
  let all = (await opponentList()).opponents;
  assert.equal(all.length, 7); assert.equal(all.filter(p => p.enabled).length, 4);
  assert.deepEqual(all.find(p => p.id === manual.id), manual);
  for (const p of old) assert.deepEqual(all.find(o => o.id === p.id), { ...p, enabled: false, revision: p.revision + 1 });
  assert.deepEqual((await me(a)).pending, pending);
  const raw = await clientFetch(`https://rank.test/matches/${pending.id}/fleet-blueprints/${pending.opponentFleet.units[0].hash}`,
    { headers: { Authorization: 'Bearer ' + a.token } });
  assert.equal(raw.status, 200); assert.match(await raw.text(), /dwg-/);
  assert.equal((await result(a, pending, .5)).opponentRating, 1105);
  // An explicit administrator choice after migration is not undone on later requests.
  let restored = (await opponentList()).opponents.find(p => p.id === old[0].id);
  restored = (await saveOpponent(restored, restored.fleet.units)).opponent;
  all = (await api('POST', '/admin/tournaments/standard-100k/opponents/defaults', admin, {})).opponents;
  assert.deepEqual(all.find(p => p.id === restored.id), restored);
});
test('measured stock ratings update unchanged fleets once and preserve admin edits and pending ratings', async () => {
  const a = await register('Human'), h = await library(a,'Human',50000); await submitFleet(a,[unit(h)]);
  const t = await getTournament(a), presets = [], old = [];
  for (const key of ['pristine','renamed','formation','disabled','rated']) {
    let p = await newOpponent(key), bp = await stockLibrary(p,key,20000);
    p = (await saveOpponent(p,[unit(bp)])).opponent;
    await db.prepare('UPDATE system_opponents SET seed_key=? WHERE owner=?').bind(key,p.id).run();
    presets.push({key,name:p.name,previousRating:p.rating,rating:1350,fingerprint:hash(JSON.stringify(p.fleet))});
    old.push(p);
  }
  const pending = await fleetMatch(a);
  await saveOpponent(old[1],old[1].fleet.units,{name:'Administrator name'});
  await saveOpponent(old[2],old[2].fleet.units.map(u=>({...u,x:120})));
  await api('PUT','/admin/opponents/'+old[3].id+'/enabled',admin,{enabled:false,expectedRevision:old[3].revision});
  await saveOpponent(old[4],old[4].fleet.units,{rating:1450});
  const before = (await opponentList()).opponents;
  const calibration = {id:'test-measured-v1',rules:t.rules,presets};
  await Promise.all([applyCampaignRatings(db,t,calibration),applyCampaignRatings(db,t,calibration)]);
  const after = (await opponentList()).opponents;
  for (const p of before) assert.deepEqual(after.find(x=>x.id===p.id),p.id===old[0].id?{...p,rating:1350,revision:p.revision+1}:p);
  assert.deepEqual((await me(a)).pending,pending);
  assert.equal((await result(a,pending,.5)).opponentRating,1100);
  const settled = (await opponentList()).opponents;
  await applyCampaignRatings(db,t,calibration);
  assert.deepEqual((await opponentList()).opponents,settled);
});

test('calibration releases never overwrite a stock rating after it has played', async () => {
  const {a,p,m}=await stockBattle(); await result(a,m,.5);
  await db.prepare("UPDATE system_opponents SET seed_key='played' WHERE owner=?").bind(p.id).run();
  const t=await getTournament(a), before=(await opponentList()).opponents;
  await applyCampaignRatings(db,t,{id:'played-test',rules:t.rules,presets:[{
    key:'played',name:p.name,previousRating:1000,rating:1400,fingerprint:hash(JSON.stringify(p.fleet))
  }]});
  assert.deepEqual((await opponentList()).opponents,before);
});
test('rating release is transactional and does not mark untested tournament rules as calibrated', async () => {
  let p=await newOpponent('Stock'), bp=await stockLibrary(p,'Stock',20000); p=(await saveOpponent(p,[unit(bp)])).opponent;
  await db.prepare("UPDATE system_opponents SET seed_key='stock' WHERE owner=?").bind(p.id).run();
  const t=await db.prepare("SELECT * FROM tournaments WHERE id='standard-100k'").first();
  const calibration={id:'test-atomic-v1',rules:JSON.parse(t.rules),presets:[{key:'stock',name:p.name,previousRating:p.rating,rating:1400,fingerprint:hash(JSON.stringify(p.fleet))}]};
  await applyCampaignRatings(db,{...t,rules:{...calibration.rules,duration:60}},calibration);
  assert.equal((await opponentList()).opponents[0].rating,1100);
  assert.equal(await db.prepare('SELECT key FROM system_defaults WHERE key=?').bind(t.id+':ratings:'+calibration.id).first(),null);
  await db.prepare('UPDATE tournaments SET revision=2 WHERE id=?').bind(t.id).run();
  await applyCampaignRatings(db,t,calibration); // Rule update after the caller's snapshot.
  assert.equal((await opponentList()).opponents[0].rating,1100);
  assert.equal(await db.prepare('SELECT key FROM system_defaults WHERE key=?').bind(t.id+':ratings:'+calibration.id).first(),null);
  await db.prepare('UPDATE tournaments SET revision=1 WHERE id=?').bind(t.id).run();
  await db.exec("CREATE TRIGGER calibration_failure BEFORE INSERT ON system_defaults BEGIN SELECT RAISE(ABORT,'test'); END;");
  try { await assert.rejects(applyCampaignRatings(db,t,calibration)); }
  finally { await db.exec('DROP TRIGGER calibration_failure'); }
  assert.equal((await opponentList()).opponents[0].rating,1100);
  assert.equal((await opponentList()).opponents[0].revision,p.revision);
  await applyCampaignRatings(db,t,calibration);
  assert.equal((await opponentList()).opponents[0].rating,1400);
});
test('bundled measured ratings upgrade original aircraft defaults without rewriting issued tickets', async () => {
  // The recorded calibration only upgrades fleets under its original 5-minute rules.
  await db.prepare("UPDATE tournaments SET rules=json_set(rules,'$.duration',300) WHERE id=?").bind(tournamentId).run();
  const installed=await api('POST','/admin/tournaments/standard-100k/opponents/defaults',admin,{});
  for(const p of installed.opponents) {
    const item=campaignCalibration.presets.find(x=>x.key===p.preset);
    await db.prepare('UPDATE tournament_ratings SET rating=? WHERE owner=?').bind(item.previousRating,p.id).run();
  }
  await db.prepare('DELETE FROM system_defaults WHERE key=?').bind('standard-100k:ratings:'+campaignCalibration.id).run();
  const a=await register('Human'), h=await library(a,'Human',50000); await submitFleet(a,[unit(h)]);
  const pending=await fleetMatch(a); // Automatic defaults are disabled in this fixture.
  const upgraded=await api('POST','/admin/tournaments/standard-100k/opponents/defaults',admin,{});
  for(const p of upgraded.opponents) assert.equal(p.rating,campaignCalibration.presets.find(x=>x.key===p.preset).rating);
  assert.deepEqual((await me(a)).pending,pending);
  assert.equal((await result(a,pending,.5)).opponentRating,pending.opponent.rating);
});
test('concurrent registrations normalize duplicate IDs and create exactly one login', async () => {
  const responses = await Promise.all(['Concurrent_ID',' concurrent_id ','CONCURRENT_ID'].map((username, i) => clientFetch('https://rank.test/auth/register', {
    method:'POST',body:JSON.stringify({ username,nickname:'Concurrent '+i,password:testPassword }),headers:{'Content-Type':'application/json'} })));
  assert.deepEqual(responses.map(r => r.status).sort(), [200,409,409]);
  assert.equal((await db.prepare("SELECT count(*) AS n FROM accounts WHERE username='concurrent_id'").first()).n, 1);
});



test('material decisions persist win, loss, tiny lead and tie receipts with mirrored opponent history', async () => {
  const { a, b } = await fleets(), other = (await me(b)).account;
  for (const [totals, score] of [[[65000,60000],1], [[60000,60000.001],0], [[70000,70000],.5]]) {
    const health=[.1,.9], materials=totals.map(total=>({vehicle:total-10000,supply:10000,total}));
    const m = await fleetMatch(a); assert.equal(m.resultPolicy, 'remaining-materials-v1');
    const body = { score, outcome: { kind: score === .5 ? 'timeout-draw' : 'judgment', remaining: health,
      eliminated: [false,false], seconds: m.duration, materials } };
    const receipts = await Promise.all([1,2,3].map(() => api('POST', `/matches/${m.id}/result`, a, body)));
    assert.ok(receipts.every(r => JSON.stringify(r) === JSON.stringify(receipts[0])));
    assert.deepEqual(receipts[0].outcome, body.outcome);
    assert.deepEqual((await me(a)).history[0], receipts[0]);
    assert.deepEqual((await me(b)).account, other);
    const passive=(await me(b)).history[0]; assert.equal(passive.score,1-score); assert.equal(passive.initiated,false); assert.deepEqual(passive.outcome.remaining,[...health].reverse());
    assert.deepEqual(passive.outcome.materials,[...materials].reverse());
  }
  assert.equal((await me(a)).rating.games, 3);
});
test('old clients can finish issued health matches but cannot create new material matches', async () => {
  const {a}=await fleets();
  const oldRequest=(route,body)=>clientFetch('https://rank.test'+route,{method:'POST',headers:{Authorization:'Bearer '+a.token,'Content-Type':'application/json','X-FTD-Rank-Version':'0.7.5'},body:JSON.stringify(body)});
  assert.equal((await oldRequest('/tournaments/standard-100k/matches',{})).status,426);
  assert.equal((await db.prepare('SELECT count(*) AS n FROM matches').first()).n,0);
  const m=await fleetMatch(a);m.resultPolicy='total-health-v1';
  await db.prepare('UPDATE matches SET ticket=? WHERE id=?').bind(JSON.stringify(m),m.id).run();
  const resumed=await oldRequest('/tournaments/standard-100k/matches',{});assert.equal(resumed.status,200);assert.equal((await resumed.json()).resultPolicy,'total-health-v1');
  const done=await oldRequest('/matches/'+m.id+'/result',{score:1,outcome:{kind:'judgment',remaining:[.9,.6],eliminated:[false,false],seconds:m.duration}});
  assert.equal(done.status,200);assert.equal((await done.json()).score,1);
});

test('new tickets require consistent outcomes and cannot change a completed decision on retry', async () => {
  const { a } = await fleets(), m = await fleetMatch(a), route = `/matches/${m.id}/result`;
  const good = { score: 1, outcome: { kind: 'judgment', remaining: [.9,.6], eliminated: [false,false], seconds: m.duration,
    materials:[{vehicle:40000,supply:10000,total:50000},{vehicle:30000,supply:10000,total:40000}] } };
  await api('POST', route, a, {score:1}, 400);
  await api('POST', route, a, {...good, outcome:{...good.outcome,seconds: m.duration - .01}}, 400);
  await api('POST', route, a, {...good,score:.5}, 400);
  const saved = await api('POST', route, a, good);
  await api('POST', route, a, {...good,outcome:{...good.outcome,remaining:[.91,.6]}}, 409);
  assert.deepEqual(await api('POST', route, a, good), saved);
});

async function fleets() {
  const a = await register('Fleet A'), b = await register('Fleet B');
  const h1 = await library(a, 'Flagship', 50000), h2 = await library(a, 'Escort', 15000), h3 = await library(b, 'Opponent', 40000);
  const units = [unit(h1, 0), unit(h2, -120, -100), unit(h2, 120, -100)];
  await submitFleet(a, units); await submitFleet(b, [unit(h3)]); return { a, b, h1, h2, h3, units };
}
test('tournament fleet budget includes all copies and remaining supplies; formation snapshot and bilateral settlement', async () => {
  const { a, b, h1 } = await fleets();
  const listing = await api('GET', '/tournaments', a); assert.equal(listing.tournaments[0].rules.teamBudget, 100000);
  const tickets = await Promise.all(Array.from({ length: 6 }, () => fleetMatch(a)));
  assert.equal(new Set(tickets.map(t => t.id)).size, 1);
  const m = tickets[0]; assert.equal(m.ownerFleet.units.length, 3);
  assert.equal(m.duration, 600); assert.equal(m.rules.duration, 600);
  assert.equal(m.ownerFleet.spawnCost, 80000); assert.equal(m.ownerFleet.supply, 20000);
  assert.equal(m.opponentFleet.supply, 60000); assert.equal(m.ownerFleet.units[2].x, 120);
  const bpPath = `/matches/${m.id}/fleet-blueprints/${h1}`;
  const r = await clientFetch('https://rank.test' + bpPath, { headers: { Authorization: 'Bearer ' + a.token } });
  assert.equal(await r.text(), blueprint('Flagship')); await api('GET', bpPath, b, undefined, 404);
  const receipts = await Promise.all(Array.from({ length: 8 }, () => result(a, m, 1)));
  assert.ok(receipts.every(r => JSON.stringify(r) === JSON.stringify(receipts[0])));
  assert.equal((await me(a)).rating.rating, 1016); assert.equal((await me(b)).rating.rating, 984);
  assert.equal(receipts[0].tournamentId, tournamentId);
});
test('server validates fleet budget, BP ownership, numbers, count and formation limits', async () => {
  const a = await register('Validation'), b = await register('Other');
  const h = await library(a, 'Costly', 60000), foreign = await library(b, 'Foreign', 1);
  await submitFleet(a, [unit(h), unit(h)], 1, 400);
  await submitFleet(a, [unit(foreign)], 1, 400);
  for (const bad of [{ x: 501 }, { z: 1 }, { z: -1001 }, { yaw: 181 }, { altitude: 501 }, { x: '0' }, { x: null }])
    await submitFleet(a, [{ ...unit(h), ...bad }], 1, 400);
  await submitFleet(a, Array.from({ length: 21 }, () => unit(h)), 1, 400);
  await submitFleet(a, [], 1, 400);
  await submitFleet(a, [unit(h)], 99, 409);
  assert.equal((await submitFleet(a, [unit(h)])).entry.fleet.supply, 40000);
  await library(a, 'Costly', 65000);
  const saved = (await api('GET', '/tournaments/' + tournamentId, a)).entry;
  assert.equal(saved.fleet.spawnCost, 60000); // pricing updates never mutate submitted/snapshotted fleets
});
test('admin auth, live rule updates, stale entry rejection and immutable pending battles', async () => {
  const { a, b } = await fleets(), m = await fleetMatch(a);
  const original = await getTournament(a);
  await api('PUT', '/admin/tournaments/' + tournamentId, a, {}, 403);
  const t = await configure(a, { rules: { teamBudget: 200000, duration: 90, distance: 900, maxUnits: 30 } });
  assert.equal(t.revision, 2);
  assert.equal((await me(a)).pending.rules.teamBudget, 100000);
  assert.equal((await api('GET', `/tournaments/${tournamentId}`, b)).entry.current, false);
  await api('POST', `/tournaments/${tournamentId}/matches`, b, {}, 409);
  await api('PUT', '/admin/tournaments/' + tournamentId, admin, { ...original, expectedRevision: 1 }, 409);
  await result(a, m, .5);
  const { entry } = await api('GET', `/tournaments/${tournamentId}`, a);
  await submitFleet(a, entry.fleet.units, 2); // rule revision permits immediate re-submission
  const other = (await api('GET', `/tournaments/${tournamentId}`, b)).entry;
  await submitFleet(b, other.fleet.units, 2);
  const next = await fleetMatch(a); assert.equal(next.duration, 90); assert.equal(next.ownerFleet.supply, 120000);
  await configure(a, { status: 'closed' });
  await api('POST', `/tournaments/${tournamentId}/matches`, b, {}, 409);
  await result(a, next, 1); // closing does not void an already issued battle
});
test('entry cooldown, idempotence, lock state and racing replacement', async () => {
  const { a, b, units } = await fleets();
  const retry = await submitFleet(a, units); assert.equal(retry.entry.fleet.spawnCost, 80000);
  await submitFleet(a, units.slice(1), 1, 409);
  await configure(a, { status: 'locked' });
  assert.equal((await getTournament(a)).revision, 1);
  await submitFleet(a, units, 1, 409);
  const m = await fleetMatch(a); await result(a, m, .5);
  await configure(a, { status: 'open' });
  await db.prepare('UPDATE tournament_entries SET composition_updated=0 WHERE owner=?').bind(a.account.id).run();
  const attempts = await Promise.all([units.slice(1), units.slice(0, 1)].map(async units => {
    const r = await clientFetch(`https://rank.test/tournaments/${tournamentId}/entry`, { method: 'PUT',
      headers: { Authorization: 'Bearer ' + a.token }, body: JSON.stringify({ revision: 1, units }) });
    return r.status;
  }));
  assert.deepEqual(attempts.sort(), [200, 409]); assert.equal((await me(b)).rating.games, 1);
});
test('formation edits and reordering preserve the BP cooldown; content and per-BP quantity changes do not', async () => {
  const { a, h1, h2, units } = await fleets();
  // Make clock assertions independent of timer resolution without waiting a day.
  const initial = (await submitFleet(a, units)).entry;
  const started = initial.compositionUpdated - 60;
  await db.prepare('UPDATE tournament_entries SET updated=?,composition_updated=? WHERE owner=?')
    .bind(started, started, a.account.id).run();
  const moved = units.map((u, i) => ({ ...u, x: 100 - i * 40, z: -200, altitude: 100, yaw: 90 }));
  for (const arrangement of [moved, [...moved].reverse(), units]) {
    const { entry } = await submitFleet(a, arrangement);
    assert.deepEqual(entry.fleet.units.map(({ name, cost, ...u }) => u), arrangement);
    assert.equal(entry.compositionUpdated, started); assert.equal(entry.replaceAt, started + 86400);
    assert.ok(entry.updated > started);
    assert.deepEqual((await submitFleet(a, arrangement)).entry, entry); // exact retry is idempotent
  }
  const sameName = await library(a, 'Flagship', 50000, 200, blueprint('Flagship', 'modified blocks'));
  await submitFleet(a, [unit(sameName), unit(h2), unit(h2)], 1, 409);
  await submitFleet(a, [unit(h2), unit(h2), unit(h2)], 1, 409); // same total count, different per-BP counts
  await submitFleet(a, [unit(h1), unit(h2)], 1, 409);
  await submitFleet(a, [...units, unit(h2)], 1, 409);
  assert.equal((await api('GET', '/tournaments/' + tournamentId, a)).entry.replaceAt, started + 86400);
});
test('formation edits after expiry leave replacement available; replacement starts a fresh cooldown', async () => {
  const { a, units } = await fleets();
  await db.prepare('UPDATE tournament_entries SET composition_updated=0 WHERE owner=?').bind(a.account.id).run();
  const moved = units.map(u => ({ ...u, yaw: -90 }));
  assert.equal((await submitFleet(a, moved)).entry.replaceAt, 86400);
  const replacement = (await submitFleet(a, moved.slice(1))).entry;
  assert.ok(replacement.compositionUpdated > 86400);
  assert.equal(replacement.replaceAt, replacement.compositionUpdated + 86400);
  assert.equal((await submitFleet(a, units.slice(1))).entry.replaceAt, replacement.replaceAt);
  await submitFleet(a, units, 1, 409);
});
test('racing old-formation edits cannot restore an old composition after its replacement', async () => {
  const { a, units } = await fleets();
  await db.prepare('UPDATE tournament_entries SET composition_updated=0 WHERE owner=?').bind(a.account.id).run();
  const replacement = units.slice(1);
  const requests = [replacement, ...Array.from({ length: 8 }, (_, i) => units.map(u => ({ ...u, yaw: i + 1 })))];
  const statuses = await Promise.all(requests.map(async units => {
    const r = await clientFetch(`https://rank.test/tournaments/${tournamentId}/entry`, { method: 'PUT',
      headers: { Authorization: 'Bearer ' + a.token }, body: JSON.stringify({ revision: 1, units }) });
    return r.status;
  }));
  assert.equal(statuses[0], 200); assert.ok(statuses.every(s => s === 200 || s === 409));
  const entry = (await api('GET', '/tournaments/' + tournamentId, a)).entry;
  assert.equal(entry.fleet.units.length, 2); assert.ok(entry.compositionUpdated > 86400);
  await submitFleet(a, units, 1, 409);
});
test('pending battles allow exact retries only; opponent formation edits never alter issued tickets', async () => {
  const { a, b, units, h3 } = await fleets(), pending = await fleetMatch(a);
  await submitFleet(a, units);
  await submitFleet(a, units.map(u => ({ ...u, yaw: 45 })), 1, 409);
  const other = (await api('GET', '/tournaments/' + tournamentId, b)).entry;
  assert.equal((await submitFleet(b, [{ ...unit(h3, 220, -140), yaw: 80 }])).entry.replaceAt, other.replaceAt);
  assert.deepEqual((await me(a)).pending, pending);
  await result(a, pending, .5);
  await submitFleet(a, units.map(u => ({ ...u, yaw: 45 })));
  const next = await fleetMatch(a);
  assert.equal(next.ownerFleet.units[0].yaw, 45); assert.equal(next.opponentFleet.units[0].x, 220);
});
test('formation-only submissions still revalidate raw BPs and budgets; metadata is not a BP replacement', async () => {
  const { a, units } = await fleets();
  const initial = (await submitFleet(a, units)).entry;
  const moved = units.map(u => ({ ...u, yaw: 30 }));
  await bucket.delete(key(blueprint('Flagship')));
  await submitFleet(a, moved, 1, 503);
  await bucket.put(key(blueprint('Flagship')), blueprint('Flagship'));
  await library(a, 'Renamed flagship', 55000, 200, blueprint('Flagship'));
  const entry = (await submitFleet(a, moved)).entry;
  assert.equal(entry.fleet.spawnCost, 85000); assert.equal(entry.fleet.units[0].name, 'Renamed flagship');
  assert.equal(entry.replaceAt, initial.replaceAt);
  await library(a, 'Renamed flagship', 90000, 200, blueprint('Flagship'));
  await submitFleet(a, moved, 1, 400);
});
test('rule revision resubmission preserves the clock unless BP composition changes', async () => {
  const { a, units } = await fleets();
  const initial = (await submitFleet(a, units)).entry;
  await configure(a, { rules: { teamBudget: 110000 } });
  assert.equal((await submitFleet(a, units, 2)).entry.replaceAt, initial.replaceAt);
  await submitFleet(a, units.slice(1), 2, 409);
  await configure(a, { rules: { teamBudget: 120000, replacementSeconds: 3600 } });
  const changed = (await submitFleet(a, units.slice(1), 3)).entry;
  assert.equal(changed.replaceAt, changed.compositionUpdated + 3600);
  await submitFleet(a, units, 3, 409);
});

test('one-minute cooldown changes preserve submissions, opponents and pending battles and use the last composition change', async () => {
  const {a,b,units,h3}=await fleets();
  let stock=await newOpponent('Cooldown stock'), sh=await stockLibrary(stock,'Stock',30000);
  stock=(await saveOpponent(stock,[unit(sh)])).opponent;
  const stale=await register('Stale cooldown'), staleHash=await library(stale,'Stale',20000);
  await submitFleet(stale,[unit(staleHash)]);
  await db.prepare('UPDATE tournament_entries SET revision=0 WHERE owner=?').bind(stale.account.id).run();
  const recent=Date.now()/1000-30, expired=recent-90;
  await db.prepare('UPDATE tournament_entries SET composition_updated=? WHERE owner=?').bind(expired,a.account.id).run();
  await db.prepare('UPDATE tournament_entries SET composition_updated=? WHERE owner=?').bind(recent,b.account.id).run();
  const pending=await fleetMatch(a);
  const rows=async table=>(await db.prepare('SELECT * FROM '+table+' ORDER BY rowid').all()).results;
  const before=await rows('tournament_entries'), preserved={};
  for(const table of ['accounts','tournament_ratings','matches','system_opponents','blueprint_library']) preserved[table]=await rows(table);
  const t=await configure(a,{rules:{replacementSeconds:60}});
  assert.equal(t.revision,2);
  assert.deepEqual(await rows('tournament_entries'),before.map(row=>({...row,revision:row.revision===1?2:row.revision})));
  for(const [table,value] of Object.entries(preserved)) assert.deepEqual(await rows(table),value);
  assert.deepEqual((await me(a)).pending,pending);
  assert.equal(pending.rules.replacementSeconds,86400);
  const entryA=(await api('GET','/tournaments/'+tournamentId,a)).entry;
  const entryB=(await api('GET','/tournaments/'+tournamentId,b)).entry;
  assert.equal(entryA.current,true); assert.equal(entryB.current,true);
  assert.equal(entryA.replaceAt,expired+60); assert.equal(entryB.replaceAt,recent+60);
  assert.deepEqual(new Set((await findFleetOpponents(db,t,{...a.account,rating:1000})).map(r=>r.id)),new Set([b.account.id,stock.id]));
  await submitFleet(a,units.slice(1),2,409); // Pending owner cannot replace, even after expiry.
  await submitFleet(b,[unit(h3),unit(h3,100)],2,409); // Still inside the shortened minute.
  const moved=(await submitFleet(b,[{...unit(h3,80,-40),yaw:30,altitude:140}],2)).entry;
  assert.equal(moved.replaceAt,entryB.replaceAt); assert.equal(moved.compositionUpdated,recent);
  await db.prepare('UPDATE tournament_entries SET composition_updated=? WHERE owner=?').bind(Date.now()/1000-61,b.account.id).run();
  const replaced=(await submitFleet(b,[unit(h3),unit(h3,100)],2)).entry;
  assert.equal(replaced.replaceAt,replaced.compositionUpdated+60);
  await submitFleet(b,[unit(h3)],2,409);
  await result(a,pending,.5);
  const ownReplacement=(await submitFleet(a,units.slice(1),2)).entry;
  assert.equal(ownReplacement.replaceAt,ownReplacement.compositionUpdated+60);
  const next=await fleetMatch(a); assert.equal(next.rules.replacementSeconds,60);
});

test('cooldown updates roll back on failure, reject stale writes and never bypass changed fleet constraints', async () => {
  const {a,b}=await fleets(), original=await getTournament(a);
  const rows=async ()=>(await db.prepare('SELECT * FROM tournament_entries ORDER BY owner').all()).results;
  const before=await rows();
  const change={...original,expectedRevision:original.revision,rules:{...original.rules,replacementSeconds:60}};
  await db.exec("CREATE TRIGGER reject_cooldown_update BEFORE UPDATE ON tournaments BEGIN SELECT RAISE(ABORT,'cooldown update failed'); END;");
  try { await api('PUT','/admin/tournaments/'+tournamentId,admin,change,503); }
  finally { await db.exec('DROP TRIGGER reject_cooldown_update'); }
  assert.deepEqual(await getTournament(a),original); assert.deepEqual(await rows(),before);
  await configure(a,{rules:{replacementSeconds:60}});
  const changed=await rows();
  await api('PUT','/admin/tournaments/'+tournamentId,admin,change,409);
  assert.deepEqual(await rows(),changed);
  await configure(a,{rules:{replacementSeconds:120,teamBudget:90000}});
  assert.equal((await api('GET','/tournaments/'+tournamentId,b)).entry.current,false);
  assert.deepEqual(await rows(),changed);
});

test('fleet entries and frozen BP access survive restart and opponent replacement', async () => {
  const { a, b, h3 } = await fleets(), m = await fleetMatch(a);
  await configure(a, { rules: { replacementSeconds: 0 } });
  const newHash = await library(b, 'New opponent', 10000);
  await submitFleet(b, [unit(newHash)], 2);
  await mf.dispose(); await start();
  const restored = (await me(a)).pending;
  assert.deepEqual(restored, m);
  const response = await clientFetch(`https://rank.test/matches/${m.id}/fleet-blueprints/${h3}`,
    { headers: { Authorization: 'Bearer ' + a.token } });
  assert.equal(await response.text(), blueprint('Opponent'));
});

function clientFetch(url, options = {}) {
  const headers = new Headers(options.headers);
  if (!headers.has('X-FTD-Rank-Version')) headers.set('X-FTD-Rank-Version', '0.7.6');
  if (!headers.has('X-FTD-Rank-Protocol')) headers.set('X-FTD-Rank-Protocol', '1');
  return mf.dispatchFetch(url, { ...options, headers });
}
test('missing and obsolete clients are refused across participant APIs; admin controls the minimum version', async () => {
  const a = await register('Version test');
  for (const [method, route, body] of [['POST', '/accounts', { name: 'Old' }], ['GET', '/tournaments'], ['GET', '/me'],
    ['POST', '/blueprints/raw', 'bp'], ['POST', '/tournaments/standard-100k/matches', {}]]) {
    for (const version of [null, '0.3.0', '0.4.0', '0.5.1', '0.6.1', '0.6.5', '0.6.6', 'invalid']) {
      const r = await mf.dispatchFetch('https://rank.test' + route, { method,
        headers: { Authorization: 'Bearer ' + a.token, ...(version ? { 'X-FTD-Rank-Version': version, 'X-FTD-Rank-Protocol': '1' } : {}) },
        ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) });
      assert.equal(r.status, 426); assert.match((await r.json()).error, /0.6.10/);
    }
  }
  assert.equal((await mf.dispatchFetch('https://rank.test/health')).status, 200);
  assert.equal((await mf.dispatchFetch('https://rank.test/admin')).status, 200);
  await api('PUT', '/admin/client-policy', admin, { minimumVersion: '0.6.1', minimumProtocol: 1, expectedRevision: 1 }, 400);
  const p = await api('PUT', '/admin/client-policy', admin, { minimumVersion: '0.7.0', minimumProtocol: 1, expectedRevision: 1 });
  assert.equal(p.clientPolicy.revision, 2);
  assert.equal((await clientFetch('https://rank.test/tournaments', { headers: { Authorization: 'Bearer ' + a.token, 'X-FTD-Rank-Version': '0.6.10' } })).status, 426);
  assert.equal((await clientFetch('https://rank.test/tournaments', { headers: { Authorization: 'Bearer ' + a.token, 'X-FTD-Rank-Version': '0.7.0' } })).status, 200);
  assert.equal((await clientFetch('https://rank.test/tournaments', { headers: { Authorization: 'Bearer ' + a.token, 'X-FTD-Rank-Version': '0.10.0' } })).status, 200);
  await api('PUT', '/admin/client-policy', admin, { minimumVersion: '0.6.10', minimumProtocol: 1, expectedRevision: 1 }, 409);
});
test('admin can create new server-defined content without a client build; configuration is validated', async () => {
  const a = await register('Admin content'), source = await getTournament(a);
  const created = await api('PUT', '/admin/tournaments/light-fleet', admin, { ...source, name: '경량전', expectedRevision: 0,
    rules: { ...source.rules, teamBudget: 25000, maxUnits: 4, maxBlueprints: 4, duration: 120 } });
  assert.equal(created.tournament.revision, 1);
  const listed = await api('GET', '/tournaments', a); assert.ok(listed.tournaments.some(t => t.id === 'light-fleet' && t.rules.teamBudget === 25000));
  const config = await api('GET', '/admin/tournaments', admin); assert.ok(config.numericRules.teamBudget);
  await api('GET', '/admin/tournaments', a, undefined, 403);
  await api('PUT', '/admin/tournaments/invalid', admin, { ...source, expectedRevision: 0, rules: { ...source.rules, duration: -1 } }, 400);
  await api('PUT', '/admin/tournaments/invalid', admin, { ...source, expectedRevision: 0, rules: { ...source.rules, minAltitude: 1000, maxAltitude: 0 } }, 400);
  const html = await (await mf.dispatchFetch('https://rank.test/admin')).text();
  new Script(html.match(/<script>([\s\S]*?)<\/script>/)[1]);
  assert.ok(!html.includes(admin.token));
});



test('server inspects actual nested BP blocks on every submission and rejects same-name replacements', async () => {
  const a = await register('Ban check');
  const forbidden = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const allowed = '11111111-1111-1111-1111-111111111111';
  const rules = { bannedBlocks: [{ guid: forbidden, name: 'Test banned block' }] };
  const t = await configure(a, { rules });
  const raw = nested => JSON.stringify({ Name: 'Same name', ItemDictionary: { 1: allowed, 2: forbidden },
    Blueprint: { BlockIds: [1], SCs: nested ? [{ BlockIds: [1], SCs: [{ BlockIds: [2, 2], AliveCount: 0 }] }] : [] } });
  const legal = await library(a, 'Same name', 100, 200, raw(false));
  const banned = await library(a, 'Same name', 100, 200, raw(true));
  assert.notEqual(legal, banned);
  const rejection = await submitFleet(a, [{ ...unit(banned), counts: {}, checked: true }], t.revision, 400);
  assert.match(rejection.error, /Test banned block 2개/);
  await submitFleet(a, [unit(legal)], t.revision);
  // An idempotent retry must inspect storage, rather than trusting its earlier pass.
  await bucket.delete(key(raw(false)));
  await submitFleet(a, [unit(legal)], t.revision, 503);
  await bucket.put(key(raw(false)), raw(false));
  await submitFleet(a, [unit(legal)], t.revision);
  const saved = (await api('GET', '/tournaments/' + tournamentId, a)).entry;
  assert.equal(saved.fleet.units[0].hash, legal);
});

test('ban edits require fresh submission, preserve pending battle rules, and allow removal', async () => {
  const { a, b, units } = await fleets(), m = await fleetMatch(a);
  const bannedBlocks = [{ guid: '11111111-1111-1111-1111-111111111111', name: 'Common block' }];
  const t = await configure(a, { rules: { bannedBlocks } });
  assert.equal(t.revision, 2); assert.deepEqual((await me(a)).pending.rules.bannedBlocks, []);
  await result(a, m, .5);
  await submitFleet(a, units, t.revision, 400);
  await api('POST', `/tournaments/${tournamentId}/matches`, b, {}, 409);
  const cleared = await configure(a, { rules: { bannedBlocks: [] } });
  assert.equal(cleared.revision, 3); await submitFleet(a, units, cleared.revision);
});

test('malformed or unmapped BP blocks never publish a tournament entry, including ban-free tournaments', async () => {
  const a = await register('Malformed');
  for (const raw of ['{', JSON.stringify({ Name: 'bad', ItemDictionary: {}, Blueprint: { BlockIds: [999] } })]) {
    const digest = await library(a, 'bad', 1, 200, raw);
    await submitFleet(a, [unit(digest)], 1, 400);
  }
  assert.equal((await api('GET', '/tournaments/' + tournamentId, a)).entry, null);
});

test('admin block catalogue is authenticated, ban validation is strict and admin script parses', async () => {
  const a = await register('Catalogue');
  const listing = await api('GET', '/admin/block-catalog', admin); assert.ok(listing.blocks.length > 900);
  assert.ok(listing.blocks.some(b => /Lua/i.test(b.name)));
  await api('GET', '/admin/block-catalog', a, undefined, 403);
  const t = await getTournament(a);
  for (const bannedBlocks of [null, [{ guid: 'runtime-id', name: 'Wrong' }], [{ guid: listing.blocks[0].guid, name: '' }]])
    await api('PUT', '/admin/tournaments/' + tournamentId, admin, { ...t, expectedRevision: t.revision, rules: { ...t.rules, bannedBlocks } }, 400);
  const html = await (await mf.dispatchFetch('https://rank.test/admin')).text();
  new Script(html.match(/<script>([\s\S]*?)<\/script>/)[1]); assert.ok(html.includes('inspectBlueprint'));
});



test('admin can choose Neter/AOTE and fractional coordinates; issued matches keep their original world', async () => {
  const { a, b, units } = await fleets(), m = await fleetMatch(a);
  const t = await configure(a, { rules: { world: 'aote', boardEast: 5.25, boardNorth: 6.75 } });
  assert.equal(t.revision, 2); assert.equal(t.rules.world, 'aote');
  const shown = await getTournament(b); assert.equal(shown.rules.boardEast, 5.25);
  assert.equal((await me(a)).pending.rules.world, 'neter');
  await result(a, m, .5);
  const opponent = (await api('GET', '/tournaments/' + tournamentId, b)).entry;
  await submitFleet(a, units, 2); await submitFleet(b, opponent.fleet.units, 2);
  const next = await fleetMatch(a);
  assert.equal(next.rules.world, 'aote'); assert.equal(next.rules.boardNorth, 6.75);
  await configure(a, { rules: { world: 'neter', boardEast: 17.25, boardNorth: 18.125 } });
  assert.equal((await me(a)).pending.rules.world, 'aote');
  const adminState = await api('GET', '/admin/tournaments', admin);
  assert.deepEqual(adminState.battlefields.map(m => [m.id, m.eastMax, m.northMax]), [['neter',19,19],['aote',11,11]]);
});

test('battlefield changes keep registered humans and stock matchable without resetting fleets or cooldowns', async () => {
  const {a,b}=await fleets(), pending=await fleetMatch(a);
  let stock=await newOpponent('Registered stock'), h=await stockLibrary(stock,'Stock',30000);
  stock=(await saveOpponent(stock,[{...unit(h),altitude:100}])).opponent;
  let disabled=await newOpponent('Disabled stock'), dh=await stockLibrary(disabled,'Disabled',20000);
  disabled=(await saveOpponent(disabled,[unit(dh)])).opponent;
  await api('PUT','/admin/opponents/'+disabled.id+'/enabled',admin,{enabled:false,expectedRevision:disabled.revision});
  const stale=await register('Stale'), sh=await library(stale,'Old',50000); await submitFleet(stale,[unit(sh)]);
  await db.prepare('UPDATE tournament_entries SET revision=0 WHERE owner=?').bind(stale.account.id).run();
  const before=(await db.prepare('SELECT * FROM tournament_entries ORDER BY owner').all()).results;
  const profiles=(await db.prepare('SELECT * FROM system_opponents ORDER BY owner').all()).results;
  const t=await configure(a,{rules:{world:'aote',boardEast:5.25,boardNorth:6.75,distance:900,duration:900}});
  const after=(await db.prepare('SELECT * FROM tournament_entries ORDER BY owner').all()).results;
  assert.deepEqual(after,before.map(row=>({...row,revision:row.revision===1?2:row.revision})));
  assert.deepEqual((await db.prepare('SELECT * FROM system_opponents ORDER BY owner').all()).results,profiles);
  assert.deepEqual((await me(a)).pending,pending);
  assert.deepEqual(new Set((await findFleetOpponents(db,t,{...a.account,rating:1000})).map(r=>r.id)),new Set([b.account.id,stock.id]));
  await result(a,pending,.5);
  const next=await fleetMatch(a); assert.equal(next.rules.world,'aote'); assert.equal(next.duration,900);
  await configure(a,{rules:{boardEast:4.5,teamBudget:90000}});
  assert.equal((await api('GET','/tournaments/'+tournamentId,b)).entry.current,false);
  assert.equal((await opponentList()).opponents.find(p=>p.id===stock.id).current,false);
});

test('battlefield revision and registration carry-forward roll back together on failure or stale admin requests', async () => {
  const {a}=await fleets(), original=await getTournament(a);
  const before=(await db.prepare('SELECT * FROM tournament_entries ORDER BY owner').all()).results;
  await db.exec("CREATE TRIGGER reject_map_update BEFORE UPDATE ON tournaments BEGIN SELECT RAISE(ABORT,'map update failed'); END;");
  try { await api('PUT','/admin/tournaments/'+tournamentId,admin,{...original,expectedRevision:original.revision,rules:{...original.rules,boardEast:4.5}},503); }
  finally { await db.exec('DROP TRIGGER reject_map_update'); }
  assert.deepEqual(await getTournament(a),original);
  assert.deepEqual((await db.prepare('SELECT * FROM tournament_entries ORDER BY owner').all()).results,before);
  await configure(a,{rules:{boardEast:4.5}});
  const changed=(await db.prepare('SELECT * FROM tournament_entries ORDER BY owner').all()).results;
  await api('PUT','/admin/tournaments/'+tournamentId,admin,{...original,expectedRevision:1,rules:{...original.rules,boardEast:8.5}},409);
  assert.deepEqual((await db.prepare('SELECT * FROM tournament_entries ORDER BY owner').all()).results,changed);
});

test('world-specific coordinate limits reject unsupported worlds and allow repairing old out-of-map settings', async () => {
  const a = await register('Coordinates'), source = await getTournament(a);
  for (const patch of [{ world: 'glao' }, { world: null }, { world: 'AOTE' }, { world: 'aote', boardEast: 11.1 },
    { world: 'aote', boardNorth: -1 }, { world: 'neter', boardEast: 19.1 }, { boardEast: '5' }, { boardNorth: null }])
    await api('PUT', '/admin/tournaments/' + tournamentId, admin, { ...source, expectedRevision: 1, rules: { ...source.rules, ...patch } }, 400);
  for (const world of ['aote','neter']) {
    const max = world === 'aote' ? 11 : 19;
    const t = await configure(a, { rules: { world, boardEast: max, boardNorth: 0 } });
    assert.equal(t.rules.boardEast, max);
  }
  await db.prepare("UPDATE tournaments SET rules=json_set(rules,'$.boardEast',99) WHERE id=?").bind(tournamentId).run();
  const repaired = await configure(a, { rules: { world: 'aote', boardEast: 5.5, boardNorth: 5.5 } });
  assert.equal(repaired.rules.boardEast, 5.5);
});



