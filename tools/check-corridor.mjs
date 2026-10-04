// ---------------------------------------------------------------------------
// check-corridor.mjs - "can the car actually drive this road?"
//
// Para sa BAWAT kalsada: may ba bang tuloy-tuloy na libreng lateral na sapat
// para sa kotse (2.0 m + margin)? Kung wala, may nakatigil na collider
// (poste/puno/building) sa loob ng kalsada - iyon ang "invisible wall".
// Usage: node tools/check-corridor.mjs
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { Map as GameMap } from '../src/world/Map.js';
import { ROAD_LINES, densifyROAD, headingFromRoadNormal } from '../src/utils/roadLayout.js';

let fail = 0;
const CAR_W = 2.0, CAR_L = 4.2, CAR_H = 1.5;
const NEED = CAR_W + 0.4; // libreng lapad na kailangan
const STEP = 1.0;

const scene = new THREE.Scene();
const map = new GameMap(scene);
map.build();
const boxes = map.getCollisionBoxes();

// uniform grid para mabilis ang box lookup
const CELL = 16;
const grid = new Map();
const key = (cx, cz) => `${cx},${cz}`;
boxes.forEach((b, i) => {
  const x0 = Math.floor(b.min.x / CELL), x1 = Math.floor(b.max.x / CELL);
  const z0 = Math.floor(b.min.z / CELL), z1 = Math.floor(b.max.z / CELL);
  for (let cx = x0; cx <= x1; cx++) {
    for (let cz = z0; cz <= z1; cz++) {
      const k = key(cx, cz);
      let l = grid.get(k);
      if (!l) { l = []; grid.set(k, l); }
      l.push(i);
    }
  }
});

function nearby(x, z) {
  const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
  const out = new Set();
  for (let i = -1; i <= 1; i++) {
    for (let j = -1; j <= 1; j++) {
      const l = grid.get(key(cx + i, cz + j));
      if (l) for (const b of l) out.add(b);
    }
  }
  return out;
}

const obbs = map.getObbColliders();

// --- spatial index para sa mga OBB (buildings) ---
// Ang OBB test ay masyadong mahal para sa 800+ buildings bawat sample, kaya
// naka-grid din ito (same cell size).
const obbGrid = new Map();
obbs.forEach((o, i) => {
  const ex = Math.abs(o.cos) * o.hx + Math.abs(o.sin) * o.hz;
  const ez = Math.abs(o.sin) * o.hx + Math.abs(o.cos) * o.hz;
  const x0 = Math.floor((o.x - ex) / CELL), x1 = Math.floor((o.x + ex) / CELL);
  const z0 = Math.floor((o.z - ez) / CELL), z1 = Math.floor((o.z + ez) / CELL);
  for (let cx = x0; cx <= x1; cx++) {
    for (let cz = z0; cz <= z1; cz++) {
      const k = key(cx, cz);
      let l = obbGrid.get(k);
      if (!l) { l = []; obbGrid.set(k, l); }
      l.push(i);
    }
  }
});
function nearbyObbs(x, z) {
  const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
  const out = new Set();
  for (let i = -1; i <= 1; i++) {
    for (let j = -1; j <= 1; j++) {
      const l = obbGrid.get(key(cx + i, cz + j));
      if (l) for (const b of l) out.add(b);
    }
  }
  return out;
}

function vertexNormalsLocal(pts) {
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(pts.length - 1, i + 1)];
    const dx = b.x - a.x, dz = b.z - a.z;
    const l = Math.hypot(dx, dz) || 1;
    out.push({ x: -dz / l, z: dx / l });
  }
  return out;
}

// TALA: ang audit ay gumagamit ng AABB para sa mga poste/puno/NPC, pero
// OBB (oriented) para sa MGA BAHAY at para sa KOTSE - gaya ng mismong
// collision ng game. Ang car OBB ay naka-rotate sa heading (tingnan ang
// carObb() sa Vehicle.js).

/** Ang OBB ng kotse naka-rotate sa heading (sanggunian sa Vehicle.carObb). */
function makeCar(cx, cz, heading) {
  return {
    cx, cy: 0, cz,
    ex: CAR_W / 2, ey: CAR_H / 2, ez: CAR_L / 2,
    ax: Math.cos(heading), az: -Math.sin(heading),
  };
}

/** OBB vs OBB (kotse vs building). */
function obbVsObb(a, b) {
  const dx = a.cx - b.x, dz = a.cz - b.z;
  const azx = -a.az, azz = a.ax;
  for (const [ax, az] of [[1, 0], [0, 1], [a.ax, a.az], [azx, azz],
    [b.cos, -b.sin], [b.sin, b.cos]]) {
    const rA = Math.abs(a.ax * ax + a.az * az) * a.ex
      + Math.abs(azx * ax + azz * az) * a.ez;
    const rB = Math.abs(b.cos * ax - b.sin * az) * b.hx
      + Math.abs(b.sin * ax + b.cos * az) * b.hz;
    if (Math.abs(dx * ax + dz * az) > rA + rB) return false;
  }
  return true;
}

