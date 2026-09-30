// ---------------------------------------------------------------------------
// coloredMesh.js - Merged vertex-colored mesh builder
//
// Ang buong environment (bahay, puno, poste, kanal, NPC) ay binubuo dito at
// na-merge sa iilang meshes lang - iisang material, kulay per-vertex.
// Ito ang dahilan kung bakit kasya ang daan-daang objects sa 60fps
// (imbes na isang draw call bawat box).
// ---------------------------------------------------------------------------
import * as THREE from 'three';

function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }

export class ColoredMeshBuilder {
  constructor() {
    this.pos = [];
    this.nrm = [];
    this.col = [];
    this.idx = [];
    this.count = 0;
  }

  /** Hex color (0xffcc00) -> normalized [r, g, b]. */
  static rgb(hex) {
    return [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];
  }

  vert(p, n, c) {
    const col = typeof c === 'number' ? ColoredMeshBuilder.rgb(c) : c;
    this.pos.push(p[0], p[1], p[2]);
    this.nrm.push(n[0], n[1], n[2]);
    this.col.push(col[0], col[1], col[2]);
    return this.count++;
  }

  // quad mula sa 4 puntos; winding inaayos ayon sa gustong normal
  // FIX: ZERO `want` (halimbawa kapag walang valid na segment direction) =>
  // gamitin ang computed face normal. Hindi (0,0,0) - zero light + "perp".
  quad(a, b, c, d, color, want) {
    let n = cross(sub(b, a), sub(c, a));
    const nl0 = Math.hypot(n[0], n[1], n[2]) || 1;
    n = [n[0] / nl0, n[1] / nl0, n[2] / nl0];
    if (want && Math.hypot(want[0], want[1], want[2]) < 1e-9) want = n;
    let verts = [a, b, c, d];
    if (want && n[0] * want[0] + n[1] * want[1] + n[2] * want[2] < 0) {
      verts = [a, d, c, b];
      n = [-n[0], -n[1], -n[2]];
    }
    const nn = want
      ? (() => { const l = Math.hypot(want[0], want[1], want[2]) || 1; return [want[0] / l, want[1] / l, want[2] / l]; })()
      : n;
    const base = this.count;
    for (const v of verts) this.vert(v, nn, color);
    this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  tri(a, b, c, color, want) {
    let n = cross(sub(b, a), sub(c, a));
    const nl0 = Math.hypot(n[0], n[1], n[2]) || 1;
    n = [n[0] / nl0, n[1] / nl0, n[2] / nl0];
    // FIX: same guard sa quad() - huwag na pumunta sa (0,0,0) normal.
    if (want && Math.hypot(want[0], want[1], want[2]) < 1e-9) want = n;
    if (want && n[0] * want[0] + n[1] * want[1] + n[2] * want[2] < 0) {
      const tmp = b; b = c; c = tmp;
      n = [-n[0], -n[1], -n[2]];
    }
    const base = this.count;
    this.vert(a, n, color);
    this.vert(b, n, color);
    this.vert(c, n, color);
    this.idx.push(base, base + 1, base + 2);
  }

  /** Axis-aligned o rotated na kahon. rotY sa paligid ng (cx, cz). */
  box(cx, cy, cz, w, h, d, color, rotY = 0) {
    const hw = w / 2;
    const hd = d / 2;
    const y0 = cy - h / 2;
    const y1 = cy + h / 2;
    const cos = Math.cos(rotY);
    const sin = Math.sin(rotY);
    const P = (x, y, z) => [cx + x * cos + z * sin, y, cz - x * sin + z * cos];
    const c000 = P(-hw, y0, -hd), c100 = P(hw, y0, -hd);
    const c110 = P(hw, y0, hd), c010 = P(-hw, y0, hd);
    const c001 = P(-hw, y1, -hd), c101 = P(hw, y1, -hd);
    const c111 = P(hw, y1, hd), c011 = P(-hw, y1, hd);
    // faces (want normals rotated din)
    // NOTE: cXYZ = P(x, y, z) - so c001/c011/c010/c000 ay nasa x = -hw
    // (i.e. -X face), hindi -Z. Kailangang tama ang axis ng bawat normal.
    const f = (ax, az) => [sin * az + cos * ax, 0, cos * az - sin * ax]; // rot2d ng normal
    this.quad(c001, c101, c111, c011, color, [0, 1, 0]);                  // top (+Y)
    this.quad(c000, c010, c110, c100, color, [0, -1, 0]);                 // bottom (-Y)
    this.quad(c001, c011, c010, c000, color, f(-1, 0));                   // -X
    this.quad(c101, c111, c110, c100, color, f(1, 0));                    // +X
    this.quad(c001, c101, c100, c000, color, f(0, -1));                   // -Z
    this.quad(c011, c111, c110, c010, color, f(0, 1));                    // +Z
  }

  /**
   * Gable roof prism na may ridge sa ibabaw. Ridge axis = local X.
   * cy = taas ng eaves (base ng bubong).
   */
  gable(cx, cy, cz, w, d, h, color, rotY = 0) {
    const hw = w / 2;
    const hd = d / 2;
    const cos = Math.cos(rotY);
    const sin = Math.sin(rotY);
    const P = (x, y, z) => [cx + x * cos + z * sin, y, cz - x * sin + z * cos];
    const a0 = P(-hw, cy, -hd), a1 = P(hw, cy, -hd);
    const b0 = P(-hw, cy, hd), b1 = P(hw, cy, hd);
    const r0 = P(-hw, cy + h, 0), r1 = P(hw, cy + h, 0);
    // dalawang slopes
    const slopeN1 = (() => { // +z side slope
      const n = [0, hd, h]; const l = Math.hypot(n[0], n[1], n[2]);
      const nn = [n[0] / l, n[1] / l, n[2] / l];
      return [sin * nn[2] + cos * nn[0], nn[1], cos * nn[2] - sin * nn[0]];
    })();
    const slopeN2 = [-slopeN1[0], slopeN1[1], -slopeN1[2]];
    this.quad(a0, a1, r1, r0, color, slopeN2);   // -z slope
    this.quad(b1, b0, r0, r1, color, slopeN1);   // +z slope
    // dalawang gable triangles (nasa x = -hw at +hw, kaya normal ay Â±X)
    const gx1 = [cos, 0, -sin];
    const gx2 = [-cos, 0, sin];
    this.tri(a1, b1, r1, color, gx1);   // +X end
    this.tri(b0, a0, r0, color, gx2);   // -X end
  }

  /** Cylinder na may axis Y (trunk, poste). Hindi na binubuo ang bottom. */
  cylinder(cx, cy, cz, rBot, rTop, h, seg, color, rotY = 0) {
    const y0 = cy - h / 2;
    const y1 = cy + h / 2;
    for (let i = 0; i < seg; i++) {
      const a0 = (i / seg) * Math.PI * 2 + rotY;
      const a1 = ((i + 1) / seg) * Math.PI * 2 + rotY;
      const c0 = Math.cos(a0), s0 = Math.sin(a0);
      const c1 = Math.cos(a1), s1 = Math.sin(a1);
      const p00 = [cx + c0 * rBot, y0, cz + s0 * rBot];
      const p10 = [cx + c1 * rBot, y0, cz + s1 * rBot];
      const p11 = [cx + c1 * rTop, y1, cz + s1 * rTop];
      const p01 = [cx + c0 * rTop, y1, cz + s0 * rTop];
      const mid = (a0 + a1) / 2;
      this.quad(p00, p10, p11, p01, color, [Math.cos(mid), 0, Math.sin(mid)]);
      this.tri([cx, y1, cz], p01, p11, color, [0, 1, 0]); // top cap
    }
  }

  /** Low-poly ellipsoid blob (foliage ng mangga). */
  blob(cx, cy, cz, rx, ry, rz, seg, rings, color) {
    const point = (ri, si) => {
      const phi = (ri / rings) * Math.PI;
      const th = (si / seg) * Math.PI * 2;
      const x = Math.sin(phi) * Math.cos(th);
      const y = Math.cos(phi);
      const z = Math.sin(phi) * Math.sin(th);
      return [cx + x * rx, cy + y * ry, cz + z * rz];
    };
    const normal = (p) => {
      const mx = p[0] - cx;
      const my = p[1] - cy;
      const mz = p[2] - cz;
      return [mx / (rx * rx), my / (ry * ry), mz / (rz * rz)];
    };
    for (let ri = 0; ri < rings; ri++) {
      for (let si = 0; si < seg; si++) {
        const a = point(ri, si);
        const b = point(ri, si + 1);
        const c = point(ri + 1, si + 1);
        const d = point(ri + 1, si);
        // Sa mga pole (ri=0 o rings-1) nag-i-collapse lahat ng vertices sa
        // iisang punto -> zero-area quads. Emitted bilang TRIANGLE nalang.
        if (ri === 0) {
          // sa pole, a == b (pareho ang pole point) - kaya gamitin ang
          // lower ring: tri(pole, ring1[si+1], ring1[si])
          this.tri(a, c, d, color, normal(a));
        } else if (ri === rings - 1) {
          this.tri(a, b, d, color, normal(a));
        } else {
          this.quad(a, b, c, d, color, normal(a));
        }
      }
    }
  }

  /** Flat horizontal strip sa pagitan ng 2 puntos (palm frond). */
  strip(a, b, width, color, up = [0, 1, 0]) {
    const dx = b[0] - a[0];
    const dz = b[2] - a[2];
    const l = Math.hypot(dx, dz) || 1;
    const px = (-dz / l) * (width / 2);
    const pz = (dx / l) * (width / 2);
    this.quad(
      [a[0] - px, a[1], a[2] - pz], [a[0] + px, a[1], a[2] + pz],
      [b[0] + px, b[1], b[2] + pz], [b[0] - px, b[1], b[2] - pz],
      color, up
    );
  }

  /** Gulong: cylinder na may horizontal axis (local +x), rotY ang heading. */
  wheel(cx, cy, cz, r, w, seg, color, yaw) {
    const cos = Math.cos(yaw);
    const sin = Math.sin(yaw);
    // local axes sa world
    const lx = [cos, 0, -sin];  // side (axis ng gulong)
    const lz = [sin, 0, cos];   // forward
    const P = (t, th) => [
      cx + lx[0] * t + lz[0] * Math.cos(th) * r,
      cy + Math.sin(th) * r,
      cz + lx[2] * t + lz[2] * Math.cos(th) * r,
    ];
    for (let i = 0; i < seg; i++) {
      const t0 = (i / seg) * Math.PI * 2;
      const t1 = ((i + 1) / seg) * Math.PI * 2;
      const a0 = P(-w / 2, t0), a1 = P(-w / 2, t1);
      const b1 = P(w / 2, t1), b0 = P(w / 2, t0);
      // outward normal sa gitna ng arc
      const mid = (t0 + t1) / 2;
      const n = [
        lz[0] * Math.cos(mid) + 0 * Math.sin(mid),
        Math.sin(mid),
        lz[2] * Math.cos(mid),
      ];
      this.quad(a0, a1, b1, b0, color, n);
    }
    // Side caps: fan mula sa gitna gamit ang MID-angles ng bawat segment.
    // (Kung gamitin ang t0/t1, may segment na i=0 na zero-area dahil t0 = 0.)
    const stepA = (Math.PI * 2) / seg;
    for (let i = 0; i < seg; i++) {
      const m0 = i * stepA + stepA / 2;
      const m1 = (i + 1) * stepA + stepA / 2;
      this.tri(P(-w / 2, 0), P(-w / 2, m0), P(-w / 2, m1), color, [-lx[0], 0, -lx[2]]);
      this.tri(P(w / 2, 0), P(w / 2, m0), P(w / 2, m1), color, [lx[0], 0, lx[2]]);
    }
  }

  build(material) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    geo.setIndex(this.idx);
    const mesh = new THREE.Mesh(geo, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    return mesh;
  }

  get triangles() { return this.idx.length / 3; }
}


