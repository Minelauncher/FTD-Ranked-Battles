import { ApiError, json, readJson } from './shared.js';

function versionParts(version) {
  if (typeof version !== 'string' || !/^\d{1,5}\.\d{1,5}\.\d{1,5}$/.test(version)) return null;
  return version.split('.').map(Number);
}
export function atLeast(version, minimum) {
  const a = versionParts(version), b = versionParts(minimum);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return true;
}
export async function policy(db) {
  const p = await db.prepare('SELECT * FROM client_policy WHERE id=1').first();
  if (!p) throw new ApiError(503, '최소 클라이언트 버전 설정이 없습니다.');
  return { minimumVersion: p.minimum_version, minimumProtocol: p.minimum_protocol, revision: p.revision };
}
export async function enforceClient(request, db) {
  const p = await policy(db), version = request.headers.get('X-FTD-Rank-Version'), protocol = request.headers.get('X-FTD-Rank-Protocol');
  if (!atLeast(version, p.minimumVersion) || !protocol || !/^\d{1,5}$/.test(protocol) || Number(protocol) < p.minimumProtocol)
    throw new ApiError(426, `모드 업데이트가 필요합니다. 서버 최소 버전: ${p.minimumVersion} / 통신 규격: ${p.minimumProtocol}`);
}
export async function updatePolicy(request, db) {
  const data = await readJson(request);
  if (!atLeast(data.minimumVersion, '0.6.10') || !Number.isInteger(data.minimumProtocol) || data.minimumProtocol < 1 || data.minimumProtocol > 99999)
    throw new ApiError(400, '최소 버전은 양쪽 레이팅 정산을 지원하는 0.6.10 이상, 통신 규격은 1 이상의 정수로 지정하세요.');
  if (!Number.isInteger(data.expectedRevision)) throw new ApiError(400, 'expectedRevision이 필요합니다.');
  const result = await db.prepare(`UPDATE client_policy SET minimum_version=?,minimum_protocol=?,revision=revision+1
    WHERE id=1 AND revision=? RETURNING *`).bind(data.minimumVersion, data.minimumProtocol, data.expectedRevision).all();
  if (!result.results.length) throw new ApiError(409, '접속 정책이 변경되었습니다. 다시 읽으세요.');
  return json({ clientPolicy: await policy(db) });
}

