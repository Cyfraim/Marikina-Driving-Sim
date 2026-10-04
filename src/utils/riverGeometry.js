// Pure geographic layer; no Three.js dependency and no circular geo imports.
import { RIVERS } from '../world/riverData.js';
import { MAP_ORIGIN } from '../world/roadData.js';
const lonScale = 111320 * Math.cos(MAP_ORIGIN.lat * Math.PI / 180);
const local = ([lat, lon]) => ({ x: (lon - MAP_ORIGIN.lon) * lonScale, z: -(lat - MAP_ORIGIN.lat) * 111132 });
export const WATER_Y = 0.2;
export const BANK_HEIGHT = 1.5;
const CELL = 200, REACH = 850;
const grid = new Map();
export const RIVER_SEGMENTS = [];
// Endpoint tangents are shared by OSM node ID, preventing way-boundary seams.
const vectors = new Map();
for (const river of RIVERS) {
  const pts = river.pts.map(local);
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1], len = Math.hypot(b.x - a.x, b.z - a.z);
    if (!len) continue;
    const tx = (b.x - a.x) / len, tz = (b.z - a.z) / len;
    for (const j of [i, i + 1]) {
      const key = river.nodeIds?.[j] ?? `${pts[j].x},${pts[j].z}`;
      const v = vectors.get(key) || { x: 0, z: 0 };
      v.x += tx; v.z += tz; vectors.set(key, v);
    }
    RIVER_SEGMENTS.push({ a, b, len, tx, tz, half: river.width / 2,
      aId: river.nodeIds?.[i] ?? `${a.x},${a.z}`, bId: river.nodeIds?.[i + 1] ?? `${b.x},${b.z}` });
  }
}
for (const seg of RIVER_SEGMENTS) {
  const offset = (p, id, sign) => {
    const v = vectors.get(id), len = Math.hypot(v.x, v.z) || 1;
    const nx = -v.z / len, nz = v.x / len;
    const dot = Math.max(0.5, nx * -seg.tz + nz * seg.tx);
    return { x: p.x + nx * seg.half * sign / dot, z: p.z + nz * seg.half * sign / dot };
  };
  seg.leftA = offset(seg.a, seg.aId, 1); seg.leftB = offset(seg.b, seg.bId, 1);
  seg.rightA = offset(seg.a, seg.aId, -1); seg.rightB = offset(seg.b, seg.bId, -1);
  for (let cx = Math.floor((Math.min(seg.a.x, seg.b.x) - REACH) / CELL); cx <= Math.floor((Math.max(seg.a.x, seg.b.x) + REACH) / CELL); cx++) {
    for (let cz = Math.floor((Math.min(seg.a.z, seg.b.z) - REACH) / CELL); cz <= Math.floor((Math.max(seg.a.z, seg.b.z) + REACH) / CELL); cz++) {
      const key = `${cx},${cz}`;
      if (!grid.has(key)) grid.set(key, []);
      grid.get(key).push(seg);
    }
  }
}
export function riverDistance(x, z) {
  let best = Infinity, half = 35;
  for (const s of grid.get(`${Math.floor(x / CELL)},${Math.floor(z / CELL)}`) || []) {
    const t = Math.max(0, Math.min(1, ((x - s.a.x) * s.tx + (z - s.a.z) * s.tz) / s.len));
    const d = Math.hypot(x - s.a.x - s.tx * s.len * t, z - s.a.z - s.tz * s.len * t);
    if (d < best) { best = d; half = s.half; }
  }
  return { centerDistance: best, bankDistance: Math.max(0, best - half), halfWidth: half };
}
export function isRiver(x, z, margin = 0) {
  const r = riverDistance(x, z);
  return r.centerDistance < r.halfWidth + margin;
}

// Sutherland-Hodgman clipping: water polygons meet exactly at tile edges.
export function clipPolygon(points, bounds) {
  let out = points;
  for (const [axis, limit, sign] of [['x', bounds.minX, 1], ['x', bounds.maxX, -1], ['z', bounds.minZ, 1], ['z', bounds.maxZ, -1]]) {
    const input = out; out = [];
    for (let i = 0; i < input.length; i++) {
      const a = input[i], b = input[(i + 1) % input.length];
      const ia = sign * (a[axis] - limit) >= 0, ib = sign * (b[axis] - limit) >= 0;
      if (ia) out.push(a);
      if (ia !== ib) {
        const t = (limit - a[axis]) / (b[axis] - a[axis]);
        out.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t });
      }
    }
  }
  return out;
}
export function clipLine(a, b, bounds) {
  let low = 0, high = 1;
  for (const axis of ['x', 'z']) {
    const min = axis === 'x' ? bounds.minX : bounds.minZ;
    const max = axis === 'x' ? bounds.maxX : bounds.maxZ;
    const d = b[axis] - a[axis];
    if (Math.abs(d) < 1e-9) { if (a[axis] < min || a[axis] > max) return null; continue; }
    const t0 = (min - a[axis]) / d, t1 = (max - a[axis]) / d;
    low = Math.max(low, Math.min(t0, t1)); high = Math.min(high, Math.max(t0, t1));
  }
  if (high <= low) return null;
  return [low, high].map(t => ({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t }));
}