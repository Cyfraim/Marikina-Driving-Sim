// ---------------------------------------------------------------------------
// generate-road-data.mjs
// Builds src/world/roadData.js from the Overpass JSON dump in .cache/.
// Node port of tools/generate-road-data.ps1, extended for the full Marikina
// City map (Fix 2).
//
// Source data: (c) OpenStreetMap contributors, ODbL licence (via Overpass API).
// The output hardcodes real GPS polylines; src/utils/geo.js converts them to
// Three.js scene units (1 unit = 1 metre) around MAP_ORIGIN.
//
// PER-CLASS SIMPLIFICATION (Fix 2 performance budget). The old generator used a
// single 8 m spacing for everything; that is wasteful on minor barangay lanes
// and too coarse on the arterials we actually drive along:
//   primary / secondary            5 m  (want them accurate - we drive these)
//   tertiary                       8 m  (between the two; see note below)
//   residential / unclassified /
//   living_street                 10 m
//   service / track               15 m  (alleys - shape barely matters)
// NOTE: tertiary was not in the original brief. 8 m keeps the collectors around
// Marikina City Hall readable without ballooning the vertex count the way 5 m
// would. Change it here if you want 5 m or 10 m for tertiary.
//
// Usage: node tools/generate-road-data.mjs [--in <json>] [--out <js>]
// ---------------------------------------------------------------------------
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const argv = process.argv.slice(2);
const argOf = (flag, dflt) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const IN = argOf('--in', ROOT + '.cache/marikina_roads.json');
const OUT = argOf('--out', ROOT + 'src/world/roadData.js');

// --- Fix 2: map centre moves to the middle of the Marikina bounding box ------
// Old (Nangka-only) origin was 14.6508, 121.1080.
const MAP_ORIGIN = { lat: 14.657, lon: 121.105 };

// Keep only what is inside the city bounding box. Points outside are clipped,
// so a road starting just outside still contributes its in-city portion.
const BBOX = { south: 14.62, west: 121.08, north: 14.695, east: 121.14 };

const MIN_LEN_M = 10;     // drop stubs shorter than this
// FIX 3 (cleanup): i-trim ang mga MALIIT at WALANG PANGALAN na service road.
// Marikina may ~2,474 na `service` polyline at halos lahat ay parking-lot aisle
// at subdivision stub ng mall - hindi kalsada ng lungsod.
//
// TALA: ang 50 m na threshold ng brief ay nagbawas ng 1,142 road (6,789 ->
// 5,647) at 138 kB sa bundle, pero 1,715 kB pa rin - HINDI natatampok ang
// 1,600 kB na target. Kaya dalawang karagdagang lever:
//   1) MIN_SERVICE_M: 50 -> 100 -> 120 m. Ang mga natitirang 60-100 m na unnamed
//      service ay mga padalaan ng loob ng mall/pamilya, hindi kalsada.
//   2) MIN_STUB_M = 40 m para sa residential/unclassified/track: ang mga
//      ito ay driveway stub sa pagitan ng bahay, hindi kalsada.
// PATAASAN/IBABA ANG NUMBER KUNG HINDI MASYADO - naka-flag sa header.
const TRIM_UNNAMED_SERVICE = true;
const MIN_SERVICE_M = 120;
const TRIM_UNNAMED_STUBS = true;
const MIN_STUB_M = 40;
// The bbox already bounds the data, so this radius clamp is only a safety net
// against malformed geometry. It must be WIDER than the bbox half-diagonal
// (~4.9 km from the new origin to a corner) or it silently clips the city
// corners - 4200 m did exactly that, dropping 1,183 real ways.
const MAX_RADIUS_M = 6000;

const ALLOWED = new Set([
  'motorway', 'trunk', 'primary', 'secondary', 'tertiary',
  'unclassified', 'residential', 'living_street', 'service', 'track',
]);

const MPD_LAT = 111132.0;
const MPD_LON = 111320.0 * Math.cos((MAP_ORIGIN.lat * Math.PI) / 180);

/** Per-class vertex spacing in metres (see header). */
function spacingFor(cls) {
  switch (cls) {
    case 'primary':
    case 'secondary':
    case 'motorway':
    case 'trunk': return 5;
    case 'tertiary': return 8;
    case 'service':
    case 'track': return 15;
    default: return 10; // residential, unclassified, living_street
  }
}

