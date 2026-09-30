// ---------------------------------------------------------------------------
// find-stuck.mjs - DIAGNOSTIC: sanahan ang mga lugar na may "invisible wall"
//
// Drives the real Vehicle along every major road (following the road tangent,
// like a real player) and reports where the car gets stuck: speed collapses
// with no obstacle in sight.
//
// Reports, for each stop:
//  - which road the car was ON (its own corridor)
//  - what the confinement thought was "nearest" and its limit
//  - whether the nearest road was a DIFFERENT road (cross-road conflict)
// Usage: node tools/find-stuck.mjs
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { Map as GameMap } from '../src/world/Map.js';
import { Vehicle } from '../src/game/Vehicle.js';
import { ROAD_LINES, sampleRoad, distToPolyline } from '../src/utils/roadLayout.js';

const scene = new THREE.Scene();
const map = new GameMap(scene);
map.build();
const conf = map.confinement;

const roads = ROAD_LINES.filter(
  (r) => (r.cls === 'primary' || r.cls === 'secondary' || r.cls === 'tertiary') && r.len > 60
);
console.log(`Driving ${roads.length} major roads, looking for invisible walls...\n`);

const stuck = [];
for (const road of roads) {
  const ri = road.i;
  const ownLimit = road.half + road.swWidth;
  // step along the road
  for (let d = 6; d < road.len - 6; d += 3) {
    const s = sampleRoad(ri, d, 0); // on the centreline
    // what does the confinement think?
    const near = conf.query(s.x, s.z);
    if (!near) { stuck.push({ road, d, why: 'no road within search radius' }); continue; }
    const over = near.dist - near.limit;
    if (over > 2.0) {
      // Car is ON its own road but confinement thinks it is off-road!
      // Is the "nearest" road a different one? (cross-road conflict)
      const ownSeg = { limit: ownLimit };
      const ownDist = 0; // we are ON the centreline
      const ownOver = ownDist - ownSeg.limit;
      stuck.push({
        road, d, x: s.x, z: s.z,
        why: 'cross-road conflict',
        nearestRoadIdx: near.ri !== undefined ? near.ri : '?',
        ownRi: ri,
        nearDist: near.dist, nearLimit: near.limit, over,
        ownOver,
      });
    }
  }
}

console.log(`Found ${stuck.length} points ON a road that the confinement calls "off-road".\n`);
if (stuck.length) {
  // Group by road for readability
  const byRoad = new Map();
  for (const s of stuck) {
    const k = s.road.i;
    if (!byRoad.has(k)) byRoad.set(k, []);
    byRoad.get(k).push(s);
  }
  const sorted = [...byRoad.entries()].sort((a, b) => b[1].length - a[1].length);
  for (const [ri, list] of sorted.slice(0, 12)) {
    const road = ROAD_LINES[ri];
    console.log(`ROAD ${ri} "${road.name}" [${road.cls}] half=${road.half} sidewalk=${road.swWidth} ` +
      `-> own limit ${(road.half + road.swWidth).toFixed(1)} m`);
    for (const s of list.slice(0, 4)) {
      console.log(`   d=${s.d.toFixed(0)}m  nearest: dist=${s.nearDist.toFixed(1)} ` +
        `limit=${s.nearLimit.toFixed(1)} => OVER by ${s.over.toFixed(1)} m`);
    }
    if (list.length > 4) console.log(`   ... and ${list.length - 4} more`);
  }
}

// ---------------------------------------------------------------------------
// PART 2: LIVE DRIVE - can the car actually traverse each whole road?
//
// Pure-pursuit autopilot (steer toward a lookahead point on the centrelines).
// A "STALL" = car presses forward but speed stays ~0 for many frames, which is
// what the player experiences as an invisible wall.
// NOTE: huwag na mag-detect ng "speed < 1" kasi iyon ay nananatili sa
// collision bounce (negative speed) - dapat sustained pa.
// ---------------------------------------------------------------------------
console.log('\n' + '='.repeat(72));
console.log('PART 2 - LIVE DRIVE (pure-pursuit autopilot, full-road traversal)');
console.log('='.repeat(72));

const v = new Vehicle(scene);
v.build();
v.setConfinement(map.confinement);
v.setCollisionObjects(map.getCollisionBoxes());

// Pre-bucket ang collision boxes ayon sa kalsada para mabilis ang probe:
// isang kalsada, tanging ang mga box na malapit dito ang susuriin.
const ALL_BOXES = map.getCollisionBoxes();
let nearBoxes = [];

