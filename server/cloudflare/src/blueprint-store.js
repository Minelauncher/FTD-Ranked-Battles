import { ApiError, BP_LIMIT, sha256 } from './shared.js';

// Gzip chunks stay below D1's 2 MB row limit. An 8 MiB incompressible BP
// needs at most 17 chunks and stays below Free's 50 queries per request.
const CHUNK_BYTES = 512 * 1024;
const COMPRESSED_LIMIT = BP_LIMIT + 65536;
function expectedHash(key) {
  const match = /^blueprints\/([a-f0-9]{64})\.blueprint$/.exec(key);
  if (!match) throw new Error('Invalid blueprint object key');
  return match[1];
}
async function readBytes(body, limit = BP_LIMIT) {
  const reader = new Response(body).body?.getReader();
  if (!reader) throw new ApiError(400, 'BP 파일이 비어 있습니다.');
  const chunks = []; let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) { await reader.cancel(); throw new ApiError(413, 'BP 파일 크기는 최대 8 MiB입니다.'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}
function base64(bytes) {
  const strings = [];
  for (let i = 0; i < bytes.length; i += 16384) strings.push(String.fromCharCode(...bytes.subarray(i, i + 16384)));
  return btoa(strings.join(''));
}
function unbase64(text) {
  const binary = atob(text), bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
export function blueprintStore(db) {
  return {
    async head(key) {
      expectedHash(key);
      return await db.prepare('SELECT key,size,compressed_size FROM blueprint_objects WHERE key=?').bind(key).first();
    },
    async put(key, body, options = {}) {
      const hash = expectedHash(key), bytes = await readBytes(body);
      if (!bytes.length) throw new ApiError(400, 'BP 파일이 비어 있습니다.');
      if (options.size !== undefined && options.size !== bytes.byteLength) throw new ApiError(400, 'BP 파일 크기가 일치하지 않습니다.');
      if ((options.sha256 && options.sha256 !== hash) || await sha256(bytes) !== hash) throw new Error('BP hash mismatch');
      const compressed = await readBytes(new Response(bytes).body.pipeThrough(new CompressionStream('gzip')), COMPRESSED_LIMIT);
      const parts = [];
      for (let i = 0; i < compressed.length; i += CHUNK_BYTES) parts.push(base64(compressed.subarray(i, i + CHUNK_BYTES)));
      // Manifest and chunks commit together. Concurrent uploads of identical,
      // verified content deduplicate without replacing an existing object.
      await db.batch([
        db.prepare('INSERT INTO blueprint_objects(key,size,compressed_size,parts) VALUES(?,?,?,?) ON CONFLICT DO NOTHING')
          .bind(key, bytes.length, compressed.length, parts.length),
        ...parts.map((data, part) => db.prepare('INSERT INTO blueprint_chunks(key,part,data) VALUES(?,?,?) ON CONFLICT DO NOTHING').bind(key, part, data)),
      ]);
      return { key, size: bytes.length };
    },
    async get(key) {
      const hash = expectedHash(key);
      const rows = (await db.prepare(`SELECT o.size,o.compressed_size,o.parts,c.part,c.data FROM blueprint_objects o
        LEFT JOIN blueprint_chunks c ON c.key=o.key WHERE o.key=? ORDER BY c.part`).bind(key).all()).results;
      if (!rows.length) return null;
      const meta = rows[0];
      try {
        if (rows.length !== meta.parts || rows.some((r, i) => r.part !== i) || meta.compressed_size > COMPRESSED_LIMIT) throw new Error();
        const compressed = new Uint8Array(meta.compressed_size); let offset = 0;
        for (const row of rows) { const bytes = unbase64(row.data); compressed.set(bytes, offset); offset += bytes.length; }
        if (offset !== compressed.length) throw new Error();
        const bytes = await readBytes(new Response(compressed).body.pipeThrough(new DecompressionStream('gzip')));
        if (bytes.length !== meta.size || await sha256(bytes) !== hash) throw new Error();
        return { key, size: bytes.length, body: bytes,
          text: async () => new TextDecoder().decode(bytes), arrayBuffer: async () => bytes.buffer.slice(0) };
      } catch { throw new ApiError(503, '저장된 BP 파일이 손상되었습니다. 운영자에게 알려 주세요.'); }
    },
    // Internal maintenance/test helper; no participant deletion endpoint.
    async delete(key) {
      expectedHash(key);
      await db.prepare('DELETE FROM blueprint_objects WHERE key=?').bind(key).run();
    },
  };
}

export const storageBinding = name => name === 'DB' || /^BP_DB_0[1-9]$/.test(name);

// The hash-to-database directory is stable when bindings are appended. Never
// select a database by hash % count: that would remap every existing object.
export function routedBlueprintStore(env, main = env.DB.withSession('first-primary')) {
  const writer = env.BLUEPRINT_WRITE_DB ?? 'DB', stores = new Map([['DB', blueprintStore(main)]]);
  function store(name) {
    if (!storageBinding(name) || !env[name]) throw new ApiError(503, 'BP 저장소 설정을 확인해 주세요.');
    if (!stores.has(name)) stores.set(name, blueprintStore(env[name].withSession('first-primary')));
    return stores.get(name);
  }
  store(writer); // A bad write target must not silently fall back to a full DB.
  async function location(key) {
    expectedHash(key);
    return await main.prepare('SELECT storage FROM blueprint_locations WHERE key=?').bind(key).first('storage');
  }
  return {
    async head(key) { return store(await location(key) ?? 'DB').head(key); },
    async get(key) { return store(await location(key) ?? 'DB').get(key); },
    async put(key, body, options = {}) {
      const existing = await location(key);
      // An old BP without a directory entry still belongs to DB. Retain that
      // location on retries even after the administrator changes the writer.
      const target = existing ?? ((await stores.get('DB').head(key)) ? 'DB' : writer);
      const saved = await store(target).put(key, body, options);
      if (existing == null && target !== 'DB') {
        // Cross-database operations cannot share a transaction: publish the
        // location only AFTER the complete immutable object is committed.
        // A failed publication leaves a harmless copy; the same upload retries.
        if (options.generation !== undefined) {
          await main.prepare(`INSERT INTO blueprint_locations(key,storage,updated) SELECT ?,?,?
            WHERE EXISTS(SELECT 1 FROM blueprint_lifecycle WHERE hash=? AND state='ready' AND generation=?)
            ON CONFLICT(key) DO NOTHING`).bind(key,target,Date.now()/1000,expectedHash(key),options.generation).run();
        } else {
          await main.prepare('INSERT INTO blueprint_locations(key,storage,updated) VALUES(?,?,?) ON CONFLICT(key) DO NOTHING')
            .bind(key, target, Date.now()/1000).run();
        }
      }
      // Competing Worker versions may choose different write targets. The
      // directory winner must be readable before metadata can be published.
      const published = await store(await location(key) ?? 'DB').head(key);
      if (!published || published.size !== saved.size) throw new ApiError(503, 'BP 저장 위치를 확인할 수 없습니다. 다시 시도하세요.');
      return saved;
    },
    // Internal fault-injection helper. Preserve the directory to avoid falling
    // back to an obsolete copy after deletion; there is no participant endpoint.
    async delete(key) { await store(await location(key) ?? 'DB').delete(key); },
  };
}
