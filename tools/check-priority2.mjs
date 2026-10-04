import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createRoadProfile, canRunTraffic, canPark } from '../src/utils/RoadProfile.js';
import { ROAD_LINES } from '../src/utils/roadLayout.js';
import { ROADS } from '../src/world/roadData.js';
import { Roads } from '../src/world/Roads.js';
import { RoadGraph } from '../src/utils/RoadGraph.js';
import { RoadConfinement } from '../src/utils/boundary.js';
import * as THREE from 'three';

const narrow = createRoadProfile({ highway: 'residential', width: '5.5 m' });
assert.equal(narrow.carriageWidth, 5.5);
assert.equal(narrow.leftSidewalkWidth, 1.5);
assert.equal(narrow.parkingWidth, 0);
assert.equal(canRunTraffic({ profile: narrow }), false);
assert.equal(canPark({ profile: narrow }), false);
const primary = createRoadProfile({ highway: 'primary', lanes: '4', drainage: 'canal', oneway: 'yes' });
assert.equal(primary.carriageWidth, 14);
assert.equal(primary.laneCount, 4);
assert.equal(primary.leftSidewalkWidth, 2.5);
assert.equal(primary.shoulderWidth, 0.5);
assert.equal(primary.drainageWidth, 0.6);
assert.equal(primary.isOneWay, true);
assert.equal(createRoadProfile({ highway: 'service' }).leftSidewalkWidth, 0);
assert.equal(createRoadProfile({ highway: 'primary', sidewalk: 'left' }).rightSidewalkWidth, 0);
assert.equal(createRoadProfile({ highway: 'primary', junction: 'roundabout' }).isOneWay, true);
console.log('PASS profile defaults, tags, narrow-road restrictions');

const renderer = new Roads(new THREE.Scene());
for (const line of ROAD_LINES) {
  assert.equal(line.half * 2, ROADS[line.i].profile.carriageWidth);
  assert.equal(line.nodeIds.length, line.pts.length);
}
// Rendering pre-converts the same source; inspect the actual ribbon half widths.
assert.equal(renderer.roads.length, ROAD_LINES.length);
for (const r of renderer.roads) assert.equal(r.half * 2, r.profile.carriageWidth);
const confinement = new RoadConfinement([{ i: 0, half: 100, profile: narrow,
  pts: [{ x: 0, z: 0 }, { x: 20, z: 0 }] }], { search: 5 });
const seg = [...confinement.grid.values()][0][0];
assert.ok(seg.limit < 4, 'confinement must use profile, not stale half-width');
console.log(`PASS shared road dimensions: ${ROAD_LINES.length} roads, zero width mismatches`);

const testLine = (i, ids, pts, isOneWay = false) => ({ i, name: '', nodeIds: ids, pts, profile: { isOneWay } });
const directed = new RoadGraph([testLine(0, [1, 2], [{ x: 0, z: 0 }, { x: 20, z: 0 }], true)]);
assert.ok(directed.findPath(0, 0, 20, 0));
assert.equal(directed.findPath(20, 0, 0, 0), null);
const separate = new RoadGraph([
  testLine(0, [1, 2], [{ x: 0, z: 0 }, { x: 20, z: 0 }]),
  testLine(1, [3, 4], [{ x: 0, z: 1 }, { x: 20, z: 1 }]),
]);
assert.equal(separate.nodeCount, 4, 'nearby carriageways must not be merged');
console.log('PASS one-way pathfinding and distinct nearby OSM nodes');

const dir = mkdtempSync(join(tmpdir(), 'nangka-topology-'));
try {
  const fixture = join(dir, 'input.json'), output = join(dir, 'output.mjs');
  const point = (lat, lon) => ({ lat, lon });
  writeFileSync(fixture, JSON.stringify({ elements: [
    { type: 'way', id: 10, nodes: [1, 2, 3], tags: { highway: 'primary', name: 'A', oneway: '-1', bridge: 'yes', layer: '1' },
      geometry: [point(14.65, 121.10), point(14.65, 121.101), point(14.65, 121.102)] },
    { type: 'way', id: 11, nodes: [4, 2, 5], tags: { highway: 'primary', name: 'B', tunnel: 'yes', layer: '-1', junction: 'roundabout' },
      geometry: [point(14.649, 121.101), point(14.65, 121.101), point(14.651, 121.101)] },
  ] }));
  execFileSync(process.execPath, [fileURLToPath(new URL('./generate-road-data.mjs', import.meta.url)), '--in', fixture, '--out', output]);
  const result = await import(pathToFileURL(output));
  assert.equal(result.ROADS.length, 4);
  for (const r of result.ROADS) assert.ok(r.nodeIds[0] === 2 || r.nodeIds.at(-1) === 2);
  assert.deepEqual(result.ROADS[0].nodeIds, [2, 1]);
  assert.equal(result.ROADS[0].oneway, '-1');
  assert.equal(result.ROADS[0].bridge, 'yes');
  assert.equal(result.ROADS[0].layer, 1);
  assert.equal(result.ROADS[2].tunnel, 'yes');
  assert.equal(result.ROADS[2].junction, 'roundabout');
  assert.equal(result.ROADS[2].profile.isOneWay, true);
} finally { rmSync(dir, { recursive: true, force: true }); }
console.log('PASS generator junction splitting, original IDs, reverse-oneway normalization, bridge/tunnel/layer/roundabout tags');