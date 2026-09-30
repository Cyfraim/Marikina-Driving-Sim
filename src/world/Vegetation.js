// ---------------------------------------------------------------------------
// Vegetation.js - Palms at mangga sa gilid ng mga kalsada
//
// Ang mga puno ay inilalagay sa mga PUWANG ng frontage (walang bahay doon -
// ginagamit ang FRONTAGE registry ng Buildings.js) at sa mga open lot.
// Palm sa pangunahing kalsada, mangga sa residential na kalye.
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { ColoredMeshBuilder } from '../utils/coloredMesh.js';
import { terrainHeight } from '../utils/geo.js';
import {
  ROAD_LINES, sampleRoad, curbsideSpot, FRONTAGE, mulberry32, SW_WIDTH,
  sidewalkWidth,
} from '../utils/roadLayout.js';

const PALM_TRUNK = 0x8d6e4a;
const PALM_FROND = 0x2e7d32;
const MANGO_TRUNK = 0x6d4c2f;
const MANGO_LEAF = [0x2e7d32, 0x388e3c, 0x1b5e20];

const TREE_CLASSES = new Set([
  'primary', 'secondary', 'tertiary', 'residential', 'unclassified', 'living_street',
]);

export class Vegetation {
  constructor(scene) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.collisionBoxes = [];
    scene.add(this.group);
  }

  /**
   * @param bounds  {minX,maxX,minZ,maxZ} - kung set, ang PUNO na ang sentro ay
   *                nasa loob ng box ang gagawin (tile build). Bawat puno ay
   *                ina-assign sa EXACTLY ISANG tile kaya walang duplicates.
   * @param target  THREE.Group na tatanggapin ang mesh.
   */
  build(bounds = null, target = this.group) {
    const mesh = new ColoredMeshBuilder();
    let palms = 0;
    let mangoes = 0;

    // FIX 2: per-road RNG stream (seeded mula sa index) para TILE-INDEPENDENT
    // at paulit-ulit ang placement. Isang shared na rnd ang dating gamit -
    // naipupunto iyon sa pagbabago ng bawat puno depende sa tile.
    const roadSeed = (ri) => mulberry32((0x54524545 ^ Math.imul(ri + 1, 2654435761)) >>> 0);

    ROAD_LINES.forEach((road, ri) => {
      if (!TREE_CLASSES.has(road.cls)) return;
      if (bounds) {
        if (road.maxX < bounds.minX || road.minX > bounds.maxX ||
            road.maxZ < bounds.minZ || road.minZ > bounds.maxZ) return;
      }
      const rnd = roadSeed(ri);
      const major = road.cls === 'primary' || road.cls === 'secondary' || road.cls === 'tertiary';

      // paso 1: mga puwang sa harap ng bahay (dito lang puwedeng magtanim)
      for (let d = 12; d < road.len - 12; d += 13 + rnd() * 7) {
        for (const side of [1, -1]) {
          if (!FRONTAGE.isFree(ri, side, d - 4, d + 4)) continue; // may bahay
          if (rnd() < 0.4) continue; // hindi bawat puwang may puno
          const sw = road.hasSW ? sidewalkWidth(road.cls) : 0;
          const off = road.half + sw + 1.4 + rnd() * 2.5;
          const s = sampleRoad(ri, d, side * off);
          // FIX 2: owner check - ang sentro ng puno ang tinutukoy ng tile.
          if (bounds) {
            if (s.x < bounds.minX || s.x > bounds.maxX ||
                s.z < bounds.minZ || s.z > bounds.maxZ) continue;
          }
          if (!curbsideSpot(s.x, s.z, ri, 0.6)) continue;
          // taas ng lupa para masundan ang slope
          const gy = terrainHeight(s.x, s.z);
          // palm sa pangunahing kalsada, mangga sa residential
          if (major && rnd() < 0.65) {
            this.palm(mesh, s.x, s.z, gy, 5 + rnd() * 2.5, rnd);
            palms++;
          } else {
            this.mango(mesh, s.x, s.z, gy, 2.4 + rnd() * 1.2, rnd);
            mangoes++;
          }
          this.collisionBoxes.push(
            new THREE.Box3().setFromCenterAndSize(
              new THREE.Vector3(s.x, gy + 1.5, s.z),
              new THREE.Vector3(0.7, 3, 0.7)
            )
          );
          FRONTAGE.add(ri, side, d - 2, d + 2); // hindi magkatabi
        }
      }
    });

    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.9, metalness: 0.0,
    });
    target.add(mesh.build(mat));
    if (!bounds) {
      console.log(`[Vegetation] ${palms} palm + ${mangoes} mangga, ${mesh.triangles} tris`);
    }
    return { palms, mangoes, tris: mesh.triangles };
  }

  // Palm tree: payat na trunk + nakausli na fronds (iconic sa Marikina)
  palm(mesh, x, z, gy, h, rnd) {
    mesh.cylinder(x, gy + h / 2, z, 0.28, 0.18, h, 6, PALM_TRUNK);
    const n = 7;
    const top = gy + h;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + rnd() * 0.5;
      const len = 2.4 + rnd() * 0.9;
      const droop = 0.7 + rnd() * 0.5;
      const x0 = x;
      const z0 = z;
      const x1 = x + Math.cos(a) * len;
      const z1 = z + Math.sin(a) * len;
      // dalawang seksyon para may droop
      const xm = x + Math.cos(a) * len * 0.5;
      const zm = z + Math.sin(a) * len * 0.5;
      mesh.strip([x0, top, z0], [xm, top + 0.25, zm], 0.9, PALM_FROND);
      mesh.strip([xm, top + 0.25, zm], [x1, top - droop, z1], 0.55, PALM_FROND);
    }
    // prutas (maliit na berdeng bola sa tuktok)
    mesh.blob(x, top + 0.1, z, 0.35, 0.3, 0.35, 4, 2, 0x7cb342);
  }

  // Mangga: makapal na puno + malaking mababang korona
  mango(mesh, x, z, gy, r, rnd) {
    const h = 2.6 + rnd() * 0.8;
    mesh.cylinder(x, gy + h / 2, z, 0.35, 0.22, h, 5, MANGO_TRUNK);
    const color = MANGO_LEAF[(rnd() * MANGO_LEAF.length) | 0];
    mesh.blob(x, gy + h + r * 0.5, z, r, r * 0.75, r, 6, 3, color);
    mesh.blob(x + r * 0.35, gy + h + r * 0.7, z - r * 0.25, r * 0.5, r * 0.4, r * 0.5, 5, 3, color);
  }

  getCollisionBoxes() { return this.collisionBoxes; }
}