function toEN(lat, lon) {
  return { e: (lon - MAP_ORIGIN.lon) * MPD_LON, n: (lat - MAP_ORIGIN.lat) * MPD_LAT };
}

function polyLength(pts) {
  let len = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = toEN(pts[i - 1][0], pts[i - 1][1]);
    const b = toEN(pts[i][0], pts[i][1]);
    len += Math.hypot(b.e - a.e, b.n - a.n);
  }
  return len;
}

// --- 1. read + filter -------------------------------------------------------
const raw = JSON.parse(readFileSync(IN, 'utf8'));
console.log(`Read ${raw.elements.length} ways from ${IN}`);

const kept = [];
let rejectedClass = 0;
let rejectedBbox = 0;
let rejectedRadius = 0;

for (const e of raw.elements) {
  const hw = e.tags && e.tags.highway;
  if (!ALLOWED.has(hw)) { rejectedClass++; continue; }
  if (!e.geometry || e.geometry.length < 2) continue;

  // clip to the city bounding box (keep the part inside)
  const pts = [];
  for (const g of e.geometry) {
    const lat = +g.lat;
    const lon = +g.lon;
    if (lat < BBOX.south || lat > BBOX.north || lon < BBOX.west || lon > BBOX.east) continue;
    pts.push([lat, lon]);
  }
  if (pts.length < 2) { rejectedBbox++; continue; }

  let minD = Infinity;
  for (const [la, lo] of pts) {
    const p = toEN(la, lo);
    const d = Math.hypot(p.e, p.n);
    if (d < minD) minD = d;
  }
  if (minD > MAX_RADIUS_M) { rejectedRadius++; continue; }

  kept.push({ name: e.tags.name || null, cls: hw, tags: e.tags, pts });
}
console.log(
  `Kept ${kept.length} ways (dropped: ${rejectedClass} class, ` +
  `${rejectedBbox} outside bbox, ${rejectedRadius} outside radius)`
);

