import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';

// Smaller import chunks keep each SQL statement below D1's 100 KB limit.
export function blueprintSql(bytes) {
  if (!bytes.length || bytes.length > 8 * 1024 * 1024) throw new Error('Invalid BP size.');
  const hash = createHash('sha256').update(bytes).digest('hex');
  const key = `blueprints/${hash}.blueprint`, compressed = gzipSync(bytes), parts = [];
  for (let offset = 0; offset < compressed.length; offset += 32768)
    parts.push(compressed.subarray(offset, offset + 32768).toString('base64'));
  return [
    `INSERT INTO blueprint_objects(key,size,compressed_size,parts) VALUES('${key}',${bytes.length},${compressed.length},${parts.length});`,
    ...parts.map((data, part) => `INSERT INTO blueprint_chunks(key,part,data) VALUES('${key}',${part},'${data}');`)
  ];
}
