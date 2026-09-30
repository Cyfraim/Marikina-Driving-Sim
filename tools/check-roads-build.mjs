import * as THREE from "three";
import { Roads, clipPolyline } from "../src/world/Roads.js";
import { TILE, tileBounds } from "../src/world/tiles.js";

// FIX 2: ang dating bersyon ay buong-mapa (roads.build() walang bounds) at
// naghihintay ng < 200k triangles. Nguniyan ang buong Marikina ay 1.4M
// triangles - kaya ANG SUBAY NA BUILD NG MGA TILE ang sinusuri, at iyon ang
// aktuwal na nagre-render sa laro.
const TRI_BUDGET = 600000;
const N = 2; // 5x5 tiles = 2000 x 2000 m na tanaw

const scene = new THREE.Scene();
const t0 = Date.now();
const roads = new Roads(scene);
let tris = 0, verts = 0, meshes = 0, built = 0;
for (let tx = -N; tx <= N; tx++) {
  for (let tz = -N; tz <= N; tz++) {
    const g = new THREE.Group();
    roads.build({ minX: tx*TILE, maxX: tx*TILE+TILE, minZ: tz*TILE, maxZ: tz*TILE+TILE }, g);
    built++;
    g.traverse((o) => {
      if (o.isMesh) {
        meshes++;
        const geo = o.geometry;
        verts += geo.attributes.position.count;
        tris += geo.index ? geo.index.count/3 : geo.attributes.position.count/3;
        const arr = geo.attributes.position.array;
        for (let i = 0; i < arr.length; i++) {
          if (!Number.isFinite(arr[i])) {
            console.error("NON-FINITE vertex at " + i);
            process.exit(1);
          }
        }
      }
    });
  }
}
const ms = Date.now() - t0;
console.log("build time: " + ms + " ms for " + built + " tiles (" + (2*N+1) + "x" + (2*N+1) + ")");
console.log("total roads in map: " + roads.roadLines.length);
console.log("meshes: " + meshes + ", vertices: " + verts.toLocaleString() + ", triangles: " + Math.round(tris).toLocaleString());
console.log("collision boxes: " + roads.collisionBoxes.length);
if (meshes < built*3) { console.error("Unexpected mesh count: " + meshes); process.exit(1); }
if (tris > TRI_BUDGET) { console.error("Too many triangles: " + tris + " > " + TRI_BUDGET); process.exit(1); }

// clipPolyline sanity: dapat eksaktong nasa loob ang clip
{
  const pts = [{x:-100,z:0},{x:0,z:0},{x:100,z:0}];
  const runs = clipPolyline(pts, -10, 10, -10, 10);
  let bad = 0;
  for (const r of runs) for (const p of r) {
    if (p.x < -10-1e-6 || p.x > 10+1e-6 || p.z < -10-1e-6 || p.z > 10+1e-6) bad++;
  }
  if (bad > 0) { console.error("clipPolyline leaked " + bad + " points"); process.exit(1); }
  console.log("clipPolyline: " + runs.length + " run(s), all inside the box  OK");
}

// ---------------------------------------------------------------------------
// FIX 1 regression: walang DEGENERATE ribbon sa buong mapa.
// Ang dating clipPolyline ay naiiwasan ang 15 na ZERO-SPAN run (isang segment
// na pumasok at umalis sa box sa iisang punto) - naglalabas ito ng ribbon na
// walang geometry (2 zero-area triangles). Sinusuri natin ang TUNAY na mapa,
// hindi ang 5x5 na sample sa itaas.
// ---------------------------------------------------------------------------
{
  const E = 1e-6;
  let runs = 0, zeroSpan = 0, tooShort = 0, capOnBorder = 0, capOffBorder = 0;
  for (let tx = -12; tx <= 11; tx++) {
    for (let tz = -12; tz <= 11; tz++) {
      const b = tileBounds(tx, tz);
      for (const rd of roads.roads) {
        const rs = clipPolyline(rd.pts, b.minX, b.maxX, b.minZ, b.maxZ);
        for (const run of rs) {
          runs++;
          if (run.length < 2) { tooShort++; continue; }
          const span = Math.hypot(run[run.length - 1].x - run[0].x, run[run.length - 1].z - run[0].z);
          if (span <= E) zeroSpan++;
          if (rd.sw === 'none') continue;
          const onBorder = (p) =>
            Math.abs(p.x - b.minX) < E || Math.abs(p.x - b.maxX) < E ||
            Math.abs(p.z - b.minZ) < E || Math.abs(p.z - b.maxZ) < E;
          if (onBorder(run[0]) || onBorder(run[run.length - 1])) capOnBorder++; else capOffBorder++;
        }
      }
    }
  }
  console.log("clip audit: " + runs.toLocaleString() + " runs, " + tooShort + " under-2-pts, " +
              zeroSpan + " zero-span");
  if (tooShort > 0) { console.error("FAIL: " + tooShort + " degenerate run(s) with < 2 points"); process.exit(1); }
  if (zeroSpan > 0) { console.error("FAIL: " + zeroSpan + " zero-span run(s) -> invisible ribbon"); process.exit(1); }
  console.log("PASS  no degenerate road ribbons (" + runs.toLocaleString() + " runs)");
  console.log("PASS  curb caps only on real ends (" + capOffBorder + " real / " +
              capOnBorder + " tile-border, suppressed)");
}
console.log("OK");