// --- 2. chain ways that share endpoints -------------------------------------
// Group by name so one named road becomes one polyline. Unnamed ways are
// grouped by CLASS instead (the old PS script keyed them by their first
// coordinate, which left every unnamed segment as its own polyline - fine for
// 139 Nangka roads, but it triples the polyline count city-wide).
const groups = new Map();
for (const k of kept) {
  const key = k.name ? `N:${k.name}` : `C:${k.cls}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(k);
}
console.log(`Grouped into ${groups.size} groups (by name, unnamed by class)`);

// Shared-node key. OSM shared nodes are normally bit-identical, so rounding to
// 1e-7 deg (~1 cm) is a safe way to join them.
const NODE = (p) => `${Math.round(p[0] * 1e7)},${Math.round(p[1] * 1e7)}`;

/**
 * Chain the ways of one group into polylines.
 *
 * Walks each way forward then backward, joining any unused way whose endpoint
 * matches the current open end. Endpoint lookup goes through a hash index, so
 * this is O(total points) instead of the O(n^2) "scan the whole pool and
 * restart" loop the PS version used - that old loop times out on the 4,036
 * `service` ways in the full-city dump.
 */
function chainGroup(ways) {
  const used = new Array(ways.length).fill(false);
  const lens = ways.map((w) => polyLength(w.pts));

  const startAt = new Map(); // nodeKey -> [wayIdx]
  const endAt = new Map();
  ways.forEach((w, i) => {
    const s = NODE(w.pts[0]);
    const e = NODE(w.pts[w.pts.length - 1]);
    if (!startAt.has(s)) startAt.set(s, []);
    startAt.get(s).push(i);
    if (!endAt.has(e)) endAt.set(e, []);
    endAt.get(e).push(i);
  });

  const take = (map, key) => {
    const list = map.get(key);
    if (!list) return -1;
    for (const i of list) if (!used[i]) { used[i] = true; return i; }
    return -1;
  };

  const out = [];
  for (let i = 0; i < ways.length; i++) {
    if (used[i]) continue;
    used[i] = true;

    // The chain is  [backward parts] + ways[i].pts + [forward parts].
    // headParts/tailParts hold ONLY the ways joined on each side - the anchor
    // ways[i] must NOT be seeded into both, or the road is emitted twice (out
    // and back) and the total length doubles.
    const mid = ways[i].pts;
    const headParts = []; // unshifted, so flatten() keeps travel order
    const tailParts = []; // pushed, so flatten() keeps travel order
    let headOpen = mid[0];             // open node on the head side
    let tailOpen = mid[mid.length - 1]; // open node on the tail side
    let best = i;

    // grow forward
    for (;;) {
      const key = NODE(tailOpen);
      let j = take(startAt, key);
      let flip = false;
      if (j < 0) { j = take(endAt, key); flip = true; }
      if (j < 0) break;
      const p = ways[j].pts;
      // p.start == key -> p continues as-is;  p.end == key -> p reversed
      tailParts.push(flip ? p.slice().reverse() : p);
      tailOpen = flip ? p[0] : p[p.length - 1];
      if (lens[j] > lens[best]) best = j;
    }

    // grow backward
    for (;;) {
      const key = NODE(headOpen);
      let j = take(endAt, key);
      let flip = false;
      if (j < 0) { j = take(startAt, key); flip = true; }
      if (j < 0) break;
      const p = ways[j].pts;
      // p.end == key -> p sits before the head as-is; p.start == key -> reversed
      headParts.unshift(flip ? p.slice().reverse() : p);
      headOpen = flip ? p[p.length - 1] : p[0];
      if (lens[j] > lens[best]) best = j;
    }

    const head = headParts.flat();
    const tail = tailParts.flat();
    // head/tail do NOT include the anchor, and the shared junction node
    // between head and mid appears in exactly one of them, so a plain
    // concatenation is correct here.
    out.push({
      pts: head.concat(mid, tail),
      cls: ways[best].cls,
      name: ways[i].name || ways[best].name,
      tags: ways[best].tags,
    });
  }
  return out;
}

const chains = [];
for (const grp of groups.values()) chains.push(...chainGroup(grp));
console.log(`Chained into ${chains.length} polylines`);

// Sanity check: chaining must PRESERVE total length (it only regroups ways).
// If this drifts, a way is being duplicated or dropped by the chain walk.
{
  const before = kept.reduce((s, k) => s + polyLength(k.pts), 0);
  const after = chains.reduce((s, c) => s + polyLength(c.pts), 0);
  console.log(
    `Length check: before ${(before / 1000).toFixed(1)} km -> ` +
    `after ${(after / 1000).toFixed(1)} km ` +
    `(${(((after - before) / before) * 100).toFixed(2)}% drift)`
  );
}

// ---------------------------------------------------------------------------
// FIX 3: SPLIT "FOLD-BACK" POLYLINES
//
// Ang bundling bug na nasa "Marcos Highway": ang polyline ay hindi simpleng
// landas. Nagsasapawan ito pabalik sa sarili (divided highway na dalawang
// magkabilang carriageway ang nai-chain sa iisang polyline dahil magkakatabi
// ang dulo). Nasuri: x 2248..3213 (965 m) ngunit 1,181 m ng haba sa
// z 3526..3640 (114 m) - kaya humigit 2.3x ang fold-back. Sa index 0 at 16,
// magkatapat sila sa 0 m.
//
// BAKIT MASAMA: hindi ito bug sa physics - walang collider doon (0 AABB, 0
// OBB sa loob ng 25 m) at ang kalsada ay talagang madadaanan. Ang problema ay
// sa TEST: ang pure-pursuit ng drive-sweep ay humahanap ng "pinakamalapit
// na punto ng centerline" - pero habang nagmamaneho sa ISANG carriageway,
// palaging nahanap ang KATABI na carriageway (mas mababa ang index), kaya
// naka-freeze ang index at "ran out of frames".
//
// AYUS: hatiin ang chain sa mga fold-back point bago i-emit. Hindi ito
// nagbabawas ng anumang kalsada - ang bawat piyal ng dating polyline ay
// nananatiling drawable - at mas maliit pa ang bawat polyline, kaya mas mabilis
// ang build at ang sweep.
// ---------------------------------------------------------------------------
const FOLD_M = 40;        // kapag ganito ka-close, fold-back na ito
const FOLD_MIN_GAP = 4;   // min index gap (~20 m ng paglalakbay) bago mag-fold

/** Hatiin ang polyline sa mga lugar na bumalik ito sa sarili. */
function splitFoldBack(pts) {
  if (!pts || pts.length < 8) return [pts];
  const parts = [];
  let cur = [pts[0]];
  // NOTE: sa generator ang bawat punto ay [lat, lon] - HINDI {x, z}. Ang
  // dating bersyon ay gumagamit ng pts[i].x / .z, kaya lahat ng distansya ay
  // NaN at HINDI kailanman naghahati (naiulat na "Split 0"). Ito ang bug.
  const dist = (a, b) => {
    const dLat = (a[0] - b[0]) * MPD_LAT;
    const dLon = (a[1] - b[1]) * MPD_LON;
    return Math.hypot(dLon, dLat);
  };
  for (let i = 1; i < pts.length; i++) {
    let cut = false;
    // ang labas ay ~200 index (~1 km sa 5 m spacing) - sapat para sa
    // hairpin, at hindi nagbabawas ng kalkulasyon para sa mahabang kalsada.
    for (let k = Math.max(0, i - 200); k <= i - FOLD_MIN_GAP; k++) {
      if (dist(pts[i], pts[k]) < FOLD_M) { cut = true; break; }
    }
    if (cut) {
      if (cur.length >= 2) parts.push(cur);
      cur = [pts[i]];
    } else {
      cur.push(pts[i]);
    }
  }
  if (cur.length >= 2) parts.push(cur);
  return parts;
}

// --- 3. simplify with the per-class spacing --------------------------------
function simplify(pts, spacing) {
  if (pts.length <= 2) return pts;
  const out = [pts[0]];
  let acc = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const a = toEN(pts[i - 1][0], pts[i - 1][1]);
    const b = toEN(pts[i][0], pts[i][1]);
    acc += Math.hypot(b.e - a.e, b.n - a.n);
    if (acc >= spacing) { out.push(pts[i]); acc = 0; }
  }
  out.push(pts[pts.length - 1]);
  return out;
}

// --- 4. width / sidewalk / markings / surface from real OSM tags ------------
const num = (v) => {
  if (v === undefined || v === null || v === '') return 0;
  const m = /-?\d+(\.\d+)?/.exec(String(v)); // OSM widths are sometimes "5.5 m"
  const n = m ? parseFloat(m[0]) : 0;
  return Number.isFinite(n) ? n : 0;
};

const MAJOR = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary'];

function widthFor(tags, cls) {
  const w = num(tags.width);
  if (w > 0) return w;
  const lanes = num(tags.lanes);
  if (lanes > 0) return (MAJOR.includes(cls) ? 3.5 : 2.75) * lanes;
  switch (cls) {
    case 'motorway': return 17.5;
    case 'trunk': return 14.0;
    case 'primary': return 9.0;
    case 'secondary': return 14.0;
    case 'tertiary': return 7.0;
    case 'residential': return 5.5;
    case 'unclassified': return 5.5;
    case 'living_street': return 5.0;
    case 'service': return 3.5;
    case 'track': return 3.0;
    default: return 5.5;
  }
}

function surfaceFor(tags, cls) {
  switch (String(tags.surface || '')) {
    case 'concrete': return 'concrete';
    case 'asphalt': return 'asphalt';
    case 'paved': return 'concrete';
    case 'unpaved':
    case 'ground':
    case 'gravel':
    case 'dirt':
    case 'earth':
    case 'grass':
    case 'sand':
    case 'mud': return 'unpaved';
    default: return MAJOR.includes(cls) ? 'asphalt' : 'concrete';
  }
}

function sidewalkFor(tags, cls) {
  switch (String(tags.sidewalk || '')) {
    case 'both': return 'both';
    case 'left': return 'left';
    case 'right': return 'right';
    case 'no':
    case 'none': return 'none';
    default: return MAJOR.includes(cls) ? 'both' : 'none';
  }
}

function markingsFor(tags, cls) {
  const lm = String(tags.lane_markings || '');
  if (lm === 'no') return false;
  if (lm === 'yes') return true;
  return MAJOR.includes(cls);
}

// --- 5. emit ----------------------------------------------------------------
const lines = [];
let totalLen = 0;
let totalPts = 0;
let droppedShort = 0;
let droppedService = 0;
let splitCount = 0;
let droppedStub = 0;
const perClass = {};
const usedSpacing = {};

for (const ch of chains) {
  const len = polyLength(ch.pts);
  if (len < MIN_LEN_M) { droppedShort++; continue; }
  // FIX 3: alisin ang maliit at walang pangalan na service road (alley)
  if (TRIM_UNNAMED_SERVICE && ch.cls === 'service' && !ch.name && len < MIN_SERVICE_M) {
    droppedService++;
    continue;
  }
  // FIX 3: alisin din ang maliit at walang pangalan na residential/
  // unclassified/track - driveway stub, hindi kalsada
  if (TRIM_UNNAMED_STUBS && !ch.name && len < MIN_STUB_M &&
      (ch.cls === 'residential' || ch.cls === 'unclassified' || ch.cls === 'track')) {
    droppedStub++;
    continue;
  }
  const cls = ch.cls;
  const sp = spacingFor(cls);
  const pts = simplify(ch.pts, sp);
  if (pts.length < 2) { droppedShort++; continue; }

  // FIX 3: hatiin ang fold-back (divided highway na magkabilang carriageway)
  const parts = splitFoldBack(pts);
  if (parts.length > 1) splitCount += (parts.length - 1);

  for (let pi = 0; pi < parts.length; pi++) {
    const part = parts[pi];
    if (part.length < 2) continue;
    totalLen += len / parts.length;   // pantay-pantay na hatiin ang haba
    totalPts += part.length;
    perClass[cls] = (perClass[cls] || 0) + 1;
    usedSpacing[cls] = sp;
    const w = widthFor(ch.tags, cls);
    const sw = sidewalkFor(ch.tags, cls);
    const mk = markingsFor(ch.tags, cls);
    const surf = surfaceFor(ch.tags, cls);
    const name = ch.name
      ? "'" + String(ch.name).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'"
      : 'null';
    const ptStr = part.map(([la, lo]) => `[${la.toFixed(5)},${lo.toFixed(5)}]`).join(',');
    lines.push(
      `  { name: ${name}, cls: '${cls}', w: ${w}, sw: '${sw}', mk: ${mk}, surf: '${surf}', pts: [${ptStr}] },`
    );
  }
}

console.log(`Dropped ${droppedShort} stubs (< ${MIN_LEN_M} m)`);
console.log(`Dropped ${droppedService} unnamed service alleys (< ${MIN_SERVICE_M} m)`);
console.log(`Dropped ${droppedStub} unnamed driveway stubs (< ${MIN_STUB_M} m)`);
console.log(`Split ${splitCount} fold-back polyline(s) (divided-highway carriageways)`);
console.log(`Emitted ${lines.length} roads, ${totalPts} vertices, ${(totalLen / 1000).toFixed(1)} km centreline`);
console.log('By class:');
for (const [k, v] of Object.entries(perClass).sort((a, b) => b[1] - a[1])) {
  console.log(`   ${k.padEnd(16)} ${String(v).padStart(5)}   spacing ${usedSpacing[k]} m`);
}

const header = [
  '// ---------------------------------------------------------------------------',
  '// roadData.js - HARDKODED na road network ng BUONG Marikina City',
  '// Generated by tools/generate-road-data.mjs from OpenStreetMap data',
  '// (c) OpenStreetMap contributors, ODbL - https://www.openstreetmap.org/copyright',
  '//',
  '// Every polyline is real GPS data. pts = [latitude, longitude] pairs.',
  '// src/utils/geo.js converts these to Three.js scene units (1 unit = 1 metre)',
  '// relative to MAP_ORIGIN below.',
  '//',
  '// MAP_ORIGIN: centre of the Marikina City bounding box',
  '//   bbox = S14.6200 W121.0800 N14.6950 E121.1400  (8.3 x 6.5 km)',
  `// Source: Overpass API (overpass.kumi.systems), ${kept.length} OSM ways`,
  `//         -> ${lines.length} polylines, ${(totalLen / 1000).toFixed(1)} km of road,`,
  `//         ${totalPts} vertices after per-class simplification.`,
  '//',
  '// w     = road width (metres, from OSM width/lanes tags)',
  "// sw    = sidewalk side ('both'|'left'|'right'|'none')",
  '// mk    = centre lane markings (dashed)',
  "// surf  = surface from OSM 'surface' tag: 'concrete' | 'asphalt' | 'unpaved'",
  '//         (concrete = light grey, asphalt = dark grey)',
  '// pts   = [latitude, longitude]',
  '// ---------------------------------------------------------------------------',
].join('\n');

const body = [
  `export const MAP_ORIGIN = { lat: ${MAP_ORIGIN.lat}, lon: ${MAP_ORIGIN.lon} };`,
  '',
  'export const ROADS = [',
  ...lines,
  '];',
  '',
].join('\n');

writeFileSync(OUT, header + '\n' + body, 'utf8');
console.log(`\nWrote ${OUT}`);
