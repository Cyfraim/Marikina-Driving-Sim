// ---------------------------------------------------------------------------
// Roads.js - Road network ng Nangka mula sa totoong GPS data (roadData.js)
//
// Structure ng Nangka, Marikina (see .clinerules):
// - Main roads: Bayan-Bayanan Avenue (14 m, 4 lanes) at J. P. Rizal Street (9 m)
// - Side streets: residential na polylines (Twinville, barangay streets)
// - Intersections: natural na nag-o-overlap ang mga ribbon sa mga junction
// - Sidewalks + curbs sa mga pangunahing kalsada, dashed lane markings
//
// 1 scene unit = 1 metre (see utils/geo.js). Lahat ng geometry ay low-poly
// at naka-merge sa 4 na mesh lang para sa 60fps.
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { ROADS } from './roadData.js';
import { gpsToLocal, terrainHeight } from '../utils/geo.js';
import { ROAD_LINES, SW_WIDTH, sidewalkWidth, mulberry32 } from '../utils/roadLayout.js';
import { getRoadProfile } from '../utils/RoadProfile.js';

// NOTE: SW_WIDTH ay imported mula sa roadLayout.js (single source of truth)
// - dapat TUGMA ito sa boundary.js RoadConfinement limit computation.
// Fix 5: ang bangketa ay PER-CLASS (1.8 m residential .. 2.8 m main road),
// kaya ang geometry gamit ang sidewalkWidth(rd.cls), hindi ang constant.

// Heights (relative sa antas ng Lupa sa bawat punto, para masundan ang
// slope ng Nangka). Lahat ng asphalt ay may PAREHONG offset - kapag
// nag-overlap ang dalawang kalsada sa intersection, invisible ang z-fighting.
const ROAD_Y = 0.01;
const MARK_Y = ROAD_Y + 0.012; // markings ay bahagyang nasa itaas ng asphalt
const SW_HEIGHT = 0.15;        // taas ng bangketa/curb (tulad sa Nangka)
// lapad ng bangketa: per-class, mula sa roadLayout.js (Fix 5)
// lapad ng "lot fill" (kompaktadong lupa/semento) sa pagitan ng bangketa at
// building (Fix 2): 6 m mula sa labas ng bangketa, pero palaging umaabot
// ng hindi bababa sa 15 m mula sa CENTERLINE ng kalsada - kaya ang berdeng
// ground plane ay LALO lang lumalabas sa mga labasan (open fields).
const LOT_WIDTH = 6.0;
const LOT_MIN_FROM_CENTER = 15.0;
const LOT_Y = 0.005;           // above ground, below road and sidewalk
const DASH_LEN = 3;            // haba ng puting dash sa gitna
const DASH_GAP = 3;
const MARK_W = 0.14;           // lapad ng lane marking
// --- Fix 6: weathering ng kalsada ---------------------------------------
// Ang dating asphalt ay perpekto at makinis - sa totoong Marikina, ang
// kalsada ay may patch ng semento, medyo abradadong gilid, at manhole.
const WEAR_Y = ROAD_Y + 0.008; // sa itaas ng asphalt, sa ibaba ng markings
const PATCH_COLOR = 0x555555; // 1-3 m na patch ng semento
const EDGE_COLOR = 0x666666;  // 0.2 m na strips sa gilid ng kalsada
const MANHOLE_COLOR = 0x222222;
// Fix 6: ang dating 0xffffff (pure white) ay masyadong mating pagitan sa
// makapal na kalsada ng Marikina - ang totoong ay off-white na 0xDDDDDD.
const MARK_COLOR = 0xdddddd;
// Spacing ng wear pass. Maliit ang halaga => mas patag ang mga quad, pero
// mas maraming triangles. 4 m ay kasyahang patag sa 0.4 m/s na slope.
const WEAR_SAMPLE = 6;
const SIDE_SAMPLE = 10;        // retain all source bends; subdivide long runs only
const LOT_SAMPLE = 16;        // planar frontage needs less redundant tessellation
const UP = [0, 1, 0];

// Kulay base sa OSM `surface` tag:
// - concrete = light grey (barangay streets sa Nangka, karamihan)
// - asphalt  = dark grey (main roads / tertiary)
const SURFACE_COLORS = {
  concrete: 0x999999,
  asphalt: 0x444444,
  unpaved: 0x7a6f5d,
};

// Sidewalk gray (0-3 m) at lot fill (3-20 m) - para hindi na plain green
// ang ground sa tabi ng kalsada (spec Fix 2/5)
const SIDEWALK_COLOR = 0xcccccc;
const LOT_FILL_COLOR = 0x9e8c6e;

// --- Minimal triangle-mesh accumulator (walang per-quad meshes = mabilis) ---
class MeshBuilder {
  constructor() {
    this.positions = [];
    this.normals = [];
    this.indices = [];
    this.count = 0;
  }

  // a,b,c,d = [x,y,z]; winding iaayos ayon sa gustong normal (`want`)
  quadFacing(a, b, c, d, want) {
    const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const bc = [c[0] - b[0], c[1] - b[1], c[2] - b[2]];
    const n = [
      ab[1] * bc[2] - ab[2] * bc[1],
      ab[2] * bc[0] - ab[0] * bc[2],
      ab[0] * bc[1] - ab[1] * bc[0],
    ];
    // FIX: kapag ZERO ang `want` (posible kapag may duplicate points sa
    // polyline at wala pang valid na direksyon), gamitin ang computed face
    // normal. Sa dating code ang `|| 1` ay nagbibigay ng (0,0,0) na vertex
    // normal - zero lighting at naka-"perp" sa plane nang >60 deg.
    if (Math.hypot(want[0], want[1], want[2]) < 1e-9) {
      const l = Math.hypot(n[0], n[1], n[2]);
      want = l < 1e-9 ? UP : [n[0] / l, n[1] / l, n[2] / l];
    }
    const flip = n[0] * want[0] + n[1] * want[1] + n[2] * want[2] < 0;
    const quad = flip ? [a, d, c, b] : [a, b, c, d]; // baligtarin kung baliktad ang facing
    const nl = Math.hypot(want[0], want[1], want[2]) || 1;
    const nn = [want[0] / nl, want[1] / nl, want[2] / nl];
    const base = this.count;
    for (const p of quad) {
      this.positions.push(p[0], p[1], p[2]);
      this.normals.push(nn[0], nn[1], nn[2]);
    }
    this.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    this.count += 4;
  }

