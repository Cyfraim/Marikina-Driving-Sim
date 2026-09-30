// ---------------------------------------------------------------------------
// StreetObjects.js - Mga bagay sa kalye ng Nangka
//
// - Electric posts na may overhead wires (ikoniko sa Pinoy na kalye!)
// - Street lights sa pangunahing kalsada
// - Open drainage canals sa gilid ng mga pangunahing kalsada
// - Road signs sa mga intersection
// - Mga NPC na naka-parada: tricycle (terminal sa kanto) at jeepney
//
// Lahat ay merged sa 3 draw calls: furniture mesh, NPC mesh, wire lines.
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { ColoredMeshBuilder } from '../utils/coloredMesh.js';
import { terrainHeight } from '../utils/geo.js';
import {
  ROAD_LINES, sampleRoad, curbsideSpot, npcSpot, nearestDistanceOnRoad,
  getMajorJunctions, mulberry32, SW_WIDTH, sidewalkWidth, distToPolyline,
  npcClearOfLanes,
  pickSpawnRoad,
} from '../utils/roadLayout.js';

const POST = 0x7a6a55;        // semento/kahoy na poste
const POST_ARM = 0x5d4e3c;
const WIRE_COLOR = 0x141414;
const LIGHT_POLE = 0x4a4a4a;
const LIGHT_HEAD = 0xfff3b0;
const CANAL_WALL = 0x8a8a80;  // semento ng kanal
const CANAL_BOTTOM = 0x1c1c1c; // madilim na tubig/drain
const SIGN_BLUE = 0x1565c0;
const TRIKE_BLUE = 0x1e88e5;
const TRIKE_SIDE = 0x0d47a1;
const JEEP_BODY = 0xef6c00;
const JEEP_ROOF = 0xbdbdbd;
const TIRE = 0x1a1a1a;

const FURNITURE_CLASSES = new Set([
  'primary', 'secondary', 'tertiary', 'residential', 'unclassified', 'living_street',
]);
const MAJOR = new Set(['primary', 'secondary', 'tertiary']);
const CANAL_RADIUS = 350;

/**
 * Clearance NG MGA POSTE/ILAW/SIGN mula sa gilid ng kalsada, para hindi
 * mabisang ang kalsada. Ito ang "invisible wall" fix.
 *
 * BUG NA HINULING: ang dating offset ay 0.95 m - nasa loob mismo ng travel
 * lane. Hindi yan ang tunay na rule.
 *
 * TAMANG RULE: kapag nasa dulo ng lane (centerline +- half), ang kotse ay
 * umaabot sa +-(half + 1.0) dahil half-width ng kotse ay 1.0 m. Ang poste
 * ay dapat nasa labas nito. Ang clearance mula sa centerline ay `half + c`,
 * kaya:
 *     half + c >= half + 1.0 (kotse) + 0.25 (poste) + 0.35 (margen)
 *   => c >= 1.6
 * Ibig sabihin: 1.6 = 1.0 (kotse) + 0.25 (poste) + 0.35 (margen).
 * Tingnan: tools/check-corridor.mjs
 */
const FURNITURE_CLEAR = 1.6;

// --- Fix 5: mga bagay na nasa bangketa -----------------------------------
// Ang dating bangketa ay walang laman - malinis at patag. Sa totoong
// Nangka, puno ng abala ang sidewalk: utility box, nakatiyaking bisikleta,
// at street food cart. Sila ang nagbibigay ng buhay sa kalye.
const UTILITY_BOX = 0x8a8a8a;   // kahayag/kahon sa gilid ng kalsada
const BICYCLE = 0x2e5c8a;       // aswang bisikleta
const CART_BODY = 0x8d6e63;     // katawan ng cart
const UMBRELLA = 0xffcc00;      // parasol (payag na yellow)

/**
 * Per-road RNG stream (seeded mula sa road index).
 * FIX 2: bakit per-road at hindi isang shared na rnd? Dahil ang placement
 * ay TILE-INDEPENDENT - kung shared, magbabago ang resulta depende kung
 * aling tile ang naka-load. Per-road stream => pareho man full-map o
 * per-tile, at paulit-ulit (deterministic) ang resulta.
 */
const roadSeed = (ri) => mulberry32((0x5354524f ^ Math.imul(ri + 1, 2654435761)) >>> 0);

