import { ApiError, encoder, json, now, randomId, readJson, sha256, publicAccount } from './shared.js';

const SESSION_SECONDS = 30 * 86400;
// Hosted Workers currently cap WebCrypto PBKDF2 at 100,000 iterations.
// A separate mandatory pepper protects against a DB-only disclosure; see AUTH.txt.
const ITERATIONS = 100000;
const hex = bytes => Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
const bytes = value => Uint8Array.from(value.match(/../g), n => parseInt(n, 16));
function secret(env) {
  if (typeof env.AUTH_PEPPER !== 'string' || env.AUTH_PEPPER.length < 32)
    throw new ApiError(503, '서버 인증 비밀키 설정이 필요합니다. 운영자에게 알려 주세요.');
  return env.AUTH_PEPPER;
}
async function mac(env, value) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret(env)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, encoder.encode(value)));
}
async function passwordHash(env, password, salt) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const hash = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: bytes(salt), iterations: ITERATIONS, hash: 'SHA-256' }, key, 256);
  return mac(env, 'password-v1:' + hex(hash));
}
function equal(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0; for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
function username(value) {
  if (typeof value !== 'string') throw new ApiError(400, '아이디를 입력하세요.');
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_.-]{7,31}$/.test(normalized))
    throw new ApiError(400, '아이디: 8~32자, 영문·숫자 및 _ . - / Username: 8–32 characters.');
  return normalized;
}
function password(value) {
  const length = typeof value === 'string' ? Array.from(value).length : 0;
  if (length < 8 || length > 32 || /[\u0000-\u001f\u007f]/.test(value))
    throw new ApiError(400, '비밀번호: 8~32자 / Password: 8–32 characters.');
  return value;
}
function nickname(value) {
  const display = typeof value === 'string' ? value.normalize('NFKC').trim().replace(/ +/g, ' ') : '';
  const length = Array.from(display).length;
  if (length < 2 || length > 24 || !/^[\p{L}\p{M}\p{N} _.-]+$/u.test(display) || !/[\p{L}\p{N}]/u.test(display))
    throw new ApiError(400, '닉네임: 2~24자, 한글·영문·숫자·공백 및 _ . - / Nickname: 2–24 characters.');
  return { display, key: display.toLowerCase() };
}
export function authInfo(a) { return { username: a.username, needsCredentials: !a.username, expiresAt: a.token_expires,
  recoveryEmail:a.recovery_email??null,emailVerified:!!a.email_verified_at,passwordResetRequired:!!a.password_reset_required }; }
