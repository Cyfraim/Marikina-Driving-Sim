// ---------------------------------------------------------------------------
// roadLayout.js - Road-relative placement utilities para sa environment
//
// Lahat ng object (bahay, poste, puno, kanal, NPC) ay inilalagay RELATIVE
// sa tunay na centerline ng kalsada gamit ang sampled na distance `d` at
// lateral offset mula sa road edge.
//
// Zoning mula centerline palabas (1 unit = 1 m):
//   [0 .. half]                  asphalt
//   [half .. half+1.6]           sidewalk (kung may tag) - poste/ilaw dito
//   [half+SW .. half+SW+0.9]     drainage canal (mga pangunahing kalsada)
//   [half+SW+front .. +depth]    bahay/tindahan (front zone)
//   gaps sa frontage             puno
// ---------------------------------------------------------------------------
import { ROADS } from '../world/roadData.js';
import { gpsToLocal } from './geo.js';

// Lapad ng bangketa (sidewalk). Perisyoso: ang drivable limit ng kotse ay
// half-width + SW_WIDTH (tingnan RoadConfinement sa utils/boundary.js).
//
// --- VISUAL PASS Fix 5: bangketa ay mas makitid at HINDI pantay-pantay ----
// Ang dating constant na 3.0 m ay para sa main roads lang. Sa totoong
// Nangka: 1.5-2 m sa residential/barangay, 2.5-3 m sa main roads.
// SW_WIDTH = ang UPPER BOUND (2.8 m) para sa mga code path na kailangan
// ng worst case (confinement limit, corridor checks).
export const SW_WIDTH = 2.8;

/** Lapad ng bangketa para sa isang kalsada ayon sa OSM class. */
export function sidewalkWidth(cls) {
  if (cls === 'primary' || cls === 'secondary') return 2.8; // main road
  if (cls === 'tertiary') return 2.2;                         // collector
  return 1.8;                                                 // residential / alley
}

// --- Minimum drivable width (Fix invisible-wall) ---------------------------
// Ang kalsada ay kailangang HINDI LAGYAN ng poste + tricycle sa magkabilang
// gilid na magkasalubong. Pinagsasama:
//   - kotse: 2.0 m wide
//   - 2 x poste (0.5 m) sa magkabilang gilid
//   - 2 x jeepney (2.4 m) sa magkabilang gilid
//   - 2 x 0.3 m margin
//   = 2.0 + 1.0 + 4.8 + 0.6 = 8.4 m
// Kaya ang MIN_DRIVABLE_HALF ay 4.2 m (8.4 m kalsada) para may 2.4 m na
// tunay na lane kahit sa makitid na barangay street.
// NOTE: ito ay mas malaki sa OSM width para sa ilang kalsada, pero ang
// kalsada sa lalim ng Nangka ay karaniwang 6-8 m, at ang 5.5 m ay hindi
// sapat para sa kotse + naka-park na sasakyan.
export const MIN_DRIVABLE_HALF = 4.2;
const MIN_ROAD_WIDTH = MIN_DRIVABLE_HALF * 2; // 8.4 m

// Minimum clearance ng naka-park na NPC (tricycle/jeepney) mula sa centerline
// ng kahit anong kalsada, bago pa idagdag ang half-width ng sasakyan.
const MIN_NPC_LANE = 2.4;

// Pre-convert lahat ng polylines (isang beses lang sa boot)
export const ROAD_LINES = ROADS.map((r, i) => {
  let pts = r.pts.map(([lat, lon]) => gpsToLocal(lat, lon));
  pts = pts.filter((p, j) => j === 0 || Math.hypot(p.x - pts[j - 1].x, p.z - pts[j - 1].z) > 0.05);
  if (pts.length < 2) return null;
  const cum = [0];
  for (let k = 1; k < pts.length; k++) {
    cum.push(cum[k - 1] + Math.hypot(pts[k].x - pts[k - 1].x, pts[k].z - pts[k - 1].z));
  }
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.z < minZ) minZ = p.z;
    if (p.z > maxZ) maxZ = p.z;
  }
  // Lapad: OSM width, nang hindi bababa sa minimum drivable width
  const w = Math.max(r.w, MIN_ROAD_WIDTH);
  return {
    i, name: r.name, cls: r.cls, sw: r.sw, mk: r.mk,
    half: w / 2, pts, cum, len: cum[cum.length - 1],
    minX, maxX, minZ, maxZ,
    hasSW: r.sw !== 'none',
    // lapad ng bangketa para sa confinement ng kotse (0 kung walang bangketa)
    // Fix 5: per-class, hindi isang constant na 3.0 m
    swWidth: r.sw !== 'none' ? sidewalkWidth(r.cls) : 0,
  };
}).filter(Boolean);

