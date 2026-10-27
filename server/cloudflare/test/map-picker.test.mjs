import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Script } from 'node:vm';
import { mapCoordinates, mapPoint, mapViewport } from '../src/map-picker.js';
import { battlefieldMaps } from '../src/battlefield-maps.js';
import { battlefields } from '../src/battlefields.js';
import { adminPage } from '../src/admin-page.js';

test('map corners, fractional clicks and north-up orientation match custom battle coordinates', () => {
  for (const map of battlefields) {
    assert.deepEqual(mapCoordinates(map, 0, 1000), { east: 0, north: 0 });
    assert.deepEqual(mapCoordinates(map, 1000, 0), { east: map.eastMax, north: map.northMax });
    assert.deepEqual(mapCoordinates(map, 0, 0), { east: 0, north: map.northMax });
    assert.deepEqual(mapCoordinates(map, 1000, 1000), { east: map.eastMax, north: 0 });
    assert.deepEqual(mapCoordinates(map, 250, 750), { east: map.eastMax / 4, north: map.northMax / 4 });
    const point = mapPoint(map, 5.25, 6.75);
    assert.deepEqual(mapCoordinates(map, point.x, point.y), { east: 5.25, north: 6.75 });
  }
});

test('invalid numeric fields and clicks outside map never silently clamp into a saved location', () => {
  for (const map of battlefields) {
    for (const point of [[-1,0],[0,-1],[1001,500],[NaN,20],[10,Infinity]])
      assert.equal(mapCoordinates(map, ...point), null);
    for (const point of [[-1,0],[0,-1],[map.eastMax+.001,2],[NaN,2],[null,2],['1',2]])
      assert.equal(mapPoint(map, ...point), null);
  }
});

test('zoomed viewport preserves world coordinates at both edges and at a fractional selection', () => {
  for (const map of battlefields) for (const zoom of [1,2,4,8]) for (const [east,north] of [[0,0],[map.eastMax,map.northMax],[5.25,6.75]]) {
    const view = mapViewport(map, east, north, zoom), point = mapPoint(map, east, north);
    assert.equal(view.size, 1000 / zoom);
    assert.ok(view.x >= 0 && view.y >= 0 && view.x + view.size <= 1000 && view.y + view.size <= 1000);
    const screenX = (point.x-view.x)/view.size, screenY = (point.y-view.y)/view.size;
    assert.ok(screenX >= -1e-10 && screenX <= 1+1e-10 && screenY >= -1e-10 && screenY <= 1+1e-10);
    assert.deepEqual(mapCoordinates(map, view.x + screenX*view.size, view.y + screenY*view.size), {east,north});
  }
});

test('bundled maps have valid PNGs and bounds matching the two native FTD world-switch probes', () => {
  for (const map of battlefields) {
    const asset = battlefieldMaps[map.id], bytes = Buffer.from(asset.image.split(',')[1], 'base64');
    assert.equal(bytes.subarray(0,8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(bytes.readUInt32BE(16), asset.width); assert.equal(bytes.readUInt32BE(20), asset.height);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), asset.imageSha256);
    assert.equal(asset.eastMax,map.eastMax); assert.equal(asset.northMax,map.northMax);
    assert.equal(asset.endX-asset.originX,map.eastMax*map.tileSize);
    assert.equal(asset.endZ-asset.originZ,map.northMax*map.tileSize);
    const [east,north,x,z] = map.id==='neter' ? [2.25,3.75,-37120,-29440] : [5.25,6.75,-1280,6400];
    assert.equal(asset.originX+east*map.tileSize,x); assert.equal(asset.originZ+north*map.tileSize,z);
  }
  assert.notEqual(battlefieldMaps.neter.imageSha256,battlefieldMaps.aote.imageSha256);
});

test('admin page includes self-contained maps, keyboard controls and valid browser script under CSP', async () => {
  const response=adminPage(),html=await response.text();
  assert.match(response.headers.get('Content-Security-Policy'), /img-src data:/);
  assert.match(html, /id="battlefieldMap"/); assert.match(html, /id="mapZoom"/);
  assert.match(html, /getScreenCTM/); assert.match(html, /ArrowUp/);
  assert.equal((html.match(/data:image\/png;base64,/g)||[]).length,2);
  for (const script of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) new Script(script[1]);
});
