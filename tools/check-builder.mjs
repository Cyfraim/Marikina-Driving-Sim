// ---------------------------------------------------------------------------
// check-builder.mjs - Unit test ng ColoredMeshBuilder primitives
//
// Sinusuri ang mga bagay na hindi kita ng world-level audit:
// - gable roof: dapat ALIGNED sa box base (eaves sa itaas ng pader, base
//   width/depth = box + overhang, ridge axis tamang direksyon)
// - sari-sari store: dapat may awning (slanted) at signage
// - zero-scale geometry, degenerate faces, inverted normals
// ---------------------------------------------------------------------------
import { ColoredMeshBuilder } from '../src/utils/coloredMesh.js';

let fail = 0;
const check = (label, cond, extra) => {
  console.log((cond ? 'PASS' : 'FAIL') + ' - ' + label + (extra ? ' ' + extra : ''));
  if (!cond) fail++;
};

/** I-return ang triangles bilang {verts:[3][x,y,z], n:[x,y,z]} */
function trisOf(m) {
  const P = m.pos;
  const N = m.nrm;
  const out = [];
  for (let i = 0; i < m.idx.length; i += 3) {
    const v = [];
    for (let k = 0; k < 3; k++) {
      const vi = m.idx[i + k];
      v.push([P[vi * 3], P[vi * 3 + 1], P[vi * 3 + 2], vi]);
    }
    out.push({ v, n: [N[v[0][3] * 3], N[v[0][3] * 3 + 1], N[v[0][3] * 3 + 2]] });
  }
  return out;
}

const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0],
];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

/** Bilang ng triangle na may maling normal o degenerate area */
function badFaces(m) {
  let bad = 0;
  for (const t of trisOf(m)) {
    const n = cross(sub(t.v[1], t.v[0]), sub(t.v[2], t.v[0]));
    const len = Math.hypot(n[0], n[1], n[2]);
    if (len / 2 < 1e-8) { bad++; continue; }
    if (Math.abs(dot3(n, t.n) / len) < 0.99) bad++;
  }
  return bad;
}

console.log('='.repeat(70));
console.log('BUILDER PRIMITIVE TESTS');
console.log('='.repeat(70));

// --- 1) box(): 6 faces, lahat ng normal parallel sa plane ng triangle ------
{
  const m = new ColoredMeshBuilder();
  m.box(0, 2, 0, 4, 4, 6, 0xff0000, 0);
  // 6 quads = 12 triangles = 36 indices
  check('box: 6 quads (12 tris)', m.idx.length === 36 && m.idx.length / 3 === 12,
    `(${m.idx.length / 3} tris, ${m.idx.length} indices)`);
  check('box: lahat ng normal parallel sa face plane', badFaces(m) === 0, `(${badFaces(m)} bad)`);
  // unang 4 vertices = top face (naunang ini-add) - dapat normal +Y
  // vertex i ay nasa nrm[3i], nrm[3i+1], nrm[3i+2] -> Y = nrm[3i+1]
  const topN = [1, 4, 7, 10].map((k) => m.nrm[k]);
  check('box: top face normal = +Y', topN.every((v) => v > 0.99),
    `(${topN.map((v) => v.toFixed(2)).join(',')})`);
}

// --- 2) gable(): eaves aligned sa box top, base = box + overhang ----------
{
  const W = 8;
  const D = 6;
  const H = 4;
  const OVER = 0.6;
  const RH = 1.5;
  const g = new ColoredMeshBuilder();
  g.gable(0, H, 0, W + OVER, D + OVER, RH, 0x0000ff, 0);

  const gtris = trisOf(g);
  check('gable: 2 slopes (4 tris) + 2 end triangles', gtris.length === 6, `(${gtris.length} tris)`);

  // NOTE: hindi nadede-dedup ng builder ang vertices, kaya maraming
  // duplicates ang eaves/ridge. Ang mahalaga: LAHAT ay nasa tamang taas.
  const eaves = [];
  const ridge = [];
  for (let i = 0; i < g.count; i++) {
    const y = g.pos[i * 3 + 1];
    if (Math.abs(y - H) < 1e-6) eaves.push([g.pos[i * 3], g.pos[i * 3 + 2]]);
    if (Math.abs(y - (H + RH)) < 1e-6) ridge.push([g.pos[i * 3], g.pos[i * 3 + 2]]);
  }
  check('gable: eaves nasa y = box top (H)', eaves.length >= 4, `(${eaves.length} eaves verts)`);
  check('gable: ridge nasa y = H + roofHeight', ridge.length >= 2, `(${ridge.length} ridge verts)`);

  const ex = eaves.map((p) => p[0]);
  const ez = eaves.map((p) => p[1]);
  check('gable: base width = box width + overhang',
    Math.abs(Math.max(...ex) - (W + OVER) / 2) < 1e-6, `(${Math.max(...ex).toFixed(2)} vs ${((W + OVER) / 2).toFixed(2)})`);
  check('gable: base depth = box depth + overhang',
    Math.abs(Math.max(...ez) - (D + OVER) / 2) < 1e-6, `(${Math.max(...ez).toFixed(2)} vs ${((D + OVER) / 2).toFixed(2)})`);

  const rx = ridge.map((p) => p[0]);
  check('gable: ridge axis = local X (dulo sa +/- width/2)',
    Math.abs(Math.max(...rx) - (W + OVER) / 2) < 1e-6 &&
    Math.abs(Math.min(...rx) + (W + OVER) / 2) < 1e-6);
  check('gable: ridge nasa gitna ng depth (z=0)',
    ridge.map((p) => p[1]).every((v) => Math.abs(v) < 1e-6));
  check('gable: lahat ng normal parallel sa face plane', badFaces(g) === 0, `(${badFaces(g)} bad)`);
}