// Broad-phase: labas ba ang point sa bbox ng road? (mabilis na rejection)
function outsideBBox(line, x, z, reach) {
  return x < line.minX - reach || x > line.maxX + reach ||
         z < line.minZ - reach || z > line.maxZ + reach;
}

export function distToPolyline(x, z, pts) {
  let best = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const dx = b.x - a.x, dz = b.z - a.z, l2 = dx * dx + dz * dz;
    let t = l2 ? ((x - a.x) * dx + (z - a.z) * dz) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    const d = Math.hypot(x - (a.x + dx * t), z - (a.z + dz * t));
    if (d < best) best = d;
  }
  return best;
}

/**
 * Ligtas ba ang malaking bagay (bahay) dito? Tumatawid ba ito sa ibang
 * kalsada o bangketa? `ownRi` = ang kalsadang kaharap nito (pinapayagan
 * ang space sa harap nito).
 */
// ---------------------------------------------------------------------------
// FIX 2: SHARED ROAD SPATIAL GRID
//
// Ang safeSpot/clearOfCorridors/curbsideSpot/npcClearOfLanes ay dating
// nag-scan ng BUONG listahan ng kalsada sa bawat tawag. Sa Nangka (139 roads)
// katamtaman pa; sa buong Marikina (6,789 roads) naging ~40,000 operasyon
// BAGAT sa isang tawag - at ang mga tawag ay dinoble (bahay + puno + poste +
// NPC) sa bawat isa sa 357 tile. Resulta: >10 s para mag-load ng unang tile
// set.
//
// Ang ayos: spatial grid ng mga kalsada, at ang apat na function ay dumadaan
// sa grid. GRID_MARGIN ay dapat mas malaki sa PINAKAMALAKI ng `need` sa apat
// na function (~21 m) - kung hindi, maaaring ma-miss ang isang kalsada.
// ---------------------------------------------------------------------------
const GRID_CELL = 50;
const GRID_MARGIN = 25;
const ROAD_GRID = new Map();
const gkey = (cx, cz) => cx * 100000 + cz; // numeric: mas mabilis kaysa string

for (let i = 0; i < ROAD_LINES.length; i++) {
  const l = ROAD_LINES[i];
  const c0 = Math.floor((l.minX - GRID_MARGIN) / GRID_CELL);
  const c1 = Math.floor((l.maxX + GRID_MARGIN) / GRID_CELL);
  const d0 = Math.floor((l.minZ - GRID_MARGIN) / GRID_CELL);
  const d1 = Math.floor((l.maxZ + GRID_MARGIN) / GRID_CELL);
  for (let cx = c0; cx <= c1; cx++) {
    for (let cz = d0; cz <= d1; cz++) {
      const k = gkey(cx, cz);
      let list = ROAD_GRID.get(k);
      if (!list) { list = []; ROAD_GRID.set(k, list); }
      list.push(i);
    }
  }
}

/**
 * Ang mga kalsadang maaaring malapit sa (x, z). Ligtas na pagbabalik: kung
 * wala, walang kalsada sa loob ng GRID_MARGIN.
 */
export function candidateRoads(x, z) {
  return ROAD_GRID.get(gkey(Math.floor(x / GRID_CELL), Math.floor(z / GRID_CELL)));
}

export function safeSpot(x, z, halfSize, ownRi = -1) {
  const hs = halfSize || 1;
  const list = candidateRoads(x, z);
  if (!list) return true;
  for (let n = 0; n < list.length; n++) {
    const line = ROAD_LINES[list[n]];
    const sw = line.swWidth;
    const need = line.half + sw + 0.3 + hs * 0.6;
    if (outsideBBox(line, x, z, need)) continue;
    if (distToPolyline(x, z, line.pts) < need) return false;
  }
  return true;
}

/**
 * FIX invisible-wall: "corridor keep-out" para sa building.
 *
 * Ang dating safeSpot() ay sinusuri lang ang CENTER ng bahay, kaya ang
 * malaking rotated building (12 m) ay maaaring umabot ng likod hanggang sa
 * kalsada ng IBA kalsada. Kapag ginawa iyon sa 5.5 m na barangay street,
 * nauuwi sa < 2.4 m na clear lane - at naiipit ang kotse (invisible wall).
 *
 * Dito sinusuri natin ang tunay na OBB laban sa drivable lane ng BAWAT
 * kalsada. Ang "reach" ay conservative bounding radius ng OBB - kaya hindi
 * kailis ang tunay na clearance, pero HINDI kailanman magpapasok sa lane.
 */
