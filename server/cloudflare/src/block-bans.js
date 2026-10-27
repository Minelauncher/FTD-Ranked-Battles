import { ApiError, objectKey } from './shared.js';
import { inspectBlueprint } from './blueprint-inspector.js';

export function bannedBlocksChecked(value = []) {
  if (!Array.isArray(value) || value.length > 128) throw new ApiError(400, '금지 블록은 최대 128종까지 지정할 수 있습니다.');
  const seen = new Set();
  return value.map(block => {
    if (!block || typeof block !== 'object' || typeof block.guid !== 'string' ||
      !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(block.guid) ||
      typeof block.name !== 'string' || !block.name.trim() || block.name.length > 100 || /[\x00-\x1f\x7f]/.test(block.name))
      throw new ApiError(400, '금지 블록의 GUID와 표시 이름을 확인하세요.');
    const guid = block.guid.toLowerCase();
    if (seen.has(guid)) throw new ApiError(400, '금지 블록 GUID가 중복되었습니다.');
    seen.add(guid); return { guid, name: block.name.trim() };
  }).sort((a, b) => a.guid < b.guid ? -1 : a.guid > b.guid ? 1 : 0);
}

export async function blueprintInspection(env, hash) {
  const stored = await env.BLUEPRINTS.get(objectKey(hash));
  if (!stored) throw new ApiError(503, '검사할 BP 원본이 없습니다. 다시 업로드하세요.');
  let report;
  try { report = inspectBlueprint(JSON.parse(await stored.text())); }
  catch (error) { throw new ApiError(400, error.message.startsWith('BP 블록 검사 실패:') ? error.message : 'BP JSON을 읽지 못했습니다. 게임에서 다시 저장하세요.'); }
  // No persisted pass or report: inspect the original bytes on EVERY submission.
  return report;
}

export async function enforceBlockBans(env, blueprints, bans = []) {
  const problems = [];
  for (const bp of blueprints) {
    const report = await blueprintInspection(env, bp.hash);
    const blocked = bans.filter(b => report.counts[b.guid] > 0);
    if (blocked.length) problems.push(bp.name + ': ' + blocked.slice(0, 4).map(b => `${b.name} ${report.counts[b.guid]}개 (${b.guid})`).join(', '));
    if (problems.length === 3) break;
  }
  if (problems.length) throw new ApiError(400, '금지 블록이 포함되어 제출할 수 없습니다. ' + problems.join(' / '));
}
