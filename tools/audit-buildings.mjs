// ---------------------------------------------------------------------------
// audit-buildings.mjs - Headless geometry audit ng buong mundo.
//
// Hinahanap: NaN vertices, degenerate (zero-area) faces, maling orientation ng
// vertex normal vs ang actual plane ng triangle (perpendicular = broken),
// inverted normals, geometry na nasa ilalim ng lupa, at mga bagay na labas sa
// hangganan ng ground plane.
//
// Usage: node tools/audit-buildings.mjs
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { Map as GameMap } from '../src/world/Map.js';
import { terrainHeight, RIVER_X, RIVER_HALF_WIDTH, WEST_EDGE } from '../src/utils/geo.js';
import { ROAD_LINES, distToPolyline } from '../src/utils/roadLayout.js';

const GROUND_Y = 0;            // baseline
// FIX: dating 1600 (half ng 3200x3200 na ground plane ng Nangka lang).
// Ngayon ang buong Marikina: ground plane = 9600x9600 (Map.js createGround),
// kaya 4800. Ang 1600 ay nagbibigay ng FALSE POSITIVE na "out of bounds"
// sa lahat ng tile sa labas ng dating Nangka bounds.
const GROUND_HALF = 4800;      // half-size ng 9600x9600 ground plane
const MIN_Y = -0.3;            // pinapayagang pagpapalaba sa ilalim ng lupa
const DEGEN_AREA = 1e-8;
const PERP_EPS = 0.5;          // |dot(normal, planeNormal)| < 0.5 = mali

const scene = new THREE.Scene();
const map = new GameMap(scene);
map.build();

let totalNaN = 0;
let totalDegen = 0;
let totalPerp = 0;
let terrainBelowVerts = 0;
let outOfBounds = 0;
const report = [];

