import { ApiError } from './shared.js';

// Built-in FTD 4.3.4.1 .world BoardLayout dimensions, matching Custom battle's
// tiles-east/north controls (not metres or latitude/longitude).
export const battlefields = [
  { id: 'neter', name: '네터 (Neter)', eastMax: 19, northMax: 19, tileSize: 5120 },
  { id: 'aote', name: 'AOTE (Ashes of the Empire)', eastMax: 11, northMax: 11, tileSize: 5120 },
];
export function battlefieldChecked(rules, validatePosition = true) {
  const world = rules.world === undefined ? 'neter' : rules.world;
  const map = battlefields.find(m => m.id === world);
  if (!map) throw new ApiError(400, '전장은 네터(neter) 또는 AOTE(aote)를 선택하세요.');
  if (validatePosition && (rules.boardEast < 0 || rules.boardEast > map.eastMax || rules.boardNorth < 0 || rules.boardNorth > map.northMax))
    throw new ApiError(400, `${map.name} 전장 좌표는 동쪽 0~${map.eastMax}, 북쪽 0~${map.northMax}칸입니다.`);
  return world;
}
