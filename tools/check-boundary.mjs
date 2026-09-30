// ---------------------------------------------------------------------------
// check-boundary.mjs - FIX 1 validation: invisible boundary walls
//
// Test A: MAP BOUNDARY - drive N/S/E/W at max speed, confirm the car is
//         stopped BEFORE reaching the scene edge (Â±1600 m).
// Test B: ROAD CONFINEMENT - real Vehicle steering off the road, confirm the
//         soft kerb force + hard clamp keep the car inside the corridor.
// Test C: reports boundary wall positions + road-side wall count.
// Usage: node tools/check-boundary.mjs
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { Map as GameMap } from '../src/world/Map.js';
import { Vehicle } from '../src/game/Vehicle.js';
import { ROAD_LINES, pickSpawnRoad } from '../src/utils/roadLayout.js';
import { MAP_BOUND, KERB_SOFT, KERB_HARD, clampToMap } from '../src/utils/boundary.js';

let fail = 0;
const check = (name, cond, detail = '') => {
  if (!cond) fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' -> ' + detail : ''}`);
};

const scene = new THREE.Scene();
const map = new GameMap(scene);
map.build();

console.log('='.repeat(72));
console.log('FIX 1 - BOUNDARY WALL REPORT');
console.log('='.repeat(72));

// --- Map boundary wall positions (4 walls, square Â±MAP_BOUND) ---
const B = MAP_BOUND - 1.4; // effective car-centre limit (CAR_HALF)
console.log(`\nMAP BOUNDARY WALLS (square, ${MAP_BOUND * 2} m x ${MAP_BOUND * 2} m):`);
const walls = [
  { side: 'NORTH', axis: 'z', coord: -B },
  { side: 'SOUTH', axis: 'z', coord: +B },
  { side: 'WEST', axis: 'x', coord: -B },
  { side: 'EAST', axis: 'x', coord: +B },
];
for (const w of walls) {
  console.log(`  ${w.side.padEnd(6)} ${w.axis} = ${w.coord.toFixed(1).padStart(8)}   ` +
    `(${w.axis === 'z' ? 'x' : 'z'} ${-B}..${B})`);
}
console.log('  height: 2 m, invisible (collision only)   total: 4 walls');

// --- Road-side wall count + network extents ---
let segs = 0, sides = 0;
let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
for (const r of ROAD_LINES) {
  const n = Math.max(1, r.pts.length - 1);
  segs += n;
  sides += n * (r.hasSW ? 2 : 1);
  minX = Math.min(minX, r.minX); maxX = Math.max(maxX, r.maxX);
  minZ = Math.min(minZ, r.minZ); maxZ = Math.max(maxZ, r.maxZ);
}
console.log('\nROAD-SIDE COLLISION WALLS:');
console.log(`  roads:             ${ROAD_LINES.length}`);
console.log(`  wall segments:     ${segs}`);
console.log(`  road-side walls:   ${sides}  (2 per segment where a sidewalk exists)`);
console.log(`  network extent:    x ${minX.toFixed(0)}..${maxX.toFixed(0)}   z ${minZ.toFixed(0)}..${maxZ.toFixed(0)}`);
console.log(`  kerb tuning:       soft push at ${KERB_SOFT} m past edge, hard clamp at ${KERB_HARD} m`);
console.log(`  map.confinement:   ${map.confinement ? 'wired' : 'MISSING'}`);
console.log(`  boundaryWallCount: ${map.boundaryWallCount}`);

check('confinement index built', !!map.confinement);
check('road-side wall count > 1000', sides > 1000, `${sides}`);

// ---------------------------------------------------------------------------
// TEST A: map boundary - drive 4 directions at max speed (60 m/s)
// ---------------------------------------------------------------------------
// Isolates the MAP boundary from road confinement: no roads are involved,
// so only clampToMap can stop the car.
function driveTest(dx, dz, label) {
  // Simulate from the origin driving straight out at 60 m/s in 1 s steps.
  // FIX 2: ang bilang ng hakbang ay DINE-DERIVE sa MAP_BOUND. Ang dating
  // hard-coded 1700 ay para sa lumang 1600 m na limit; ngayon ang MAP_BOUND
  // ay 4500, kaya kailangan ng ~4600 hakbang - kung hindi, TUMATAPOS na ang
  // simulation bago pa maabot ng kotse ang pader.
  const p = new THREE.Vector3(0, 0, 0);
  const step = 1.0;
  const maxSteps = Math.ceil(MAP_BOUND / step) + 100;
  let hitWall = false;
  let steps = 0;
  for (let i = 0; i < maxSteps; i++) {
    p.x += dx * step;
    p.z += dz * step;
    steps = i + 1;
    if (clampToMap(p)) { hitWall = true; break; }
  }
  const stoppedAt = Math.max(Math.abs(p.x), Math.abs(p.z));
  console.log(`  ${label.padEnd(6)} drove ${(steps * step).toFixed(0).padStart(5)} m, ` +
    `stopped at ${stoppedAt.toFixed(1).padStart(7)} m  (edge ${MAP_BOUND})  ` +
    `${hitWall ? 'WALL HIT' : 'ESCAPED!'}`);
  check(`map boundary stops ${label.toLowerCase()}`, hitWall && stoppedAt < MAP_BOUND,
    `held at ${stoppedAt.toFixed(1)} m < ${MAP_BOUND} m`);
}

console.log('\nTEST A - MAP BOUNDARY (max speed, 4 directions):');
driveTest(0, -1, 'NORTH');
driveTest(0, 1, 'SOUTH');
driveTest(-1, 0, 'WEST');
driveTest(1, 0, 'EAST');

// ---------------------------------------------------------------------------
// TEST B: road confinement - real Vehicle steering off the road edge
// ---------------------------------------------------------------------------
console.log('\nTEST B - ROAD CONFINEMENT (real Vehicle, steering off the road):');

// FIX 2: ang dating pagpili ay "pinakamahabang primary/secondary" - sa Nangka
// iisang arteryal lang, pero sa buong Marikina ito ay ang 4,836 m na
// J. P. Rizal, na ang midpoint ay maaaring malayo sa sentro at tabi ng ibang
// kalsada (kaya ang confinement.query() ay sumusukat laban sa ibang kalsada -
// 4.02 m, isang marginal 0.02 m sa itaas ng 4.0 m na threshold ng test).
// Dito: isang arteryal na MALAMANG sa center ng mapa - ang aktuwal na
// sitwasyon ng pagmamaneho.
const spawnLine = pickSpawnRoad();
const testRoad = spawnLine && spawnLine.len > 120
  ? spawnLine
  : ROAD_LINES
    .filter((r) => (r.cls === 'primary' || r.cls === 'secondary') && r.len > 120)
    .sort((a, b) => b.len - a.len)[0];
const limit = testRoad.half + testRoad.swWidth;
console.log(`  road: "${testRoad.name}" [${testRoad.cls}] half=${testRoad.half} m ` +
  `+ sidewalk=${testRoad.swWidth} m -> limit=${limit} m`);

const mid = { x: testRoad.pts[Math.floor(testRoad.pts.length / 2)].x,
  z: testRoad.pts[Math.floor(testRoad.pts.length / 2)].z }; // plain object, hindi reference
// Alin ang kotse sa TUNAY na direksyon ng kalsada. Dati naka-hypothetical na
// heading = +z, kaya agad pumapalabas sa kalsada at naka-"stranded".
const idx = Math.floor(testRoad.pts.length / 2);
const prev = testRoad.pts[Math.max(0, idx - 1)];
const next = testRoad.pts[Math.min(testRoad.pts.length - 1, idx + 1)];
const heading = Math.atan2(next.x - prev.x, next.z - prev.z);
console.log(`  start (${mid.x.toFixed(1)}, ${mid.z.toFixed(1)}), ` +
  `heading ${(heading * 180 / Math.PI).toFixed(0)} deg (along road)`);

function runVehicle(steerRight, seconds) {
  const v = new Vehicle(scene);
  v.build(); // kailangan para may wheels
  v.setConfinement(map.confinement);
  v.position.set(mid.x, 0, mid.z);
  v.rotation = heading; // along the road tangent
  v.lastGoodRoad = { x: mid.x, z: mid.z };
  const input = { forward: true, backward: false, left: false, right: steerRight, handbrake: false };
  let maxOver = 0;
  const steps = Math.round(seconds * 60);
  for (let i = 0; i < steps; i++) {
    v.update(1 / 60, input); // signature: update(delta, input)
    const n = map.confinement.query(v.position.x, v.position.z);
    if (n) maxOver = Math.max(maxOver, n.dist - n.limit);
  }
  const n = map.confinement.query(v.position.x, v.position.z);
  return {
    v, maxOver,
    finalOver: n ? n.dist - n.limit : null, // null = walang kalsada sa 150 m
    // FIX: kinopya ang start posisyon - kung hindi, mag-a-add ng reference at
    // magiging NaN ang distansya (parehong object ang v.position at mid).
    moved: Math.hypot(v.position.x - mid.x, v.position.z - mid.z),
  };
}

// B1: steer hard right for 6 s -> should be pushed back onto the road
const b1 = runVehicle(true, 6);
const f1 = b1.finalOver === null ? 'STRANDED (no road within 150 m)' : `${b1.finalOver.toFixed(2)} m`;
console.log(`  steer off-road 6 s:  max excursion ${b1.maxOver.toFixed(2)} m past edge, final ${f1}`);
check('never passed the HARD clamp', b1.maxOver <= KERB_HARD + 1.5,
  `${b1.maxOver.toFixed(2)} m vs hard ${KERB_HARD} m`);
check('never stranded beyond search radius', b1.finalOver !== null, f1);
check('soft force returned it to the road', b1.finalOver !== null && b1.finalOver < KERB_SOFT + 2,
  `final ${f1}`);

// B2: long run (20 s) of continuous steering off the road - must not escape
const b2 = runVehicle(true, 20);
const f2 = b2.finalOver === null ? 'STRANDED' : `${b2.finalOver.toFixed(2)} m`;
console.log(`  steer off-road 20 s: max excursion ${b2.maxOver.toFixed(2)} m past edge, final ${f2}`);
check('sustained off-road steering stays confined',
  b2.maxOver <= KERB_HARD + 1.5 && b2.finalOver !== null, `max ${b2.maxOver.toFixed(2)} m, final ${f2}`);

// B3: normal in-road driving must be unimpeded
const b3 = runVehicle(false, 2);
const n3 = map.confinement.query(b3.v.position.x, b3.v.position.z);
console.log(`  in-road 2 s: moved ${b3.moved.toFixed(1)} m, offset ${(n3.dist - n3.limit).toFixed(2)} m, ` +
  `speed ${b3.v.getSpeedKmh()} km/h`);
check('in-road driving is unimpeded', b3.moved > 20 && n3.dist <= n3.limit + KERB_SOFT,
  `moved ${b3.moved.toFixed(1)} m`);

// B4: every road - sample points along the corridor must be "inside"
let sampled = 0, outside = 0;
for (const r of ROAD_LINES) {
  for (let i = 0; i < r.pts.length; i += 3) {
    const p = r.pts[i];
    const n = map.confinement.query(p.x, p.z);
    if (!n) { outside++; continue; }
    sampled++;
    if (n.dist > n.limit + 0.01) outside++;
  }
}
console.log(`  corridor sampling: ${sampled} centreline points, ${outside} outside their own road`);
check('all sampled road centrelines are inside their corridor', outside === 0, `${outside} bad`);

console.log('\n' + '='.repeat(72));
console.log(fail === 0 ? 'ALL BOUNDARY TESTS PASSED' : `${fail} TEST(S) FAILED`);
process.exit(fail === 0 ? 0 : 1);


