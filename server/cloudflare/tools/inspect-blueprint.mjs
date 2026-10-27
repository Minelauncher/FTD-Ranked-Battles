import { readFile } from 'node:fs/promises';
import { inspectBlueprint } from '../src/blueprint-inspector.js';
import { blockCatalog } from '../src/block-catalog.js';
if (process.argv.length !== 3) throw Error('Usage: node tools/inspect-blueprint.mjs <file.blueprint>');
const bp = JSON.parse(await readFile(process.argv[2], 'utf8')), report = inspectBlueprint(bp);
const names = new Map(blockCatalog.map(b => [b.guid, b.name]));
console.log(JSON.stringify({ name: bp.Name, ...report, blocks: Object.entries(report.counts).map(([guid, count]) => ({ guid, name: names.get(guid) || guid, count })) }, null, 2));
