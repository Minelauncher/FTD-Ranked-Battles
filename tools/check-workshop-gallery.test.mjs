import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseGallery} from './check-workshop-gallery.mjs';
const previews=Array.from({length:5},(_,i)=>({filename:`${i}.jpg`,url:`https://images.steamusercontent.com/ugc/${i+1}/${'A'.repeat(40)}/`}));
const html=previews.map((p,i)=>`<img id="previewImage${i+1}"><div id="thumb_screenshot_${i+1}"><img src="${p.url}?imw=116"></div>`).join('')+
 'var rgScreenshotURLs = {'+previews.map((p,i)=>`'${i+1}':'${p.url}?imw=637'`).join(',')+'};';
test('five real registrations in matching order pass',()=>assert.equal(parseGallery(html,previews).length,5));
test('SDK count five with empty public gallery fails',()=>assert.throws(()=>parseGallery('var rgScreenshotURLs={};',previews),/all five/));
test('missing thumbnail fails',()=>assert.throws(()=>parseGallery(html.replace('thumb_screenshot_3','removed'),previews),/thumbnail/));
test('stale public URL fails despite five slots',()=>assert.throws(()=>parseGallery(html.replace("'3':'https://images.steamusercontent.com/ugc/3/","'3':'https://images.steamusercontent.com/ugc/99/"),previews),/registration/));
test('untrusted image URL is not fetched',()=>assert.throws(()=>parseGallery(html.replace('https://images.steamusercontent.com','https://example.com'),previews),/host/));
