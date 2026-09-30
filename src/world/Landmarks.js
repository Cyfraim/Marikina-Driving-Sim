// ---------------------------------------------------------------------------
// Landmarks.js - Marikina River at ang mga tanda ng Nangka
//
// - Marikina River: tubig N-S sa silangang bahagi ng mapa (~14.651, 121.112)
//   na may concrete embankment walls
// - Nangka Public Market: malaking tinala sa tabi ng main road
// - Tricycle terminal: sa pinakamalaking intersection ng Bayan-Bayanan Ave
//
// Lahat ng GPS ay galing sa src/utils/geo.js (gpsToLocal).
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { ColoredMeshBuilder } from '../utils/coloredMesh.js';
import { RIVER_X, RIVER_HALF_WIDTH, terrainHeight } from '../utils/geo.js';
import { ROAD_LINES, getMajorJunctions, sampleRoad } from '../utils/roadLayout.js';

// GPS coordinates (mula sa .clinerules at OSM)
export const RIVER_GPS = { lat: 14.6510, lon: 121.1120 };

const WATER_DEEP = 0x1b4a63;   // malalim na tubig
const WATER_SHALLOW = 0x2e6f8e; // maaaring di malalim
const BANK_WALL = 0x8d8d85;    // concrete embankment
const WATER_Y = 0.05;           // antas ng tubig

