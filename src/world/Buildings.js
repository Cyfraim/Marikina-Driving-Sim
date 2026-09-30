// ---------------------------------------------------------------------------
// Buildings.js - Mababang bahay at maliit na tindahan sa gilid ng tunay na kalsada
//
// Placeholders ng Step 1 (hardcoded sa lumang straight road) ay pinalitan ng
// road-relative placement gamit ang roadLayout.js sampling. Ang bawat bahay
// ay nakaharap sa kalsada; ang mga tindahan (sari-sari stores, etc.) ay
// nag-ucluster malapit sa mga intersections - gaya sa totoong Nangka.
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { ColoredMeshBuilder } from '../utils/coloredMesh.js';
import { terrainHeight } from '../utils/geo.js';
import {
  ROAD_LINES, sampleRoad, safeSpot, FRONTAGE, getMajorJunctions, mulberry32,
  SW_WIDTH, sidewalkWidth, clearOfCorridors,
} from '../utils/roadLayout.js';

// --- FIX 3: height mix 30% / 50% / 20% (1/2/3 storey) ---
// Hindi na RNG-based: gumagamit ng EXACT quota (fixed cycle) para eksaktong
// tumugma sa target. Nakikita natin na ang rng-based ay nagbigay ng
// 34.7/40.0/25.3 sa halip na 30/50/20.
// Cycle ng 10: 3x 1-storey (4 m), 5x 2-storey (7 m), 2x 3-storey (10 m)
//   = eksaktong 30% / 50% / 20%
const HEIGHT_CYCLE = [4, 4, 4, 7, 7, 7, 7, 7, 10, 10];

// --- FIX 3: facade palette na i-cycle kada lot (hindi random) ---
// cream, faded blue, salmon, white, yellow - saklaw ng tunay na Marikina
const FACADE_COLORS = [
  0xf5e6ca, // cream
  0x8ab4c9, // faded blue
  0xe8a07a, // salmon
  0xf0eeeb, // white
  0xe8d87a, // yellow
];
// Pastel na kulay ng pader (tulad ng mga bahay sa Marikina)
const WALL_COLORS = [
  0xf5e6ca, 0xe8d5b5, 0xd4e6f1, 0xfadbd8, 0xd5f5e3,
  0xfce4d6, 0xd6eaf8, 0xf9e79f, 0xebdef0, 0xfaf3e0,
];
// --- VISUAL PASS Fix 1: kulay ng bubong ---------------------------------
// ANG DATING palette (0x117a65 teal, 0x117864 green, 0xb7950b yellow,
// 0xd35400 orange, 0x6c3483 purple) ay HINDI umuuwit sa tunay na Nangka.
// Sa totoong Marikina, halos lahat ng mababang bahay ay may:
//   1. galvanized iron (GI) sheet na CORRUGATED at luma na -> rust
//   2. red iron sheet na namatay na ang kulay -> faded red
//   3. patagong beton (flat concrete)
//   4. minsan weathered blue GI
// Hindi cycle kundi WEIGHTED pick, para organic ang tanaw at pare-pareho
// ang distribution kahit gaano man kadalas ma-rebuild (deterministic).
const ROOF_KINDS = [
  { w: 50, lo: 0x8b4513, hi: 0xa0522d }, // rusty corrugated GI (saddle brown - sienna)
  { w: 25, lo: 0x8b2525, hi: 0xcc3333 }, // faded red iron sheet (firebrick - red)
  { w: 15, lo: 0xc8c8c8, hi: 0xdddddd }, // bare concrete flat roof
  { w: 10, lo: 0x4a6b8a, hi: 0x4477aa }, // weathered blue GI
];
const ROOF_TOTAL_W = ROOF_KINDS.reduce((n, k) => n + k.w, 0);

/**
 * Weighted roof colour na may per-building weathering jitter.
 * Ang jitter ay nasa loob ng bawat kind's range, kaya hindi kailanman
 * lalabas sa rust/red/concrete/blue palette.
 */
