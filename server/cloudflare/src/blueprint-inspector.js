// Pure function shared by Worker validation, admin's local BP preview and CLI.
// Inspect placed BlockIds, not every dictionary entry. SCs includes turrets and drones.
export function inspectBlueprint(document) {
  const fail = reason => { throw new Error('BP 블록 검사 실패: ' + reason + ' 게임에서 다시 저장한 BP를 사용하세요.'); };
  const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  const canonical = (value, names) => {
    for (const key of Object.keys(value))
      if (names.some(name => name.toLowerCase() === key.toLowerCase() && name !== key)) fail('중복되거나 모호한 필드: ' + key.slice(0, 40));
  };
  const guidPattern = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
  if (!object(document) || !object(document.Blueprint) || !object(document.ItemDictionary)) fail('Blueprint / ItemDictionary가 없습니다.');
  canonical(document, ['Blueprint', 'ItemDictionary']);
  const dictionary = new Map();
  for (const [id, guid] of Object.entries(document.ItemDictionary)) {
    if (!/^(0|[1-9][0-9]*)$/.test(id) || Number(id) > 2147483647 || typeof guid !== 'string' || !guidPattern.test(guid)) fail('블록 식별 목록이 올바르지 않습니다.');
    dictionary.set(Number(id), guid.toLowerCase());
  }
  const pending = [{ bp: document.Blueprint, depth: 0 }], counts = new Map();
  let blockCount = 0, constructCount = 0;
  while (pending.length) {
    const { bp, depth } = pending.pop();
    if (!object(bp) || depth > 64 || ++constructCount > 4096) fail('하위 BP 구조 또는 깊이가 지원 범위를 벗어났습니다.');
    canonical(bp, ['BlockIds', 'SCs']);
    if (!Array.isArray(bp.BlockIds) || (bp.SCs != null && !Array.isArray(bp.SCs))) fail('BlockIds / SCs 구조가 올바르지 않습니다.');
    if ((blockCount += bp.BlockIds.length) > 1000000) fail('블록 수가 검사 한도를 초과했습니다.');
    for (const id of bp.BlockIds) {
      if (!Number.isInteger(id) || !dictionary.has(id)) fail('식별할 수 없는 블록 번호가 있습니다.');
      const guid = dictionary.get(id);
      counts.set(guid, (counts.get(guid) || 0) + 1);
    }
    if (counts.size > 4096) fail('블록 종류가 검사 한도를 초과했습니다.');
    for (const child of bp.SCs || []) pending.push({ bp: child, depth: depth + 1 });
  }
  if (!blockCount) fail('배치된 블록이 없습니다.');
  return { version: 1, blockCount, constructCount, counts: Object.fromEntries([...counts].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) };
}