export async function saveProfile(request, db, me) {
  const data = await readJson(request, 1024);
  const color = data.nicknameColor;
  if (color !== null && (typeof color !== 'string' || !/^#[0-9a-f]{6}$/i.test(color)))
    throw new ApiError(400, 'Use an RGB color such as #66CCFF, or reset to default.');
  const normalized = color?.toUpperCase() ?? null;
  if (normalized === me.nickname_color) return publicAccount(me);
  const timestamp = now();
  const result = await db.prepare(`UPDATE accounts SET nickname_color=?,color_updated=?
    WHERE id=? AND token_hash=? AND color_updated<=? RETURNING *`)
    .bind(normalized, timestamp, me.id, me.token_hash, timestamp-10).all();
  if (!result.results.length) throw new ApiError(429, 'Wait ten seconds before changing your nickname color again.');
  return publicAccount(result.results[0]);
}
export async function account(db, token, allowPasswordReset=false) {
  if (!token || token.length > 256) throw new ApiError(401, '로그인해 주세요.');
  const a = await db.prepare('SELECT * FROM accounts WHERE token_hash=? AND NOT EXISTS(SELECT 1 FROM system_opponents s WHERE s.owner=accounts.id)').bind(await sha256(encoder.encode(token))).first();
  if (!a || (a.username && (!a.token_expires || a.token_expires <= now()))) throw new ApiError(401, '로그인이 만료되었거나 다른 곳에서 로그인했습니다. 다시 로그인하세요.');
  if(a.password_reset_required && !allowPasswordReset)throw new ApiError(403,'Recovery.ChangeRequired');
  return a;
}
function bearer(request) { const h = request.headers.get('Authorization') || ''; return h.startsWith('Bearer ') ? h.slice(7) : ''; }
async function throttle(request, env, db, name, action) {
  const timestamp = now(), window = Math.floor(timestamp / 900);
  const ip = request.headers.get('CF-Connecting-IP') || 'local';
  // Separate budgets for registration, login and authenticated credential changes.
  const keys = [await mac(env, `rate:${action}:ip:${ip}`), await mac(env, `rate:${action}:user:${name}`)];
  await db.prepare('DELETE FROM auth_attempts WHERE window<?').bind(window - 1).run();
  for (let i = 0; i < keys.length; i++) {
    const result = await db.prepare(`INSERT INTO auth_attempts(key,window,attempts) VALUES(?,?,1)
    ON CONFLICT(key) DO UPDATE SET window=excluded.window,
    attempts=CASE WHEN auth_attempts.window=excluded.window THEN auth_attempts.attempts+1 ELSE 1 END RETURNING attempts`).bind(keys[i], window).all();
    if (result.results[0].attempts > (i === 0 ? 40 : 10)) throw new ApiError(429, '시도가 너무 많습니다. 최대 15분 뒤 다시 시도하세요.');
  }
}
async function credentials(env, value) {
  const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
  return { salt, hash: await passwordHash(env, value, salt) };
}
async function session() {
  const token = randomId() + randomId();
  return { token, hash: await sha256(encoder.encode(token)), expires: now() + SESSION_SECONDS };
}
function response(a, s) { return json({ account: publicAccount(a), auth: authInfo(a), token: s.token, serverTime: now() }); }
async function saveCredentials(db, a, name, c, s, nick = { display: a.name, key: a.nickname_key }) {
  const result = await db.prepare(`UPDATE accounts SET username=?,name=?,nickname_key=?,password_salt=?,password_hash=?,
    token_hash=?,token_expires=?,auth_revision=auth_revision+1,password_reset_required=0,password_reset_expires=NULL WHERE id=? AND auth_revision=?
    AND NOT EXISTS(SELECT 1 FROM accounts WHERE (username=? OR nickname_key=?) AND id<>?) RETURNING *`)
    .bind(name, nick.display, nick.key, c.salt, c.hash, s.hash, s.expires, a.id, a.auth_revision, name, nick.key, a.id).all();
  if (!result.results.length) throw new ApiError(409, '아이디·닉네임이 사용 중이거나 계정 정보가 변경되었습니다. 다시 시도하세요.');
  return response(result.results[0], s);
}
function adminAccount(a) {
  return { id: a.id, username: a.username, name: a.name,
    authRevision: a.auth_revision, canResetPassword: !!a.username };
}
// Called only after adminRoute has checked ADMIN_TOKEN. No participant tokens are issued here.
export async function adminAccountRoute(request, env, db, path) {
  if (path === '/admin/accounts' && request.method === 'GET') {
    const params = new URL(request.url).searchParams, query = (params.get('q') || '').trim(), after = params.get('after') || '';
    if (query.length > 100 || after.length > 128 || /[\u0000-\u001f\u007f]/.test(query + after))
      throw new ApiError(400, '검색어는 100자 이내로 입력하세요.');
    // Literal substring search: SQL LIKE wildcard characters are ordinary search text.
    const rows = (await db.prepare(`SELECT id,username,name,auth_revision FROM accounts
      WHERE NOT EXISTS(SELECT 1 FROM system_opponents s WHERE s.owner=accounts.id) AND id>? AND (?='' OR instr(lower(coalesce(username,'')),lower(?))>0
      OR instr(lower(name),lower(?))>0 OR instr(lower(id),lower(?))>0) ORDER BY id LIMIT 26`)
      .bind(after, query, query, query, query).all()).results;
    return json({ accounts: rows.slice(0, 25).map(adminAccount), next: rows.length > 25 ? rows[24].id : null });
  }
  const route = /^\/admin\/accounts\/([^/]+)\/password-reset$/.exec(path);
  if (!route || request.method !== 'POST') return null;
  secret(env);
  let id;
  try { id = decodeURIComponent(route[1]); } catch { throw new ApiError(400, '계정 ID 형식이 올바르지 않습니다.'); }
  if (id.length > 128) throw new ApiError(400, '계정 ID 형식이 올바르지 않습니다.');
  const data = await readJson(request, 4096);
  if (!Number.isSafeInteger(data.expectedRevision) || data.expectedRevision < 0 || typeof data.confirmUsername !== 'string')
    throw new ApiError(400, '계정 조회 후 확인용 아이디와 expectedRevision을 보내세요.');
  const a = await db.prepare('SELECT id,username,name,auth_revision FROM accounts WHERE id=? AND NOT EXISTS(SELECT 1 FROM system_opponents s WHERE s.owner=accounts.id)').bind(id).first();
  if (!a) throw new ApiError(404, '계정을 찾을 수 없습니다.');
  if (!a.username) throw new ApiError(409, '아이디를 아직 등록하지 않은 이전 계정입니다. 기존 로그인으로 아이디를 먼저 등록해야 합니다.');
  if (data.confirmUsername !== a.username) throw new ApiError(400, '확인용 아이디가 선택한 계정과 일치하지 않습니다.');
  if (data.expectedRevision !== a.auth_revision) throw new ApiError(409, '로그인 또는 계정 정보가 변경되었습니다. 계정을 다시 검색하세요.');
  // 128 random bits / 32 characters. Returned once; never persisted in plaintext.
  const temporaryPassword = hex(crypto.getRandomValues(new Uint8Array(16)));
  const c = await credentials(env, temporaryPassword), s = await session();
  const loginKey = await mac(env, `rate:/auth/login:user:${a.username}`);
  const changes = await db.batch([
    db.prepare(`UPDATE accounts SET password_salt=?,password_hash=?,token_hash=?,token_expires=0,password_reset_required=0,password_reset_expires=NULL,
      auth_revision=auth_revision+1 WHERE id=? AND auth_revision=? RETURNING id,username,name,auth_revision`)
      .bind(c.salt, c.hash, s.hash, a.id, data.expectedRevision),
    // Clear this user's failed-login budget atomically; retain the shared IP budget.
    db.prepare('DELETE FROM auth_attempts WHERE key=? AND EXISTS(SELECT 1 FROM accounts WHERE id=? AND password_hash=?)')
      .bind(loginKey, a.id, c.hash),
  ]);
  if (!changes[0].results.length) throw new ApiError(409, '다른 로그인 또는 초기화가 먼저 완료되었습니다. 계정을 다시 검색하세요.');
  return json({ account: adminAccount(changes[0].results[0]), temporaryPassword, sessionsRevoked: true });
}
export async function authRoute(request, env, db, path) {
  if (request.method === 'POST' && path === '/accounts') throw new ApiError(410, '회원가입·로그인을 지원하는 모드로 업데이트하세요.');
  if (!path.startsWith('/auth/')) return null;
  if (request.method !== 'POST' || !['/auth/register','/auth/login','/auth/claim','/auth/logout','/auth/password'].includes(path))
    throw new ApiError(404, '인증 요청 경로가 올바르지 않습니다.');
  const url = new URL(request.url);
  if (url.protocol !== 'https:' && !['localhost','127.0.0.1','[::1]'].includes(url.hostname)) throw new ApiError(400, '로그인에는 HTTPS 서버 주소가 필요합니다.');
  secret(env);
  const data = await readJson(request, 4096);
  if (path === '/auth/logout') {
    const a = await account(db, bearer(request),true);
    await db.prepare('UPDATE accounts SET token_hash=?,token_expires=0,auth_revision=auth_revision+1 WHERE id=? AND token_hash=?')
      .bind(await sha256(encoder.encode(randomId() + randomId())), a.id, a.token_hash).run();
    return json({ loggedOut: true });
  }
  const own = ['/auth/claim','/auth/password'].includes(path) ? await account(db, bearer(request),path==='/auth/password') : null;
  const name = path === '/auth/password' ? own.username : username(data.username);
  if (!name) throw new ApiError(409, '먼저 기존 계정에 아이디를 등록하세요.');
  await throttle(request, env, db, name, path);
  if (path === '/auth/register') {
    if (env.REGISTRATION_OPEN !== 'true') throw new ApiError(403, '신규 참가 등록이 닫혀 있습니다.');
    const value = password(data.password), nick = nickname(data.nickname), limit = Number(env.MAX_ACCOUNTS || 1000);
    if (!Number.isInteger(limit) || limit < 1) throw new ApiError(503, '서버 계정 제한 설정이 잘못되었습니다.');
    const c = await credentials(env, value), s = await session();
    const result = await db.prepare(`INSERT INTO accounts(id,token_hash,name,username,nickname_key,password_salt,password_hash,token_expires)
      SELECT ?,?,?,?,?,?,?,? WHERE (SELECT count(*) FROM accounts WHERE NOT EXISTS(SELECT 1 FROM system_opponents s WHERE s.owner=accounts.id))<? ON CONFLICT DO NOTHING RETURNING *`)
      .bind(randomId(), s.hash, nick.display, name, nick.key, c.salt, c.hash, s.expires, limit).all();
    if (!result.results.length) throw new ApiError(409, '아이디 또는 닉네임이 이미 사용 중이거나 참가 정원에 도달했습니다.');
    return response(result.results[0], s);
  }
  if (path === '/auth/claim') {
    if (own.username) throw new ApiError(409, '이미 아이디가 등록된 계정입니다.');
    const nick = nickname(data.nickname);
    return saveCredentials(db, own, name, await credentials(env, password(data.password)), await session(), nick);
  }
  const a = own || await db.prepare('SELECT * FROM accounts WHERE username=? AND NOT EXISTS(SELECT 1 FROM system_opponents s WHERE s.owner=accounts.id)').bind(name).first();
  // The same KDF runs for unknown users, to avoid a cheap timing distinction.
  const value = password(data.password);
  const digest = await passwordHash(env, value, a?.password_salt || '00000000000000000000000000000000');
  if (!equal(digest, a?.password_hash)) throw new ApiError(401, '아이디 또는 비밀번호가 올바르지 않습니다.');
  if(path==='/auth/login' && a.password_reset_required && a.password_reset_expires<=now())throw new ApiError(401,'Recovery.ExpiredPassword');
  if (data.expectedAccountId && data.expectedAccountId !== a.id) throw new ApiError(409, '저장된 경기와 같은 계정으로 로그인하세요.');
  if (path === '/auth/password') {
    if(a.password_reset_required && data.newPassword===data.password)throw new ApiError(400,'Recovery.DifferentPassword');
    return saveCredentials(db, a, name, await credentials(env, password(data.newPassword)), await session());
  }
  const s = await session();
  const result = await db.prepare(`UPDATE accounts SET token_hash=?,token_expires=?,auth_revision=auth_revision+1
    WHERE id=? AND auth_revision=? RETURNING *`).bind(s.hash, s.expires, a.id, a.auth_revision).all();
  if (!result.results.length) throw new ApiError(409, '로그인 중 계정 정보가 변경되었습니다. 다시 시도하세요.');
  return response(result.results[0], s);
}
export async function verifyCurrentPassword(env,a,value){
  if(!equal(await passwordHash(env,password(value),a.password_salt),a.password_hash))throw new ApiError(401,'아이디 또는 비밀번호가 올바르지 않습니다.');
}
export {credentials,session,mac,throttle,username};
