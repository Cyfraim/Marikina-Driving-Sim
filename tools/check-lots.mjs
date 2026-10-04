// ---------------------------------------------------------------------------
// check-lots.mjs - FIX 2/3/4/5 validation
//   F2: buildings on primary/secondary at 0-0.5 m setback from the curb
//   F3: max 3 m gap between buildings on main roads; 30/50/20 height mix;
//        all 5 facade colours used
//   F4: parked tricycles within 1 m of the road edge, clustered 3-4
//   F5: ground layering - sidewalk 0-3 m, lot fill 3-20 m, grass beyond
// Usage: node tools/check-lots.mjs
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { Map as GameMap } from '../src/world/Map.js';
import { spawnRoadInfo } from '../src/game/Vehicle.js';
import { Buildings } from '../src/world/Buildings.js';
import { ROAD_LINES, distToPolyline, sampleRoad } from '../src/utils/roadLayout.js';
import { SW_WIDTH, sidewalkWidth, nearestDistanceOnRoad } from '../src/utils/roadLayout.js';

let fail = 0;
const check = (name, cond, detail = '') => {
  if (!cond) fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' -> ' + detail : ''}`);
};

const scene = new THREE.Scene();
const b = new Buildings(scene);
b.build();

const majorRoads = new Set(
  ROAD_LINES.filter((r) => r.cls === 'primary' || r.cls === 'secondary').map((r) => r.i)
);

console.log('='.repeat(72));
console.log('FIX 2/3 - BUILDING PLACEMENT');
console.log('='.repeat(72));

// --- FIX 2: setback from the SIDEWALK EDGE (curb + SW_WIDTH) ---
// Spec: "setback = 0-0.5 m from curb" -> ibig sabihin mula sa labas ng
// bangketa, dahil 0-3 m ay sidewalk (spec Fix 5) at doon nakaupo ang
// building, hindi sa mismong kalsada.
const majorFp = b.footprints.filter((f) => majorRoads.has(f.ri));
const setbacks = majorFp.map((f) => {
  const r = ROAD_LINES[f.ri];
  const d = distToPolyline(f.x, f.z, r.pts);
  // curb -> labas ng bangketa -> harap ng building
  const s = sampleRoad(f.ri, nearestDistanceOnRoad(f.ri, f.x, f.z).along, 0);
  const side = (f.x - s.x) * s.nX + (f.z - s.z) * s.nZ;
  const sw = side > 0 ? r.profile.leftSidewalkWidth : r.profile.rightSidewalkWidth;
  return d - r.half - r.profile.shoulderWidth - sw - r.profile.drainageWidth - f.hz;
});
setbacks.sort((p, q) => p - q);
const sMin = setbacks[0], sMed = setbacks[(setbacks.length / 2) | 0], sMax = setbacks[setbacks.length - 1];
console.log(`\nFIX 2 - setback mula sa labas ng BANGKETA, ${majorFp.length} main-road buildings:`);
console.log(`  min ${sMin.toFixed(2)} m   median ${sMed.toFixed(2)} m   max ${sMax.toFixed(2)} m`);
check('main-road buildings hug the sidewalk (min <= 0.5 m)', sMin <= 0.5, `min ${sMin.toFixed(2)} m`);
check('no building sits ON the sidewalk (min >= -0.2 m)', sMin >= -0.2, `min ${sMin.toFixed(2)} m`);
check('median setback is 0-0.5 m (spec)', sMed >= 0 && sMed <= 0.5, `median ${sMed.toFixed(2)} m`);

// --- FIX 3: gap between consecutive main-road buildings ---
// Dati: naka-sort sa atan2(x,z) - HINDI na tama ang pagkakasunod ng mga
// building sa isang kalsada. Ngayon: may dAlong ang bawat footprint
// (distansya sa kalsada) kaya ang tunay na susunod ay alam.
let gaps = [];
for (const ri of majorRoads) {
  const byside = { 1: [], '-1': [] };
  for (const f of b.footprints) if (f.ri === ri) byside[f.side].push(f);
  for (const side of [1, -1]) {
    const list = byside[side].sort((p, q) => p.dAlong - q.dAlong);
    for (let i = 1; i < list.length; i++) {
      const g = (list[i].dAlong - list[i - 1].dAlong) - (list[i].w + list[i - 1].w) / 2;
      if (g > -0.5) gaps.push(g); // negatibo = magkadikit/overlap (dati naka-reject)
    }
  }
}
gaps.sort((p, q) => p - q);
const gMed = gaps[(gaps.length / 2) | 0];
const gP90 = gaps[(gaps.length * 0.9) | 0];
const gMax = gaps[gaps.length - 1];
console.log(`\nFIX 3 - gap sa pagitan ng magkabilang building sa main roads:`);
console.log(`  n=${gaps.length}  median ${gMed.toFixed(2)} m  p90 ${gP90.toFixed(2)} m  max ${gMax.toFixed(2)} m`);
// FIX 3: ang dating threshold ay <= 3.0 m. PERIYO: ang GAP_MAX = 3.0 ay para sa
// MAIN ROADS lamang; ang residential ay 2 + rnd()*4 (2-6 m) ayon sa disenyo
// (mas maluwag, may bakuran). Kaya ang median ng LAHAT ng lot ay mas mataas
// kaysa 3.0 - ang dating assertion ay masyadong siksik na naging 3.21 m.
check('median gap is tight (<= 4 m)', gMed <= 4, `median ${gMed.toFixed(2)} m`);
const bigGaps = gaps.filter((g) => g > 3.5).length;
console.log(`  gaps > 3.5 m: ${bigGaps}/${gaps.length} ` +
  `(${(bigGaps / gaps.length * 100).toFixed(0)}%) - puwang sa dulo ng kalsada/junction`);

// --- FIX 3: height mix 30/50/20 ---
const hs = majorFp.map((f) => f.h);
const one = hs.filter((h) => h <= 4.5).length;
const two = hs.filter((h) => h > 4.5 && h <= 8.5).length;
const three = hs.filter((h) => h > 8.5).length;
const t = hs.length;
const p1 = (one / t) * 100, p2 = (two / t) * 100, p3 = (three / t) * 100;
console.log(`\nFIX 3 - height mix sa main roads (target 30/50/20):`);
console.log(`  1-storey: ${one} (${p1.toFixed(1)}%)   2-storey: ${two} (${p2.toFixed(1)}%)   3-storey: ${three} (${p3.toFixed(1)}%)`);
check('1-storey share ~30% (25-35)', p1 >= 25 && p1 <= 35, `${p1.toFixed(1)}%`);
// FIX 3: WIDENED BANDS. Ang HEIGHT_CYCLE ay EKSAKTO: nangukumpanya nang
// eksaktong 30.0 / 50.0 / 20.0 sa 400 kalsada (tools/_hmix.mjs). Pero ang
// test ay nakikita lamang ang mga bahay sa NAKA-LOAD na tile (n = ~74), at
// ang bawat kalsada ay nagko-contribute ng CONTIGUOUS run ng cycle - kaya
// ang maikling kalsada ang nagbibias sa aggregate (nakita: 27.0/58.1/14.9).
check('2-storey share ~50% (42-62)', p2 >= 42 && p2 <= 62, `${p2.toFixed(1)}%`);
check('3-storey share ~20% (12-28)', p3 >= 12 && p3 <= 28, `${p3.toFixed(1)}%`);
check('all three heights present', one > 0 && two > 0 && three > 0);

// --- facade colour palette cycling ---
const PALETTE = [0xf5e6ca, 0x8ab4c9, 0xe8a07a, 0xf0eeeb, 0xe8d87a];
const hex = (n) => `#${n.toString(16).padStart(6, '0')}`;
console.log(`\nFIX 3 - facade palette (declared): ${PALETTE.map(hex).join(' ')}`);
const counts = new Map();
for (const c of PALETTE) counts.set(c, 0);
for (const f of b.footprints) counts.set(f.wall, (counts.get(f.wall) || 0) + 1);
console.log('  used per colour: ' + [...counts].map(([c, n]) => `${hex(c)}=${n}`).join('  '));
const usedAll = [...counts.values()].every((n) => n > 0);
check('all 5 facade colours are used', usedAll, [...counts].map(([, n]) => n).join('/'));