  /** Isang patagong triangle; winding ayon sa gustong normal. */
  triFacing(a, b, c, want) {
    const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    let n = [
      ab[1] * ac[2] - ab[2] * ac[1],
      ab[2] * ac[0] - ab[0] * ac[2],
      ab[0] * ac[1] - ab[1] * ac[0],
    ];
    if (Math.hypot(want[0], want[1], want[2]) < 1e-9) {
      const l = Math.hypot(n[0], n[1], n[2]);
      want = l < 1e-9 ? UP : [n[0] / l, n[1] / l, n[2] / l];
    }
    const tri = (n[0] * want[0] + n[1] * want[1] + n[2] * want[2]) < 0 ? [a, c, b] : [a, b, c];
    const nl = Math.hypot(want[0], want[1], want[2]) || 1;
    const nn = [want[0] / nl, want[1] / nl, want[2] / nl];
    const base = this.count;
    for (const p of tri) {
      this.positions.push(p[0], p[1], p[2]);
      this.normals.push(nn[0], nn[1], nn[2]);
    }
    this.indices.push(base, base + 1, base + 2);
    this.count += 3;
  }

  /** Flat disc (manhole cover) - fan mula sa gitna, nasa XZ plane. */
  disc(cx, cy, cz, r, seg, color, want) {
    for (let i = 0; i < seg; i++) {
      const t0 = (i / seg) * Math.PI * 2;
      const t1 = ((i + 1) / seg) * Math.PI * 2;
      this.triFacing(
        [cx, cy, cz],
        [cx + Math.cos(t0) * r, cy, cz + Math.sin(t0) * r],
        [cx + Math.cos(t1) * r, cy, cz + Math.sin(t1) * r],
        want
      );
    }
    void color; // MeshBuilder ay vertex-color based; kulay ay nasa material
  }

  build(material) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(this.normals, 3));
    geo.setIndex(this.indices);
    const mesh = new THREE.Mesh(geo, material);
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false; // static geometry - hindi gumagalaw kailanman
    return mesh;
  }
}

// --- Geometry helpers -------------------------------------------------------

// Per-vertex mitred normals ng isang polyline (para maayos ang liko/kanto)
function vertexNormals(pts) {
  if (!pts || pts.length === 0) return [];
  if (pts.length === 1) return [{ x: 0, z: 0 }];
  const seg = [];
  // FIX (visual pass): kung may DUPLICATE / zero-length segment, ang
  // normal ay magiging (0,0) - at pagkatapos ay magiging ZERO VECTOR ang
  // `want` ng curb face, kaya walang lighting at naka-"perp" ang mukha.
  // Dito, ini-carry forward ang dating valid na direksyon.
  let lastX = 0, lastZ = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const dx = pts[i + 1].x - pts[i].x;
    const dz = pts[i + 1].z - pts[i].z;
    const len = Math.hypot(dx, dz);
    if (len < 1e-6) { seg.push(null); continue; }
    seg.push({ x: -dz / len, z: dx / len });
    lastX = seg[seg.length - 1].x;
    lastZ = seg[seg.length - 1].z;
  }
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    const a = seg[Math.max(0, i - 1)] || { x: lastX, z: lastZ };
    const b = seg[Math.min(seg.length - 1, i)] || { x: lastX, z: lastZ };
    let mx = a.x + b.x;
    let mz = a.z + b.z;
    // FIX: kung ang mitre sum ay ~0 (HAIRPIN / U-turn - magkabilang
    // direksyon), huwag na pumunta sa (0,0) - GUMAMIT ng isa sa dalawang
    // segment normal. Ang (0,0) ay nagbibigay ng degenerate geometry
    // (4 na sulok sa iisang punto) sa wear pass at zero-light sa curb.
    const ml = Math.hypot(mx, mz);
    if (ml < 1e-6) {
      const bl = Math.hypot(b.x, b.z) || 1;
      out.push({ x: b.x / bl, z: b.z / bl });
      continue;
    }
    mx /= ml;
    mz /= ml;
    const cos = mx * b.x + mz * b.z; // miter scale, may cap para walang spike
    const scale = Math.min(2.5, 1 / Math.max(0.4, cos));
    out.push({ x: mx * scale, z: mz * scale });
  }
  return out;
}

// Mag-insert ng punto para ang spacing ay hindi lumampas sa maxLen
//
// FIX 2: may BUG dito bago - kung ang unang segment ay maikli (d <= maxLen),
// hindi napipush ang `b`, kaya lumalaba sa isang 1-puntong array. Hindi ito
// nahahati sa dating buong-mapa na pagkakataon dahil halos lahat ng kalsada ay
// may mahabang unang segment, pero pag dinidikit ng TILE CLIPPING (ang unang
// punto ng tile ay maaaring ilang metro lang mula sa susunod) biglang nag-crash
// sa vertexNormals(). Ang ayus: palaging i-push ang b, at i-guard ang
// vertexNormals sa mga 0-1 puntong polyline.
function densify(pts, maxLen) {
  if (!pts || pts.length === 0) return [];
  if (pts.length === 1) return [pts[0]];
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const a = out[out.length - 1];
    const b = pts[i];
    // FIX (visual pass): SKIP ang duplicate points. Ang TILE CLIPPING at
    // minsan ay naglalagay ng eksaktong parehong pangalawang point (ang
    // dating vertex ay nasa mismo ang border). Ang zero-length segment ay
    // nagbibigay ng (0,0) na normal => (a) ZERO vertex normal sa curb face,
    // at (b) DEGENERATE quads sa wear pass (4 na sulok sa iisang punto).
    const d = Math.hypot(b.x - a.x, b.z - a.z);
    if (d < 1e-6) continue;
    if (d > maxLen) {
      const n = Math.ceil(d / maxLen);
      for (let k = 1; k < n; k++) {
        out.push({ x: a.x + ((b.x - a.x) * k) / n, z: a.z + ((b.z - a.z) * k) / n });
      }
    }
    out.push(b);
  }
  return out;
}

