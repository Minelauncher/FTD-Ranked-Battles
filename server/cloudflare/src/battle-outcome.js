import { ApiError } from './shared.js';

export const resultPolicy = 'remaining-materials-v1';
export const healthPolicy = 'total-health-v1';
const rounded = v => Math.round(v * 1000) / 1000;
function checkedMaterials(o) {
  if (!Array.isArray(o.materials) || o.materials.length !== 2 || o.materials.some((m,i) =>
    !m || ['vehicle','supply','total'].some(k => typeof m[k] !== 'number' || !Number.isFinite(m[k]) || m[k] < 0 || m[k] > 1e12 || rounded(m[k]) !== m[k]) ||
    m.total !== rounded(m.vehicle + m.supply) || (o.eliminated[i] && m.total !== 0)))
    throw new ApiError(400, '남은 기체 비용과 보급 자원, 합계가 필요합니다.');
  return o.materials.map(({vehicle,supply,total}) => ({vehicle,supply,total}));
}
// Consistency checking of a local result, not proof of the simulation itself.
export function checkedResult(ticket, data) {
  const score = data?.score;
  if (typeof score !== 'number' || ![0, .5, 1].includes(score))
    throw new ApiError(400, '결과는 패배(0), 무승부(0.5), 승리(1) 중 하나입니다.');
  if (ticket.resultPolicy == null && data.outcome == null) return { score }; // Previously queued results.
  if (ticket.resultPolicy != null && ![resultPolicy,healthPolicy].includes(ticket.resultPolicy)) throw new ApiError(503, '지원하지 않는 경기 판정 방식입니다.');
  const o = data.outcome, duration = ticket.rules?.duration ?? ticket.duration;
  if (!o || !Array.isArray(o.remaining) || o.remaining.length !== 2 ||
      o.remaining.some(v => typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) ||
      !Array.isArray(o.eliminated) || o.eliminated.length !== 2 || o.eliminated.some(v => typeof v !== 'boolean') ||
      typeof o.seconds !== 'number' || !Number.isFinite(o.seconds) || o.seconds < 0 || o.seconds > duration + 5 ||
      o.eliminated.some((gone, i) => gone && o.remaining[i] !== 0))
    throw new ApiError(400, '전투 종료 시각과 두 편대의 체력비·전멸 여부가 필요합니다.');
  const materials = ticket.resultPolicy === resultPolicy ? checkedMaterials(o) : null;
  if (!materials && o.materials != null) throw new ApiError(400, '발급된 경기 판정 방식과 결과가 다릅니다.');
  const values = materials ? materials.map(m=>m.total) : o.remaining;
  let expected, kind;
  if (o.eliminated.every(Boolean)) { expected = .5; kind = 'mutual-elimination'; }
  else if (o.eliminated.some(Boolean)) { expected = o.eliminated[0] ? 0 : 1; kind = 'elimination'; }
  else if (o.seconds < duration) throw new ApiError(400, '제한 시간 전에 판정승을 제출할 수 없습니다.');
  else if (ticket.resultPolicy != null && values[0] !== values[1]) {
    expected = values[0] > values[1] ? 1 : 0; kind = 'judgment';
  } else { expected = .5; kind = 'timeout-draw'; }
  if (score !== expected || o.kind !== kind) throw new ApiError(400, '종료 상태와 경기 결과가 일치하지 않습니다.');
  return { score, outcome: { kind, remaining: o.remaining, eliminated: o.eliminated, seconds: o.seconds, ...(materials ? {materials} : {}) } };
}
export function sameResult(receipt, decision) {
  return receipt.score === decision.score && JSON.stringify(receipt.outcome) === JSON.stringify(decision.outcome);
}