function pickRoofColor(rnd) {
  let r = rnd() * ROOF_TOTAL_W;
  let k = ROOF_KINDS[ROOF_KINDS.length - 1];
  for (const kind of ROOF_KINDS) {
    r -= kind.w;
    if (r <= 0) { k = kind; break; }
  }
  const t = rnd(); // 0..1 - magkakaibang antas ng pananawis sa isang uri
  const ch = (shift) => {
    const a = (k.lo >> shift) & 255;
    const b = (k.hi >> shift) & 255;
    return Math.round(a + (b - a) * t);
  };
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
}

// Tarpaulin banner (Fix 3) - maliwanag na brand ng palda sa pader ng tindahan
const TARP_COLORS = [0xcc0000, 0x0044cc, 0xffcc00, 0x006600];
// Maliwanag na kulay ng signage
const SIGN_COLORS = [
  0xfc4353, 0xf4d03f, 0x2ecc71, 0x3498db, 0xe67e22, 0xffffff,
];

const BUILD_CLASSES = new Set([
  'primary', 'secondary', 'tertiary', 'residential', 'unclassified', 'living_street',
]);
const MAX_RADIUS = 330; // bahay hanggang 330 m mula sa sentro

/**
 * Spatial hash para sa overlap detection ng buildings.
 * Ang bawat cell ay may listahan ng naglalagay na footprints (AABB, may yaw).
 * Ang check ay tunay na OBB-vs-OBB (SAT) test hindi lang AABB - kasi ang
 * mga bahay ay naka-rotate ayon sa kalsada.
 */
class SpatialHash {
  constructor(cellSize) {
    this.cell = cellSize;
    this.map = new Map();
  }

  key(cx, cz) { return `${cx},${cz}`; }

  /** footprint: { x, z, hx, hz, c, s } (half-extents + cos/sin ng yaw) */
  overlaps(fp) {
    const reach = Math.hypot(fp.hx, fp.hz) + this.cell;
    const c0 = Math.floor((fp.x - reach) / this.cell);
    const c1 = Math.floor((fp.x + reach) / this.cell);
    const d0 = Math.floor((fp.z - reach) / this.cell);
    const d1 = Math.floor((fp.z + reach) / this.cell);
    for (let cx = c0; cx <= c1; cx++) {
      for (let cz = d0; cz <= d1; cz++) {
        const list = this.map.get(this.key(cx, cz));
        if (!list) continue;
        for (const o of list) if (obbOverlap(fp, o)) return true;
      }
    }
    return false;
  }

  insert(fp) {
    const reach = Math.hypot(fp.hx, fp.hz);
    const c0 = Math.floor((fp.x - reach) / this.cell);
    const c1 = Math.floor((fp.x + reach) / this.cell);
    const d0 = Math.floor((fp.z - reach) / this.cell);
    const d1 = Math.floor((fp.z + reach) / this.cell);
    for (let cx = c0; cx <= c1; cx++) {
      for (let cz = d0; cz <= d1; cz++) {
        const k = this.key(cx, cz);
        let list = this.map.get(k);
        if (!list) { list = []; this.map.set(k, list); }
        list.push(fp);
      }
    }
  }
}

// Separating Axis Theorem para sa dalawang naka-rotate na rectangles (2D, XZ)
// NOTE: dapat MATCH ang convention sa ColoredMeshBuilder.box():
//   local X axis -> ( cos, -sin ),   local Z axis -> ( sin, cos )
// Kung ibang convention, susiin ang box na "mirror" - mali ang overlap test.
function obbOverlap(a, b) {
  const axes = [
    [a.c, -a.s], [a.s, a.c],
    [b.c, -b.s], [b.s, b.c],
  ];
  for (const [ax, az] of axes) {
    const d = (b.x - a.x) * ax + (b.z - a.z) * az;
    const ra = a.hx * Math.abs(a.c * ax - a.s * az) + a.hz * Math.abs(a.s * ax + a.c * az);
    const rb = b.hx * Math.abs(b.c * ax - b.s * az) + b.hz * Math.abs(b.s * ax + b.c * az);
    if (Math.abs(d) > ra + rb) return false; // may separating axis
  }
  return true;
}