function auditMesh(name, mesh) {
  const g = mesh.geometry;
  const pos = g.attributes.position;
  const nrm = g.attributes.normal;
  if (!pos) return;
  // I-apply ang world matrix - kasi ang ground plane ay naka-rotate at
  // ang local space ay magkaibang mundo (false positive kung hindi).
  mesh.updateWorldMatrix(true, false);
  const M = mesh.matrixWorld;
  const e = M.elements;
  const vcount = pos.count;
  // ituturo: ito ba ang mismong ground plane? (malaking, flat-top, wide)
  let isGroundMesh = false;
  {
    let minX0 = Infinity; let maxX0 = -Infinity; let minZ0 = Infinity; let maxZ0 = -Infinity;
    for (let v = 0; v < vcount; v++) {
      const x = pos.array[v * 3];
      const z = pos.array[v * 3 + 2];
      if (x < minX0) minX0 = x;
      if (x > maxX0) maxX0 = x;
      if (z < minZ0) minZ0 = z;
      if (z > maxZ0) maxZ0 = z;
    }
    isGroundMesh = (maxX0 - minX0) > 3000 && (maxZ0 - minZ0) > 3000;
  }
  const wx = new Float32Array(vcount);
  const wy = new Float32Array(vcount);
  const wz = new Float32Array(vcount);
  const rx = new Float32Array(vcount);
  const ry = new Float32Array(vcount);
  const rz = new Float32Array(vcount);

  let nan = 0;
  for (let i = 0; i < pos.array.length; i++) if (!Number.isFinite(pos.array[i])) nan++;
  if (nrm) for (let i = 0; i < nrm.array.length; i++) if (!Number.isFinite(nrm.array[i])) nan++;
  if (g.attributes.color) {
    const C = g.attributes.color.array;
    for (let i = 0; i < C.length; i++) if (!Number.isFinite(C[i])) nan++;
  }
  totalNaN += nan;

  let minY = Infinity;
  let maxY = -Infinity;
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let v = 0; v < vcount; v++) {
    const x = pos.array[v * 3];
    const y = pos.array[v * 3 + 1];
    const z = pos.array[v * 3 + 2];
    // world position (column-major 4x4)
    const X = e[0] * x + e[4] * y + e[8] * z + e[12];
    const Y = e[1] * x + e[5] * y + e[9] * z + e[13];
    const Z = e[2] * x + e[6] * y + e[10] * z + e[14];
    wx[v] = X; wy[v] = Y; wz[v] = Z;
    // world normal (rotation only, normalized below)
    if (nrm) {
      const nx = nrm.array[v * 3];
      const ny = nrm.array[v * 3 + 1];
      const nz = nrm.array[v * 3 + 2];
      const nX = e[0] * nx + e[4] * ny + e[8] * nz;
      const nY = e[1] * nx + e[5] * ny + e[9] * nz;
      const nZ = e[2] * nx + e[6] * ny + e[10] * nz;
      const l = Math.hypot(nX, nY, nZ) || 1;
      rx[v] = nX / l; ry[v] = nY / l; rz[v] = nZ / l;
    }
    if (Y < minY) minY = Y;
    if (Y > maxY) maxY = Y;
    if (X < minX) minX = X;
    if (X > maxX) maxX = X;
    if (Z < minZ) minZ = Z;
    if (Z > maxZ) maxZ = Z;
  }
  const below = minY < MIN_Y ? 1 : 0;
  // Terrain-aware: ang "below ground" ay relative sa lupa, hindi sa y=0.
  // EXCEPTION: ang mismong ground mesh ay by design na terrain - 0.02,
  // kaya't hiwalayin siya (dapat siya lang ang puwedeng maging "below").
  let terrainBelow = 0;
  // EXCEPTION 1: mismong ground plane (by design na terrain - 0.02)
  // EXCEPTION 2: ang river (tubig, by design na -0.4 m sa bank)
  const isWater = !isGroundMesh && (maxX - minX) < 120 && (maxZ - minZ) > 2000;
  if (!isGroundMesh && !isWater) {
    for (let v = 0; v < vcount; v++) {
      // MIN_Y = -0.3, kaya dapat terrain + MIN_Y (hindi - MIN_Y!)
      if (wy[v] < terrainHeight(wx[v], wz[v]) + MIN_Y) terrainBelow++;
    }
  }
  terrainBelowVerts += terrainBelow;
  const oob = (minX < -GROUND_HALF || maxX > GROUND_HALF ||
               minZ < -GROUND_HALF || maxZ > GROUND_HALF) ? 1 : 0;
  outOfBounds += oob;

  // --- triangles: degenerate area + normal-vs-plane ---
  const idx = g.index;
  const triCount = idx ? idx.count / 3 : vcount / 3;
  let degen = 0;
  let perp = 0;
  for (let t = 0; t < triCount; t++) {
    const i0 = idx ? idx.getX(t * 3) : t * 3;
    const i1 = idx ? idx.getX(t * 3 + 1) : t * 3 + 1;
    const i2 = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
    const ax = wx[i0], ay = wy[i0], az = wz[i0];
    const bx = wx[i1] - ax, by = wy[i1] - ay, bz = wz[i1] - az;
    const cx = wx[i2] - ax, cy = wy[i2] - ay, cz = wz[i2] - az;
    const nx = by * cz - bz * cy;
    const ny = bz * cx - bx * cz;
    const nz = bx * cy - by * cx;
    const len = Math.hypot(nx, ny, nz);
    if (len / 2 < DEGEN_AREA) { degen++; continue; }
    if (nrm) {
      const dot = Math.abs((nx * rx[i0] + ny * ry[i0] + nz * rz[i0]) / len);
      if (dot < PERP_EPS) perp++;
    }
  }
  totalDegen += degen;
  totalPerp += perp;

  report.push({
    name,
    tris: triCount,
    verts: vcount,
    nan,
    degen,
    perp,
    minY: +minY.toFixed(2),
    maxY: +maxY.toFixed(2),
    x: [+minX.toFixed(0), +maxX.toFixed(0)],
    z: [+minZ.toFixed(0), +maxZ.toFixed(0)],
    below: terrainBelow,
    oob,
  });
}

