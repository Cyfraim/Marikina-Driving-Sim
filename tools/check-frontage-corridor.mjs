import assert from 'node:assert/strict';
import * as THREE from 'three';
import { headingFromRoadNormal, ROAD_LINES } from '../src/utils/roadLayout.js';
import { Buildings } from '../src/world/Buildings.js';

for (const angle of [0, Math.PI / 2, Math.PI, -Math.PI / 2, .73, -2.1]) {
  const tangent = { x: Math.sin(angle), z: Math.cos(angle) };
  const normal = { x: -tangent.z, z: tangent.x };
  const heading = headingFromRoadNormal(normal);
  assert.ok(Math.abs(Math.sin(heading) - tangent.x) < 1e-12);
  assert.ok(Math.abs(Math.cos(heading) - tangent.z) < 1e-12);
  // Car's width axis must align with road normal, not its 4.2m length axis.
  const lateralWidth = 2 * Math.abs(Math.cos(heading) * normal.x - Math.sin(heading) * normal.z)
    + 4.2 * Math.abs(Math.sin(heading) * normal.x + Math.cos(heading) * normal.z);
  assert.ok(Math.abs(lateralWidth - 2) < 1e-12);
}
console.log('PASS corridor car heading follows tangent; lateral car extent is 2m, not 4.2m.');

const buildings = new Buildings(new THREE.Scene());
buildings.plan();
const firstMinor = buildings.catalog.findIndex(lot => !['primary', 'secondary'].includes(ROAD_LINES[lot.ri].cls));
assert.ok(firstMinor > 0);
assert.ok(buildings.catalog.slice(firstMinor).every(lot => !['primary', 'secondary'].includes(ROAD_LINES[lot.ri].cls)));
assert.equal(new Set(buildings.catalog.map(lot => lot.id)).size, buildings.catalog.length);
console.log('PASS primary/secondary frontage planned before minor roads; stable lot IDs are unique.');