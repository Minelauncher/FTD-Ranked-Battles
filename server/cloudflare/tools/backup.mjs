import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { root, productionConfig, productionPath, wrangler } from './common.mjs';
export async function backup() {
  const config=await productionConfig();
  const directory = path.join(root, 'backups'); await mkdir(directory, { recursive: true });
  const stamp=new Date().toISOString().replaceAll(':', '-');
  const output = path.join(directory, stamp + '.sql'), files=[];
  // Wrangler prints a signed download URL; keep it out of deployment logs.
  for(const db of config.d1_databases){
    const file=db.binding==='DB'?output:path.join(directory,stamp+'.'+db.binding+'.sql');
    await wrangler(['d1','export',db.binding,'--remote','--output',file,'--config',productionPath],true);
    files.push({binding:db.binding,databaseId:db.database_id,file});
  }
  await writeFile(path.join(directory,stamp+'.manifest.json'),JSON.stringify({created:new Date().toISOString(),files},null,2));
  console.log('D1 backup saved:', output); return output;
}
if (process.argv[1] && path.resolve(process.argv[1]) === path.join(root, 'tools/backup.mjs')) await backup();
