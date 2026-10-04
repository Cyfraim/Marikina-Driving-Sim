import assert from 'node:assert/strict';
import * as THREE from 'three';
import { RIVERS } from '../src/world/riverData.js';
import { RIVER_SEGMENTS, WATER_Y, BANK_HEIGHT, riverDistance, clipPolygon } from '../src/utils/riverGeometry.js';
import { terrainHeight, TERRAIN_MAX, gpsToLocal, localToGps } from '../src/utils/geo.js';
import { LANDMARKS, SPAWN_GPS } from '../src/world/landmarkData.js';
import { River } from '../src/world/River.js';
import { Landmarks } from '../src/world/Landmarks.js';
import { TileManager, tileBounds } from '../src/world/tiles.js';
import { spawnRoadInfo } from '../src/game/Vehicle.js';
import { ROAD_LINES, distToPolyline, reservedGeography } from '../src/utils/roadLayout.js';

const sourcePoints = RIVERS.reduce((n, r) => n + r.pts.length, 0);
assert.equal(sourcePoints, 158);
assert.equal(RIVERS.length, 19);
assert.ok(RIVERS.every(r => r.width >= 60 && r.width <= 80));
const river = new River();
let waterVertices = 0;
for (const s of RIVER_SEGMENTS) {
  const bounds = tileBounds(Math.floor(s.a.x / 400), Math.floor(s.a.z / 400));
  const group = new THREE.Group(); river.build(bounds, group);
  group.traverse(o => {
    if (!o.isMesh) return;
    const pos = o.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      assert.ok(pos.getX(i) >= bounds.minX - 0.001 && pos.getX(i) <= bounds.maxX + 0.001);
      assert.ok(pos.getZ(i) >= bounds.minZ - 0.001 && pos.getZ(i) <= bounds.maxZ + 0.001);
      assert.ok(Number.isFinite(pos.getY(i)));
      if (o.name.endsWith('water')) { assert.ok(Math.abs(pos.getY(i) - WATER_Y) < 1e-6); waterVertices++; }
      else assert.ok(Math.abs(pos.getY(i) - WATER_Y) < 1e-6 || Math.abs(pos.getY(i) - WATER_Y - BANK_HEIGHT) < 1e-6);
    }
  });
  const p = { x: (s.a.x + s.b.x) / 2, z: (s.a.z + s.b.z) / 2 };
  assert.equal(terrainHeight(p.x, p.z), 0);
  assert.ok(riverDistance(p.x, p.z).centerDistance < 1e-6);
}
assert.ok(waterVertices > 0);
const polygon = [{ x: -10, z: -10 }, { x: 10, z: -10 }, { x: 10, z: 10 }, { x: -10, z: 10 }];
assert.equal(clipPolygon(polygon, { minX: 0, maxX: 10, minZ: -10, maxZ: 10 }).length, 4);
console.log(`PASS real OSM river: ${RIVERS.length} ways, ${sourcePoints} points; clipped filled geometry and bank heights`);

let min = Infinity, max = -Infinity;
for (let x = -4800; x <= 4800; x += 40) for (let z = -4800; z <= 4800; z += 40) {
  const y = terrainHeight(x, z); min = Math.min(min, y); max = Math.max(max, y);
  assert.ok(y >= 0 && y <= TERRAIN_MAX);
}
assert.ok(max - min <= 3);
console.log(`PASS terrain min=${min.toFixed(3)}m max=${max.toFixed(3)}m variation=${(max - min).toFixed(3)}m; zero noise`);

const landmarks = new Landmarks(new THREE.Scene()); landmarks.build();
assert.equal(landmarks.positions.length, 4);
for (const data of LANDMARKS) {
  const p = landmarks.positions.find(l => l.id === data.id), expected = gpsToLocal(...data.gps);
  assert.equal(p.x, expected.x); assert.equal(p.z, expected.z);
  assert.ok(p.width <= data.width && p.depth <= data.depth);
  for (const road of ROAD_LINES) {
    const clearance = distToPolyline(p.x, p.z, road.pts) - road.half;
    assert.ok(Math.hypot(p.width, p.depth) / 2 < clearance,
      `${data.id} model must not overlap ${road.name || road.cls}`);
  }
  assert.ok(reservedGeography(p.x, p.z));
  const inverse = localToGps(p.x, p.z);
  assert.ok(Math.abs(inverse.lat - data.gps[0]) < 1e-9 && Math.abs(inverse.lon - data.gps[1]) < 1e-9);
  console.log(`${data.id}: GPS ${data.gps.join(', ')} -> x=${p.x.toFixed(3)} z=${p.z.toFixed(3)}`);
}
assert.equal(landmarks.collisionBoxes.length, 0, 'rotated landmarks use OBBs, not oversized AABBs');
assert.equal(landmarks.obbColliders.length, 5);
const spawn = spawnRoadInfo(), request = gpsToLocal(...SPAWN_GPS);
assert.equal(spawn.road, 'Bayan-Bayanan Avenue');
assert.ok(distToPolyline(spawn.x, spawn.z, ROAD_LINES[spawn.ri].pts) < 1e-6);
assert.ok(Math.hypot(spawn.x - request.x, spawn.z - request.z) < 30);
console.log(`PASS road-snapped spawn: x=${spawn.x.toFixed(3)} z=${spawn.z.toFixed(3)}, adjustment=${Math.hypot(spawn.x - request.x, spawn.z - request.z).toFixed(3)}m`);

const tiles = new TileManager(new THREE.Scene(), { roads: { build() {} }, river });
const s = RIVER_SEGMENTS[30];
for (let i = 0; i < 100 && (i === 0 || tiles.pending); i++) tiles.update(s.a.x, s.a.z);
assert.ok([...tiles.tiles.values()].some(t => t.group.children[0].children.some(m => m.name === 'Marikina River water')));
let disposed = false;
const oldTile = [...tiles.tiles.values()].find(t => t.group.children[0].children.length);
oldTile.group.children[0].children[0].geometry.addEventListener('dispose', () => { disposed = true; });
tiles.update(10000, 10000);
assert.ok(disposed, 'river GPU geometry must be disposed on tile unload');
console.log('PASS river tile streaming and disposal');