// Pinakamalapit na dist mula point hanggang polyline (2D, sa XZ plane)
function distToPolyline(px, pz, pts) {
  let best = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const ax = pts[i].x;
    const az = pts[i].z;
    const dx = pts[i + 1].x - ax;
    const dz = pts[i + 1].z - az;
    const l2 = dx * dx + dz * dz;
    let t = l2 ? ((px - ax) * dx + (pz - az) * dz) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    const d = Math.hypot(px - (ax + dx * t), pz - (az + dz * t));
    if (d < best) best = d;
  }
  return best;
}

// ---------------------------------------------------------------------------
// FIX 2 - TILE CLIPPING
//
// Para sa buong Marikina, ang isang kalsada ay maaaring humayo ng 6 km at
// dumaan sa maraming tile. Kung gagawin natin ang geometry ng buong kalsada
// sa bawat tile na natatamaan nito, madoble ang mga triangle. Kaya ini-clip
// natin ang polyline sa loob ng AABB ng tile (na may margin) - magkakadikit
// pa rin ang mga magkabilang tile dahil sa overlap ng margin.
//
// CLIP_MARGIN ay dapat mas malaki sa PINAKAMALAYO na inilalagay na bagay
// sa tabi ng kalsada: half-width (8.75 m) + bangketa (3 m) + lot fill (20 m)
// ~= 32 m. 45 m para may safety margin at para hindi maputol ang dulo ng
// kalsada sa tile border.
//
// FIX 1 - MALINAW NA PAGPAPALIWANAG: ang CLIP_MARGIN ay GINAMAGAMI sa
// REJECT TEST lang (ang unang bbox check sa build()), HINDI sa mismong clip.
// Ang clipPolyline ay gumagamit ng RAW tile bounds - ang magkakatugong tile ay
// eksaktong NAGHAPIT, walang overlap.
//
// Bakit ito ang tamang pagpipilian (ang dating "may margin" na clip ay mas
// masama):
//  - Kung may overlap ang clip, DITO mag-doble ang asphalt ng magkabilang
//    tile sa overlap band - COPLANAR na surface, i.e. z-fighting sa halos
//    90 m ng kalsada kada tile border.
//  - Ang eksaktong pagdikit ay PERFEKTO para sa asphalt: magkatabi ang
//    vertices, walang butas.
//  - Ang PROBLEMA ay ang curb END CAPS: ang bawat run na natatapos sa border
//    ay naglalabas ng cap, at ang katabing tile ay naglalabas ng kaparehong
//    cap sa TILANG PUNTONG IYON = magkakapatong coplanar faces.
//    Ang ayus ay ang onClipBorder() check sa build() - hindi na namin
//    ini-e-emit ang cap kung clip artefact ang dulo (ang cap ay para sa tunay
//    na dulo ng kalsada lamang).
// ---------------------------------------------------------------------------
const CLIP_MARGIN = 45;

/** Liang-Barsky: i-clip ang isang segment sa loob ng axis-aligned box. */
function clipSegment(a, b, minX, maxX, minZ, maxZ) {
  let t0 = 0, t1 = 1;
  const dx = b.x - a.x, dz = b.z - a.z;
  const p = [-dx, dx, -dz, dz];
  const q = [a.x - minX, maxX - a.x, a.z - minZ, maxZ - a.z];
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) {
      if (q[i] < 0) return null; // parallel at nasa labas
      continue;
    }
    const r = q[i] / p[i];
    if (p[i] < 0) {
      if (r > t1) return null;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return null;
      if (r < t1) t1 = r;
    }
  }
  return [
    { x: a.x + dx * t0, z: a.z + dz * t0 },
    { x: a.x + dx * t1, z: a.z + dz * t1 },
  ];
}

/**
 * I-clip ang polyline sa box, at ibinabalik ang mga magkakadikit na run ng
 * 2+ na punto. Ang mga tumatlong ay pinagsasama para hindi magkaroon ng
 * artefakto sa dulo ng tile.
 */
export function clipPolyline(pts, minX, maxX, minZ, maxZ) {
  const runs = [];
  let cur = null;
  for (let i = 0; i < pts.length - 1; i++) {
    const s = clipSegment(pts[i], pts[i + 1], minX, maxX, minZ, maxZ);
    if (!s) { cur = null; continue; }
    if (!cur) { cur = s; runs.push(cur); }
    else cur.push(s[1]);
  }
  // Ang bawat run ay nagsisimula sa isang 2-pointong clipped segment, kaya
  // garantisado nang >= 2 na punto - walang degenerate ribbon.
  //
  // FIX 1: alisin ang mga ZERO-SPAN run. May mga segment na pumasok sa box at
  // umalis agad (sa sulok/capo lang), kaya ang t2 == t1 at ang 2 punto ay
  // magkapantay. Bago ito ay naglalabas ang ribbon na walangGEOMETRY
  // (2 triangles na zero-area) - invisible at pabigat lamang.
  return runs.filter(
    (r) => r.length >= 2 && Math.hypot(r[r.length - 1].x - r[0].x, r[r.length - 1].z - r[0].z) > 1e-6
  );
}

/**
 * Nasa border ba ng clip box ang puntong ito?
 *
 * FIX 1 (root cause ng "broken roads" sa tile seams): ang clip ay GINAGAMIT ang
 * RAW tile bounds (wala nang margin), kaya ang magkakatugong tile ay eksaktong
 * NAGHAPIT. Ang bawat run na natatapos sa border ay naglalabas ng CURB END CAP
 * (emitSidewalkRun) - at ang katabing tile ay naglalabas ng sarili nitong cap sa
 * TILANG PUNTONG IYON. Magkakapatong coplanar na geometry = z-fighting at
 * makikitang "basang" kalsada sa bawat tile border.
 *
 * Ayus: huwag na mag-emit ng cap kung ang dulo ay artefact ng clip (ipinapasok
 * o iniabot lamang ng tile) - ang cap ay para sa TUNAY na dulo ng kalsada.
 */