const MIN_LANE_CLEAR = 2.4; // kotse 2.0 + 0.4 margin

/**
 * @param {number} x,z    center ng building
 * @param {number} hx,hz  half-extents (local X = width, local Z = depth)
 * @param {number} yaw    rotation
 * @param {number} ownRi  index ng sariling kalsada
 */
export function clearOfCorridors(x, z, hx, hz, yaw, ownRi = -1) {
  // Ang collision box ng game ay AXIS-ALIGNED na AABB ng rotated footprint:
  //   ex = |cos|*hx + |sin|*hz   (half sa X)
  //   ez = |sin|*hx + |cos|*hz   (half sa Z)
  const c = Math.abs(Math.cos(yaw)), s = Math.abs(Math.sin(yaw));
  const ex = c * hx + s * hz;
  const ez = s * hx + c * hz;
  const reach = Math.hypot(ex, ez);

  const list = candidateRoads(x, z);
  if (!list) return true;
  // NOTE: ang loop counter ay `k`, hindi `n` - may `const n` (ang unit
  // normal) sa loob ng body, kaya magkakapareho ang `n` ay TDZ error.
  for (let k = 0; k < list.length; k++) {
    const line = ROAD_LINES[list[k]];
    const need = line.half + MIN_LANE_CLEAR;
    if (outsideBBox(line, x, z, need + reach)) continue;
    const d = distToPolyline(x, z, line.pts);
    if (d - reach >= need) continue; // pinakamalayong corner, ligtas

    // LATERAL reach: ang AABB half-extent sa direksyong PERPENDIKULAR sa
    // kalsada. Ito ang tanging sukat na mahalaga - ang haba ng building ay
    // parallel sa kalsada, kaya hindi ito lumalaki ang clearance.
    const n = nearestNormal(x, z, line.pts);
    if (!n) continue;
    const lat = Math.abs(n.x) * ex + Math.abs(n.z) * ez;

    if (line.i === ownRi) {
      // sariling kalsada: ang FRONT ay normal na malapit -> dapat lang ang
      // LIKOD ang malayo.
      if (d + lat >= need) continue;
      return false;
    }
    // ibang kalsada: kahit ang FRONT ay dapat labas ng lane.
    if (d - lat >= need) continue;
    return false;
  }
  return true;
}

/** Unit normal (perpendicular) ng polyline sa pinakamalapit na punto kay (x,z). */
function nearestNormal(x, z, pts) {
  let best = Infinity, bnx = 0, bnz = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const dx = b.x - a.x, dz = b.z - a.z;
    const l2 = dx * dx + dz * dz;
    let t = l2 ? ((x - a.x) * dx + (z - a.z) * dz) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    const px = a.x + dx * t, pz = a.z + dz * t;
    const d = (x - px) ** 2 + (z - pz) ** 2;
    if (d < best) {
      best = d;
      const l = Math.sqrt(l2) || 1;
      bnx = -dz / l; bnz = dx / l;
    }
  }
  return { x: bnx, z: bnz };
}

/**
 * Para sa curbside furniture (poste, ilaw, kanal, puno sa gilid):
 * - bawal SA loob ng own asphalt (half + 0.2)
 * - bawal sa loob ng corridor+sidewalk ng IBA ring kalsada
 */
export function curbsideSpot(x, z, ownRi, pad = 0.5) {
  const list = candidateRoads(x, z);
  if (!list) return true;
  for (let n = 0; n < list.length; n++) {
    const line = ROAD_LINES[list[n]];
    if (outsideBBox(line, x, z, line.half + line.swWidth + pad + 1)) continue;
    const d = distToPolyline(x, z, line.pts);
    if (line.i === ownRi) {
      if (d < line.half + 0.2) return false; // nasa asphalt
    } else if (d < line.half + line.swWidth + pad) {
      return false; // junction / ibang kalsada
    }
  }
  return true;
}

/**
 * FIX invisible-wall: TUNAY na lane clearance para sa naka-park na NPC.
 *
 * Ang curbsideSpot() ay nangangalawan sa "junction" at sa sariling
 * kalsada, pero HINDI nito tinatalaking nasa loob ng drivable lane ng IBA
 * kalsada. Halimbawa: tricycle na inilagay labas ng isang kalsada ay
 * nakakapasok pa rin sa lane ng katabing (magkabilang) kalsada.
 *
 * Dito sinusuri ang PINAKAMALAPIT na 3 kalsada at hinihingi na labas ng
 * (half + MIN_NPC_LANE + halfWidth) sa lahat.
 */
