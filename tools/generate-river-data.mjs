// Offline conversion of the Overpass river query; runtime needs no network/key.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
const raw = JSON.parse(readFileSync(root + '.cache/marikina-river.json', 'utf8'));
const ways = raw.elements.filter(e => e.type === 'way' && e.tags?.waterway === 'river' && /Marikina/i.test(e.tags?.name || ''));
if (!ways.length) throw new Error('No Marikina River geometry in cache');
const rivers = ways.map(e => ({ osmWayId: e.id, name: e.tags.name, width: 70,
  pts: e.geometry.map(p => [p.lat, p.lon]), nodeIds: e.nodes }));
writeFileSync(root + 'src/world/riverData.js',
  '// Generated from Overpass waterway=river/name~Marikina, bbox 14.62,121.08,14.695,121.14.\n' +
  '// (c) OpenStreetMap contributors, ODbL. Centerlines are surveyed data; 70m width is an approximation.\n' +
  'export const RIVERS = ' + JSON.stringify(rivers, null, 2) + ';\n');
console.log(`River: ${rivers.length} OSM ways, ${rivers.reduce((n, r) => n + r.pts.length, 0)} source points`);