/** OBB (kotse) vs AABB (world box). */
function obbVsAabb(o, box) {
  const bx = (box.min.x + box.max.x) / 2;
  const bz = (box.min.z + box.max.z) / 2;
  const bex = (box.max.x - box.min.x) / 2;
  const bez = (box.max.z - box.min.z) / 2;
  const dx = o.cx - bx, dz = o.cz - bz;
  const zx = -o.az, zz = o.ax;
  for (const [ax, az] of [[1, 0], [0, 1], [o.ax, o.az], [zx, zz]]) {
    const rA = Math.abs(ax) * bex + Math.abs(az) * bez;
    const rO = Math.abs(o.ax * ax + o.az * az) * o.ex
      + Math.abs(zx * ax + zz * az) * o.ez;
    if (Math.abs(dx * ax + dz * az) > rA + rO) return false;
  }
  return true;
}

/** Exact na collision ng game. */
function carHits(cx, cz, heading) {
  const car = makeCar(cx, cz, heading);
  const out = [];
  for (const bi of nearby(cx, cz)) {
    const b = boxes[bi];
    if (obbVsAabb(car, b)) {
      out.push(`${(b.max.x - b.min.x).toFixed(1)}x${(b.max.y - b.min.y).toFixed(1)}x${(b.max.z - b.min.z).toFixed(1)}`);
    }
  }
  for (const bi of nearbyObbs(cx, cz)) {
    const o = obbs[bi];
    if (obbVsObb(car, o)) out.push(`OBB ${(o.hx * 2).toFixed(1)}x${(o.hz * 2).toFixed(1)}`);
  }
  return out;
}

console.log('='.repeat(72));
console.log('DRIVABLE CORRIDOR - "is the road passable?" AUDIT');
console.log('='.repeat(72));
console.log(`  car box ${CAR_W}x${CAR_H}x${CAR_L} m, needs ${NEED.toFixed(1)} m clear`);
console.log(`  collision boxes: ${boxes.length}\n`);

const blocked = [];
let totalSamples = 0, failSamples = 0;

for (const road of ROAD_LINES) {
  const line = densifyROAD(road.pts, STEP);
  const nrm = vertexNormalsLocal(line);
  let firstBad = null;
  for (let i = 0; i < line.length; i++) {
    totalSamples++;
    const p = line[i], n = nrm[i];
    // heading ng kotse = direksyon ng kalsada ("kaya bang mag-drive dito
    // nang naka-align sa kalsada?")
    // Normal = (-tangent.z, tangent.x); vehicle forward is (sin h, cos h).
    const heading = headingFromRoadNormal(n);
    const limit = road.half + 0.5;
    const N = Math.ceil((limit * 2) / 0.25);
    const free = new Array(N + 1).fill(true);
    for (let j = 0; j <= N; j++) {
      const o = -limit + j * 0.25;
      if (carHits(p.x + n.x * o, p.z + n.z * o, heading).length) free[j] = false;
    }
    let best = 0, run = 0;
    for (let j = 0; j <= N; j++) {
      if (free[j]) { run++; if (run > best) best = run; } else run = 0;
    }
    const clearM = best * 0.25;
    if (clearM < NEED) {
      failSamples++;
      if (!firstBad) {
        const blockers = new Set();
        for (let j = 0; j <= N; j++) {
          if (free[j]) continue;
          const o = -limit + j * 0.25;
          for (const t of carHits(p.x + n.x * o, p.z + n.z * o, heading)) blockers.add(t);
        }
        firstBad = { road, x: p.x, z: p.z, clearM, blockers };
      }
    }
  }
  if (firstBad) blocked.push(firstBad);
}

console.log(`  samples: ${totalSamples}   impassable: ${failSamples}`);
console.log(`  roads with a blocked spot: ${blocked.length} / ${ROAD_LINES.length}\n`);

if (blocked.length) {
  const byType = new Map();
  for (const b of blocked) for (const t of b.blockers) byType.set(t, (byType.get(t) || 0) + 1);
  console.log('  Blocking collider types (roads affected):');
  for (const [t, c] of [...byType].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    console.log(`    ${t.padEnd(20)} ${c} road(s)`);
  }
  console.log('\n  Worst roads:');
  for (const b of blocked.sort((x, y) => x.clearM - y.clearM).slice(0, 12)) {
    console.log(`    "${b.road.name}" [${b.road.cls}] half=${b.road.half} ` +
      `clear=${b.clearM.toFixed(2)}m at (${b.x.toFixed(0)},${b.z.toFixed(0)})`);
    console.log(`       blocked by: ${[...b.blockers].slice(0, 4).join(', ')}`);
  }
  fail = blocked.length;
} else {
  console.log('  Every road has a continuous passable lane. CLEAN.\n');
}

console.log('\n' + '='.repeat(72));
console.log(fail === 0 ? 'ALL ROADS PASSABLE' : `${fail} ROAD(S) BLOCKED`);
process.exit(fail === 0 ? 0 : 1);
