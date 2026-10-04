import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Buildings, ownsBuilding, obbOverlap, roofStyle } from '../src/world/Buildings.js';
import { mulberry32 } from '../src/utils/roadLayout.js';
import { ColoredMeshBuilder } from '../src/utils/coloredMesh.js';
import { Roads } from '../src/world/Roads.js';

const random = mulberry32(44), sample = new Map();
let gabled = 0;
for (let i = 0; i < 100000; i++) {
  const style = roofStyle(random);
  sample.set(style.color, (sample.get(style.color) || 0) + 1);
  if (style.gable) gabled++;
  if (style.color === 0xc8c8c8) assert.equal(style.gable, false);
}
for (const [color, fraction] of [[0x9b4a1a, .5], [0x8b2525, .25], [0xc8c8c8, .15], [0x4a6b8a, .1]]) {
  assert.ok(Math.abs(sample.get(color) / 100000 - fraction) < .01);
}
assert.ok(Math.abs(gabled / 100000 - .7) < .01);
console.log('Roof sampler proportions:', Object.fromEntries([...sample].map(([c, n]) => [c.toString(16), `${n / 1000}%`])), 'gabled', gabled / 1000 + '%');

const buildings = new Buildings(new THREE.Scene());
buildings.plan();
assert.ok(buildings.catalog.length > 0);
const cells = new Map();
for (const lot of buildings.catalog) {
  const e = lot.envelope;
  const cx = Math.floor(lot.x / 32), cz = Math.floor(lot.z / 32);
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
    for (const other of cells.get(`${cx + dx},${cz + dz}`) || []) assert.equal(obbOverlap(e, other.envelope), false, `${lot.id} overlaps ${other.id}`);
  }
  const key = `${cx},${cz}`;
  if (!cells.has(key)) cells.set(key, []);
  cells.get(key).push(lot);
}
assert.equal(ownsBuilding({ minX: 0, maxX: 100, minZ: 0, maxZ: 100 }, { x: 100, z: 50 }), false);
assert.equal(ownsBuilding({ minX: 100, maxX: 200, minZ: 0, maxZ: 100 }, { x: 100, z: 50 }), true);
const boxes = [{ minX: 200, maxX: 400, minZ: 600, maxZ: 800 }, { minX: 400, maxX: 600, minZ: 600, maxZ: 800 }];
const ids = buildings.catalog.filter(lot => boxes.some(b => ownsBuilding(b, lot))).map(lot => lot.id).sort();
for (const b of boxes) buildings.build(b, new THREE.Group());
assert.deepEqual(buildings.footprints.map(lot => lot.id).sort(), ids);
for (const b of [...boxes].reverse()) buildings.build(b, new THREE.Group());
assert.deepEqual(buildings.footprints.map(lot => lot.id).sort(), ids);
console.log(`Seams: ${buildings.catalog.length} city-wide lots, zero envelope overlaps; half-open ownership and reversed rebuild order passed.`);

// Render every catalog lot once for actual city-wide palette/detail statistics.
buildings.facadeCounts = { counters: 0, grilleStrips: 0, banners: 0, fences: 0, waterTanks: 0, airConditioners: 0 };
const roofs = new Map(); let houses = 0, shops = 0, gables = 0;
for (const lot of buildings.catalog) {
  const mesh = new ColoredMeshBuilder(), rnd = mulberry32(lot.seed);
  buildings.currentLot = lot;
  if (lot.shop) { buildings.addShop(mesh, lot, lot.w, lot.d, lot.h, lot.yaw, rnd, 0, lot.wall); shops++; }
  else { buildings.addHouse(mesh, lot, lot.w, lot.d, lot.h, lot.yaw, rnd, 0, lot.ri, lot.wall); houses++; gables += Number(lot.gable); roofs.set(lot.roof, (roofs.get(lot.roof) || 0) + 1); }
  assert.ok(mesh.pos.every(Number.isFinite));
}
assert.equal(buildings.facadeCounts.counters, shops * 2);
assert.ok(buildings.facadeCounts.banners >= shops && buildings.facadeCounts.banners <= shops * 2);
assert.equal(buildings.facadeCounts.fences, houses);
assert.ok(buildings.facadeCounts.waterTanks > 0 && buildings.facadeCounts.airConditioners > 0);
console.log('Residential roofs:', Object.fromEntries([...roofs].map(([c, n]) => [c.toString(16), { count: n, percent: +(n / houses * 100).toFixed(2) }])));
console.log({ houses, shops, residentialGablePercent: +(gables / houses * 100).toFixed(2), facadeCounts: buildings.facadeCounts });
console.log('Priority 4 checks passed.');

const roads = new Roads(new THREE.Scene());
const surface = [], concrete = [];
const recorder = list => ({ quadFacing: (...args) => list.push(...args.slice(0, 4)) });
roads.addLotFill(recorder(surface), {
  half: 3, pts: [{ x: 0, z: 0 }, { x: 40, z: 0 }],
  profile: { shoulderWidth: 0, leftSidewalkWidth: 1.5, rightSidewalkWidth: 0 },
}, 0, () => false, recorder(concrete));
assert.ok(surface.length && concrete.length);
assert.ok(surface.every(p => Math.abs(p[2]) >= 5 && Math.abs(p[2]) <= 11));
assert.ok(concrete.every(p => Math.abs(p[2]) >= 3 && Math.abs(p[2]) <= 5));
console.log('Frontage bands verified: concrete within 0-2m of curb; compacted lots within 2-8m.');