export function npcClearOfLanes(x, z, halfWidth) {
  // NOTE: 2 lang ang sinusuri (sariling kalsada + 1 katabi). Ang 3rd
  // kalsada ay kadalasang malayo na at nagta-tanga lang ng NPC count.
  const near = [];
  const list = candidateRoads(x, z);
  if (!list) return true;
  for (let n = 0; n < list.length; n++) {
    const line = ROAD_LINES[list[n]];
    if (outsideBBox(line, x, z, line.half + 8)) continue;
    near.push({ half: line.half, d: distToPolyline(x, z, line.pts) });
  }
  near.sort((a, b) => a.d - b.d);
  const n = Math.min(2, near.length);
  for (let k = 0; k < n; k++) {
    if (near[k].d < near[k].half + MIN_NPC_LANE + halfWidth) return false;
  }
  return true;
}

/** Para sa naka-paradang NPC: nasa OWN asphalt, hindi sa junction, malapit sa spawn. */
export function npcSpot(x, z, ownRi) {
  // FIX 4c: dating 45 m ang clearance - hinala pa ang mga tricycle sa malayo.
  // Ginawa na 20 m para may cluster na VISIBLE mula sa spawn, pero hindi
  // nakatakbo sa mismong lugar ng kotse.
  if (Math.hypot(x, z) < 20) return false; // malapit sa spawn point
  for (const line of ROAD_LINES) {
    if (outsideBBox(line, x, z, line.half + line.swWidth + 2)) continue;
    const d = distToPolyline(x, z, line.pts);
    if (line.i === ownRi) {
      if (d > line.half + 0.1) return false; // dapat nasa loob ng kalsada
    } else if (d < line.half + line.swWidth + 1.0) {
      return false; // malapit sa ibang kalsada = junction
    }
  }
  return true;
}

/**
 * Densify: higit pang sample points sa polyline para walang mahabang segment
 * (ginagamit ng corridor audit at ng road ribbon builder).
 */
export function densifyROAD(pts, maxStep) {
  if (!pts || pts.length < 2) return pts ? pts.slice() : [];
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const d = Math.hypot(b.x - a.x, b.z - a.z);
    const n = Math.max(1, Math.ceil(d / maxStep));
    for (let k = 1; k <= n; k++) {
      const t = k / n;
      out.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t });
    }
  }
  return out;
}

// --- Frontage occupancy (bahay -> puwang para sa puno) ----------------------
// Record: { ri, side, d0, d1 } - ginagamit ng Vegetation para hindi
// mapunta ang puno sa loob ng bahay.
export const FRONTAGE = {
  records: [],
  clear() { this.records.length = 0; },
  add(ri, side, d0, d1) { this.records.push({ ri, side, d0, d1 }); },
  isFree(ri, side, d0, d1) {
    for (const r of this.records) {
      if (r.ri !== ri || r.side !== side) continue;
      if (d0 < r.d1 && d1 > r.d0) return false;
    }
    return true;
  },
};

// --- Major road junctions (para sa tindahan + tricycle terminal) -------------
function segIntersect(p1, p2, p3, p4) {
  const d = (p2.x - p1.x) * (p4.z - p3.z) - (p2.z - p1.z) * (p4.x - p3.x);
  if (Math.abs(d) < 1e-9) return null;
  const t = ((p3.x - p1.x) * (p4.z - p3.z) - (p3.z - p1.z) * (p4.x - p3.x)) / d;
  const u = ((p3.x - p1.x) * (p2.z - p1.z) - (p3.z - p1.z) * (p2.x - p1.x)) / d;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { x: p1.x + (p2.x - p1.x) * t, z: p1.z + (p2.z - p1.z) * t };
}