function onClipBorder(p, b) {
  const E = 1e-6;
  return (
    Math.abs(p.x - b.minX) < E || Math.abs(p.x - b.maxX) < E ||
    Math.abs(p.z - b.minZ) < E || Math.abs(p.z - b.maxZ) < E
  );
}

/**
 * Road bounding box + margin. Ang margin ay humigit-kulang sa maximum na
 * lawak ng kalsada (half-width) + pinakamalabong offset ng nililagay na bagay
 * (bangketa + lote), para hindi maputol ang kalsada sa tile border.
 */
export function roadBBox(rd, margin) {
  return {
    minX: rd.minX - margin, maxX: rd.maxX + margin,
    minZ: rd.minZ - margin, maxZ: rd.maxZ + margin,
  };
}

export class Roads {
  constructor(scene) {
    this.roadLines = ROAD_LINES; // shared index - gamit ng boundary system
    this.scene = scene;
    this.group = new THREE.Group();
    scene.add(this.group);
    this.collisionBoxes = []; // kalsada = drivable, walang collision box
    this.surfaceRoughness = null; // Current weather, inherited by streamed tiles.

    // FIX 2: ang conversion at ang junction grid ay GINAWA ISANG BESES sa
    // constructor. Bago, nasa build() sila - kaya kung magbu-build tayo ng
    // 350 tile, 350x ang paulit-ulit na gawain para sa parehong bagay.
    this.roads = this.#convertRoads();
    this.#buildJunctionGrid();
  }

