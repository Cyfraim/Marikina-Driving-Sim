import * as THREE from 'three';
import { Map as GameMap } from '../src/world/Map.js';
import { ROAD_LINES } from '../src/utils/roadLayout.js';

const scene = new THREE.Scene();
const map = new GameMap(scene);
map.build();
const boxes = map.getCollisionBoxes();

function minCenterlineDist(x, z) {
  let best = Infinity;
  for (const line of ROAD_LINES) {
    if (x < line.minX - 20 || x > line.maxX + 20 || z < line.minZ - 20 || z > line.maxZ + 20) continue;
    for (let i = 0; i < line.pts.length - 1; i++) {
      const a = line.pts[i], b = line.pts[i + 1];
      const dx = b.x - a.x, dz = b.z - a.z, l2 = dx * dx + dz * dz;
      let t = l2 ? ((x - a.x) * dx + (z - a.z) * dz) / l2 : 0;
      t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(x - (a.x + dx * t), z - (a.z + dz * t)) - line.half;
      if (d < best) best = d;
    }
  }
  return best; // negatibo = nasa loob ng asphalt
}

let vehicles = 0, onRoad = 0, tooClose = 0;
for (const b of boxes) {
  const c = b.getCenter(new THREE.Vector3());
  const s = b.getSize(new THREE.Vector3());
  const isVehicle = Math.max(s.x, s.z) <= 4.8 && s.y <= 2.2;
  if (isVehicle) { vehicles++; continue; }
  const d = minCenterlineDist(c.x, c.z);
  if (d < 0.2) { onRoad++; console.log(`ON ROAD (${s.x.toFixed(1)}x${s.z.toFixed(1)}) at (${c.x.toFixed(1)}, ${c.z.toFixed(1)})`); }
  else if (d < 0.25) { tooClose++; }
}
console.log(`vehicle boxes (parked on road, by design): ${vehicles}`);
console.log(`non-vehicle boxes ON road: ${onRoad}, too close: ${tooClose}`);

// spawn corridor clearance (centerline walk, first 80 m)
const main = ROAD_LINES.find((l) => l.name === 'Bayan-Bayanan Avenue');
let blockers = 0;
for (let i = 0; i < main.pts.length - 1; i++) {
  const a = main.pts[i], b = main.pts[i + 1];
  const len = Math.hypot(b.x - a.x, b.z - a.z);
  const steps = Math.max(1, Math.ceil(len));
  for (let k = 0; k < steps; k++) {
    const t = k / steps;
    const x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t;
    if (Math.hypot(x, z) > 80) break;
    for (const b2 of boxes) {
      const c = b2.getCenter(new THREE.Vector3());
      const s = b2.getSize(new THREE.Vector3());
      if (Math.abs(c.x - x) < s.x / 2 + 1.2 && Math.abs(c.z - z) < s.z / 2 + 1.2) {
        blockers++;
        console.log(`  spawn blocker (${s.x.toFixed(1)}x${s.z.toFixed(1)}) at (${c.x.toFixed(1)}, ${c.z.toFixed(1)})`);
      }
    }
  }
}
console.log(`spawn corridor blockers within 80m: ${blockers}`);
console.log(onRoad === 0 && tooClose === 0 && blockers === 0 ? 'ALL CLEAR' : 'ISSUES');