const stalls = [];
for (const road of roads) {
  const ri = road.i;
  // mga box na malapit sa kalsadong ito (30 m corridor) - mabilis na probe
  nearBoxes = ALL_BOXES.filter((b) => {
    const cx = (b.min.x + b.max.x) / 2, cz = (b.min.z + b.max.z) / 2;
    return distToPolyline(cx, cz, road.pts) < road.half + road.swWidth + 30;
  });
  const s0 = sampleRoad(ri, 4, 0);
  v.position.set(s0.x, 0, s0.z);
  v.lastGoodRoad = { x: s0.x, z: s0.z };
  v.speed = 12;
  v.steering = 0;
  v.rotation = Math.atan2(s0.nX, s0.nZ);

  const input = { forward: true, backward: false, left: false, right: false, handbrake: false };
  let d = 4;
  let lowFrames = 0;
  const STALL_FRAMES = 90; // 1.5 s of crawling = na-stall
  let maxD = 4;
  let guard = 0;
  let lastPush = 'none';

  while (d < road.len - 4 && guard < 3000) {
    guard++;
    // pure pursuit: aim at a point ~14 m further along the road
    const look = sampleRoad(ri, Math.min(d + 14, road.len - 2), 0);
    const tx = look.x - v.position.x;
    const tz = look.z - v.position.z;
    // signed angle between heading and target
    const heading = Math.atan2(Math.sin(v.rotation), Math.cos(v.rotation));
    const want = Math.atan2(tx, tz);
    let diff = want - heading;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    input.left = diff < -0.02;
    input.right = diff > 0.02;

    v.update(1 / 60, input);
    // subukan: aling component ang nagpapatigil? (box collision vs confinement)
    // NOTE: ang full 4000-box scan bawat frame ay MABAGAT. Ang probe ay
    // pang-diagnostics lang, kaya cheap na pagpapadala (sqr distance gate).
    {
      const np = new THREE.Vector3(
        v.position.x + Math.sin(v.rotation) * v.speed / 60,
        v.position.y,
        v.position.z + Math.cos(v.rotation) * v.speed / 60
      );
      const nb = new THREE.Box3().setFromCenterAndSize(np, new THREE.Vector3(2, 1.5, 4.2));
      let boxHit = false;
      for (const b of nearBoxes) {
        if (Math.abs(b.min.x - np.x) > 6 || Math.abs(b.min.z - np.z) > 6) continue;
        if (nb.intersectsBox(b)) { boxHit = true; break; }
      }
      const qq = map.confinement.queryAll(v.position.x, v.position.z);
      lastPush = boxHit ? 'BOX' : (qq && qq.over > 2 ? `CONFINE(over=${qq.over.toFixed(1)})` : 'none');
    }
    d = nearestAlong(ri, v.position.x, v.position.z);
    maxD = Math.max(maxD, d);

    // STALL: pushing forward but not moving
    if (v.speed < 1.5) lowFrames++; else lowFrames = 0;
    if (lowFrames > STALL_FRAMES) {
      // !!! DITO: gamitin ang EXACT na collision box ng Vehicle.checkCollision
      // (center = newPos, y = position.y - HINDI y+0.75). Ang dating
      // diagnostic ay may 0.75 m offset kaya maling "boxes: NONE".
      const gameBox = new THREE.Box3().setFromCenterAndSize(
        new THREE.Vector3(v.position.x, v.position.y, v.position.z),
        new THREE.Vector3(2, 1.5, 4.2)
      );
      const hits = new Set();
      for (const b of nearBoxes) {
        if (gameBox.intersectsBox(b)) {
          hits.add(`${(b.max.x - b.min.x).toFixed(1)}x${(b.max.y - b.min.y).toFixed(1)}x${(b.max.z - b.min.z).toFixed(1)}`);
        }
      }
      const q = map.confinement.queryAll(v.position.x, v.position.z);
      stalls.push({
        road, d, x: v.position.x, z: v.position.z, speed: v.speed,
        over: q ? q.over : null, judgeRi: q ? q.ri : null, ownRi: ri,
        nearestRi: q ? q.nearestRi : null, nearestDist: q ? q.nearestDist : null,
        hits: [...hits],
        confinePush: lastPush,
      });
      break;
    }
  }
}

// helper: distance along road ri of point (x,z)
function nearestAlong(ri, x, z) {
  const road = ROAD_LINES[ri];
  const pts = road.pts;
  let best = 0, bd = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const dx = b.x - a.x, dz = b.z - a.z;
    const l2 = dx * dx + dz * dz;
    let t = l2 ? ((x - a.x) * dx + (z - a.z) * dz) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    const px = a.x + dx * t, pz = a.z + dz * t;
    const dd = (x - px) ** 2 + (z - pz) ** 2;
    if (dd < bd) { bd = dd; best = i + t; }
  }
  // approximate metres using segment lengths up to best
  let acc = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const seg = Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].z - pts[i].z);
    if (i >= best) { acc += seg * (best - i); break; }
    acc += seg;
  }
  return acc;
}

console.log(`\nRoads driven: ${roads.length}   roads with a STALL: ${stalls.length}\n`);
for (const s of stalls) {
  console.log(`STALL "${s.road.name}" [${s.cls ?? s.road.cls}] at d=${s.d.toFixed(0)}/${s.road.len.toFixed(0)} m ` +
    `pos (${s.x.toFixed(1)}, ${s.z.toFixed(1)}) speed=${s.speed.toFixed(2)}`);
  console.log(`   judged by road ri=${s.judgeRi} (own=${s.ownRi}) over=${s.over?.toFixed(2)} m ` +
    `nearest ri=${s.nearestRi} at ${s.nearestDist?.toFixed(1)} m`);
  console.log(`   boxes: ${s.hits.length ? s.hits.join(', ') : 'NONE'}   stoppedBy=${s.confinePush}`);
}
if (!stalls.length) console.log('  No stalls - every major road is fully traversable.\n');