// --- 3) sari-sari store: may awning (slanted) + signage ---------------------
{
  const m = new ColoredMeshBuilder();
  const width = 9;
  const depth = 7;
  const h = 4;
  const yaw = 0;
  const sign = 0xf4d03f;
  m.box(0, h / 2, 0, width, h, depth, 0xffffff, yaw);                     // katawan
  m.box(0, h + 0.15, 0, width + 0.5, 0.3, depth + 0.5, 0x616161, yaw);   // flat roof
  const frontX = Math.sin(yaw) * (depth / 2 + 0.03);
  const frontZ = Math.cos(yaw) * (depth / 2 + 0.03);
  m.box(frontX, 1.6, frontZ, width * 0.45, 1.8, 0.06, 0x8fd3f4, yaw);   // storefront
  m.box(frontX, 1.1, frontZ, 1.1, 2.2, 0.06, 0x4e342e, yaw);            // pinto
  m.box(frontX, h - 0.5, frontZ, width * 0.8, 0.8, 0.1, sign, yaw);     // signage
  // awning (tulad ng addShop sa Buildings.js)
  const px = Math.cos(yaw);
  const pz = -Math.sin(yaw);
  const awH = 2.6;
  const out = 1.2;
  const ox = Math.sin(yaw);
  const oz = Math.cos(yaw);
  const awN = [ox * 0.4, 1.2, oz * 0.4];
  m.quad(
    [frontX + px * (-width / 2), awH, frontZ + pz * (-width / 2)],
    [frontX + px * (width / 2), awH, frontZ + pz * (width / 2)],
    [frontX + px * (width / 2) + ox * out, awH - 0.4, frontZ + pz * (width / 2) + oz * out],
    [frontX + px * (-width / 2) + ox * out, awH - 0.4, frontZ + pz * (-width / 2) + oz * out],
    sign, awN
  );

  const t = trisOf(m);
  const awning = t.find((tri) => {
    const n = tri.n;
    const axisAligned = Math.abs(n[0]) > 0.99 || Math.abs(n[1]) > 0.99 || Math.abs(n[2]) > 0.99;
    return !axisAligned;
  });
  check('shop: may awning (slanted, non-axis-aligned normal)', !!awning,
    awning ? `(n=${awning.n.map((v) => v.toFixed(2)).join(',')})` : '(MISSING)');
  if (awning) {
    const ys = awning.v.map((v) => v[1]);
    const dy = Math.max(...ys) - Math.min(...ys);
    check('shop: awning may slope (hindi flat)', dy > 0.3, `(dy=${dy.toFixed(2)})`);
    check('shop: awning normal tilted up+outward', awning.n[1] > 0.5 && awning.n[2] > 0.1,
      `(n=${awning.n.map((v) => v.toFixed(2)).join(',')})`);
  }
  // sign box: center y = h-0.5, half-height 0.4 -> y range [h-0.9, h-0.1]
  let signVerts = 0;
  for (let i = 0; i < m.count; i++) {
    const y = m.pos[i * 3 + 1];
    if (y > h - 0.95 && y < h - 0.05) signVerts++;
  }
  check('shop: may signage sa itaas ng storefront', signVerts >= 4, `(${signVerts} verts)`);
  check('shop: walang broken normals', badFaces(m) === 0, `(${badFaces(m)} bad)`);
}

// --- 4) zero-scale detection ------------------------------------------------
{
  const m = new ColoredMeshBuilder();
  m.box(0, 0, 0, 0, 0, 0, 0xffffff, 0); // zero scale
  let degen = 0;
  for (const tri of trisOf(m)) {
    const n = cross(sub(tri.v[1], tri.v[0]), sub(tri.v[2], tri.v[0]));
    if (Math.hypot(n[0], n[1], n[2]) / 2 < 1e-8) degen++;
  }
  check('zero-scale box ay detectable bilang degenerate', degen === 12, `(${degen}/12 tris)`);
}

console.log('-'.repeat(70));
console.log(fail === 0 ? 'ALL BUILDER CHECKS PASS' : `${fail} CHECK(S) FAILED`);
process.exit(fail === 0 ? 0 : 1);