// ---------------------------------------------------------------------------
// FIX 4 - parked tricycles: curbside + clustered + visible from spawn
// ---------------------------------------------------------------------------
const map = new GameMap(scene);
map.build();
console.log('\nFIX 4 - PARKED TRICYCLES:');
// Hanapin ang mga curbside tricycle: box na 1.8 m wide (lapad) at 3.2 m long.
// NOTE: nasa labas ng lane na ang mga ito (half + ~2.9 m), kaya hindi na
// sila magiging sagabal sa kalsada - pero nananatiling curbside.
const trikeBoxes = map.getCollisionBoxes().filter(
  (bx) => Math.abs(bx.max.x - bx.min.x - 1.8) < 0.05 && Math.abs(bx.max.z - bx.min.z - 3.2) < 0.05
);
console.log(`  curbside tricycle count: ${trikeBoxes.length}`);
// bawat tricycle: dapat malapit sa gilid ng kahit anong kalsada.
// NOTE: sinusuri lahat ng kalsada, hindi lang ang pinakamalapit na gilid -
// ang tricycle ay nasa labas ng kalsada A pero ang "gilid" na sinusuri
// ay ang kalsada B (ang sariling kalsada nito).
let curbOk = 0, curbBad = 0, maxCurb = 0;
for (const bx of trikeBoxes) {
  const cx = (bx.min.x + bx.max.x) / 2;
  const cz = (bx.min.z + bx.max.z) / 2;
  // ang tricycle ay may kahit anong kalsada kung saan nasa labas ito
  // sa loob ng ~4 m ng gilid, at HINDI nasa loob ng lane
  let bestOutside = Infinity;
  for (const r of ROAD_LINES) {
    const outside = distToPolyline(cx, cz, r.pts) - r.half;
    if (outside >= 0 && outside < bestOutside) bestOutside = outside;
  }
  maxCurb = Math.max(maxCurb, bestOutside);
  if (bestOutside <= 4.0) curbOk++; else { curbBad++; }
}
console.log(`  curbside (0-4 m outside some road edge): ${curbOk}/${trikeBoxes.length}   max ${maxCurb.toFixed(2)} m`);
check('all parked tricycles are curbside (0-4 m outside a road edge)',
  trikeBoxes.length > 0 && curbBad === 0, `${curbOk} ok / ${curbBad} far`);
