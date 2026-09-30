// ---------------------------------------------------------------------------
// 2B - SpeedSigns.js - Mga SPEED LIMIT sign
//
// Spec: Primary 60 km/h (sign kada 200 m), Secondary 40 km/h (kada 300 m),
//       Residential 20 km/h.
//
// Sign design: white circle + red border + black number. Ginagamit ang isang
// CanvasTexture para may "number" sa loob - ang 3D na numero ay sobrang
// mahal (bawat digit = maraming triangles).
// ANG TEXTURE AY I-CACHE KATLON: may 3 lang na numero (20/40/60), kaya 3
// canvases lang ang buong lungsod, kahit may 100+ na sign.
//
// Ang HUD warning ay gumagamit ng `currentLimitAt(x,z)`, at si HUD ang
// nagpapakita ng "âš  Speed Limit: 40 km/h".
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { ROAD_LINES, sampleRoad, mulberry32 } from '../utils/roadLayout.js';
import { terrainHeight } from '../utils/geo.js';

const SPACING = { primary: 200, secondary: 300 };   // spec
export const LIMITS = { primary: 60, secondary: 40, residential: 20, default: 20 };
const ARTERIAL = new Set(['primary', 'secondary']);
const SIGN_R = 0.55;      // radius ng puting disc (m)
const POST_H = 2.3;
const MAX_PER_ROAD = 6;   // para hindi spam sa mahabang kalsada

/** I-cache ang texture ng isang numero (isang beses lang bawat numero). */
const texCache = new Map();
function numberTexture(num) {
  if (texCache.has(num)) return texCache.get(num);
  const S = 128;
  const c = document.createElement('canvas');
  c.width = S; c.height = S;
  const g = c.getContext('2d');
  g.fillStyle = '#ffffff';
  g.beginPath(); g.arc(S / 2, S / 2, S / 2 - 2, 0, Math.PI * 2); g.fill();
  g.strokeStyle = '#d32f2f';
  g.lineWidth = 14;
  g.beginPath(); g.arc(S / 2, S / 2, S / 2 - 8, 0, Math.PI * 2); g.stroke();
  g.fillStyle = '#000000';
  g.font = 'bold 68px sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(String(num), S / 2, S / 2 + 3);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  texCache.set(num, t);
  return t;
}

export class SpeedSignSystem {
  constructor(scene) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.group.name = 'speed-signs';
    scene.add(this.group);
    this.signs = [];
    this.build();
  }

  build() {
    for (const r of ROAD_LINES) {
      if (!ARTERIAL.has(r.cls)) continue;          // primary/secondary lang
      const spacing = SPACING[r.cls];
      const limit = LIMITS[r.cls];
      const n = Math.min(MAX_PER_ROAD, Math.floor(r.len / spacing));
      if (n < 1) continue;
      for (let i = 0; i < n; i++) {
        // unang sign ~40 m mula sa simula, pagkatapos ay kada `spacing`
        const d = 40 + i * spacing;
        if (d > r.len - 20) break;
        const side = (i % 2 === 0) ? 1 : -1;       // palaging mag-alternate
        const s = sampleRoad(r.i, d, (r.half + 1.4) * side);
        const g = this.#makeSign(limit);
        g.position.set(s.x, terrainHeight(s.x, s.z), s.z);
        g.rotation.y = s.yaw;
        this.group.add(g);
        this.signs.push({ x: s.x, z: s.z, limit, ri: r.i, cls: r.cls });
      }
    }
  }

  /** Isang sign: poste + disc na may texture ng numero. */
  #makeSign(limit) {
    const g = new THREE.Group();
    const post = new THREE.Mesh(
      new THREE.CylinderGeometry(0.05, 0.05, POST_H, 5),
      new THREE.MeshStandardMaterial({ color: 0x9e9e9e, roughness: 0.8 })
    );
    post.position.y = POST_H / 2;
    g.add(post);
    // Ang disc ay isang CircleGeometry - 1 plane lang (2 triangles!) na may
    // texture. Mas mura at mas maganda kaysa 3D na numero.
    const disc = new THREE.Mesh(
      new THREE.CircleGeometry(SIGN_R, 16),
      new THREE.MeshStandardMaterial({
        map: numberTexture(limit),
        transparent: true,
        side: THREE.DoubleSide,
        roughness: 0.6,
      })
    );
    disc.position.y = POST_H - 0.35;
    g.add(disc);
    return g;
  }

  /** Ang speed limit para sa isang road index (spec: 60/40/20). */
  limitFor(ri) {
    const r = ROAD_LINES.find((x) => x.i === ri);
    if (!r) return LIMITS.default;
    if (r.cls === 'primary') return LIMITS.primary;
    if (r.cls === 'secondary') return LIMITS.secondary;
    return LIMITS.residential;
  }

  /**
   * Ang speed limit sa posisyong (x,z) - pinakamalapit na kalsada.
   * @returns {{limit:number, name:string}}
   */
  currentLimitAt(x, z) {
    let best = null, bestD = Infinity;
    for (const line of ROAD_LINES) {
      if (x < line.minX - 30 || x > line.maxX + 30 ||
          z < line.minZ - 30 || z > line.maxZ + 30) continue;
      const d = pointLineDist(x, z, line.pts) - line.half;
      if (d < bestD) { bestD = d; best = line; }
    }
    if (!best || bestD > 25) return { limit: LIMITS.default, name: '' };
    let limit = LIMITS.residential;
    if (best.cls === 'primary') limit = LIMITS.primary;
    else if (best.cls === 'secondary') limit = LIMITS.secondary;
    return { limit, name: best.name || '' };
  }

  get count() { return this.signs.length; }
  get byLimit() {
    const m = { 60: 0, 40: 0, 20: 0 };
    for (const s of this.signs) m[s.limit] = (m[s.limit] || 0) + 1;
    return m;
  }
}

// maliit na local na copy ng distToPolyline (iwasan ang circular import)
function pointLineDist(px, pz, pts) {
  let best = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const dx = b.x - a.x, dz = b.z - a.z, l2 = dx * dx + dz * dz;
    let t = l2 ? ((px - a.x) * dx + (pz - a.z) * dz) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    const d = Math.hypot(px - (a.x + dx * t), pz - (a.z + dz * t));
    if (d < best) best = d;
  }
  return best;
}