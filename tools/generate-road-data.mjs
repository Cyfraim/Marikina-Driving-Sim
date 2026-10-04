// Preserve OSM way metadata and junction IDs; never chain by street name.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRoadProfile, oneWayDirection } from '../src/utils/RoadProfile.js';
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const argv = process.argv.slice(2);
const arg = (flag, fallback) => argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : fallback;
const IN = arg('--in', ROOT + '.cache/marikina_roads.json');
const OUT = arg('--out', ROOT + 'src/world/roadData.js');
const MAP_ORIGIN = { lat: 14.657, lon: 121.105 };
const classes = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'living_street', 'service', 'track'];
const major = classes.slice(0, 5);
const lonScale = 111320 * Math.cos(MAP_ORIGIN.lat * Math.PI / 180);
const dist = (a, b) => Math.hypot((a[0] - b[0]) * 111132, (a[1] - b[1]) * lonScale);
const length = pts => pts.slice(1).reduce((sum, p, i) => sum + dist(pts[i], p), 0);
const inside = p => p[0] >= 14.62 && p[0] <= 14.695 && p[1] >= 121.08 && p[1] <= 121.14;
const spacing = cls => major.slice(0, 4).includes(cls) ? 5 : cls === 'tertiary' ? 8 : ['service', 'track'].includes(cls) ? 15 : 10;
function simplify(pts, ids, step) {
  const indices = [0];
  let accumulated = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    accumulated += dist(pts[i - 1], pts[i]);
    const a = pts[i - 1], b = pts[i], c = pts[i + 1];
    const ux = (b[1] - a[1]) * lonScale, uz = (b[0] - a[0]) * 111132;
    const vx = (c[1] - b[1]) * lonScale, vz = (c[0] - b[0]) * 111132;
    const norm = Math.hypot(ux, uz) * Math.hypot(vx, vz);
    const bend = norm > 0 && (ux * vx + uz * vz) / norm < Math.cos(Math.PI / 12);
    if (accumulated >= step || bend) { indices.push(i); accumulated = 0; }
  }
  indices.push(pts.length - 1);
  return { pts: indices.map(i => pts[i]), nodeIds: indices.map(i => ids[i]) };
}
const raw = JSON.parse(readFileSync(IN, 'utf8'));
const ways = raw.elements.filter(e => e.type === 'way' && classes.includes(e.tags?.highway) && e.geometry?.length >= 2);
if (ways.some(e => !e.nodes || e.nodes.length !== e.geometry.length)) {
  throw new Error('Original OSM node IDs required: run tools/fetch-osm.mjs (out body geom).');
}
const users = new Map(), neighbours = new Map();
for (const way of ways) {
  way.nodes.forEach((id, i) => {
    if (!users.has(id)) users.set(id, new Set());
    users.get(id).add(way.id);
    if (!neighbours.has(id)) neighbours.set(id, new Set());
    if (i > 0) neighbours.get(id).add(way.nodes[i - 1]);
    if (i + 1 < way.nodes.length) neighbours.get(id).add(way.nodes[i + 1]);
  });
}
const junctions = new Set([...users].filter(([id, refs]) => refs.size > 1 || neighbours.get(id).size >= 3).map(([id]) => id));
const roads = [];
for (const way of ways) {
  const tags = way.tags, cls = tags.highway;
  const all = way.geometry.map(p => [p.lat, p.lon]);
  const connections = new Set(way.nodes.filter(id => junctions.has(id))).size;
  // Keep connecting stubs; trim only isolated unnamed driveway ways.
  if (!tags.name && connections < 2 &&
    ((cls === 'service' && length(all) < 120) ||
     (['residential', 'unclassified', 'track'].includes(cls) && length(all) < 40))) continue;
  const profile = createRoadProfile(tags, cls);
  const sw = profile.leftSidewalkWidth && profile.rightSidewalkWidth ? 'both' :
    profile.leftSidewalkWidth ? 'left' : profile.rightSidewalkWidth ? 'right' : 'none';
  let segmentIndex = 0;
  const emit = (start, end) => {
    if (end <= start) return;
    const pts = all.slice(start, end + 1), ids = way.nodes.slice(start, end + 1);
    // Legal direction always goes first -> last, including oneway=-1.
    if (oneWayDirection(tags) === -1) { pts.reverse(); ids.reverse(); }
    roads.push({ id: `${way.id}:${segmentIndex++}`, osmWayId: way.id,
      name: tags.name || null, cls, w: profile.carriageWidth, sw,
      mk: tags.lane_markings === 'yes' || (tags.lane_markings !== 'no' && major.includes(cls)),
      surf: profile.surfaceType, profile,
      oneway: tags.oneway ?? (profile.isOneWay ? 'yes' : 'no'),
      bridge: tags.bridge ?? 'no', tunnel: tags.tunnel ?? 'no',
      layer: Number(tags.layer) || 0, junction: tags.junction || null,
      ...simplify(pts, ids, spacing(cls)) });
  };
  let start = -1;
  for (let i = 0; i < all.length; i++) {
    if (!inside(all[i])) { if (start >= 0) emit(start, i - 1); start = -1; continue; }
    if (start < 0) start = i;
    else if (junctions.has(way.nodes[i])) { emit(start, i); start = i; }
  }
  if (start >= 0) emit(start, all.length - 1);
}
const profiles = [], profileIds = new Map();
const records = roads.map(road => {
  const key = JSON.stringify(road.profile);
  if (!profileIds.has(key)) { profileIds.set(key, profiles.length); profiles.push(road.profile); }
  const { profile, ...record } = road;
  const encoded = JSON.stringify(record);
  return `  ${encoded.slice(0, -1)},"profile":PROFILES[${profileIds.get(key)}]},`;
});
writeFileSync(OUT, `// Generated by tools/generate-road-data.mjs; (c) OpenStreetMap contributors, ODbL.
// GPS pts and original OSM nodeIds are aligned; reverse-oneway geometry normalized.
// w/sw/surf are compatibility aliases of profile. Do not edit by hand.
export const MAP_ORIGIN = ${JSON.stringify(MAP_ORIGIN)};
const PROFILES = ${JSON.stringify(profiles)};
export const ROADS = [\n` + records.join('\n') + '\n];\n');
console.log(`Read ${ways.length} ways; protected ${junctions.size} shared/branch nodes`);
console.log(`Emitted ${roads.length} segments, ${roads.reduce((n, r) => n + r.pts.length, 0)} vertices`);
console.log(`One-way segments: ${roads.filter(r => r.profile.isOneWay).length}`);
for (const cls of classes) {
  const group = roads.filter(r => r.cls === cls);
  if (group.length) console.log(`${cls}: ${group.length} roads, mean width ${(group.reduce((n, r) => n + r.w, 0) / group.length).toFixed(3)} m`);
}
console.log(`Wrote ${OUT}`);