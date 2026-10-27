// Anonymous HTTP verification, independent of SteamUGC's preview count.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath,pathToFileURL} from 'node:url';
import path from 'node:path';
const workshop=fileURLToPath(new URL('../workshop/',import.meta.url));
const imageOrigin='https://images.steamusercontent.com';
function imageUrl(value){
 const u=new URL(value.replaceAll('&amp;','&'));
 assert.equal(u.origin,imageOrigin,'Unexpected public image host');
 assert.match(u.pathname,/^\/ugc\/\d+\/[A-Fa-f0-9]{40}\/$/,'Unexpected image path');
 return u;
}
export function parseGallery(html,previews){
 assert.equal(previews.length,5,'Expected five approved screenshots');
 const ids=[...html.matchAll(/<img\b[^>]*\bid="previewImage(\d+)"/g)].map(m=>m[1]);
 assert.equal(ids.length,5,'Public page does not contain all five gallery images');
 assert.equal(new Set(ids).size,5,'Duplicate gallery slots');
 const map=html.match(/var rgScreenshotURLs\s*=\s*\{([\s\S]*?)\};/)?.[1]??'';
 const urls=new Map([...map.matchAll(/'(\d+)'\s*:\s*'(https:[^']+)'/g)].map(m=>[m[1],m[2]]));
 const thumbs=[...html.matchAll(/id="thumb_screenshot_(\d+)"[^>]*>\s*<img\b[^>]*src="([^"]+)"/g)];
 assert.deepEqual(thumbs.map(m=>m[1]),ids,'Public thumbnail order differs');
 return previews.map((p,i)=>{
  const original=imageUrl(p.url),display=imageUrl(urls.get(ids[i])??''),thumb=imageUrl(thumbs[i][2]);
  assert.equal(display.pathname,original.pathname,'Public image differs from verified registration');
  assert.equal(thumb.pathname,original.pathname,'Thumbnail differs from verified registration');
  return {filename:p.filename,id:ids[i],original:original.href,display:display.href,thumbnail:thumb.href};
 });
}
async function request(url){
 const r=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(20000),headers:{'Cache-Control':'no-cache'}});
 assert.equal(r.status,200,`Public request failed: ${url}`);return r;
}
async function imageExists(url){
 const r=await request(url);assert.match(r.headers.get('content-type')??'',/^image\//);
 const bytes=new Uint8Array(await r.arrayBuffer());
 assert(bytes.length>1000&&bytes[0]===0xff&&bytes[1]===0xd8,'Missing or invalid JPEG');
 return bytes.length;
}
export async function check(){
 const statePath=path.join(workshop,'publish-state.json');
 const state=JSON.parse(await readFile(statePath,'utf8'));
 assert.match(state.itemId,/^\d+$/);
 const url=`https://steamcommunity.com/sharedfiles/filedetails/?id=${state.itemId}&l=english`;
 let proof,error;
 for(let attempt=1;attempt<=3;attempt++){
  try{
   const html=await(await request(url)).text(),images=parseGallery(html,state.verifiedGallery);
   for(const image of images){
    // Check each original and both public sizes; a valid original alone is insufficient.
    image.bytes=await Promise.all([image.original,image.display,image.thumbnail].map(imageExists));
   }
   proof={checkedAt:new Date().toISOString(),itemId:state.itemId,url,anonymous:true,images,
    result:'passed',check:'Public HTML registration and image responses; visual browser check remains required.'};
   break;
  }catch(e){error=e;if(attempt<3)await new Promise(r=>setTimeout(r,5000));}
 }
 if(!proof){
  await writeFile(path.join(workshop,'public-gallery-latest.json'),JSON.stringify({checkedAt:new Date().toISOString(),result:'failed',reason:error.message},null,2));
  throw error;
 }
 state.publicGalleryCheckRequired=false;state.publicGalleryVerifiedAt=proof.checkedAt;
 await writeFile(statePath,JSON.stringify(state,null,2));
 await writeFile(path.join(workshop,'public-gallery-latest.json'),JSON.stringify(proof,null,2));
 console.log(`Public gallery passed: ${proof.images.length} screenshots and thumbnails, ${proof.checkedAt}`);
 return proof;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)await check();
