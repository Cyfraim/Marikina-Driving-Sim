// ---------------------------------------------------------------------------
// fetch-osm.mjs - Kumuha ng tunay na road network ng BUONG Marikina City mula
// sa Overpass API, at i-save ang raw JSON para sa generate-road-data.mjs.
//
// Mirrors, sunod-sunod (kung i-403/blocked ang main server):
//   1. https://overpass-api.de/api/interpreter      (main)
//   2. https://overpass.kumi.systems/api/interpreter
//   3. https://overpass.openstreetmap.ru/api/interpreter
//   4. https://maps.mail.ru/osm/tools/overpass/api/interpreter
//
// Usage: node tools/fetch-osm.mjs [--out <path>] [--bbox s,w,n,e]
// ---------------------------------------------------------------------------
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// --- Full Marikina City bounding box (from the Fix 2 brief) ----------------
const DEFAULT_BBOX = { south: 14.62, west: 121.08, north: 14.695, east: 121.14 };

// Mirrors, sunod-sunod. NOTE (Fix 2): ang main na overpass-api.de ay
// 406/504 mula sa host na ito - kinukundena ng UA (na no, na-fix natin ang
// UA para tumanggap nito, pero 504 gateway timeout pa rin ang isinusuka,
// kaya umiiwas tayo rito at inaasahan ang mga mirror). Ang kumi.systems ang
// consistent na tumutugon (~34 s para sa 11k ways).
const ENDPOINTS = [
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass-api.de/api/interpreter',          // main (often 504 here)
  'https://overpass.openstreetmap.ru/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

const HIGHWAYS =
  'motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|service|track';

function parseArgs() {
  const a = process.argv.slice(2);
  const out = { out: null, bbox: { ...DEFAULT_BBOX } };
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--out') out.out = a[++i];
    else if (a[i] === '--bbox') {
      const [s, w, n, e] = a[++i].split(',').map(Number);
      out.bbox = { south: s, west: w, north: n, east: e };
    }
  }
  return out;
}

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const args = parseArgs();
const { south, west, north, east } = args.bbox;
const outPath = args.out || ROOT + '.cache/marikina_roads.json';

const query = `[out:json][timeout:180];
way["highway"~"^(${HIGHWAYS})$"](${south},${west},${north},${east});
out geom tags;`;

const spanKm = {
  ns: ((north - south) * 111.132).toFixed(2),
  ew: ((east - west) * 111.32 * Math.cos((south + north) * 0.5 * Math.PI / 180)).toFixed(2),
};
console.log(`bbox  S${south} W${west} N${north} E${east}  (${spanKm.ns} x ${spanKm.ew} km)`);
console.log(`out   ${outPath}\n`);

let json = null;
let used = null;
const failures = [];

for (const url of ENDPOINTS) {
  const host = new URL(url).host;
  const started = Date.now();
  try {
    console.log(`-> trying ${host} ...`);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 180000);
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        // Overpass etiquette: malinaw na User-Agent. Kinukundena ng ilang
        // mirror ang default "node" UA (HTTP 406/403), kaya ito ay dapat
        // descriptive at may contact hint.
        'User-Agent': 'NangkaDrive/1.0 (offline map data build; tools/fetch-osm.mjs)',
        Accept: 'application/json',
      },
      body: 'data=' + encodeURIComponent(query),
      signal: ctrl.signal,
    });
    // NOTE: huwag clearTimeout() dito. Ang 11k-way response ay malaki at
    // may mga mirror na nag-ha-hang sa pag-send ng BODY matapos nang
    // dumating na ang headers - kung i-clear natin ang timer, mag-hahang
    // ang readForever. Iniiwan natin ang timer hanggang tapos na ang body.
    const text = await res.text();
    clearTimeout(timer);
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    if (!res.ok) {
      failures.push(`${host}: HTTP ${res.status} ${text.slice(0, 160).replace(/\s+/g, ' ')}`);
      console.log(`   HTTP ${res.status} after ${secs}s - trying next mirror`);
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      failures.push(`${host}: response was not JSON (${text.slice(0, 120).replace(/\s+/g, ' ')})`);
      console.log(`   not JSON (${text.length} bytes) - trying next mirror`);
      continue;
    }
    if (!Array.isArray(parsed.elements)) {
      failures.push(`${host}: JSON had no elements array`);
      console.log('   no elements array - trying next mirror');
      continue;
    }
    console.log(`   OK: ${parsed.elements.length} ways in ${secs}s\n`);
    json = parsed;
    used = host;
    break;
  } catch (err) {
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    const msg = err && err.name === 'AbortError' ? 'timed out after 180s' : String(err && err.message || err);
    failures.push(`${host}: ${msg}`);
    console.log(`   ${msg} (${secs}s) - trying next mirror`);
  }
}

if (!json) {
  console.error('ALL OVERPASS MIRRORS FAILED:');
  for (const f of failures) console.error('  - ' + f);
  process.exit(2);
}

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(json), 'utf8');

const byClass = {};
let totalLen = 0;
for (const e of json.elements) {
  const h = e.tags && e.tags.highway;
  if (!h) continue;
  byClass[h] = (byClass[h] || 0) + 1;
  const g = e.geometry || [];
  for (let i = 1; i < g.length; i++) {
    const dLat = (g[i].lat - g[i - 1].lat) * 111132;
    const dLon = (g[i].lon - g[i - 1].lon) * 111320 * Math.cos(g[i].lat * Math.PI / 180);
    totalLen += Math.hypot(dLon, dLat);
  }
}

console.log('SOURCE          : ' + used);
console.log('RAW WAYS        : ' + json.elements.length);
console.log('RAW ROAD LENGTH : ' + (totalLen / 1000).toFixed(1) + ' km');
console.log('BY CLASS        :');
for (const [k, v] of Object.entries(byClass).sort((a, b) => b[1] - a[1])) {
  console.log(`   ${k.padEnd(16)} ${v}`);
}