  /** GPS polylines -> local scene units (1 unit = 1 m), may bbox. */
  #convertRoads() {
    const out = [];
    for (const r of ROADS) {
      let pts = r.pts.map(([lat, lon]) => gpsToLocal(lat, lon));
      pts = pts.filter((p, i) => i === 0 || Math.hypot(p.x - pts[i - 1].x, p.z - pts[i - 1].z) > 0.05);
      if (pts.length < 2) continue;
      const profile = getRoadProfile(r);
      const rd = { name: r.name, cls: r.cls, sw: r.sw, mk: r.mk, profile, half: profile.carriageWidth / 2, pts };
      rd.surf = SURFACE_COLORS[r.surf] !== undefined ? r.surf : 'asphalt';
      rd.minX = Math.min(...pts.map((p) => p.x));
      rd.maxX = Math.max(...pts.map((p) => p.x));
      rd.minZ = Math.min(...pts.map((p) => p.z));
      rd.maxZ = Math.max(...pts.map((p) => p.z));
      out.push(rd);
    }
    return out;
  }

  /**
   * Fix 6 - weathering ng kalsada. Sa totoong Marikina, ang kalsada ay
   * hindi uniform: may patch-patch ng semento (1-3 m), medyo abradadong
   * gilid sa tabi ng curb (0.2 m na mas maliwanag na strip), at mga
   * manhole cover (0.6 m) sa main roads.
   *
   * Ang RNG ay PER-ROAD (seeded mula sa index) para pareho ang resulta
   * kahit buong-mapa o per-tile ang build.
   */
  addWear(patchB, edgeB, manB, rd, idx, inJunction) {
    // CRITICAL FIX: ang wear pass ay DENSIFIED sa <=WEAR_SAMPLE m. Kung
    // gamitin ang raw rd.pts (na simplificado sa 10-15 m kada segment),
    // ang mga quads ay LUBOS na non-planar sa sloping terrain - naaabot
    // hanggang 15 m x 0.2 m. Iba ang normal ng dalawang triangle noon
    // (naka-"perp" sa vertex normal = maliwanag nang hindi tama ang
    // parallax) at ang asphalt ay lumulutang sa ibaba ng lupa.
    const line = densify(rd.pts, WEAR_SAMPLE);
    if (line.length < 2) return;
    const rnd = mulberry32((0x57454152 ^ Math.imul(idx + 1, 2654435761)) >>> 0);
    const n = vertexNormals(line);
    const major = rd.cls === 'primary' || rd.cls === 'secondary';
    const ew = 0.2; // lapad ng abradadong gilid

    // 1) Gilid: 0.2 m na mas maliwanag na strip sa dalawang gilid.
    //    MAIN ROADS NA MAY CURB LAMANG - sa mga concrete barangay street
    //    karaniwang walang curb, kaya walang "abrased edge" na ipapakita,
    //    at ito ay 2 quad kada segment (malaking bahagi ng tri budget).
    if (major && rd.sw !== 'none') {
      for (let i = 0; i < line.length - 1; i++) {
        const p0 = line[i];
        const p1 = line[i + 1];
        const n0 = n[i];
        const n1 = n[i + 1];
        for (const sgn of [1, -1]) {
          const ax = p0.x + n0.x * rd.half * sgn;
          const az = p0.z + n0.z * rd.half * sgn;
          const bx = p1.x + n1.x * rd.half * sgn;
          const bz = p1.z + n1.z * rd.half * sgn;
          const cx = p0.x + n0.x * (rd.half - ew) * sgn;
          const cz = p0.z + n0.z * (rd.half - ew) * sgn;
          const dx = p1.x + n1.x * (rd.half - ew) * sgn;
          const dz = p1.z + n1.z * (rd.half - ew) * sgn;
          edgeB.quadFacing(
            [ax, terrainHeight(ax, az) + WEAR_Y, az],
            [cx, terrainHeight(cx, cz) + WEAR_Y, cz],
            [dx, terrainHeight(dx, dz) + WEAR_Y, dz],
            [bx, terrainHeight(bx, bz) + WEAR_Y, bz],
            UP
          );
        }
      }
    }

    // 2) Patch ng semento (1-3 m) - mas marami sa main roads
    const pProb = major ? 0.05 : 0.02;
    for (let i = 0; i < line.length - 1; i++) {
      if (rnd() > pProb) continue;
      const p0 = line[i];
      const p1 = line[i + 1];
      const n0 = n[i];
      const segLen = Math.hypot(p1.x - p0.x, p1.z - p0.z);
      if (segLen < 1.5) continue;
      const t = 0.15 + rnd() * 0.7;
      const px = p0.x + (p1.x - p0.x) * t;
      const pz = p0.z + (p1.z - p0.z) * t;
      if (inJunction(px, pz, idx, 1.0)) continue; // huwag takpan ang intersection
      const latMax = Math.max(0, rd.half - 0.8);
      const lat = (rnd() * 2 - 1) * latMax;
      const cx = px + n0.x * lat;
      const cz = pz + n0.z * lat;
      const pw = 1 + rnd() * 2;   // 1-3 m (across the road)
      const pd = 0.8 + rnd() * 1.8; // depth (along the road)
      // BUG NA HINULING: ang dating code ay gumagamit ng n0 (ang NORMAL)
      // para sa BOTH axes - kaya kapag n0 = (0,1) (patagong bahagi),
      // nagiging linya na may zero ang lapad = 217 degenerate faces.
      // Tama: depth = TANGENT (tx,tz), width = NORMAL (n0).
      const tx = -n0.z;
      const tz = n0.x;
      const ex = tx * (pd / 2);
      const ez = tz * (pd / 2);
      const fx2 = n0.x * pw;
      const fz2 = n0.z * pw;
      // patagong patch: lahat ng 4 sulok sa iisang taas (kung hindi, lalabas sa
      // ibaba ng asphalt dahil hindi planar ang lupa sa loob ng 3 m)
      const y = terrainHeight(cx, cz) + WEAR_Y;
      patchB.quadFacing(
        [cx - ex, y, cz - ez], [cx + ex, y, cz + ez],
        [cx + ex + fx2, y, cz + ez + fz2],
        [cx - ex + fx2, y, cz - ez + fz2],
        UP
      );
    }

    // 3) Manhole cover (0.6 m) sa main roads, tuwing 30-50 m
    if (!major) return;
    let acc = 30 + rnd() * 20;
    for (let i = 0; i < line.length - 1; i++) {
      const p0 = line[i];
      const p1 = line[i + 1];
      const segLen = Math.hypot(p1.x - p0.x, p1.z - p0.z);
      if (segLen < 0.5) continue;
      let run = acc;
      while (run < segLen) {
        const t = run / segLen;
        const px = p0.x + (p1.x - p0.x) * t;
        const pz = p0.z + (p1.z - p0.z) * t;
        if (!inJunction(px, pz, idx, 2.0)) {
          const lat = (rnd() * 2 - 1) * Math.max(0, rd.half - 0.9);
          const mx = px + n[i].x * lat;
          const mz = pz + n[i].z * lat;
          manB.disc(mx, terrainHeight(mx, mz) + WEAR_Y, mz, 0.3, 6, MANHOLE_COLOR, UP);
        }
        run += 30 + rnd() * 20;
      }
      acc = run - segLen;
    }
  }

  /**
   * FIX 2: ang dating `inJunction` ay nag-scan ng LAHAT ng kalsada sa bawat
   * sample point - O(roads) linear scan. Sa Nangka (139 roads) ay okay pa,
   * pero sa buong Marikina (6,789 roads) naipupunto ito sa ~2 bilyong
   * distToPolyline na tawag at hindi na tapos ang build. Ginawa na itong
   * spatial grid: bawat kalsada ay naka-bucket sa lahat ng cells na sakop ng
   * bbox + margin, kaya nananatili lang ang malalaking kalsada.
   *
   * ANG GRID AY GLOBAL (hindi per-tile) dahil kailangan pa rin ng junction
   * test na makita ang kalsada sa magkabilang gilid ng tile border - kung
   * per-tile lang, magkakaroon ng siradong sidewalk sa bawat seam.
   */
  #buildJunctionGrid() {
    const JCELL = 40;       // metres per grid cell
    const JMAX_REACH = 20;  // max (half-width + pad) sa lahat ng klase
    const jgrid = new Map();
    const jkey = (cx, cz) => `${cx},${cz}`;
    for (let j = 0; j < this.roads.length; j++) {
      const o = this.roads[j];
      const c0 = Math.floor((o.minX - JMAX_REACH) / JCELL);
      const c1 = Math.floor((o.maxX + JMAX_REACH) / JCELL);
      const d0 = Math.floor((o.minZ - JMAX_REACH) / JCELL);
      const d1 = Math.floor((o.maxZ + JMAX_REACH) / JCELL);
      for (let cx = c0; cx <= c1; cx++) {
        for (let cz = d0; cz <= d1; cz++) {
          const k = jkey(cx, cz);
          let list = jgrid.get(k);
          if (!list) { list = []; jgrid.set(k, list); }
          list.push(j);
        }
      }
    }
    this._jgrid = jgrid;
    this._jcell = JCELL;
    this._jkey = jkey;
  }

  /** Nasa loob ba ng corridor ng ibang kalsada ang (x, z)? */
  inJunction(x, z, skipIdx, pad) {
    const list = this._jgrid.get(this._jkey(Math.floor(x / this._jcell), Math.floor(z / this._jcell)));
    if (!list) return false;
    for (let n = 0; n < list.length; n++) {
      const j = list[n];
      if (j === skipIdx) continue;
      const o = this.roads[j];
      const reach = o.half + pad;
      if (x < o.minX - reach || x > o.maxX + reach) continue;
      if (z < o.minZ - reach || z > o.maxZ + reach) continue;
      if (distToPolyline(x, z, o.pts) < reach) return true;
    }
    return false;
  }

  /**
   * I-build ang mga ribbon ng kalsada.
   *
   * @param bounds  {minX,maxX,minZ,maxZ} - kung set, BANGUNO lang ang geometry
   *                sa loob ng box (na may margin) - ito ang tile build. Kung
   *                null, buong mapa ang ginagawa (legacy / tools).
   * @param target  THREE.Group na tatanggapin ang mga mesh.
   */
  build(bounds = null, target = this.group) {
    const roads = this.roads;
    // Ang index ay dapat ang index sa FULL list (para tama ang skipIdx sa
    // junction test) kahit may ini-clip tayong polyline.
    const inJunction = (x, z, skipIdx, pad) => this.inJunction(x, z, skipIdx, pad);

    // 3) I-build ang lahat ng ribbon - naka-merge lang bawat SURFACE
    //    (concrete vs asphalt) para hindi managin ang isang malaking mesh,
    //    pero kaunti pa rin ang draw calls (3 surface meshes + sidewalk etc.)
    const surfaceByType = {
      concrete: new MeshBuilder(),
      asphalt: new MeshBuilder(),
      unpaved: new MeshBuilder(),
    };
    const walkTop = new MeshBuilder();
    const curbFaces = new MeshBuilder();
    const lotFill = new MeshBuilder();
    const frontageConcrete = new MeshBuilder();
    const marks = new MeshBuilder();
    // Fix 6: tatlong hiwalay na builder dahil tatlong magkaibang kulay
    const wearPatch = new MeshBuilder();
    const wearEdge = new MeshBuilder();
    const wearMan = new MeshBuilder();

    for (let i = 0; i < roads.length; i++) {
      const rd = roads[i];
      // FIX 2: kung may bounds (tile build), lumaktaw sa mga kalsadang
      // malayo, at i-clip ang polyline sa loob ng box.
      if (bounds) {
        const M = CLIP_MARGIN;
        if (rd.maxX + M < bounds.minX || rd.minX - M > bounds.maxX ||
            rd.maxZ + M < bounds.minZ || rd.minZ - M > bounds.maxZ) continue;
        const runs = clipPolyline(rd.pts, bounds.minX, bounds.maxX, bounds.minZ, bounds.maxZ);
        if (runs.length === 0) continue;
        for (const run of runs) {
          // FIX 1: marka kung ang bago at huling dulo ay ARTEFACT ng clip.
          // Kapag nasa border ang tile, hindi dapat mag-emit ng curb end cap -
          // ang katabing tile na ang bahala nyan (at magkakapantay sila kung
          // parehong nag-emit, kaya z-fighting).
          const piece = {
            ...rd,
            pts: run,
            i,
            capStart: !onClipBorder(run[0], bounds),
            capEnd: !onClipBorder(run[run.length - 1], bounds),
          };
          this.addSurface(surfaceByType[rd.surf], piece);
          if (rd.sw !== 'none') this.addSidewalk(walkTop, curbFaces, piece, i, inJunction);
          this.addLotFill(lotFill, piece, i, inJunction, frontageConcrete);
          if (rd.mk) this.addMarkings(marks, piece, i, inJunction);
          this.addWear(wearPatch, wearEdge, wearMan, piece, i, inJunction);
        }
        continue;
      }
      this.addSurface(surfaceByType[rd.surf], rd);
      if (rd.sw !== 'none') this.addSidewalk(walkTop, curbFaces, rd, i, inJunction);
      // "Lot fill" strip: 6 m mula sa labas ng bangketa, palaging umaabot
      // ng >= 15 m mula sa centerline (Fix 2). Pinapalitan ang berdeng lupa
      // sa tabi ng kalsada ng kongkreto/lupa.
      this.addLotFill(lotFill, rd, i, inJunction, frontageConcrete);
      if (rd.mk) this.addMarkings(marks, rd, i, inJunction);
      this.addWear(wearPatch, wearEdge, wearMan, rd, i, inJunction);
    }

    // Asphalt/concrete: magkakaibang kulay kada surface type.
    for (const type of Object.keys(surfaceByType)) {
      const b = surfaceByType[type];
      if (b.count === 0) continue;
      const mat = new THREE.MeshStandardMaterial({
        color: SURFACE_COLORS[type],
        roughness: this.surfaceRoughness ?? (type === 'concrete' ? 0.95 : 0.85),
      });
      // PHASE 2D: markahan bilang "kalsada" para madaling hanapin ng
      // Game.setWetness() (basang kalsada = mas mababa ang roughness).
      mat.__isRoad = true;
      target.add(b.build(mat));
    }
    target.add(
      walkTop.build(new THREE.MeshStandardMaterial({ color: SIDEWALK_COLOR, roughness: 0.7 }))
    );
    target.add(
      lotFill.build(new THREE.MeshStandardMaterial({ color: 0x9e8c6e, roughness: 0.95 }))
    );
    target.add(frontageConcrete.build(new THREE.MeshStandardMaterial({ color: 0xaaaaaa, roughness: 0.95 })));
    target.add(
      curbFaces.build(new THREE.MeshStandardMaterial({ color: 0x999999, roughness: 0.8 }))
    );
    target.add(
      marks.build(new THREE.MeshStandardMaterial({ color: MARK_COLOR, roughness: 0.6 }))
    );
    // Fix 6: weathering layers (patch / edge / manhole) - tatlong draw calls
    target.add(
      wearPatch.build(new THREE.MeshStandardMaterial({ color: PATCH_COLOR, roughness: 0.95 }))
    );
    target.add(
      wearEdge.build(new THREE.MeshStandardMaterial({ color: EDGE_COLOR, roughness: 0.95 }))
    );
    target.add(
      wearMan.build(new THREE.MeshStandardMaterial({ color: MANHOLE_COLOR, roughness: 0.8 }))
    );
  }

  // Flat asphalt/concrete ribbon na sumusunod sa centerline (sumasunod sa terrain)
  addSurface(b, rd) {
    const n = vertexNormals(rd.pts);
    const L = [];
    const R = [];
    for (let i = 0; i < rd.pts.length; i++) {
      const p = rd.pts[i];
      const ni = n[i];
      const lx = p.x + ni.x * rd.half;
      const lz = p.z + ni.z * rd.half;
      const rx = p.x - ni.x * rd.half;
      const rz = p.z - ni.z * rd.half;
      // sumusunod sa slope ng lupa
      L.push([lx, terrainHeight(lx, lz) + ROAD_Y, lz]);
      R.push([rx, terrainHeight(rx, rz) + ROAD_Y, rz]);
    }
    for (let i = 0; i < rd.pts.length - 1; i++) {
      // FIX (visual pass): ang TILE CLIPPING ay minsan naglalagay ng
      // duplicate point (ang dating vertex ay nasa mismo ang border).
      // Zero-length segment = zero-area ribbon quad. Skip.
      const a = rd.pts[i];
      const c = rd.pts[i + 1];
      if (Math.hypot(c.x - a.x, c.z - a.z) < 1e-3) continue;
      b.quadFacing(L[i], R[i], R[i + 1], L[i + 1], UP);
    }
  }

  // "Lot fill" strip sa gilid ng kalsada: mula labas ng banketa (0-3 m mula
  // sa curb) hanggang 20 m mula sa curb. Ito ang pinapalitan ng dating
  // berdeng ground plane - sa lalim ng Nangka halos lahat ng tabi ng kalsada
  // ay sementadong lote o lupa, hindi damo (spec Fix 2/5).
  addLotFill(b, rd, idx, inJunction, concrete = b) {
    // ang panig na wala nang bangketa = panig na 'left'/'both' (mas maraming
    // espasyo). Panig na may bangketa na 'right' ay kailangan din ng fill
    // sa labas ng curb.
    const line = densify(rd.pts, LOT_SAMPLE);
    const nrm = vertexNormals(line);
    const sides = [1, -1];
    for (const sign of sides) {
      const sidewalk = sign > 0 ? rd.profile.leftSidewalkWidth : rd.profile.rightSidewalkWidth;
      const curb = rd.half + rd.profile.shoulderWidth;
      // 0-2m concrete, 2-8m compacted lot. Preserve wider authored sidewalks.
      for (const [builder, dIn, dOut] of [
        [concrete, curb + sidewalk, curb + Math.max(2, sidewalk)],
        [b, curb + Math.max(2, sidewalk), curb + 8],
      ]) {
      if (dOut <= dIn) continue;
      const rows = [];
      for (let i = 0; i < line.length; i++) {
        const p = line[i];
        const ni = nrm[i];
        const row = {
          ix: p.x + ni.x * dIn * sign, iz: p.z + ni.z * dIn * sign,
          ox: p.x + ni.x * dOut * sign, oz: p.z + ni.z * dOut * sign,
        };
        // Ilagay sa taas ng lupa (parang ground plane) para walang sahig na
        // nakasabantay sa kalsada. +0.01 para manaig sa ibaba ng bangketa.
        row.hi = terrainHeight(row.ix, row.iz) + LOT_Y;
        row.ho = terrainHeight(row.ox, row.oz) + LOT_Y;
        // Putulin sa junctions para hindi mag-overlap ng sidewalk ng ibang kalsada
        row.vis = !inJunction(row.ix, row.iz, idx, 0.4);
        rows.push(row);
      }
      let start = 0;
      while (start < rows.length) {
        if (!rows[start].vis) { start++; continue; }
        let end = start;
        while (end + 1 < rows.length && rows[end + 1].vis) end++;
        if (end > start) {
          for (let i = start; i < end; i++) {
            const r0 = rows[i];
            const r1 = rows[i + 1];
            builder.quadFacing(
              [r0.ix, r0.hi, r0.iz], [r0.ox, r0.ho, r0.oz],
              [r1.ox, r1.ho, r1.oz], [r1.ix, r1.hi, r1.iz], UP
            );
          }
        }
        start = end + 1;
      }
      }
    }
  }

  // Bangketa + curbs sa mga kalsadong may sidewalk tag
  addSidewalk(topB, faceB, rd, idx, inJunction) {
    const line = densify(rd.pts, SIDE_SAMPLE);
    const nrm = vertexNormals(line);
    for (const sign of [1, -1]) {
    const width = sign > 0 ? rd.profile.leftSidewalkWidth : rd.profile.rightSidewalkWidth;
    if (!width) continue;
    const dIn = rd.half + rd.profile.shoulderWidth;
    const dOut = dIn + width;
    const rows = [];
    for (let i = 0; i < line.length; i++) {
      const p = line[i];
      const ni = nrm[i];
      const row = {
        ix: p.x + ni.x * dIn * sign, iz: p.z + ni.z * dIn * sign,
        ox: p.x + ni.x * dOut * sign, oz: p.z + ni.z * dOut * sign,
        nx: ni.x * sign, nz: ni.z * sign,
      };
      // taas ng lupa sa bawat gilid (para sumusunod ang bangketa sa slope)
      row.hi = terrainHeight(row.ix, row.iz);
      row.ho = terrainHeight(row.ox, row.oz);
      // Putulin ang bangketa kapag tumatawid ito sa ibang kalsada
      row.vis = !(inJunction(row.ix, row.iz, idx, 0.4) || inJunction(row.ox, row.oz, idx, 0.4));
      rows.push(row);
    }
    // Ihulog ang mga sunod-sunod na visible na run (min 2 rows)
    let start = 0;
    while (start < rows.length) {
      if (!rows[start].vis) { start++; continue; }
      let end = start;
      while (end + 1 < rows.length && rows[end + 1].vis) end++;
      if (end > start) this.emitSidewalkRun(topB, faceB, rows, start, end, rd);
      start = end + 1;
    }
    }
  }

  // FIX 1: ang `capStart`/`capEnd` ay COME FROM ang clip, kaya hindi namin
  // naipapadala ang box - kinakailangan lang ng totoong landas ng polyline
  // (ang caps ay tinatago kung ang dulo ay nasa tile border).
  emitSidewalkRun(topB, faceB, rows, a, b, rd) {
    for (let i = a; i < b; i++) {
      const r0 = rows[i];
      const r1 = rows[i + 1];
      // FIX (visual pass): may mga lugar kung saan ang kalsada ay U-TURN
      // (bumabalik sa eksaktong parehong punto) - doon ang r0 at r1 ay
      // magkakapantay sa XZ at ang quad ay zero-area. Skip para hindi
      // mag-emit ng degenerate faces.
      if (Math.hypot(r1.ix - r0.ix, r1.iz - r0.iz) < 1e-3) continue;
      // top surface (sumasunod sa terrain)
      topB.quadFacing(
        [r0.ix, r0.hi + SW_HEIGHT, r0.iz], [r0.ox, r0.ho + SW_HEIGHT, r0.oz],
        [r1.ox, r1.ho + SW_HEIGHT, r1.oz], [r1.ix, r1.hi + SW_HEIGHT, r1.iz], UP
      );
      // curbside face (patungo sa kalsada)
      faceB.quadFacing(
        [r0.ix, r0.hi - 0.005, r0.iz], [r0.ix, r0.hi + SW_HEIGHT, r0.iz],
        [r1.ix, r1.hi + SW_HEIGHT, r1.iz], [r1.ix, r1.hi - 0.005, r1.iz],
        [-r0.nx, 0, -r0.nz]
      );
      // outer face (patungo sa mga bahay)
      faceB.quadFacing(
        [r0.ox, r0.ho - 0.005, r0.oz], [r0.ox, r0.ho + SW_HEIGHT, r0.oz],
        [r1.ox, r1.ho + SW_HEIGHT, r1.oz], [r1.ox, r1.ho - 0.005, r1.oz],
        [r0.nx, 0, r0.nz]
      );
    }
    // FIX 1: end caps - para hindi kitang-kitang patungan mula sa dulo.
    // PERO: kung ang dulo ay nasa tile border (clip artefact), HINDI ito
    // dapat umabot - ang magkakatugong tile ang nag-a-emit ng sarili nitong cap
    // doon, at magkakapatong coplanar faces ang z-fight (nakikita bilang basang
    // kalsada). Ang cap ay para sa TUNAY na dulo lamang.
    const capStart = !rd || rd.capStart !== false;
    const capEnd = !rd || rd.capEnd !== false;
    if (!capStart && !capEnd) return;
    // end caps (para hindi kitang-kitang patungan mula sa dulo)
    const s = rows[a];
    const e = rows[b];
    const s1 = rows[a + 1];
    const e0 = rows[b - 1];
    // FIX (visual pass): kung ZERO ang lapad ng bangketa (n0 = (0,0) sa
    // 1-puntong polyline o sa U-turn), s.ix === s.ox at s.iz === s.oz -
    // zero-area cap. Huwag i-emit.
    const startOk = Math.hypot(s.ox - s.ix, s.oz - s.iz) > 1e-3;
    const endOk = Math.hypot(e.ox - e.ix, e.oz - e.iz) > 1e-3;
    // Ang cap face ay nasa plane na binubuo ng (across-walk) at (vertical),
    // kaya ang normal nasa DIREKSYON ng kalsada.
    const sLen = Math.hypot(s1.ix - s.ix, s1.iz - s.iz) || 1;
    const eLen = Math.hypot(e.ix - e0.ix, e.iz - e0.iz) || 1;
    const sDir = [(s1.ix - s.ix) / sLen, 0, (s1.iz - s.iz) / sLen];
    const eDir = [(e.ix - e0.ix) / eLen, 0, (e.iz - e0.iz) / eLen];
    if (capStart && startOk) {
      faceB.quadFacing(
        [s.ix, s.hi - 0.005, s.iz], [s.ox, s.ho - 0.005, s.oz],
        [s.ox, s.ho + SW_HEIGHT, s.oz], [s.ix, s.hi + SW_HEIGHT, s.iz],
        [-sDir[0], 0, -sDir[2]]
      );
    }
    if (capEnd && endOk) {
      faceB.quadFacing(
        [e.ix, e.hi - 0.005, e.iz], [e.ox, e.ho - 0.005, e.oz],
        [e.ox, e.ho + SW_HEIGHT, e.oz], [e.ix, e.hi + SW_HEIGHT, e.iz],
        [eDir[0], 0, eDir[2]]
      );
    }
  }

  // Puting dashed centerline (mga pangunahing kalsada lang)
  addMarkings(b, rd, idx, inJunction) {
    const line = densify(rd.pts, 1);
    const cum = [0];
    for (let i = 1; i < line.length; i++) {
      cum.push(cum[i - 1] + Math.hypot(line[i].x - line[i - 1].x, line[i].z - line[i - 1].z));
    }
    const total = cum[cum.length - 1];
    if (total < DASH_LEN + DASH_GAP) return;

    // point sa distance s mula sa simula ng polyline (binary search)
    const at = (s) => {
      let lo = 0;
      let hi = cum.length - 1;
      while (lo < hi - 1) {
        const mid = (lo + hi) >> 1;
        if (cum[mid] <= s) lo = mid; else hi = mid;
      }
      const segLen = cum[lo + 1] - cum[lo] || 1;
      const t = (s - cum[lo]) / segLen;
      const a = line[lo];
      const c = line[lo + 1];
      return { x: a.x + (c.x - a.x) * t, z: a.z + (c.z - a.z) * t };
    };

    for (let s = 2; s + DASH_LEN <= total - 1; s += DASH_LEN + DASH_GAP) {
      const a = at(s);
      const c = at(s + DASH_LEN);
      const mx = (a.x + c.x) / 2;
      const mz = (a.z + c.z) / 2;
      if (inJunction(mx, mz, idx, 1.0)) continue; // walang markings sa intersections
      const dx = c.x - a.x;
      const dz = c.z - a.z;
      const dl = Math.hypot(dx, dz) || 1;
      const px = (-dz / dl) * (MARK_W / 2);
      const pz = (dx / dl) * (MARK_W / 2);
      // sumasunod sa terrain
      const y0 = terrainHeight(a.x, a.z) + MARK_Y;
      const y1 = terrainHeight(c.x, c.z) + MARK_Y;
      b.quadFacing(
        [a.x - px, y0, a.z - pz], [c.x - px, y1, c.z - pz],
        [c.x + px, y1, c.z + pz], [a.x + px, y0, a.z + pz], UP
      );
    }
  }
}

