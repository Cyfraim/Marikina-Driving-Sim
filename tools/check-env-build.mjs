import * as THREE from "three";
import { Map as GameMap } from "../src/world/Map.js";

const scene = new THREE.Scene();
const t0 = Date.now();
const map = new GameMap(scene);
map.build();
const ms = Date.now() - t0;

// FIX 2: bilangin ang RENDERED triangles (naka-LOK na tile lamang), hindi
// ang lahat ng resident geometry. Ang 600k badget ay para sa nire-render kada
// frame; ang culled/unloaded tile ay hindi nire-render ng GPU. Konteksto:
// ang buong-mapa ay ~2.0M triangles, kaya ang tiling ang bumaba sa badget.
const visible = (o) => { let p = o; while (p) { if (!p.visible) return false; p = p.parent; } return true; };

let meshes = 0, tris = 0, verts = 0, nan = 0, lines = 0, residentTris = 0;
scene.traverse((o) => {
  if (o.isLineSegments) { lines++; return; }
  if (!o.isMesh) return;
  meshes++;
  const g = o.geometry;
  const t = g.index ? g.index.count / 3 : g.attributes.position.count / 3;
  residentTris += t;
  if (visible(o)) { verts += g.attributes.position.count; tris += t; }
  const arr = g.attributes.position.array;
  for (let i = 0; i < arr.length; i++) if (!Number.isFinite(arr[i])) nan++;
  const col = g.attributes.color;
  if (col) for (let i = 0; i < col.array.length; i++) if (!Number.isFinite(col.array[i])) nan++;
});
console.log("---");
console.log("build time: " + ms + " ms");
console.log("tiles loaded: " + map.tiles.tiles.size + ", meshes: " + meshes + ", wire objects: " + lines);
console.log("RENDERED triangles: " + Math.round(tris).toLocaleString() + "  (budget 600,000)");
console.log("resident triangles (incl. culled tiles): " + Math.round(residentTris).toLocaleString());
console.log("vertices (rendered): " + verts.toLocaleString());
console.log("collision boxes: " + map.getCollisionBoxes().length);
console.log("NaN components: " + nan);
if (nan > 0) { console.error("FAIL: NaN"); process.exit(1); }
if (tris > 600000) { console.error("FAIL: rendered tri budget exceeded: " + tris); process.exit(1); }
if (ms > 8000) { console.error("FAIL: build too slow"); process.exit(1); }
console.log("OK");