let junctionCache = null;
export function getMajorJunctions() {
  if (junctionCache) return junctionCache;
  const major = ROAD_LINES.filter(
    (r) => r.cls === 'primary' || r.cls === 'secondary' || r.cls === 'tertiary'
  );
  const out = [];
  for (let a = 0; a < major.length; a++) {
    for (let b = a + 1; b < major.length; b++) {
      const A = major[a];
      const B = major[b];
      // bbox reject bago ang O(n*m) na segment loop
      if (A.maxX < B.minX - 10 || B.maxX < A.minX - 10 ||
          A.maxZ < B.minZ - 10 || B.maxZ < A.minZ - 10) continue;
      for (let i = 0; i < A.pts.length - 1; i++) {
        for (let j = 0; j < B.pts.length - 1; j++) {
          const p = segIntersect(A.pts[i], A.pts[i + 1], B.pts[j], B.pts[j + 1]);
          if (!p) continue;
          if (out.some((q) => Math.hypot(q.x - p.x, q.z - p.z) < 8)) continue;
          out.push({ x: p.x, z: p.z, a: A.i, b: B.i });
        }
      }
    }
  }
  junctionCache = out;
  return out;
}

/** Distance-sa-simula (`along`) ng road para sa isang point. */
export function nearestDistanceOnRoad(ri, x, z) {
  const r = ROAD_LINES[ri];
  let bestD = Infinity;
  let bestAlong = 0;
  for (let i = 0; i < r.pts.length - 1; i++) {
    const a = r.pts[i], b = r.pts[i + 1];
    const dx = b.x - a.x, dz = b.z - a.z, l2 = dx * dx + dz * dz;
    let t = l2 ? ((x - a.x) * dx + (z - a.z) * dz) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    const d = Math.hypot(x - (a.x + dx * t), z - (a.z + dz * t));
    if (d < bestD) {
      bestD = d;
      bestAlong = r.cum[i] + t * Math.sqrt(l2);
    }
  }
  return { dist: bestD, along: bestAlong };
}

// ---------------------------------------------------------------------------
// FIX 2: pagpili ng kalsada ng spawn - NASA IISANG DITO ang Vehicle at ang
// StreetObjects (ang spawn-visible tricycle row), kaya kailangan nilang
// mag-agree.
//
// BUG: ang dating `spawnRoadInfo` ay humihili ng PINAKAMALAKI at
// PINAKAMAHABANG primary/secondary sa BUONG mapa. Sa Nangka iisang arteryal
// lang ang naka-qualified kaya OK pa. Sa buong Marikina (6,789 kalsada) ang
// pinakamahabang arteryal ay maaaring kilometro na layo sa gitna - kaya
// sisimulan ang player sa random na sulog ng mapa. Samantala, ang tricycle
// row ay nasa kalsadang PINAKAMALAPIT sa center (J. P. Rizal, 149 m) - iba
// pa rin sa kalsada ng spawn. Resulta: 0 tricycle ang nakikita mula sa spawn.
//
// Ayus: primary/secondary na loob ng SPAWN_SEARCH mula sa center, at pinili
// ang pinakamahaba rito. Nananatiling siyempre ang center ng Marikina ang
// pinagsisimulan, at NAKAKABAHAGI na pareho ang kalsada ng kotse at ng tricycle.
// ---------------------------------------------------------------------------
export const SPAWN_SEARCH = 700; // metros mula sa center ng mapa

export function pickSpawnRoad() {
  let best = null;
  let bestFallback = null;
  for (const line of ROAD_LINES) {
    if (line.cls !== 'primary' && line.cls !== 'secondary') continue;
    if (!bestFallback || line.len > bestFallback.len) bestFallback = line;
    if (distToPolyline(0, 0, line.pts) > SPAWN_SEARCH) continue;
    if (!best || line.len > best.len) best = line;
  }
  return best || bestFallback || null;
}

// --- Deterministic RNG (parehong output bawat run = madaling i-validate) -----
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Position + orientation sa distance `d` mula sa simula ng road `ri`,
 * may lateral `offset` (positibo = gilid ng n normal).
 * yaw ay para sa heading na sumusunod sa daloy (sin/cos convention ng Vehicle).
 */
export function sampleRoad(ri, d, offset) {
  const r = ROAD_LINES[ri];
  const dd = Math.max(0, Math.min(r.len, d));
  let lo = 0;
  let hi = r.cum.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (r.cum[mid] <= dd) lo = mid; else hi = mid;
  }
  const along = dd - r.cum[lo];
  const segLen = r.cum[lo + 1] - r.cum[lo] || 1;
  const a = r.pts[lo];
  const b = r.pts[lo + 1];
  const dx = (b.x - a.x) / segLen;
  const dz = (b.z - a.z) / segLen;
  const nx = -dz;
  const nz = dx;
  return {
    x: a.x + dx * along + nx * offset,
    z: a.z + dz * along + nz * offset,
    dirX: dx, dirZ: dz,
    nX: nx, nZ: nz,
    yaw: Math.atan2(dx, dz),
  };
}