export class Buildings {
  constructor(scene) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.collisionBoxes = [];
    // OBB colliders para sa building (walang lumalabas na AABB corner)
    this.obbColliders = [];
    this.footprints = []; // tunay na OBB footprint ng bawat bahay (para sa audit)
    scene.add(this.group);
  }

  /**
   * @param bounds  {minX,maxX,minZ,maxZ} - kung set, BANGUNO ang mga bahay
   *                na ang CENTROID ay nasa loob ng box (tile build). Ang
   *                kalsada ay sinasagawa pa rin kung dumadaan ito sa box, pero
   *                ang bawat bahay ay ina-assign sa EXACTLY ISANG tile (ang
   *                naglalaman ng kanyang sentro) - kaya walang duplicate at
   *                tuloy-tuloy ang bilang.
   * @param target  THREE.Group na tatanggapin ang mesh.
   */
  build(bounds = null, target = this.group) {
    const mesh = new ColoredMeshBuilder();
    const junctions = getMajorJunctions();
    FRONTAGE.clear();
    // Spatial hash ng mga naglalagay na building (para hindi sila
    // magpapatong-patong sa pagitan ng magkabilang kalsada)
    const occupied = new SpatialHash(8);
    let placed = 0;
    let shops = 0;
    let rejectedOverlap = 0;
    // FIX 3: counter para sa pag-cycle ng facade colors kada lot
    let facadeIdx = 0;

    // Ang bawat kalsada ay may SARILONG RNG stream (seeded mula sa index).
    // FIX 2: dati ay iisang shared na `rnd` na dumadaloy sa lahat ng kalsada -
    // naipupunto iyon sa pagbabago ng bawat bahay depende kung aling tile ang
    // naglalaman nito. Ang per-road stream ay ginagawang TILE-INDEPENDENT at
    // paulit-ulit (deterministic) ang resulta.
    const roadSeed = (ri) => mulberry32((0x4e414e47 ^ Math.imul(ri + 1, 2654435761)) >>> 0);

    ROAD_LINES.forEach((road, ri) => {
      if (!BUILD_CLASSES.has(road.cls)) return;
      // FIX 2: sa tile mode, kailangan ng kalsadang ito na dumadaan sa box
      // (may margin, para hindi maputol ang mga dulo). Sa full-map mode,
      // pinananatili ang dating MAX_RADIUS na LAYO mula sa sentro.
      if (bounds) {
        if (road.maxX < bounds.minX || road.minX > bounds.maxX ||
            road.maxZ < bounds.minZ || road.minZ > bounds.maxZ) return;
      } else if (road.maxX < -MAX_RADIUS || road.minX > MAX_RADIUS ||
                 road.maxZ < -MAX_RADIUS || road.minZ > MAX_RADIUS) return;

      const rnd = roadSeed(ri);
      // FIX 2: counter ng lot sa bawat kalsada - bahagi ng tile-independent
      // na formula ng height slot (tingnan ang HEIGHT_CYCLE sa itaas).
      let lotIdx = 0;
      const major = road.cls === 'primary' || road.cls === 'secondary';
      // --- FIX 2: setback mula sa CURB, 0-0.5 m para sa main roads
      // (commercial right up to the bangketa). Residential: maliit na bakuran.
      const frontBase = major ? 0 : 1.2;
      const frontMax = major ? 0.5 : 1.4;
      // Sidewalk gap: bangketa (per-class, Fix 5) + front setback
      const swGap = road.hasSW ? sidewalkWidth(road.cls) : 0;

      // --- FIX 3: max 3 m gap sa main roads. Instead of a fixed stride, pipiliin
      // muna ng LAPAD ng lot, saka stride = lapad + puwang (<= 3 m) para
      // siksik ang lineup sa Bayan-Bayanan at JP Rizal.
      const GAP_MAX = 3.0;
      for (let d = 8 + rnd() * 6; d < road.len - 8;) {
        // Sukatin ang lot NGUNO (shared sa magkabilang gilid) - magiging
        // max 3 m ang puwang sa pagitan ng magkabilang building.
        const lotW = major ? 8 + rnd() * 6 : 7.5 + rnd() * 4.5;
        // Main roads: max 3 m puwang. Residential: mas malaki angspacing pero
        // siksik pa rin (~11-18 m stride) para hindi bumaba ang bilang ng bahay.
        const gap = major ? rnd() * GAP_MAX : 2 + rnd() * 4;
        for (const side of [1, -1]) {
          // FIX 3: sa main roads HINDI na may random na "bakanteng lote" -
          // dahil lumalampas sa 3 m max gap. Ang puwang ay controlled ng
          // `gap` (0-3 m) sa halip na random na pag-skip.
          if (!major && rnd() < 0.15) continue; // residential: may bakanteng lote
          // primary/secondary = COMMERCIAL (mix ng 1-3 storey, ~0 setback)
          // residential = single-storey house + small fence
          const depth = major ? 9 + rnd() * 4 : 6 + rnd() * 3;
          const width = lotW;
          // --- FIX 3: height mix 30% / 50% / 20% (1/2/3 storey)
          // EXACT quota, hindi ang rng: mahigit na eksakto ang target kahit
          // ilang building. Ang rng na may hawak na prob ay nagbigay ng
          // 34.7/40.0/25.3 (hindi 30/50/20) dahil hindi ito eksaktong
          // uniform sa maliit na sample.
          //
          // FIX 2: ang dating `heightSlot` ay COUNTER NA NAKA-RESET kada
          // build - kaya sa tiling, bawat tile ay nagsisimula ulit sa 4 m at
          // naubos ang share ng 1-storey (35.3% sa halip na 30%).
          //
          // Ang bawat kalsada ay may magkakapantay-pantay na CONSECUTIVE
          // slot (lotIdx*2 + sideIdx) - kaya isang kalsada na may 20 bahay
          // ay may eksaktong 2 bawat taas. Ang PHAZE ng bawat kalsada ay
          // hinahango sa isang hash ng `ri` para hindi sabay-sabay ang
          // lahat ng kalsada. Resulta: TILE-INDEPENDENT (pareho man full-map
          // o per-tile) at malapit sa 30/50/20.
          let height;
          if (major) {
            const phase = ((ri * 2654435761) >>> 0) % HEIGHT_CYCLE.length;
            const slot = (phase + lotIdx * 2 + (side > 0 ? 0 : 1)) % HEIGHT_CYCLE.length;
            height = HEIGHT_CYCLE[slot];
          } else {
            height = 3.2 + rnd() * 1.2;
          }
          // --- FIX 2: setback 0-0.5 m mula sa curb (commercial)
          const front = frontBase + rnd() * frontMax;
          const off = road.half + swGap + front + depth / 2;
          const s = sampleRoad(ri, d, side * off);
          // FIX 2: sa tile mode, DITO napapasok ang bahay - ang kalkuladong
          // sentro ay dapat nasa loob ng tile box. Ito ang nagsisilbing
          // "owner" check: isang bahay lamang ang gumagawa nito, kaya walang
          // kopyahang geometry sa pagitan ng magkabilang tile.
          if (bounds) {
            if (s.x < bounds.minX || s.x > bounds.maxX ||
                s.z < bounds.minZ || s.z > bounds.maxZ) continue;
          } else if (Math.hypot(s.x, s.z) > MAX_RADIUS + 60) continue;
          const halfSize = Math.max(width, depth) / 2;
          if (!safeSpot(s.x, s.z, halfSize, ri)) continue;

          // harap ng bahay = patungo sa kalsada
          const frontDir = { x: -side * s.nX, z: -side * s.nZ };
          const yaw = Math.atan2(frontDir.x, frontDir.z);

          // FIX invisible-wall: ang building ay dapat HINDI dumikit sa drivable
          // lane ng KAHIT ANONG kalsada (kasama na ang sariling likod).
          if (!clearOfCorridors(s.x, s.z, width / 2, depth / 2, yaw, ri)) continue;

          // overlap check vs naunang bahay (magkabilang kalsada / magkapitid)
          const fp = {
            x: s.x, z: s.z,
            hx: width / 2, hz: depth / 2,   // local X = width, local Z = depth
            c: Math.cos(yaw), s: Math.sin(yaw),
          };
          if (occupied.overlaps(fp)) { rejectedOverlap++; continue; }

          // tindahan kung malapit sa intersection o pangunahing kalsada
          // primary/secondary -> laging commercial; residential -> house
          const nearJunction = junctions.some(
            (j) => Math.hypot(j.x - s.x, j.z - s.z) < 32
          );
          const isShop = major || nearJunction;
          // i-record ang tunay na footprint (para sa audit/tools)
          // NOTE: `dAlong` = distansya sa kalsada. Kailangan ng tools/check-lots
          // para sukatin ang tunay na gap (sa XZ maling pagkakasunod).
          this.footprints.push({
            ...fp, w: width, d: depth, h: height, shop: isShop, ri, side, dAlong: d,
          });
          // taas ng lupa sa footprint (para nasa slope ang bahay)
          const groundY = terrainHeight(s.x, s.z);
          // FIX 3: i-cycle ang facade color kada lot (cream/faded blue/
          // salmon/white/yellow) - nag-iikot, hindi random, para organized
          // ang tanaw sa kalsada.
          const wall = FACADE_COLORS[facadeIdx++ % FACADE_COLORS.length];
          // i-record din ang kulay para ma-verify ng tools/check-lots.mjs
          this.footprints[this.footprints.length - 1].wall = wall;
          if (isShop) this.addShop(mesh, s, width, depth, height, yaw, rnd, groundY, wall);
          else this.addHouse(mesh, s, width, depth, height, yaw, rnd, groundY, ri, wall);
          if (isShop) shops++;

          // --- Collision: ORIENTED box (OBB), hindi axis-aligned AABB ---
          // BUG: ang dating AABB (|cos|*w/2 + |sin|*d/2) ay umaabo sa
          // 45° - isang 8.2x6.7 na bahay ay naging 9.9x9.0 na box, at
          // ang mga WALANG LAMANG sulok ng box ay naka-block sa kalsada
          // (invisible wall) kahit walang aktuwal na geometry doon.
          //
          // FIX: itago ang OBB (center + yaw + half-extents) sa isang
          // espesyal na listahan, at gawan ng OBB-vs-AABB test ang
          // Vehicle.checkCollision. Eksakto, at walang bulang espasyo.
          this.obbColliders.push({
            x: s.x, y: groundY + height / 2, z: s.z,
            hx: width / 2, hy: height / 2, hz: depth / 2,
            cos: Math.cos(yaw), sin: Math.sin(yaw),
          });
          // nakatala ang frontage para mapunan ng puno ang mga puwang mamaya
          FRONTAGE.add(ri, side, d - width / 2 - 1, d + width / 2 + 1);
          occupied.insert(fp);
          placed++;
        }
        // --- FIX 3: advance sa susunod na lot (max 3 m puwang sa main roads)
        d += lotW + gap;
        lotIdx++;
      }
    });

    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.85, metalness: 0.0,
    });
    const m = mesh.build(mat);
    target.add(m);
    // FIX 2: sa tile mode, huwag mag-log kada tile (libu-libong linya).
    if (!bounds) {
      console.log(
        `[Buildings] ${placed} na bahay/tindahan (${shops} tindahan), ` +
        `${rejectedOverlap} tinanggap dahil magpapatong-patong, ${mesh.triangles} tris`
      );
    }
    return { placed, shops, tris: mesh.triangles };
  }

  /**
   * Manipis na dumi/lupa (0x7A6A50) sa paanan ng bawat bahay (Fix 2).
   * Sa totoong Marikina, ang lupa sa ilalim ng labas ng bahay ay hubad na
   * lupa o semento - hindi sari-sari na damo. Ito ang pinakahuling "layer"
   * ng transition: kalsada -> curb -> bangketa -> kongkreto -> lupa -> pader.
   */
  addLotStrip(mesh, s, width, depth, yaw, gy) {
    // Isang box lang na 0.55 m palagkit sa lahat ng gilid - makikita pa rin
    // bilang manipis na "balangkas" ng lupa sa palibot ng labas ng bahay.
    // (Ang dating 4 na magkakahiwalay na box ay 4x ang triangles para sa
    // parehong visual result.)
    mesh.box(s.x, gy + 0.02, s.z, width + 1.1, 0.04, depth + 1.1, 0x7a6a50, yaw);
  }

  // Single-storey house (residential streets): box + gable roof + fence
  addHouse(mesh, s, width, depth, height, yaw, rnd, gy = 0, ri = -1, wall = null) {
    const wallC = wall === null ? WALL_COLORS[(rnd() * WALL_COLORS.length) | 0] : wall;
    const roof = pickRoofColor(rnd);
    const c = s.x;
    const z = s.z;
    // katawan
    mesh.box(c, gy + height / 2, z, width, height, depth, wallC, yaw);
    // --- Fix 1: 70% gable (may bubong na makapal), 30% flat concrete.
    // Ang gable ang default sa residential; ang flat ay pang mga -expansion
    // ng original na kubo.
    if (rnd() < 0.7) {
      const rh = 1.2 + rnd() * 0.8;
      mesh.gable(c, gy + height, z, width + 0.6, depth + 0.6, rh, roof, yaw);
    } else {
      // flat roof: slab + parapet ring (0.3 m)
      mesh.box(c, gy + height + 0.1, z, width + 0.4, 0.2, depth + 0.4, roof, yaw);
      const px = Math.cos(yaw);
      const pz = -Math.sin(yaw);
      const fx = Math.sin(yaw);
      const fz = Math.cos(yaw);
      for (const [ox, oz, ww, dd] of [
        [fx * (depth / 2 + 0.1), fz * (depth / 2 + 0.1), width + 0.4, 0.2],
        [-fx * (depth / 2 + 0.1), -fz * (depth / 2 + 0.1), width + 0.4, 0.2],
        [px * (width / 2 + 0.1), pz * (width / 2 + 0.1), 0.2, depth + 0.4],
        [-px * (width / 2 + 0.1), -pz * (width / 2 + 0.1), 0.2, depth + 0.4],
      ]) {
        mesh.box(c + ox, gy + height + 0.35, z + oz, ww, 0.3, dd, roof, yaw);
      }
    }
    // lupa sa ilalim ng labas (Fix 2)
    this.addLotStrip(mesh, s, width, depth, yaw, gy);
    // harap: pinto + dalawang bintana
    const frontX = c + Math.sin(yaw) * (depth / 2 + 0.03);
    const frontZ = z + Math.cos(yaw) * (depth / 2 + 0.03);
    // --- Fix 3: recessed darker gate/door (0x333333, 1.2 m x 2 m)
    mesh.box(frontX, gy + 1.0, frontZ, 1.2, 2.0, 0.05, 0x333333, yaw);
    const winY = gy + 1.9;
    const sideOff = width * 0.3;
    const px = Math.cos(yaw);
    const pz = -Math.sin(yaw);
    for (const so of [-sideOff, sideOff]) {
      mesh.box(frontX + px * so, winY, frontZ + pz * so, 1.1, 1.0, 0.06, 0x9ec9e2, yaw);
      // grille sa bintana (Fix 3): 4 na manipis na vertikal na strip
      for (let k = -1; k <= 1; k++) {
        mesh.box(frontX + px * (so + k * 0.28), winY, frontZ + pz * (so + k * 0.28),
          0.05, 1.0, 0.08, 0x6b6b6b, yaw);
      }
    }
    // Maliit na bakuran (fence) sa may-front - tanda ng residential
    const rd = ROAD_LINES[ri];
    if (rd && rd.cls !== 'primary' && rd.cls !== 'secondary') {
      this.addFence(mesh, s, width, depth, height, yaw, gy, rnd);
    }
  }

  // Fix 3: bakuran na HOLLOW BLOCK (CHB) - 0.8 m, grey 0xAAAAAA, may maliit
  // na bakantang pintuan (gate opening) sa gitna. Ang dating 1.5 m na
  // "bakuran" ay masyadong mataas at walang pintuan - hindi ito lumalabas
  // sa tunay na Marikina.
  addFence(mesh, s, width, depth, height, yaw, gy, rnd) {
    const c = s.x;
    const z = s.z;
    const px = Math.cos(yaw);
    const pz = -Math.sin(yaw);
    const fx = Math.sin(yaw);
    const fz = Math.cos(yaw);
    // setback ng bakuran mula sa harap ng bahay (~1.2 m)
    const off = depth / 2 + 1.2;
    const fenceX = c + fx * off;
    const fenceZ = z + fz * off;
    const halfW = width / 2 + 0.6;
    const fh = 0.8;          // Fix 3: 0.8 m (spec), dating 1.5 m
    const gate = 1.1;        // lapad ng pintuan
    const t = 0.12;          // kapal ng CHB
    // dalawang pader na may bakantang pintuan sa gitna
    const segW = (halfW * 2 - gate) / 2;
    if (segW > 0.15) {
      for (const so of [-(gate / 2 + segW / 2), gate / 2 + segW / 2]) {
        mesh.box(fenceX + px * so, gy + fh / 2, fenceZ + pz * so, segW, fh, t, 0xaaaaaa, yaw);
      }
    }
    // dalawang poste sa dulo (mas mataas - CHB pillar)
    for (const so of [-halfW, halfW]) {
      mesh.box(fenceX + px * so, gy + fh / 2 + 0.1, fenceZ + pz * so, 0.2, fh + 0.2, 0.2, 0x8f8f8f, yaw);
    }
    // Fix 5: pambihagang tanim sa gilid ng bakuran (luntian na bola sa sunggit)
    if (rnd() < 0.35) {
      const pxo = -halfW * 0.65;
      const potX = fenceX + px * pxo;
      const potZ = fenceZ + pz * pxo;
      mesh.box(potX, gy + 0.18, potZ, 0.3, 0.36, 0.3, 0x9c6b3f, yaw);
      // NOTE: ang signature ng blob() ay (cx,cy,cz,rx,ry,rz, seg, rings, color)
      mesh.blob(potX, gy + 0.55, potZ, 0.3, 0.3, 0.3, 6, 4, 0x4f7a3a);
    }
  }

  // Commercial (primary/secondary): 1-3 storey, zero setback, signage + awning
  addShop(mesh, s, width, depth, height, yaw, rnd, gy = 0, wall = null) {
    const wallC = wall === null ? WALL_COLORS[(rnd() * WALL_COLORS.length) | 0] : wall;
    const sign = SIGN_COLORS[(rnd() * SIGN_COLORS.length) | 0];
    const c = s.x;
    const z = s.z;
    const h = Math.max(height, 3.6);
    mesh.box(c, gy + h / 2, z, width, h, depth, wallC, yaw);
    const px = Math.cos(yaw);
    const pz = -Math.sin(yaw);
    const fx = Math.sin(yaw);   // outward (tungo sa kalsada)
    const fz = Math.cos(yaw);
    // --- Fix 1: patagong BETON na bubong + mababang parapet wall.
    // Ang commercial buildings sa main road ay halos walang pitched roof -
    // flat slab na may 0.5 m na parapet sa palibot (laban sa tubig).
    const slab = 0xc8c8c8;
    mesh.box(c, gy + h + 0.12, z, width + 0.4, 0.24, depth + 0.4, slab, yaw);
    const par = 0.5;           // taas ng parapet
    const pt = 0.16;           // kapal
    for (const [ox, oz, ww, dd] of [
      [fx * (depth / 2 + 0.12), fz * (depth / 2 + 0.12), width + 0.4, pt],
      [-fx * (depth / 2 + 0.12), -fz * (depth / 2 + 0.12), width + 0.4, pt],
      [px * (width / 2 + 0.12), pz * (width / 2 + 0.12), pt, depth + 0.4],
      [-px * (width / 2 + 0.12), -pz * (width / 2 + 0.12), pt, depth + 0.4],
    ]) {
      mesh.box(c + ox, gy + h + 0.24 + par / 2, z + oz, ww, par, dd, 0xd4d4d4, yaw);
    }
    // lupa sa ilalim ng labas (Fix 2)
    this.addLotStrip(mesh, s, width, depth, yaw, gy);

    // --- Fix 3: SARI-SARI STORE character --------------------------------
    // Ground floor: dalawang maliit na bintana (0.8 x 0.8 m) na may
    //   - manipis na frame
    //   - counter (0.4 m deep, 0.8 m tall) sa ilalim
    //   - security grille (0.05 m na vertikal na strip)
    // Ito ang TINDAHAN - hindi na malaking salamin na storefront lang.
    const frontX = c + fx * (depth / 2 + 0.03);
    const frontZ = z + fz * (depth / 2 + 0.03);
    const winOff = width * 0.24;   // +-24% ng lapad mula sa gitna
    for (const so of [-winOff, winOff]) {
      const wx = frontX + px * so;
      const wz = frontZ + pz * so;
      const wy = gy + 1.5;
      // frame (4 na manipis na box) - 0.06 m
      const F = 0.06;
      mesh.box(wx, wy + 0.4 + F / 2, wz, 0.8 + F * 2, F, 0.09, 0x7a5c3e, yaw);
      mesh.box(wx, wy - 0.4 - F / 2, wz, 0.8 + F * 2, F, 0.09, 0x7a5c3e, yaw);
      mesh.box(wx + px * (0.4 + F / 2), wy, wz + pz * (0.4 + F / 2), F, 0.8, 0.09, 0x7a5c3e, yaw);
      mesh.box(wx - px * (0.4 + F / 2), wy, wz - pz * (0.4 + F / 2), F, 0.8, 0.09, 0x7a5c3e, yaw);
      // dark opening
      mesh.box(wx, wy, wz, 0.8, 0.8, 0.04, 0x2b2b2b, yaw);
      // security grille: 0.05 m na strip, 4.5 px apart
      for (let k = -1; k <= 1; k++) {
        mesh.box(wx + px * k * 0.24, wy, wz + pz * k * 0.24, 0.05, 0.8, 0.07, 0x5f5f5f, yaw);
      }
      // counter: 0.4 m deep, 0.8 m tall, sa ilalim ng bintana
      mesh.box(
        wx + fx * 0.2, gy + 0.4, wz + fz * 0.2,
        0.9, 0.8, 0.4, 0x6b4f35, yaw
      );
    }
    // recessed gate/door (Fix 3: 0x333333, 1.2 m x 2 m) - gitna ng facade
    mesh.box(frontX, gy + 1.0, frontZ, 1.2, 2.0, 0.05, 0x333333, yaw);
    // signage strip sa itaas ng pinto
    mesh.box(frontX, gy + h - 0.5, frontZ, width * 0.8, 0.8, 0.1, sign, yaw);

    // --- Fix 3: TARP AULIN banners (0.8 m tall, 2-4 m sa pader).
    // 1-2 kada tindahan. Ang mga ito ang pinakabukas na tanda ng
    // Filipino commercial street - maliwanag, patagong tela sa pader.
    const nTarp = 1 + ((rnd() * 2) | 0);
    for (let i = 0; i < nTarp; i++) {
      const tw = Math.min(width * 0.42, 1.6 + rnd() * 1.6);
      const to = (rnd() * 2 - 1) * (width / 2 - tw / 2 - 0.25);
      const ty = gy + 2.0 + rnd() * 2.0; // 2-4 m
      if (ty > gy + h - 0.9) continue;   // huwag takpan ang signage
      mesh.box(
        frontX + px * to + fx * 0.05, ty, frontZ + pz * to + fz * 0.05,
        tw, 0.8, 0.05, TARP_COLORS[(rnd() * TARP_COLORS.length) | 0], yaw
      );
    }

    // awning (slanted strip) - normal ay tilted: pataas + outward
    const awH = 2.6 + gy;
    const out = 1.2;
    const ox = Math.sin(yaw);
    const oz = Math.cos(yaw);
    // slope (0, -0.4, 1.2) sa (y, outward) -> normal (0, 1.2, 0.4)
    const awN = [ox * 0.4, 1.2, oz * 0.4];
    mesh.quad(
      [frontX + px * (-width / 2), awH, frontZ + pz * (-width / 2)],
      [frontX + px * (width / 2), awH, frontZ + pz * (width / 2)],
      [frontX + px * (width / 2) + ox * out, awH - 0.4, frontZ + pz * (width / 2) + oz * out],
      [frontX + px * (-width / 2) + ox * out, awH - 0.4, frontZ + pz * (-width / 2) + oz * out],
      sign, awN
    );
  }

  getCollisionBoxes() { return this.collisionBoxes; }
  getObbColliders() { return this.obbColliders; }
}