let mi = 0;
scene.traverse((o) => {
  if (!o.isMesh) return;
  const c = o.material && o.material.color;
  const tag = c && c.getHexString ? c.getHexString() : '?';
  auditMesh(`mesh#${mi} ${o.isLineSegments ? 'lines' : 'mesh'}`, o);
  void tag;
  mi++;
});

console.log('='.repeat(78));
console.log('GEOMETRY AUDIT - Marikina Driving Simulator');
console.log('='.repeat(78));
console.table(report);
console.log('-'.repeat(78));
console.log(`NaN/Inf components ....... ${totalNaN}`);
console.log(`Degenerate (zero-area) ... ${totalDegen}`);
console.log(`Broken normals (perp) .... ${totalPerp}`);
console.log(`Verts below terrain (${MIN_Y}m) : ${terrainBelowVerts}`);
console.log(`Meshes out of bounds ..... ${outOfBounds}`);
const bad = totalNaN + totalDegen + totalPerp + terrainBelowVerts + outOfBounds;
console.log('-'.repeat(78));
console.log(bad === 0 ? 'RESULT: CLEAN' : `RESULT: ${bad} issue(s) found`);

// ===========================================================================
// TERRAIN CHECKS - nakaupo ba ang lahat sa lupa?
// ===========================================================================
// (import { terrainHeight, RIVER_X } ... sa itaas na bahagi ng file)

console.log('');
console.log('='.repeat(78));
console.log('TERRAIN CHECKS');
console.log('='.repeat(78));

// 1) gradient: kanlanging gilid mataas, kahingan ng ilog mababa.
// FIX 2: ang dating sample ay x=-600, na siyang kanlanging gilid sa lumang
// 1,200 m na mapa. Sa buong Marikina ang WEST_EDGE ay -4500 at GRADIENT_SPAN
// ay 5,360 m - kaya x=-600 ay halos sa gitna lamang at halos walang pagkakaiba
// sa ilog (0.45 m). Ang totoong 3 m na pagbagsak ay buong-map na sukat.
const hWest = terrainHeight(WEST_EDGE, 0);
const hMid = terrainHeight(0, 0);
const hRiver = terrainHeight(RIVER_X - 40, 0);
console.log(`terrain west edge (x=${WEST_EDGE}) : ${hWest.toFixed(2)} m`);
console.log(`terrain centre (x=0) ........: ${hMid.toFixed(2)} m`);
console.log(`terrain river bank .........: ${hRiver.toFixed(2)} m`);
const gradientOk = hWest > hRiver && hWest - hRiver < 4.5 && hWest - hRiver > 1.5;
console.log(`gradient 0-3 m, west high ...: ${gradientOk ? 'PASS' : 'FAIL'}` +
  ` (fall = ${(hWest - hRiver).toFixed(2)} m over ${RIVER_X - WEST_EDGE} m)`);

// 2) bawat collision box: naka-settle ba sa lupa?
let floating = 0;
let sunk = 0;
let checked = 0;
for (const b of map.getCollisionBoxes()) {
  // laktawan ang river box (tubig, hindi lupa) at ang malalaking box
  const c = b.getCenter(new THREE.Vector3());
  const s = b.getSize(new THREE.Vector3());
  if (s.x > 20 && s.z > 500) continue; // river barrier
  if (s.x < 5 && s.z < 5 && s.y < 2.5) continue; // maliit na box (NPC/marker)
  const g = terrainHeight(c.x, c.z);
  checked++;
  // box bottom dapat malapit sa lupa (within 0.6 m) para hindi lumulutang
  if (b.min.y - g > 0.6) floating++;
  // o hindi nasa loob ng lupa (below -0.5 m)
  if (b.min.y < g - 0.5) sunk++;
}
console.log(`collision boxes checked .....: ${checked}`);
console.log(`  floating (>0.6m above) ...: ${floating}`);
console.log(`  sunk (below ground) ......: ${sunk}`);

