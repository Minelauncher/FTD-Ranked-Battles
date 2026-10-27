import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {root,productionPath,wrangler} from './common.mjs';
export function cliDatabase(binding,config=productionPath){
 return {
  async query(sql){
   const data=JSON.parse(await wrangler(['d1','execute',binding,'--remote','--config',config,'--command',sql,'--json'],true));
   if(data.length!==1||!data[0].success)throw Error('Unexpected D1 query result');return data[0].results;
  },
  async batch(statements){
   if(statements.some(s=>Buffer.byteLength(s)>95000))throw Error('Statement exceeds D1 import limit');
   const directory=await mkdtemp(path.join(root,'backups/storage-import-'));
   try{
    const file=path.join(directory,'copy.sql');await writeFile(file,statements.join(';\n')+';\n');
    // --file prints an import progress preamble even with --json. Exit status
    // plus read-back verification, rather than parsing that output, is used.
    await wrangler(['d1','execute',binding,'--remote','--config',config,'--file',file,'--json'],true);
   }finally{
    const absolute=path.resolve(directory),prefix=path.resolve(root,'backups')+path.sep+'storage-import-';
    if(!absolute.startsWith(prefix))throw Error('Import cleanup path escaped the workspace');
    await rm(absolute,{recursive:true,force:true});
   }
  }
 };
}