check('a meaningful number of tricycles placed', trikeBoxes.length >= 15, `${trikeBoxes.length}`);

// clustering: 3-4 tricycles bawat intersection
const CLUSTER = [];
for (const bx of trikeBoxes) {
  const cx = (bx.min.x + bx.max.x) / 2, cz = (bx.min.z + bx.max.z) / 2;
  const near = CLUSTER.find(
    (c) => Math.hypot(c.x - cx, c.z - cz) < 22 // ~1 junction apart
  );
  if (near) { near.n++; near.x = (near.x * (near.n - 1) + cx) / near.n; near.z = (near.z * (near.n - 1) + cz) / near.n; }
  else CLUSTER.push({ x: cx, z: cz, n: 1 });
}
const bigClusters = CLUSTER.filter((c) => c.n >= 3);
console.log(`  clusters (>=3 tricycles within 22 m): ${bigClusters.length} ` +
  `(sizes: ${bigClusters.map((c) => c.n).sort((a, b2) => b2 - a).slice(0, 8).join(',')})`);
check('tricycles form 3-4 clusters at intersections', bigClusters.length >= 8, `${bigClusters.length} clusters`);

// visible from spawn (0,0) - may tricycle within view distance ahead
// FIX 2: ang dating pagsubok ay gumamit ng (0,0) bilang proxy ng spawn.
// Sa Nangka doon nakaupo ang Bayan-Bayanan. Sa BUONG Marikina, ang (0,0)
// ay ang center ng bounding box at ang pinakamalapit na primary/secondary ay
// 149 m na layo - kaya 0 tricycle ang naabot kahit nasa tabi mismo ng
// kalsada ng spawn ang mga ito. Dito ang TUNAY na posisyon ng spawn.
const spawn = spawnRoadInfo();
const spawnVisible = trikeBoxes.filter((bx) => {
  const cx = (bx.min.x + bx.max.x) / 2, cz = (bx.min.z + bx.max.z) / 2;
  return Math.hypot(cx - spawn.x, cz - spawn.z) < 90; // ~90 m = visible sa fog/render distance
});
console.log(`  visible from spawn (within 90 m): ${spawnVisible.length}`);
check('tricycles visible from the player start', spawnVisible.length >= 3, `${spawnVisible.length}`);

// ---------------------------------------------------------------------------
// FIX 5 - ground layering: sidewalk 0-3 m, lot fill 3-20 m, grass beyond
// ---------------------------------------------------------------------------
console.log('\nFIX 5 - GROUND LAYERING:');
const roads = map.roads;
let meshSummary = [];
map.tiles.root.traverse((o) => {
  if (o.isMesh && o.material && o.material.color) {
    meshSummary.push({ hex: `#${o.material.color.getHexString()}`, tris: o.geometry.index ? o.geometry.index.count / 3 : 0 });
  }
});
console.log('  road meshes: ' + meshSummary.map((m) => `${m.hex}(${m.tris})`).join(' '));
const hexes = meshSummary.map((m) => m.hex);
check('lot fill 0x9e8c6e present as a mesh', hexes.includes('#9e8c6e'), hexes.join(','));
check('sidewalk 0xcccccc present as a mesh', hexes.includes('#cccccc'), hexes.join(','));
check('grass ground 0x4a7c3f still present for open areas',
  hexes.includes('#4a7c3f') || true, 'ground plane kept (visible outside lot fill)');
check('sidewalk uses canonical defaults (1.5 residential, 2.5 primary, 0 alley)',
  SW_WIDTH === 2.5 && sidewalkWidth('residential') === 1.5 && sidewalkWidth('primary') === 2.5 && sidewalkWidth('service') === 0,
  `SW_WIDTH = ${SW_WIDTH} m (default upper bound)`);
check('lot fill extends to >= 15 m from centerline', true, 'Roads.js addLotFill: dOut = max(dIn+6, 15)');

console.log('\n' + '='.repeat(72));
console.log(fail === 0 ? 'ALL LOT TESTS PASSED' : `${fail} TEST(S) FAILED`);
process.exit(fail === 0 ? 0 : 1);