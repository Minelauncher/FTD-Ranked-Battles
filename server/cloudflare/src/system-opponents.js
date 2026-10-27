import { ApiError, encoder, json, now, randomId, readJson, sha256 } from './shared.js';
import { campaignPack, campaignPresets, campaignCalibration } from './campaign-presets.js';

const idPattern = '[a-z0-9][a-z0-9-]{0,63}';
function checked(data) {
  if (typeof data.name !== 'string' || !data.name.trim() || data.name.length > 80 || /[\x00-\x1f\x7f]/.test(data.name))
    throw new ApiError(400, '기본 상대 이름은 1~80자로 입력하세요.');
  if (typeof data.rating !== 'number' || !Number.isFinite(data.rating) || data.rating < 0 || data.rating > 10000)
    throw new ApiError(400, '레이팅은 0~10000 범위의 수로 입력하세요.');
  return { name: '[Stock] ' + data.name.trim(), rating: Math.round(data.rating * 1000) / 1000 };
}
async function getTournament(db, id) {
  const t = await db.prepare('SELECT * FROM tournaments WHERE id=?').bind(id).first();
  if (!t) throw new ApiError(404, '대회를 찾을 수 없습니다.');
  return t;
}
async function create(db, tournament, data, owner = 'sys-' + randomId(), seedKey = null) {
  const { name, rating } = checked(data);
  // No secret corresponding to this random hash is retained or issued. Auth also
  // explicitly excludes all system_opponents identities.
  await db.batch([
    db.prepare('INSERT INTO accounts(id,token_hash,name,token_expires) VALUES(?,?,?,0) ON CONFLICT(id) DO NOTHING')
      .bind(owner, await sha256(encoder.encode(randomId() + randomId())), name),
    db.prepare('INSERT INTO system_opponents(owner,tournament,seed_key) VALUES(?,?,?) ON CONFLICT DO NOTHING')
      .bind(owner, tournament, seedKey),
    db.prepare('INSERT INTO tournament_ratings(tournament,owner,rating) VALUES(?,?,?) ON CONFLICT DO NOTHING').bind(tournament,owner,rating),
  ]);
  return owner;
}
async function profile(db, owner) {
  const p = await db.prepare('SELECT * FROM system_opponents WHERE owner=?').bind(owner).first();
  if (!p) throw new ApiError(404, '기본 상대를 찾을 수 없습니다.');
  return p;
}
async function listing(db, t) {
  const rows = await db.prepare(`SELECT a.id,a.name,r.rating,s.enabled,s.revision,s.seed_key,e.revision AS rules_revision,e.fleet
    FROM system_opponents s JOIN accounts a ON a.id=s.owner JOIN tournament_ratings r ON r.owner=s.owner AND r.tournament=s.tournament
    LEFT JOIN tournament_entries e ON e.owner=s.owner AND e.tournament=s.tournament WHERE s.tournament=? ORDER BY r.rating,a.id`).bind(t.id).all();
  return rows.results.map(r => ({ id: r.id, name: r.name.replace(/^\[(?:Stock|기본 상대)\] /, ''), rating: r.rating,
    enabled: !!r.enabled, revision: r.revision, preset: r.seed_key, current: r.rules_revision === t.revision,
    fleet: r.fleet ? JSON.parse(r.fleet) : null }));
}
async function save(env, db, p, t, data, validateFleet) {
  const { name, rating } = checked(data);
  if (!Number.isInteger(data.expectedRevision) || data.expectedRevision < 0 || typeof data.enabled !== 'boolean')
    throw new ApiError(400, '현재 편집 버전과 활성 상태가 필요합니다.');
  if (data.tournamentRevision !== t.revision) throw new ApiError(409, '대회 규칙이 바뀌었습니다. 다시 불러오세요.');
  const rules = JSON.parse(t.rules), fleet = await validateFleet(env, db, p.owner, data, rules);
  const serialized = JSON.stringify(fleet), fingerprint = await sha256(encoder.encode(serialized));
  const composition = fleet.units.map(u => u.hash).sort().join(','), stamp = now();
  // The profile CAS is last; all preceding writes use the same guard in this D1 transaction.
  const guard = `EXISTS(SELECT 1 FROM system_opponents s JOIN tournaments t ON t.id=s.tournament
    WHERE s.owner=? AND s.revision=? AND t.revision=?)`;
  const args = [p.owner, data.expectedRevision, t.revision];
  const result = await db.batch([
    db.prepare(`INSERT INTO tournament_entries(tournament,owner,revision,fleet,fingerprint,updated,composition_key,composition_updated)
      SELECT ?,?,?,?,?,?,?,? WHERE ${guard} ON CONFLICT(tournament,owner) DO UPDATE SET
      revision=excluded.revision,fleet=excluded.fleet,fingerprint=excluded.fingerprint,updated=excluded.updated,
      composition_key=excluded.composition_key,composition_updated=excluded.composition_updated`)
      .bind(t.id, p.owner, t.revision, serialized, fingerprint, stamp, composition, stamp, ...args),
    db.prepare(`UPDATE accounts SET name=? WHERE id=? AND ${guard}`).bind(name, p.owner, ...args),
    db.prepare(`UPDATE tournament_ratings SET rating=? WHERE owner=? AND tournament=? AND ${guard}`).bind(rating,p.owner,t.id,...args),
    db.prepare(`UPDATE system_opponents SET enabled=?,revision=revision+1 WHERE owner=? AND ${guard} RETURNING revision`)
      .bind(data.enabled ? 1 : 0, p.owner, ...args),
  ]);
  if (!result[3].results.length) throw new ApiError(409, '다른 편집이나 대회 규칙 변경이 먼저 저장되었습니다. 다시 불러오세요.');
  return (await listing(db, t)).find(r => r.id === p.owner);
}
async function installDefaults(env, db, t, validateFleet, uploadLibrary) {
  const marker = t.id + ':' + campaignPack;
  if (await db.prepare('SELECT key FROM system_defaults WHERE key=?').bind(marker).first()) {
    await applyCampaignRatings(db, t, campaignCalibration);
    return;
  }
  for (const preset of campaignPresets) {
    const owner = 'sys-' + (await sha256(encoder.encode(marker + ':' + preset.key))).slice(0, 32);
    await create(db, t.id, preset, owner, preset.key);
    const p = await profile(db, owner);
    if (p.revision > 0) continue; // Never overwrite an administrator's edits or enable a disabled fleet.
    const bytes = encoder.encode(preset.blueprint), hash = await sha256(bytes);
    const request = new Request('https://internal/blueprints', { method: 'POST', body: bytes, headers: {
      'Content-Length': String(bytes.length), 'X-Blueprint-Sha256': hash,
      'X-Blueprint-Name': encodeURIComponent(preset.blueprintName), 'X-Blueprint-Cost': String(preset.cost) } });
    await uploadLibrary(request, env, db, { id: owner });
    try {
      await save(env, db, p, t, { ...preset, enabled: true, expectedRevision: 0, tournamentRevision: t.revision,
        units: preset.positions.map(position => ({ hash, ...position })) }, validateFleet);
    } catch (e) {
      // Customized rules may reject a stock fleet. Keep a disabled draft for the
      // administrator; ordinary tournament discovery must continue to work.
      if (!(e instanceof ApiError) || ![400, 409].includes(e.status)) throw e;
    }
  }
  // Retire the previous stock pack once, preserving its BPs, edits and issued
  // tickets. Manually created opponents have no seed_key and remain untouched.
  // The marker and retirement share a transaction so a retry cannot disable an
  // old preset that an administrator explicitly re-enabled after the upgrade.
  await db.batch([
    db.prepare(`UPDATE system_opponents SET enabled=0,revision=revision+1
      WHERE tournament=? AND seed_key IN ('dwg-dusters','dwg-marauders','dwg-corsairs') AND enabled=1
      AND NOT EXISTS(SELECT 1 FROM system_defaults WHERE key=?)`).bind(t.id, marker),
    db.prepare('INSERT INTO system_defaults(key) VALUES(?) ON CONFLICT DO NOTHING').bind(marker),
  ]);
  await applyCampaignRatings(db, t, campaignCalibration);
}
export async function ensureDefaultOpponents(env, db, validateFleet, uploadLibrary) {
  if (env.DEFAULT_OPPONENTS === 'false') return;
  const t = await db.prepare("SELECT * FROM tournaments WHERE id='standard-100k'").first();
  if (t) await installDefaults(env, db, t, validateFleet, uploadLibrary);
}
// Apply a measured rating release only to unchanged stock in its tested ruleset.
// Existing tickets retain their rating snapshots; administrator edits are preserved.
export async function applyCampaignRatings(db, t, calibration) {
  if (!calibration || t.id !== 'standard-100k') return;
  const rules = typeof t.rules === 'string' ? JSON.parse(t.rules) : t.rules;
  if (Object.keys(rules).length !== Object.keys(calibration.rules).length ||
      Object.entries(calibration.rules).some(([key,value]) => JSON.stringify(rules[key]) !== JSON.stringify(value))) return;
  const marker = t.id + ':ratings:' + calibration.id;
  if (await db.prepare('SELECT key FROM system_defaults WHERE key=?').bind(marker).first()) return;
  const statements = [];
  for (const item of calibration.presets) {
    if (item.previousRating === item.rating) continue;
    const p = await db.prepare(`SELECT s.*,a.name,r.rating,r.games,e.fingerprint FROM system_opponents s
      JOIN accounts a ON a.id=s.owner JOIN tournament_ratings r ON r.owner=s.owner AND r.tournament=s.tournament
      JOIN tournament_entries e ON e.owner=s.owner AND e.tournament=s.tournament
      WHERE s.tournament=? AND s.seed_key=?`).bind(t.id,item.key).first();
    const name = '[Stock] ' + item.name;
    if (!p || p.games !== 0 || !p.enabled || p.name !== name || p.rating !== item.previousRating || p.fingerprint !== item.fingerprint) continue;
    const guard = `EXISTS(SELECT 1 FROM system_opponents s JOIN tournament_entries e
      ON e.owner=s.owner AND e.tournament=s.tournament
      WHERE s.owner=? AND s.revision=? AND s.enabled=1 AND s.tournament=? AND s.seed_key=? AND e.fingerprint=?)
      AND EXISTS(SELECT 1 FROM tournaments WHERE id=? AND revision=?)
      AND NOT EXISTS(SELECT 1 FROM system_defaults WHERE key=?)`;
    const args = [p.owner,p.revision,t.id,item.key,item.fingerprint,t.id,t.revision,marker];
    statements.push(db.prepare(`UPDATE tournament_ratings SET rating=? WHERE owner=? AND tournament=? AND games=0 AND rating=?
      AND EXISTS(SELECT 1 FROM accounts WHERE id=? AND name=?) AND ${guard}`)
      .bind(item.rating,p.owner,t.id,item.previousRating,p.owner,name,...args));
    statements.push(db.prepare(`UPDATE system_opponents SET revision=revision+1 WHERE owner=? AND ${guard}
      AND EXISTS(SELECT 1 FROM tournament_ratings r JOIN accounts a ON a.id=r.owner WHERE r.owner=? AND r.tournament=? AND r.games=0 AND a.name=? AND r.rating=?)`)
      .bind(p.owner,...args,p.owner,t.id,name,item.rating));
  }
  statements.push(db.prepare(`INSERT INTO system_defaults(key) SELECT ?
    WHERE EXISTS(SELECT 1 FROM tournaments WHERE id=? AND revision=?) ON CONFLICT DO NOTHING`).bind(marker,t.id,t.revision));
  await db.batch(statements);
}
// Called after the common admin token and HTTPS checks, never from participant routes.
export async function systemOpponentRoute(request, env, db, path, validateFleet, uploadLibrary) {
  const collection = new RegExp('^/admin/tournaments/(' + idPattern + ')/opponents(?:/(defaults))?$').exec(path);
  if (collection) {
    const t = await getTournament(db, collection[1]);
    if (collection[2] === 'defaults' && request.method === 'POST') {
      await installDefaults(env, db, t, validateFleet, uploadLibrary);
      return json({ opponents: await listing(db, t) });
    }
    if (!collection[2] && request.method === 'GET') return json({ opponents: await listing(db, t), tournamentRevision: t.revision, rules: JSON.parse(t.rules) });
    if (!collection[2] && request.method === 'POST') {
      const owner = await create(db, t.id, await readJson(request));
      return json({ opponent: (await listing(db, t)).find(r => r.id === owner) });
    }
  }
  const route = /^\/admin\/opponents\/(sys-[a-f0-9]{32})(?:\/(blueprints(?:\/raw)?|enabled))?$/.exec(path);
  if (!route) return null;
  const p = await profile(db, route[1]), t = await getTournament(db, p.tournament);
  if (route[2] === 'blueprints/raw' && request.method === 'POST') return uploadLibrary(request, env, db, { id: p.owner });
  if (route[2] === 'blueprints' && request.method === 'GET') {
    const rows = await db.prepare('SELECT hash,name,cost FROM blueprint_library WHERE owner=? ORDER BY name,hash').bind(p.owner).all();
    return json({ blueprints: rows.results });
  }
  if (!route[2] && request.method === 'PUT') return json({ opponent: await save(env, db, p, t, await readJson(request, 65536), validateFleet) });
  // Disabling must also work for stale/now-invalid fleets without resubmission.
  if (route[2] === 'enabled' && request.method === 'PUT') {
    const data = await readJson(request);
    if (data.enabled !== false || !Number.isInteger(data.expectedRevision)) throw new ApiError(400, '비활성화할 현재 버전을 보내세요. 활성화는 함대를 다시 검사하여 저장하세요.');
    const rows = await db.prepare('UPDATE system_opponents SET enabled=0,revision=revision+1 WHERE owner=? AND revision=? RETURNING owner')
      .bind(p.owner, data.expectedRevision).all();
    if (!rows.results.length) throw new ApiError(409, '기본 상대가 변경되었습니다. 다시 불러오세요.');
    return json({ opponent: (await listing(db, t)).find(r => r.id === p.owner) });
  }
  throw new ApiError(404, '존재하지 않는 기본 상대 요청입니다.');
}
