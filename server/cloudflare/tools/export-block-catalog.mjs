// Run locally against the installed game's StreamingAssets/Mods directory.
// Only GUIDs and readable names are exported; no code, models or textures.
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
if (process.argv.length !== 3) throw Error('Usage: node tools/export-block-catalog.mjs <StreamingAssets/Mods>');
const base = path.resolve(process.argv[2]), blocks = new Map();
for (const entry of await readdir(base, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile() || !['.item', '.itemduplicateandmodify'].includes(path.extname(entry.name))) continue;
  const item = JSON.parse(await readFile(path.join(entry.parentPath, entry.name), 'utf8'));
  const guid = item.ComponentId?.Guid?.toLowerCase(), name = item.ComponentId?.Name;
  if (guid && name) blocks.set(guid, { guid, name });
}
const list = [...blocks.values()].sort((a, b) => a.name.localeCompare(b.name));
await writeFile(new URL('../src/block-catalog.js', import.meta.url), '// Names and GUIDs from the installed FTD item definitions. Regenerate when updating the game.\nexport const blockCatalog = ' + JSON.stringify(list) + ';\n');
console.log('Exported ' + list.length + ' block names/GUIDs.');
