import * as THREE from 'three';
import { Map as GameMap } from '../src/world/Map.js';
import { ROADS, MAP_ORIGIN } from '../src/world/roadData.js';

const scene = new THREE.Scene();
const map = new GameMap(scene);
map.build();
const boxes = map.getCollisionBoxes();

const MPD_LAT = 111132;
const MPD_LON = 111320 * Math.cos(MAP_ORIGIN.lat * Math.PI / 180);
const toLocal = ([lat, lon]) => ({ x: (lon - MAP_ORIGIN.lon) * MPD_LON, z: -(lat - MAP_ORIGIN.lat) * MPD_LAT });
const lines = ROADS.map((r) => ({ name: r.name, pts: r.pts.map(toLocal), half: r.w / 2 }));

// On-road test: nasa loob ba ang box ng anuman road corridor?
function insideRoadCorridor(x, z, pad = 0) {
  for (const r of lines) {
    for (let i = 0; i < r.pts.length - 1; i++) {
      const a = r.pts[i], b = r.pts[i + 1];
      const dx = b.x - a.x, dz = b.z - a.z, l2 = dx * dx + dz * dz;
      let t = l2 ? ((x - a.x) * dx + (z - a.z) * dz) / l2 : 0;
      t = Math.max(0, Math.min(1, t));
      if (Math.hypot(x - (a.x + dx * t), z - (a.z + dz * t)) < r.half + pad) return true;
    }
  }
  return false;
}

// 1) bawat built collision box ay walang overlap sa road surface
let onRoad = 0;
for (const b of boxes) {
  const c = b.getCenter(new THREE.Vector3());
  const size = b.getSize(new THREE.Vector3());
  const rad = Math.max(size.x, size.z) / 2;
  // check ang 4 na sulok ng box
  let hits = false;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    if (insideRoadCorridor(c.x + (sx * size.x) / 2, c.z + (sz * size.z) / 2, -0.5)) hits = true;
  }
  if (hits) { onRoad++; console.log(`ON ROAD: (${c.x.toFixed(1)}, ${c.z.toFixed(1)}) size ${size.x.toFixed(1)}x${size.z.toFixed(1)}`); }
}
console.log(`collision boxes touching road surface: ${onRoad} / ${boxes.length}`);

// 2) spawn drive: unang 80m ng centerline mula sa (0,0) ay malinis
//    hanapin ang centerline ng Bayan-Bayanan at i-walk ito
const main = lines.find((l) => l.name === 'Bayan-Bayanan Avenue');
let blockers = 0;
for (let i = 0; i < main.pts.length - 1; i++) {
  const a = main.pts[i], b = main.pts[i + 1];
  const steps = Math.ceil(Math.hypot(b.x - a.x, b.z - a.z));
  for (let s = 0; s < steps; s++) {
    const t = s / steps;
    const x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t;
    if (Math.hypot(x, z) > 80) break;
    for (const bx of boxes) {
      const c = bx.getCenter(new THREE.Vector3());
      const size = bx.getSize(new THREE.Vector3());
      if (Math.abs(c.x - x) < size.x / 2 + 1.5 && Math.abs(c.z - z) < size.z / 2 + 1.5) {
        blockers++;
        console.log(`CENTERLINE BLOCKER at (${x.toFixed(1)}, ${z.toFixed(1)}): box (${c.x.toFixed(1)}, ${c.z.toFixed(1)})`);
      }
    }
  }
}
console.log(`centerline blockers within 80m of spawn: ${blockers}`);
console.log(onRoad === 0 && blockers === 0 ? 'ALL CLEAR' : 'ISSUES');