// 3) road surface: sumasunod ba sa terrain? (sample road mesh verts)
let roadAbove = 0;
let roadBelow = 0;
{
  // hanapin ang road surface mesh (concrete/asphalt)
  scene.traverse((o) => {
    if (!o.isMesh || !o.material || !o.material.color) return;
    const hex = o.material.color.getHexString();
    if (hex !== '999999' && hex !== '444444') return;
    const P = o.geometry.attributes.position;
    for (let i = 0; i < P.count; i += 7) { // sample
      const x = P.getX(i);
      const z = P.getZ(i);
      const y = P.getY(i);
      const g = terrainHeight(x, z);
      if (y - g > 0.35) roadAbove++;
      if (y - g < -0.2) roadBelow++;
    }
  });
}
console.log(`road verts > 0.35m above ...: ${roadAbove}  (0 = sumasunod sa slope)`);
console.log(`road verts < -0.2m below ....: ${roadBelow}  (0 = walang nakaubos)`);

console.log('-'.repeat(78));
const terrainBad = (!gradientOk ? 1 : 0) + floating + sunk + roadAbove + roadBelow;
console.log(terrainBad === 0 ? 'TERRAIN: CLEAN' : `TERRAIN: ${terrainBad} issue(s)`);

// --- Landmark checks: nasa tamang lugar ba ang river/market/terminal? -----
let landmarkOk = 0;
{
  // River: dapat nasa silangang bahagi (+x) at may water mesh
  const riverGpsX = (121.1120 - 121.1080) * 107716;
  console.log(`river GPS x .................: ${riverGpsX.toFixed(0)} m (scene x=${RIVER_X})`);
  const riverOnEast = RIVER_X > 100;
  console.log(`river on east side ...........: ${riverOnEast ? 'PASS' : 'FAIL'}`);
  if (riverOnEast) landmarkOk++;

  // Market: dapat malapit sa main road at HINDI nasa kalsada
  const mk = map.landmarks.footprints;
  void mk;
  const marketBoxes = map.landmarks.collisionBoxes;
  const market = marketBoxes[0];
  if (market) {
    const mc = market.getCenter(new THREE.Vector3());
    const dEdge = minEdgeDist(mc.x, mc.z);
    const onRoad = dEdge < 0;
    console.log(`market off the road .........: ${onRoad ? 'FAIL' : 'PASS'} (${dEdge.toFixed(1)} m from edge)`);
    if (!onRoad) landmarkOk++;
  }
}
console.log(`landmarks verified ..........: ${landmarkOk}/2`);

// ===========================================================================
// BUILDING-SPECIFIC CHECKS (gumagamit ng collision boxes)
// ===========================================================================

console.log('');
console.log('='.repeat(78));
console.log('BUILDING CHECKS');
console.log('='.repeat(78));

// 1) Minimum clearance: walang base vertex na hihigit sa 0.3 m sa ilalim ng Lupa
// (relative sa terrain, hindi sa y=0 - dahil may 0-3 m na gradient)
const bBoxes = map.buildings.collisionBoxes;
let belowGroundVerts = 0;
for (const b of bBoxes) {
  const c = b.getCenter(new THREE.Vector3());
  if (b.min.y < terrainHeight(c.x, c.z) + MIN_Y) belowGroundVerts++;
}
console.log(`building boxes below terrain (${MIN_Y}m) : ${belowGroundVerts} / ${bBoxes.length}`);

// 2) Building overlap sa kalsada (center vs road corridor)
function minEdgeDist(x, z) {
  let best = Infinity;
  for (const line of ROAD_LINES) {
    if (x < line.minX - 40 || x > line.maxX + 40 ||
        z < line.minZ - 40 || z > line.maxZ + 40) continue;
    const d = distToPolyline(x, z, line.pts) - line.half;
    if (d < best) best = d;
  }
  return best;
}
let onRoad = 0;
for (const b of bBoxes) {
  const c = b.getCenter(new THREE.Vector3());
  if (minEdgeDist(c.x, c.z) < 0) onRoad++;
}
console.log(`buildings overlapping road surface .......: ${onRoad}`);