export class Landmarks {
  constructor(scene) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.collisionBoxes = [];
    scene.add(this.group);
  }

  build() {
    this.buildRiver();
    this.buildMarket();
    this.buildTerminal();
  }

  // --- Marikina River: water plane + concrete embankments ----------------
  buildRiver() {
    const mesh = new ColoredMeshBuilder();
    const zMin = -1400;
    const zMax = 1400;
    const step = 60; // segments sa habang Z

    for (let z = zMin; z < zMax; z += step) {
      const z0 = z;
      const z1 = Math.min(z + step, zMax);
      // slight meander para hindi sobrang tuwid ang ilog
      const cx0 = RIVER_X + Math.sin(z * 0.0022) * 18;
      const cx1 = RIVER_X + Math.sin(z1 * 0.0022) * 18;
      const inner0 = cx0 - RIVER_HALF_WIDTH;
      const inner1 = cx1 - RIVER_HALF_WIDTH;
      const outer0 = cx0 + RIVER_HALF_WIDTH;
      const outer1 = cx1 + RIVER_HALF_WIDTH;

      // water surface - darker sa gitna
      mesh.quad(
        [inner0, WATER_Y, z0], [outer0, WATER_Y, z0],
        [outer1, WATER_Y, z1], [inner1, WATER_Y, z1],
        WATER_DEEP, [0, 1, 0]
      );
      // shallows sa dalawang gilid
      mesh.quad(
        [inner0, WATER_Y, z0],
        [inner0 + (outer0 - inner0) * 0.35, WATER_Y, z0],
        [inner1 + (outer1 - inner1) * 0.35, WATER_Y, z1],
        [inner1, WATER_Y, z1],
        WATER_SHALLOW, [0, 1, 0]
      );

      // concrete embankment walls (inner at outer bank)
      mesh.quad(
        [inner0, -0.4, z0], [inner0, 0.55, z0],
        [inner1, 0.55, z1], [inner1, -0.4, z1],
        BANK_WALL, [1, 0, 0]
      );
      mesh.quad(
        [outer0, -0.4, z0], [outer0, 0.55, z0],
        [outer1, 0.55, z1], [outer1, -0.4, z1],
        BANK_WALL, [-1, 0, 0]
      );
      // bank caps (top)
      mesh.quad(
        [inner0, 0.55, z0], [inner0 - 0.5, 0.55, z0],
        [inner1 - 0.5, 0.55, z1], [inner1, 0.55, z1],
        BANK_WALL, [0, 1, 0]
      );
      mesh.quad(
        [outer0 + 0.5, 0.55, z0], [outer0, 0.55, z0],
        [outer1, 0.55, z1], [outer1 + 0.5, 0.55, z1],
        BANK_WALL, [0, 1, 0]
      );
    }
    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.6, metalness: 0.0,
    });
    this.group.add(mesh.build(mat));

    // FIX invisible-wall: HINDA na natatakot ang tubig. Ang dating mahabang
    // box (2.8 km) ay naka-block sa mga kalsadang papunta sa tulay ng
    // Marikina River (e.g. T. Bugallon Extension, Paraiso Street) - kaya
    // hindi makatapos ang drive at parang invisible wall.
    //
    // Ang tubig ay visually OBVIOUS (malaking blue plane), kaya walang
    // kailangang invisible box. Ang naka-drive sa tubig ay sapat nang
    // maging self-evident. Tinatago na lamang ang box sa hindi kailangan.
    console.log(`[Landmarks] Marikina River (x=${RIVER_X}, ${RIVER_HALF_WIDTH * 2} m wide) - no collision`);
  }

  // --- Nangka Public Market: malaking tindahang may flat roof ------------
  buildMarket() {
    const mesh = new ColoredMeshBuilder();
    // Hanapin ang main road at ilagay ang market sa tabi nito (hindi kalsada)
    const main = ROAD_LINES.find((r) => r.name === 'Bayan-Bayanan Avenue')
      || ROAD_LINES.find((r) => r.cls === 'secondary');
    if (!main) return;
    const s = sampleRoad(main.i, main.len * 0.5, main.half + 1.6 + 14);
    const x = s.x;
    const z = s.z;
    const gy = terrainHeight(x, z); // nasa slope ng lupa
    const W = 26; // haba
    const D = 18; // lapad
    const H = 7;   // 2-3 storey
    const yaw = s.yaw;

    mesh.box(x, gy + H / 2, z, W, H, D, 0xd7cfc0, yaw);
    // flat roof + parapet
    mesh.box(x, gy + H + 0.2, z, W + 0.6, 0.4, D + 0.6, 0x8a8a8a, yaw);
    // malaking signage band sa harap
    const frontX = x + Math.sin(yaw) * (D / 2 + 0.06);
    const frontZ = z + Math.cos(yaw) * (D / 2 + 0.06);
    mesh.box(frontX, gy + H - 0.9, frontZ, W * 0.7, 1.4, 0.12, 0x27ae60, yaw);
    // stall openings
    const px = Math.cos(yaw);
    const pz = -Math.sin(yaw);
    for (let i = -2; i <= 2; i++) {
      mesh.box(frontX + px * i * 4, gy + 1.6, frontZ + pz * i * 4, 2.2, 3.2, 0.1, 0x34495e, yaw);
    }

    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85 });
    this.group.add(mesh.build(mat));
    this.collisionBoxes.push(
      new THREE.Box3(
        new THREE.Vector3(x - W / 2, gy, z - D / 2),
        new THREE.Vector3(x + W / 2, gy + H, z + D / 2)
      )
    );
    console.log(`[Landmarks] Nangka Public Market at (${x.toFixed(0)}, ${z.toFixed(0)})`);
  }

  // --- Tricycle terminal sa pinakamalaking intersection -------------------
  buildTerminal() {
    const junctions = getMajorJunctions();
    if (!junctions.length) return;
    const main = ROAD_LINES.find((r) => r.name === 'Bayan-Bayanan Avenue');
    let target = junctions[0];
    if (main) {
      const onMain = junctions.filter((j) => j.a === main.i || j.b === main.i);
      if (onMain.length) target = onMain[0];
    }
    const mesh = new ColoredMeshBuilder();
    const W = 12;
    const D = 6;
    const H = 3.2;
    const road = ROAD_LINES[target.a];
    const along = nearestAlong(target.a, target.x, target.z);
    const s = sampleRoad(target.a, along + 12, road.half + 1.6 + 4);
    const yaw = s.yaw;
    const gy = terrainHeight(s.x, s.z);
    const px = Math.cos(yaw);
    const pz = -Math.sin(yaw);
    for (const [ox, oz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      mesh.box(s.x + px * ox * W / 2, gy + H / 2, s.z + pz * oz * D / 2, 0.2, H, 0.2, 0x777777, yaw);
    }
    mesh.box(s.x, gy + H + 0.15, s.z, W + 0.5, 0.3, D + 0.5, 0x556677, yaw);
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8 });
    this.group.add(mesh.build(mat));
    console.log(`[Landmarks] Tricycle terminal at (${s.x.toFixed(0)}, ${s.z.toFixed(0)})`);
  }

  getCollisionBoxes() { return this.collisionBoxes; }
}

// helper: distance-along ng road para sa isang point
function nearestAlong(ri, x, z) {
  const r = ROAD_LINES[ri];
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < r.pts.length - 1; i++) {
    const a = r.pts[i];
    const dx = r.pts[i + 1].x - a.x;
    const dz = r.pts[i + 1].z - a.z;
    const l2 = dx * dx + dz * dz;
    let t = l2 ? ((x - a.x) * dx + (z - a.z) * dz) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    const d = Math.hypot(x - (a.x + dx * t), z - (a.z + dz * t));
    if (d < bestD) { bestD = d; best = r.cum[i] + t * Math.sqrt(l2); }
  }
  return best;
}
