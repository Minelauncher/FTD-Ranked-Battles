// Pure transforms shared by browser and tests. The image is the complete playable
// rectangle. FTD custom battle subtracts 0.5 from both tile coordinates internally;
// that conversion is already represented by the exported image's world-space bounds.
export function mapCoordinates(map, x, y) {
  if (![x, y].every(Number.isFinite) || x < 0 || x > 1000 || y < 0 || y > 1000) return null;
  return { east: Math.round(x / 1000 * map.eastMax * 1000) / 1000,
    north: Math.round((1 - y / 1000) * map.northMax * 1000) / 1000 };
}
export function mapPoint(map, east, north) {
  if (![east, north].every(Number.isFinite) || east < 0 || north < 0 || east > map.eastMax || north > map.northMax) return null;
  return { x: east / map.eastMax * 1000, y: (1 - north / map.northMax) * 1000 };
}
export function mapViewport(map, east, north, zoom) {
  const point = mapPoint(map, east, north) || { x: 500, y: 500 };
  const size = 1000 / Math.max(1, Math.min(8, zoom));
  return { x: Math.max(0, Math.min(1000 - size, point.x - size / 2)),
    y: Math.max(0, Math.min(1000 - size, point.y - size / 2)), size };
}