// 3) Building-vs-building overlap: eksaktong OBB (SAT) sa tunay na footprints
let clashes = 0;
let aabbConservative = 0;
{
  const fps = map.buildings.footprints;
  const CELL = 12;
  const grid = new Map();
  fps.forEach((f, i) => {
    const reach = Math.hypot(f.hx, f.hz);
    const c0 = Math.floor((f.x - reach) / CELL), c1 = Math.floor((f.x + reach) / CELL);
    const d0 = Math.floor((f.z - reach) / CELL), d1 = Math.floor((f.z + reach) / CELL);
    for (let cx = c0; cx <= c1; cx++) {
      for (let cz = d0; cz <= d1; cz++) {
        const k = `${cx},${cz}`;
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k).push(i);
      }
    }
  });
  const sat = (a, b) => {
    const axes = [[a.c, -a.s], [a.s, a.c], [b.c, -b.s], [b.s, b.c]];
    for (const [ax, az] of axes) {
      const d = (b.x - a.x) * ax + (b.z - a.z) * az;
      const ra = a.hx * Math.abs(a.c * ax - a.s * az) + a.hz * Math.abs(a.s * ax + a.c * az);
      const rb = b.hx * Math.abs(b.c * ax - b.s * az) + b.hz * Math.abs(b.s * ax + b.c * az);
      if (Math.abs(d) > ra + rb) return false;
    }
    return true;
  };
  const seen = new Set();
  for (const [, list] of grid) {
    for (let a = 0; a < list.length; a++) {
      for (let b = a + 1; b < list.length; b++) {
        const i = list[a];
        const j = list[b];
        const key = i < j ? `${i}-${j}` : `${j}-${i}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const A = fps[i];
        const B = fps[j];
        if (sat(A, B)) {
          clashes++;
          if (clashes <= 5) {
            console.log(`   overlap: (${A.x.toFixed(1)}, ${A.z.toFixed(1)}) vs ` +
              `(${B.x.toFixed(1)}, ${B.z.toFixed(1)})`);
          }
        }
        const ahx = Math.abs(A.c) * A.hx + Math.abs(A.s) * A.hz;
        const ahz = Math.abs(A.s) * A.hx + Math.abs(A.c) * A.hz;
        const bhx = Math.abs(B.c) * B.hx + Math.abs(B.s) * B.hz;
        const bhz = Math.abs(B.s) * B.hx + Math.abs(B.c) * B.hz;
        if (Math.abs(A.x - B.x) < ahx + bhx && Math.abs(A.z - B.z) < ahz + bhz) aabbConservative++;
      }
    }
  }
}
console.log(`building pairs overlapping (exact OBB/SAT) : ${clashes}`);
console.log(`  (AABB-conservative would report ........: ${aabbConservative})`);

// 4) Ground plane bounds
let oobBuildings = 0;
for (const b of bBoxes) {
  const c = b.getCenter(new THREE.Vector3());
  if (Math.abs(c.x) > GROUND_HALF || Math.abs(c.z) > GROUND_HALF) oobBuildings++;
}
console.log(`buildings outside ground bounds ...........: ${oobBuildings}`);

console.log('-'.repeat(78));
const buildingBad = onRoad + clashes + oobBuildings;
console.log(buildingBad === 0 ? 'BUILDINGS: CLEAN' : `BUILDINGS: ${buildingBad} issue(s)`);

console.log('='.repeat(78));
const allBad = bad + buildingBad + terrainBad + (landmarkOk < 2 ? 1 : 0);
console.log(allBad === 0 ? 'OVERALL: ALL CHECKS PASS' : `OVERALL: ${allBad} issue(s)`);
process.exit(allBad === 0 ? 0 : 1);







