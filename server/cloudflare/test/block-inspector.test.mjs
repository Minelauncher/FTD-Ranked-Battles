import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { inspectBlueprint } from '../src/blueprint-inspector.js';
import { bannedBlocksChecked, enforceBlockBans } from '../src/block-bans.js';
const fixtures = JSON.parse(await readFile(new URL('./block-inspections.json', import.meta.url), 'utf8'));
for (const f of fixtures) test('BP inspector: ' + f.name, () => {
  if (f.invalid) return assert.throws(() => inspectBlueprint(f.document), /BP 블록 검사 실패/);
  const r = inspectBlueprint(f.document);
  assert.deepEqual(r.counts, f.counts); assert.equal(r.blockCount, f.blockCount); assert.equal(r.constructCount, f.constructCount);
});
test('ban configuration normalizes GUIDs, rejects duplicates, malformed IDs and excessive lists', () => {
  const block = { guid: 'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA', name: 'Banned' };
  assert.equal(bannedBlocksChecked([block])[0].guid, block.guid.toLowerCase());
  for (const invalid of [[block, { ...block, guid: block.guid.toLowerCase() }], [{ ...block, guid: '1' }], [{ ...block, name: '' }], Array(129).fill(block), null])
    assert.throws(() => bannedBlocksChecked(invalid));
});
test('nested hierarchy limit is explicit rather than a parser stack overflow', () => {
  const document = { ItemDictionary: { 1: '11111111-1111-1111-1111-111111111111' }, Blueprint: { BlockIds: [1] } };
  let leaf = document.Blueprint;
  for (let i = 0; i < 64; i++) { leaf.SCs = [{ BlockIds: [1] }]; leaf = leaf.SCs[0]; }
  assert.equal(inspectBlueprint(document).constructCount, 65);
  leaf.SCs = [{ BlockIds: [1] }]; assert.throws(() => inspectBlueprint(document), /깊이/);
});
test('identical submissions reread original BP bytes; no persistent pass cache, even with no bans', async () => {
  let reads = 0, body = JSON.stringify(fixtures[1].document);
  const env = { BLUEPRINTS: { get: async () => { reads++; return { text: async () => body }; } } };
  const bps = [{ hash: 'a'.repeat(64), name: 'Same name' }];
  await enforceBlockBans(env, bps, []); await enforceBlockBans(env, bps, []);
  assert.equal(reads, 2);
  body = JSON.stringify(fixtures[0].document);
  await assert.rejects(enforceBlockBans(env, bps, [{ guid: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', name: 'Banned' }]), /Banned 2개/);
  assert.equal(reads, 3);
});