export class StreetObjects {
  constructor(scene) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.collisionBoxes = [];
    this.wireVerts = []; // para sa LineSegments
    scene.add(this.group);
  }

  // --- Fix 5: mga abala sa bangketa ---------------------------------------

  /** Utility/kahayag box (0.4 x 0.5 x 0.4 m) - tuwing 40-60 m. */
  addUtilityBox(mesh, x, z, gy, yaw) {
    mesh.box(x, gy + 0.25, z, 0.4, 0.5, 0.4, UTILITY_BOX, yaw);
    mesh.box(x, gy + 0.52, z, 0.28, 0.04, 0.28, 0x6f6f6f, yaw);
  }

  /** Nakatiyang bisikleta - L-shape na sumasabi sa gilid ng pader. */
  addBicycle(mesh, x, z, gy, yaw) {
    const px = Math.cos(yaw);
    const pz = -Math.sin(yaw);
    mesh.wheel(x, gy + 0.34, z, 0.34, 0.05, 7, TIRE, yaw + Math.PI / 2);
    mesh.box(x, gy + 0.42, z, 0.1, 0.08, 1.1, BICYCLE, yaw);
    // upat na handlebar (nakaharap sa pader)
    mesh.box(x + px * 0.22, gy + 0.72, z + pz * 0.22, 0.08, 0.62, 0.08, BICYCLE, yaw);
  }

  /** Street food cart: katawan + gulong + payag na parasol. */
  addFoodCart(mesh, x, z, gy, yaw) {
    const px = Math.cos(yaw);
    const pz = -Math.sin(yaw);
    mesh.box(x, gy + 0.55, z, 0.9, 0.7, 1.6, CART_BODY, yaw);
    mesh.box(x, gy + 0.92, z, 1.0, 0.06, 1.7, 0xa1887f, yaw);
    for (const so of [-0.32, 0.32]) {
      for (const sz of [-0.55, 0.55]) {
        mesh.wheel(x + px * so, gy + 0.18, z + pz * so, 0.18, 0.07, 6, TIRE, yaw);
      }
    }
    mesh.box(x, gy + 1.35, z, 0.06, 1.5, 0.06, 0x666666, yaw);
    // NOTE: ang parasol ay CONE (cylinder na tapering), hindi blob. Ang
    // blob() ay ellipsoid - sa sobrang patag na ellipsoid (ry << rx) mali
    // ang normal sa mga pole (naka-"perp" sa face), kaya nang may-bisang
    // ito. Ang cone ay may tamang patag na normal sa bawat panig.
    mesh.cylinder(x, gy + 2.02, z, 0.62, 0.06, 0.34, 8, UMBRELLA, yaw);
  }

  /**
   * Fix 5 - mga abala sa bangketa. Bawat isa ay may sariling cadence
   * (spec): utility box 40-60 m, bisikleta ~80 m, cart 100-150 m sa main
   * roads lamang. Ang "phase" ay mula sa road index para hindi sabay-sabay
   * ang unang isa sa lahat ng kalsada.
   */
  addSidewalkClutter(mesh, road, ri, bounds = null) {
    const sw = road.hasSW ? sidewalkWidth(road.cls) : 0;
    if (sw <= 0) return 0;
    const rnd = roadSeed(ri ^ 0x1de1);
    const major = road.cls === 'primary' || road.cls === 'secondary';
    // gitna ng bangketa (hindi sa gilid - dapat walkable pa rin)
    const off = road.half + sw * 0.5;
    let n = 0;
    const phase = rnd() * 50;
    // FIX 2 (tile): ang bawat bagay ay "owned" ng eksaktong isang tile -
    // kung hindi, magkakaroon ng kopyahang geometry sa tile border.
    const owned = (s) => !bounds || (s.x >= bounds.minX && s.x <= bounds.maxX &&
      s.z >= bounds.minZ && s.z <= bounds.maxZ);

    for (let d = phase; d < road.len - 8; d += 40 + rnd() * 20) {
      const side = rnd() < 0.5 ? 1 : -1;
      const s = sampleRoad(ri, d, side * (off + (rnd() - 0.5) * 0.4));
      if (!owned(s)) continue;
      if (!curbsideSpot(s.x, s.z, ri, 0.3)) continue;
      this.addUtilityBox(mesh, s.x, s.z, terrainHeight(s.x, s.z), Math.atan2(s.nX, s.nZ));
      n++;
    }
    for (let d = phase * 0.6; d < road.len - 8; d += 80 + rnd() * 30) {
      const side = rnd() < 0.5 ? 1 : -1;
      const s = sampleRoad(ri, d, side * off);
      if (!owned(s)) continue;
      if (!curbsideSpot(s.x, s.z, ri, 0.3)) continue;
      this.addBicycle(mesh, s.x, s.z, terrainHeight(s.x, s.z),
        Math.atan2(s.nX, s.nZ) + (side > 0 ? 0 : Math.PI));
      n++;
    }
    if (major) {
      for (let d = phase * 0.3; d < road.len - 10; d += 100 + rnd() * 50) {
        const side = rnd() < 0.5 ? 1 : -1;
        const s = sampleRoad(ri, d, side * off);
        if (!owned(s)) continue;
        if (!curbsideSpot(s.x, s.z, ri, 0.6)) continue;
        this.addFoodCart(mesh, s.x, s.z, terrainHeight(s.x, s.z),
          Math.atan2(s.nX, s.nZ) + (side > 0 ? 0 : Math.PI));
        n++;
      }
    }
    return n;
  }

  /**
   * @param bounds  {minX,maxX,minZ,maxZ} - kung set, ang POSTE/NAKAPARK na
   *                ang sentro ay nasa loob ng box ang gagawin (tile build).
   * @param target  THREE.Group na tatanggapin ang mga mesh.
   */
  build(bounds = null, target = this.group) {
    const furniture = new ColoredMeshBuilder(); // poste, ilaw, kanal, sign
    const npc = new ColoredMeshBuilder();       // tricycle, jeepney
    let postCount = 0;
    let lightCount = 0;
    let canalRows = 0;
    let signCount = 0;
    let clutterCount = 0; // Fix 5: abala sa bangketa
    let vehicleCount = 0;

    // FIX 2: per-road RNG stream (seeded mula sa index) para TILE-INDEPENDENT
    // at paulit-ulit ang placement. Isang shared na rnd ang dating gamit -
    // naipupunto iyon sa pagbabago ng bawat poste/sasakyan depende sa tile.
    // --- 1) Electric posts + overhead wires ------------------------------
    ROAD_LINES.forEach((road, ri) => {
      if (!FURNITURE_CLASSES.has(road.cls)) return;
      if (bounds) {
        if (road.maxX < bounds.minX || road.minX > bounds.maxX ||
            road.maxZ < bounds.minZ || road.minZ > bounds.maxZ) return;
      }
      const rnd = roadSeed(ri);
      // FIX invisible-wall: clearance para sa post/ilaw (tingnan ang
      // FURNITURE_CLEAR sa itaas para sa derivation).
      const FURN = FURNITURE_CLEAR;
      const posts = { 1: [], '-1': [] }; // kada side, may `d` para ma-pair

      for (let d = 12; d < road.len - 12; d += 34 + rnd() * 10) {
        for (const side of [1, -1]) {
          // FIX invisible-wall: ang poste ay dapat HINDI sa loob ng drivable
          // lane (tingnan FURNITURE_CLEAR).
          const off = road.half + FURN;
          const s = sampleRoad(ri, d, side * off);
          // FIX 2: owner check - ang sentro ng poste ang tinutukoy ng tile.
          if (bounds) {
            if (s.x < bounds.minX || s.x > bounds.maxX ||
                s.z < bounds.minZ || s.z > bounds.maxZ) continue;
          }
          if (!curbsideSpot(s.x, s.z, ri, 0.4)) continue;
          this.post(furniture, s.x, s.z, rnd);
          posts[side].push({ d, x: s.x, z: s.z, nX: s.nX, nZ: s.nZ, y: terrainHeight(s.x, s.z) + 6.5 });
          this.collisionBoxes.push(
            new THREE.Box3().setFromCenterAndSize(
              new THREE.Vector3(s.x, posts[side][posts[side].length - 1].y - 3, s.z),
              new THREE.Vector3(0.5, 7, 0.5)
            )
          );
          postCount++;
        }
        // cross-wire: parehong poste sa magkabilang gilid sa parehong d
        const L = posts[1][posts[1].length - 1];
        const R = posts['-1'][posts['-1'].length - 1];
        if (L && R && Math.abs(L.d - R.d) < 1.5) {
          // wire na tumatawid sa ibabaw ng kalsada (meron sa totoong Nangka)
          this.addWire([L.x, L.y, L.z], [R.x, R.y, R.z], 0.9);
        }
      }

      // wire sa magkatabing poste sa parehang gilid
      for (const side of [1, -1]) {
        const list = posts[side];
        for (let i = 1; i < list.length; i++) {
          const a = list[i - 1];
          const b = list[i];
          const span = Math.hypot(b.x - a.x, b.z - a.z);
          if (span > 50) continue; // masyadong malayo = hindi na idadagit
          const sag = Math.min(1.1, span * 0.035);
          // dalawang power line sa may insulator (Â±0.45 sa normal)
          for (const lat of [-0.45, 0.45]) {
            this.addWire(
              [a.x + a.nX * lat, a.y, a.z + a.nZ * lat],
              [b.x + b.nX * lat, b.y, b.z + b.nZ * lat],
              sag
            );
          }
          // telecom cable, bahagyang mas mababa at lasog
          this.addWire([a.x, a.y - 0.6, a.z], [b.x, b.y - 0.6, b.z], sag * 1.4);
        }
      }

      // --- Fix 5: mga abala sa bangketa (utility box, bisikleta, cart) ----
      clutterCount += this.addSidewalkClutter(furniture, road, ri, bounds);
    });

    // --- 2) Street lights (pangunahing kalsada, isang gilid) --------------
    ROAD_LINES.forEach((road, ri) => {
      if (!MAJOR.has(road.cls)) return;
      if (bounds) {
        if (road.maxX < bounds.minX || road.minX > bounds.maxX ||
            road.maxZ < bounds.minZ || road.minZ > bounds.maxZ) return;
      }
      for (let d = 18, k = 0; d < road.len - 18; d += 55, k++) {
        const side = k % 2 === 0 ? 1 : -1;
        // FIX invisible-wall: same clearance bilang poste
        const off = road.half + FURNITURE_CLEAR;
        const s = sampleRoad(ri, d, side * off);
        if (bounds && (s.x < bounds.minX || s.x > bounds.maxX ||
                       s.z < bounds.minZ || s.z > bounds.maxZ)) continue;
        if (!curbsideSpot(s.x, s.z, ri, 0.4)) continue;
        this.streetLight(furniture, s, side);
        lightCount++;
      }
    });

    // --- 3) Open drainage canals sa gilid ng pangunahing kalsada ---------
    ROAD_LINES.forEach((road, ri) => {
      if (!MAJOR.has(road.cls) || road.len < 20) return;
      if (bounds) {
        if (road.maxX < bounds.minX || road.minX > bounds.maxX ||
            road.maxZ < bounds.minZ || road.minZ > bounds.maxZ) return;
      }
      // primary/secondary: dalawang gilid; tertiary: isang gilid lang
      const sides = road.cls === 'tertiary' ? [1] : [1, -1];
      const sw = road.hasSW ? sidewalkWidth(road.cls) : 0;
      for (const side of sides) {
        const rows = [];
        for (let d = 6; d < road.len - 6; d += 4) {
          const off = road.half + sw + 0.45; // gitna ng canal (0.9 m lapad)
          const s = sampleRoad(ri, d, side * off);
          // FIX 2: sa tile mode, ang labas sa box ay naghahati ng run - kaya
          // natatapos ang canal sa tile border at magpapatuloy sa next tile.
          if (bounds && (s.x < bounds.minX || s.x > bounds.maxX ||
                         s.z < bounds.minZ || s.z > bounds.maxZ)) { rows.push(null); continue; }
          rows.push(curbsideSpot(s.x, s.z, ri, 0.8) ? s : null);
        }
        let run = [];
        const flush = () => {
          if (run.length >= 2) { this.canalSegment(furniture, run, side); canalRows += run.length; }
          run = [];
        };
        for (const r of rows) { if (r) run.push(r); else flush(); }
        flush();
      }
    });

    // --- 4) Road signs sa mga malalaking intersection --------------------
    const junctions = getMajorJunctions();
    for (let ji = 0; ji < junctions.length; ji++) {
      const j = junctions[ji];
      if (Math.hypot(j.x, j.z) < 55) continue; // malayo sa spawn
      if (signCount >= 14) break;
      const along = nearestDistanceOnRoad(j.a, j.x, j.z).along + 9;
      const road = ROAD_LINES[j.a];
      if (along > road.len - 6) continue;
      // FIX invisible-wall: same clearance bilang poste
      const s = sampleRoad(j.a, along, road.half + FURNITURE_CLEAR);
      if (bounds && (s.x < bounds.minX || s.x > bounds.maxX ||
                     s.z < bounds.minZ || s.z > bounds.maxZ)) continue;
      if (!curbsideSpot(s.x, s.z, j.a, 0.5)) continue;
      this.roadSign(furniture, s.x, s.z, s.yaw);
      signCount++;
    }

    // --- 5) Mga NPC na naka-parada: tricycle + jeepney -------------------
    // FIX 4: (a) curbside - malapit sa gilid ng kalsada, hindi na 5-10 m na
    //           setback; (b) 3-4 na trike sa CLUSTER sa bawat intersection
    //           (terminal style); (c) may cluster sa tabi ng spawn.
    // FIX invisible-wall: dapat nasa labas ng drivable LANE, gaya ng poste.
    // Ang naka-park na sasakyan ay may HABA (tricycle 3.2 m, jeepney 4.6 m)
    // kaya kailangan ang clearance = half-lane + half-length ng sasakyan.
    //   tricycle: 1.0 (kotse) + 0.9 (half ng 1.8) + 0.4 = 2.3 -> gamitin 2.4
    //   jeepney:  1.0 (kotse) + 1.2 (half ng 2.4) + 0.4 = 2.6 -> +2.3 half-len
    const GUTTER = 2.4;
    const JEEPNEY_HALF_LEN = 2.3;
    let terminals = 0;
    // FIX 4c: pinili ang mga junction MUNA malapit sa spawn (para visible),
    //         saka ang malalayo. Ito ang spawn-visible tricycle cluster.
    const junctionsBySpawn = [...junctions].sort(
      (p, q) => Math.hypot(p.x, p.z) - Math.hypot(q.x, q.z)
    );
    for (let ji = 0; ji < junctionsBySpawn.length; ji++) {
      const j = junctionsBySpawn[ji];
      // FIX 2: per-junction RNG (hindi shared) para TILE-INDEPENDENT ang
      // placement ng tricycle cluster.
      const rnd = mulberry32((0x4a554e43 ^ Math.imul(ji + 1, 2654435761)) >>> 0);
      // hanggang 14 na terminal (dati 5) - mas maraming terminal style cluster
      if (terminals >= 18) break;
      if (rnd() < 0.15) continue;
      const road = ROAD_LINES[j.a];
      const base = nearestDistanceOnRoad(j.a, j.x, j.z).along;
      const cluster = 3 + (rnd() < 0.45 ? 1 : 0);
      const dir = rnd() < 0.5 ? 1 : -1; // direksyon ng pila
      const side = rnd() < 0.5 ? 1 : -1; // kumbaka sa kalsada
      let okCount = 0;
      // FIX 4b: hanggang 8 posisyon ang tinatrabaho para sigurado nang
      // MAKAPAG-3 (dati 4 lang at madalas <3 dahil tinatanggap lang ng npcSpot).
      for (let i = 0; i < 8 && okCount < cluster; i++) {
        // 7 m mula sa kanto (lalabas na sa junction zone), spacing 3.2 m
        const d = base + dir * (7 + i * 3.2);
        if (d > road.len - 5 || d < 4) continue;
        // FIX 4a + invisible-wall: labas ng lane (half + 2.4 m), sa bangketa.
        // Ang curbsideSpot(0.3) ay nagpapahintulot sa loob ng bangketa, kaya
        // maaaring malapit pa sa lane edge. Idagdag ang karagdagang push
        // para sigurado sa labas ng clearance.
        const s = sampleRoad(j.a, d, side * (road.half + GUTTER + 0.5));
        if (!curbsideSpot(s.x, s.z, j.a, 0.3)) continue;
        // FIX invisible-wall: labas din sa lane ng katabing kalsada.
        // NOTE: kung may opsyon, gamitin ang mas malayo (2.4 -> 3.2 m).
        // Kung wala, TANGGAHIN - hindi hadlang ang pagkakaroon ng tricycle.
        let sUse = s;
        if (!npcClearOfLanes(s.x, s.z, 0.9)) {
          const s2 = sampleRoad(j.a, d, side * (road.half + GUTTER + 1.4));
          if (!curbsideSpot(s2.x, s2.z, j.a, 0.3)) continue;
          if (!npcClearOfLanes(s2.x, s2.z, 0.9)) continue;
          sUse = s2;
        }
        // FIX 2: owner check - ang sentro ng tricycle ang tinutukoy ng tile.
        if (bounds && (sUse.x < bounds.minX || sUse.x > bounds.maxX ||
                       sUse.z < bounds.minZ || sUse.z > bounds.maxZ)) continue;
        this.tricycle(npc, sUse.x, sUse.z, sUse.yaw);
        this.collisionBoxes.push(
          new THREE.Box3().setFromCenterAndSize(
            new THREE.Vector3(sUse.x, terrainHeight(sUse.x, sUse.z) + 1.0, sUse.z),
            new THREE.Vector3(1.8, 2.0, 3.2)
          )
        );
        vehicleCount++;
        okCount++;
      }
      if (okCount >= 3) terminals++;
    }
    // 5a-bis) FIX 4c: SPAWN-VISIBLE tricycle row. Ang pinakamalapit na
    // junction ay ~188 m mula sa spawn, kaya kailangan ng malinaw na
    // curbside row sa tabi ng kalsadang spawn (Bayan-Bayanan) upang makita
    // agad ng player ang mga tricycle.
    {
      // FIX 2: gamitin ang PAREHONG kalsada ng pinipili ng Vehicle
      // (pickSpawnRoad) - dati ay "pinakamalapit sa (0,0)" ito, habang ang
      // kotse ay naka-spawn sa "pinakamahabang arteryal sa buong mapa" -
      // dalawang magkaibang kalsada, kaya walang tricycle na nakikita.
      const spawnLine = pickSpawnRoad();
      if (spawnLine) {
        const ri = ROAD_LINES.indexOf(spawnLine);
        const road = spawnLine;
        // Ang base ay ang projection ng CENTER ng mapa (0,0) sa kalsadang ito -
        // doon din naka-spawn ang kotse (spawnRoadInfo ay humihili ng vertex
        // na pinakamalapit sa origin). Kaya ang tricycle row ay 24-60 m lang
        // mula sa kotse. NOTE: huwag gamitin ang simula ng kalsada - sa
        // 4,836 m na J. P. Rizal, malayong iyon at literal na 3 km ang layo.
        const base = nearestDistanceOnRoad(ri, 0, 0).along;
        // dalawang panig, 3-4 bawat isa, 24-60 m mula sa spawn point
        // FIX 2: sariling RNG para sa spawn row (tile-independent).
        const spawnRnd = mulberry32(0x53504157); // "SPAW"
        for (const side of [1, -1]) {
          const n = 3 + ((spawnRnd() < 0.5) ? 1 : 0);
          for (let i = 0; i < n; i++) {
            const d = base + side * (24 + i * 3.4);
            if (d < 6 || d > road.len - 6) continue;
            const s = sampleRoad(ri, d, side * (road.half + GUTTER + 0.5));
            if (!curbsideSpot(s.x, s.z, ri, 0.3)) continue;
            // Kung ang unang posisyon ay nasa lane ng katabi, subukan ang
            // mas malayo. Kung pareho ay nasa loob, ituloy - ang tricycle ay
            // kailangan man naman para sa itsura.
            let sUse = s;
            if (!npcClearOfLanes(s.x, s.z, 0.9)) {
              const s2 = sampleRoad(ri, d, side * (road.half + GUTTER + 1.4));
              if (curbsideSpot(s2.x, s2.z, ri, 0.3) && npcClearOfLanes(s2.x, s2.z, 0.9)) sUse = s2;
            }
            // FIX 2: owner check para sa spawn row.
            if (bounds && (sUse.x < bounds.minX || sUse.x > bounds.maxX ||
                           sUse.z < bounds.minZ || sUse.z > bounds.maxZ)) continue;
            this.tricycle(npc, sUse.x, sUse.z, sUse.yaw);
            this.collisionBoxes.push(
              new THREE.Box3().setFromCenterAndSize(
                new THREE.Vector3(sUse.x, terrainHeight(sUse.x, sUse.z) + 1.0, sUse.z),
                new THREE.Vector3(1.8, 2.0, 3.2)
              )
            );
            vehicleCount++;
          }
        }
      }
    }

    // 5b) Nagkalat na naka-paradang jeepney/tricycle sa gilid (curbside)
    ROAD_LINES.forEach((road, ri) => {
      if (!MAJOR.has(road.cls)) return;
      if (bounds) {
        if (road.maxX < bounds.minX || road.minX > bounds.maxX ||
            road.maxZ < bounds.minZ || road.minZ > bounds.maxZ) return;
      }
      const rnd = roadSeed(ri);
      for (let d = 30; d < road.len - 30; d += 38 + rnd() * 20) {
        if (rnd() > 0.4) continue;
        const side = rnd() < 0.5 ? 1 : -1;
        // FIX 4a + invisible-wall: labas ng lane, sa bangketa. Ang jeepney
        // ay humihawak ng 2.3 m sa unduhan kaya kailangan pa itong idagdag.
        const isJeep = rnd() >= 0.55;
        const off = road.half + GUTTER + 0.5 + (isJeep ? JEEPNEY_HALF_LEN : 0);
        const s = sampleRoad(ri, d, side * off);
        // FIX 2: owner check - ang sentro ng sasakyan ang tinutukoy ng tile.
        if (bounds && (s.x < bounds.minX || s.x > bounds.maxX ||
                       s.z < bounds.minZ || s.z > bounds.maxZ)) continue;
        if (!curbsideSpot(s.x, s.z, ri, 0.3)) continue;
        if (!npcClearOfLanes(s.x, s.z, isJeep ? 1.2 : 0.9)) continue;
        const yaw = s.yaw + (rnd() < 0.7 ? 0 : Math.PI); // sa daloy o kabaligtaran
        if (!isJeep) this.tricycle(npc, s.x, s.z, yaw);
        else this.jeepney(npc, s.x, s.z, yaw);
        this.collisionBoxes.push(
          new THREE.Box3().setFromCenterAndSize(
            new THREE.Vector3(s.x, terrainHeight(s.x, s.z) + 1.0, s.z),
            new THREE.Vector3(2.4, 2.0, 4.6)
          )
        );
        vehicleCount++;
      }
    });

    // --- Finalize: 2 meshes + 1 wire object = 3 draw calls ---------------
    const furnitureMat = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.8, metalness: 0.1,
    });
    target.add(furniture.build(furnitureMat));
    const npcMat = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.5, metalness: 0.3,
    });
    target.add(npc.build(npcMat));

    const wireGeo = new THREE.BufferGeometry();
    wireGeo.setAttribute('position', new THREE.Float32BufferAttribute(this.wireVerts, 3));
    const wires = new THREE.LineSegments(
      wireGeo,
      new THREE.LineBasicMaterial({ color: WIRE_COLOR })
    );
    wires.matrixAutoUpdate = false;
    target.add(wires);

    // FIX 2: sa tile mode, huwag mag-log kada tile (libu-libong linya).
    if (!bounds) {
      console.log(
        `[StreetObjects] ${postCount} poste (+wires), ${lightCount} ilaw, ` +
        `${canalRows} kanal rows, ${signCount} sign, ${vehicleCount} NPC, ` +
        `${clutterCount} bangketa-abala ` +
        `(furniture ${furniture.triangles} tris, npc ${npc.triangles} tris, ` +
        `wires ${this.wireVerts.length / 3} verts)`
      );
    }
    // FIX 2: ang wireVerts ay instance state. Kung hindi ito i-reset, maipon
    // ang lahat ng wire ng bawat tile sa iisang LineSegments (lumalaki nang
    // walang hangganan habang naglo-load ng maraming tile).
    this.wireVerts = [];
    return { postCount, lightCount, vehicleCount, clutterCount, tris: furniture.triangles + npc.triangles };
  }

  // --- Individual object builders ------------------------------------------

  // Concrete electric post na may cross-arm at insulators
  post(mesh, x, z, rnd) {
    const gy = terrainHeight(x, z);
    const h = 6.8 + rnd() * 0.8;
    mesh.cylinder(x, gy + h / 2, z, 0.16, 0.13, h, 6, POST);
    const armYaw = rnd() * Math.PI;
    mesh.box(x, gy + h - 0.3, z, 1.4, 0.12, 0.12, POST_ARM, armYaw);
    // insulator sa magkabilang dulo ng arm
    const ax = Math.cos(armYaw);
    const az = -Math.sin(armYaw);
    mesh.box(x + ax * 0.6, gy + h - 0.12, z + az * 0.6, 0.14, 0.2, 0.14, 0xcfcfcf, 0);
    mesh.box(x - ax * 0.6, gy + h - 0.12, z - az * 0.6, 0.14, 0.2, 0.14, 0xcfcfcf, 0);
  }

  // Street light: haligi + braso papunta sa kalsada + ilaw
  streetLight(mesh, s, side) {
    const gy = terrainHeight(s.x, s.z);
    const h = 6;
    mesh.cylinder(s.x, gy + h / 2, s.z, 0.09, 0.07, h, 6, LIGHT_POLE);
    const tx = -side * s.nX; // patungo sa kalsada
    const tz = -side * s.nZ;
    const armYaw = Math.atan2(tx, tz);
    mesh.box(s.x + tx * 0.7, gy + h - 0.3, s.z + tz * 0.7, 0.09, 0.09, 1.5, LIGHT_POLE, armYaw);
    mesh.box(s.x + tx * 1.5, gy + h - 0.45, s.z + tz * 1.5, 0.55, 0.14, 0.3, LIGHT_HEAD, armYaw);
  }

  // Open drainage canal: madilim na ilalim + dalawang pader ng semento
  canalSegment(mesh, rows, side) {
    const W = 0.45; // kalahating lapad (gitna -> gilid)
    const TOP = 0.35;
    const BOT = 0.02;
    const LIP = 0.16;
    for (let i = 0; i < rows.length - 1; i++) {
      const r0 = rows[i];
      const r1 = rows[i + 1];
      const ix0 = r0.x - r0.nX * side * W, iz0 = r0.z - r0.nZ * side * W;
      const ox0 = r0.x + r0.nX * side * W, oz0 = r0.z + r0.nZ * side * W;
      const ix1 = r1.x - r1.nX * side * W, iz1 = r1.z - r1.nZ * side * W;
      const ox1 = r1.x + r1.nX * side * W, oz1 = r1.z + r1.nZ * side * W;
      // taas ng lupa sa bawat gilid para masundan ang slope
      const hi0 = terrainHeight(ix0, iz0), ho0 = terrainHeight(ox0, oz0);
      const hi1 = terrainHeight(ix1, iz1), ho1 = terrainHeight(ox1, oz1);
      // madilim na bottom
      mesh.quad(
        [ix0, hi0 + BOT, iz0], [ox0, ho0 + BOT, oz0],
        [ox1, ho1 + BOT, oz1], [ix1, hi1 + BOT, iz1],
        CANAL_BOTTOM, [0, 1, 0]
      );
      // Normal mula sa TUNAY na hugis ng segment (hindi sa sample normal ng
      // kalsada - mali ito sa matinding liko).
      let wx = ix1 - ix0;
      let wz = iz1 - iz0;
      const wl = Math.hypot(wx, wz) || 1;
      wx /= wl; wz /= wl;
      let px = -wz;
      let pz = wx;
      if (px * -r0.nX * side + pz * -r0.nZ * side < 0) { px = -px; pz = -pz; }
      // inner wall (nakaharap sa kalsada)
      mesh.quad(
        [ix0, hi0 + BOT, iz0], [ix1, hi1 + BOT, iz1],
        [ix1, hi1 + TOP, iz1], [ix0, hi0 + TOP, iz0],
        CANAL_WALL, [px, 0, pz]
      );
      // outer wall (nakaharap sa bahay)
      mesh.quad(
        [ox0, ho0 + BOT, oz0], [ox1, ho1 + BOT, oz1],
        [ox1, ho1 + TOP, oz1], [ox0, ho0 + TOP, oz0],
        CANAL_WALL, [-px, 0, -pz]
      );
      // coping: dalawang manipis na semento sa TUKTOK ng bawat pader
      mesh.quad(
        [ix0, hi0 + TOP, iz0],
        [ix0 - r0.nX * side * LIP, hi0 + TOP, iz0 - r0.nZ * side * LIP],
        [ix1 - r1.nX * side * LIP, hi1 + TOP, iz1 - r1.nZ * side * LIP],
        [ix1, hi1 + TOP, iz1],
        CANAL_WALL, [0, 1, 0]
      );
      mesh.quad(
        [ox0 + r0.nX * side * LIP, ho0 + TOP, oz0 + r0.nZ * side * LIP],
        [ox0, ho0 + TOP, oz0],
        [ox1, ho1 + TOP, oz1],
        [ox1 + r1.nX * side * LIP, ho1 + TOP, oz1 + r1.nZ * side * LIP],
        CANAL_WALL, [0, 1, 0]
      );
    }
  }

  // Blue road sign sa poste
  roadSign(mesh, x, z, yaw) {
    const gy = terrainHeight(x, z);
    mesh.cylinder(x, gy + 1.4, z, 0.06, 0.05, 2.8, 6, 0x9e9e9e);
    mesh.box(x, gy + 2.9, z, 1.7, 0.55, 0.08, SIGN_BLUE, yaw);
    mesh.box(x, gy + 2.9, z, 1.4, 0.16, 0.1, 0xffffff, yaw); // puting "teksto" (approx)
    this.collisionBoxes.push(
      new THREE.Box3().setFromCenterAndSize(
        new THREE.Vector3(x, gy + 1.4, z), new THREE.Vector3(0.25, 2.8, 0.25)
      )
    );
  }

  // Sagging wire segment: 3 sub-segments (4 puntos) para bilog ang lubog
  addWire(a, b, sag) {
    const pts = [];
    for (let i = 0; i <= 3; i++) {
      const t = i / 3;
      const y = a[1] + (b[1] - a[1]) * t - Math.sin(t * Math.PI) * sag;
      pts.push([a[0] + (b[0] - a[0]) * t, y, a[2] + (b[2] - a[2]) * t]);
    }
    for (let i = 0; i < 3; i++) {
      this.wireVerts.push(...pts[i], ...pts[i + 1]);
    }
  }

  // --- NPC vehicles (static, low-poly) --------------------------------------

  // Tricycle: motorsiklo + sidecar (ang tanging masasakyan sa barangay)
  tricycle(mesh, x, z, yaw) {
    const gy = terrainHeight(x, z);
    const cos = Math.cos(yaw);
    const sin = Math.sin(yaw);
    const P = (lx, lz) => [x + lx * cos + lz * sin, z - lx * sin + lz * cos];
    // katawan ng motorsiklo
    const b = P(0, 0);
    mesh.box(b[0], gy + 0.55, b[1], 0.5, 0.5, 1.9, TRIKE_BLUE, yaw);
    mesh.box(b[0], gy + 0.95, b[1] - 0.2, 0.45, 0.35, 0.7, 0x263238, yaw);
    // sidecar
    const sc = P(0.95, 0.1);
    mesh.box(sc[0], gy + 0.55, sc[1], 0.95, 0.65, 1.5, TRIKE_SIDE, yaw);
    mesh.box(sc[0], gy + 1.15, sc[1], 0.95, 0.1, 1.5, 0xb0bec5, yaw);
    // gulong
    const w1 = P(0, 1.0);
    const w2 = P(0, -1.0);
    const w3 = P(0.95, 0.1);
    mesh.wheel(w1[0], gy + 0.3, w1[1], 0.3, 0.16, 8, TIRE, yaw + Math.PI / 2);
    mesh.wheel(w2[0], gy + 0.3, w2[1], 0.3, 0.16, 8, TIRE, yaw + Math.PI / 2);
    mesh.wheel(w3[0], gy + 0.3, w3[1], 0.3, 0.16, 8, TIRE, yaw);
  }

  // Jeepney: ang hari ng kalsada - kinang na katawan
  jeepney(mesh, x, z, yaw) {
    const gy = terrainHeight(x, z);
    const cos = Math.cos(yaw);
    const sin = Math.sin(yaw);
    const P = (lx, lz) => [x + lx * cos + lz * sin, z - lx * sin + lz * cos];
    const c = P(0, 0);
    mesh.box(c[0], gy + 1.15, c[1], 2.1, 1.5, 4.6, JEEP_BODY, yaw);
    mesh.box(c[0], gy + 2.0, c[1], 2.0, 0.2, 4.4, JEEP_ROOF, yaw);
    mesh.box(c[0], gy + 1.6, c[1], 2.15, 0.5, 4.0, 0x81d4fa, yaw);
    // harap: grill + ilaw
    const f = P(0, 2.35);
    mesh.box(f[0], gy + 1.0, f[1], 1.9, 0.7, 0.15, JEEP_ROOF, yaw);
    const hl = P(0.7, 2.42);
    const hr = P(-0.7, 2.42);
    mesh.box(hl[0], gy + 1.2, hl[1], 0.3, 0.25, 0.1, 0xfff9c4, yaw);
    mesh.box(hr[0], gy + 1.2, hr[1], 0.3, 0.25, 0.1, 0xfff9c4, yaw);
    // gulong
    for (const [lx, lz] of [[0.95, 1.5], [-0.95, 1.5], [0.95, -1.5], [-0.95, -1.5]]) {
      const w = P(lx, lz);
      mesh.wheel(w[0], gy + 0.38, w[1], 0.38, 0.22, 8, TIRE, yaw + Math.PI / 2);
    }
  }

  getCollisionBoxes() { return this.collisionBoxes; }
}


