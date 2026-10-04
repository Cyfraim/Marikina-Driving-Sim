// ---------------------------------------------------------------------------
// tiles.js - FIX 2: 400 m x 400 m chunking + LOD para sa buong Marikina City
//
// Bakit kailangan nito: ang buong mapa ay 1,438,014 triangles (nang buong mapa
// ang nai-build) - 2.4x ng 600k budget, at hindi pa kasama ang mga bahay.
// Sa tile mode, 25 tile (1600 m na tanaw) ay ~200k triangles na lang.
//
// Paano gumagana:
//  - Ang kalsada ay I-CLIP sa loob ng tile (Roads.clipPolyline) para walang
//    mado-dobleng geometry sa magkabilang tile.
//  - Ang bawat bahay/puno/post ay ina-assign sa EXACTLY ISANG tile - ang
//    naglalaman ng sentro nito - kaya bawat bagay ay iginagawa isang beses.
//  - LOAD_RADIUS = 1200 m: ito ang na-prepare (inilagay sa scene).
//  - CULL_RADIUS = 300 m: ang DETAIL (bahay/puno/post) ay itinatago sa
//    likod ng player - ito ang LOD na hiningi ng spec. Ang mismong kalsada ay
//    nananatiling nakikita kahit malayo (kailangan para sa pagbabasa ng mapa).
// ---------------------------------------------------------------------------
import * as THREE from 'three';

export const TILE = 400;        // 400 m x 400 m, gaya ng spec
export const LOAD_RADIUS = 1200; // i-prepare ang mga tile sa loob nito
export const CULL_RADIUS = 300;  // ito ang LOD cut-off para sa DETAIL
// Badget sa paggawa ng tile kada frame (ms). 16 ms ~= isang frame sa 60 fps;
// ang natitira ay para sa physics + rendering.
const BUILD_BUDGET_MS = 12;

export function tileKey(tx, tz) { return `${tx},${tz}`; }

export function tileBounds(tx, tz) {
  return {
    minX: tx * TILE, maxX: tx * TILE + TILE,
    minZ: tz * TILE, maxZ: tz * TILE + TILE,
  };
}

export class TileManager {
  /**
   * @param scene     THREE.Scene
   * @param builders  { roads, buildings, vegetation, streetObjects } - bawat isa
   *                  ay may build(bounds, targetGroup)
   */
  constructor(scene, builders) {
    this.scene = scene;
    this.builders = builders;
    this.root = new THREE.Group();
    this.root.name = 'tiles';
    scene.add(this.root);
    this.tiles = new Map();   // key -> { group, detail, cx, cz, tris }
    this.lastTile = null;
    this.stats = { loaded: 0, culled: 0, tris: 0, built: 0 };
  }

  /** Lazily build/unload/cull the tiles around (x, z). */
  update(x, z) {
    const t0x = Math.floor(x / TILE);
    const t0z = Math.floor(z / TILE);
    const r = Math.ceil(LOAD_RADIUS / TILE);

    // 1) unload anything well outside the load radius
    for (const [key, t] of this.tiles) {
      const d = Math.max(Math.abs(t.tx - t0x), Math.abs(t.tz - t0z)) * TILE;
      if (d > LOAD_RADIUS + TILE) {
        this.root.remove(t.group);
        disposeGroup(t.group);
        this.tiles.delete(key);
        this.stats.unloaded = (this.stats.unloaded || 0) + 1;
      }
    }

    // 2) build anything inside the load radius that we do not have yet.
    //    TIME BUDGET: ang unang load ay ~49 tile na tumatagal ng ~2-3 s, na
    //    mag-hang ng game.kaya may BUDGET_MS kada frame - gagawa lang ng
    //    ilang tile, at magpapatuloy sa susunod na frame. Ang player ay
    //    nagsisimula sa gitna ng load radius, kaya tile ring ka muna
    //    muna ang naunang na-load (pinakamalapit muna) at hindi nahihintay
    //    ng 2 segundo bago magagalaw.
    if (!this.lastTile || this.lastTile.x !== t0x || this.lastTile.z !== t0z) {
      this.lastTile = { x: t0x, z: t0z };
      this.queue = [];
      for (let tx = t0x - r; tx <= t0x + r; tx++) {
        for (let tz = t0z - r; tz <= t0z + r; tz++) {
          const key = tileKey(tx, tz);
          if (this.tiles.has(key)) continue;
          // pinakamalapit muna - ito ang kailangan ng player agad
          const cx = tx * TILE + TILE / 2;
          const cz = tz * TILE + TILE / 2;
          this.queue.push({ tx, tz, key, d2: (cx - x) ** 2 + (cz - z) ** 2 });
        }
      }
      this.queue.sort((a, b) => a.d2 - b.d2);
    }

    if (this.queue && this.queue.length) {
      const t0 = performance.now();
      while (this.queue.length && performance.now() - t0 < BUILD_BUDGET_MS) {
        const job = this.queue.shift();
        if (this.tiles.has(job.key)) continue;
        this.#buildTile(job.tx, job.tz, job.key);
      }
    }

    // 3) LOD: hide DETAIL beyond CULL_RADIUS. Roads stay visible - they are
    //    cheap and the player needs to see where the road goes.
    const cullR2 = CULL_RADIUS * CULL_RADIUS;
    const loadR2 = LOAD_RADIUS * LOAD_RADIUS;
    let tris = 0;
    let meshes = 0;
    for (const t of this.tiles.values()) {
      // FIX 2: itinatago ang tile na lumampas na sa LOAD_RADIUS (hindi na
      // kailangan i-render). Dati, nananatiling visible ang LAHAT ng na-load
      // na tile kaya lumalaki ang rendered triangles habang naglalakbay.
      const far = (t.cx - x) ** 2 + (t.cz - z) ** 2 > loadR2;
      if (t.group.visible === far) t.group.visible = !far;
      if (t.group.visible) {
        const d2 = (t.cx - x) ** 2 + (t.cz - z) ** 2;
        const near = d2 <= cullR2;
        if (t.detail.visible !== near) t.detail.visible = near;
        tris += near ? t.tris.road + t.tris.detail : t.tris.road;
        meshes += near ? t.meshes.full : t.meshes.road;
      }
    }
    this.stats.loaded = this.tiles.size;
    this.stats.tris = tris;
    this.stats.meshes = meshes;
    return this.stats;
  }

  #buildTile(tx, tz, key) {
    const b = tileBounds(tx, tz);
    const group = new THREE.Group();
    const roadGroup = new THREE.Group();
    const detail = new THREE.Group();
    group.add(roadGroup, detail);

    const t0 = performance.now();
    this.builders.roads.build(b, roadGroup);
    if (this.builders.river) this.builders.river.build(b, roadGroup);
    let tris = 0;
    let meshes = 0;
    roadGroup.traverse((o) => { if (o.isMesh) { meshes++; tris += triCount(o); } });

    let detailTris = 0;
    const boxes = [];
    const obb = [];
    for (const name of ['buildings', 'vegetation', 'streetObjects']) {
      const bld = this.builders[name];
      if (!bld || typeof bld.build !== 'function') continue;
      const sub = new THREE.Group();
      // FIX 2: i-reset ang collider arrays ng builder kada tile, kaya
      // ang TileManager ang may hawak ng per-tile listahan (walang
      // pag-iipon ng lahat ng nakaraan na tile).
      bld.collisionBoxes.length = 0;
      if (bld.obbColliders) bld.obbColliders.length = 0;
      bld.build(b, sub);
      sub.traverse((o) => { if (o.isMesh) { meshes++; detailTris += triCount(o); } });
      detail.add(sub);
      for (const bx of bld.collisionBoxes) boxes.push(bx);
      if (bld.obbColliders) for (const o of bld.obbColliders) obb.push(o);
    }

    group.visible = false;   // hanggang sa sabihin ng update()
    this.root.add(group);
    this.tiles.set(key, {
      tx, tz, group, detail, boxes, obb,
      cx: (b.minX + b.maxX) / 2, cz: (b.minZ + b.maxZ) / 2,
      tris: { road: tris, detail: detailTris },
      meshes: { road: meshes, full: meshes },
      ms: performance.now() - t0,
    });
    this.stats.built++;
  }

  /** May pa bang tile na naghihintay na gawin? */
  get pending() { return this.queue ? this.queue.length : 0; }

  /** Kabuuang bilang ng tile na na-build (para sa Game.js). */
  get built() { return this.stats.built; }

  /** Mga AABB collider ng lahat ng naka-LOAD na tile. */
  collectBoxes(out) {
    for (const t of this.tiles.values()) {
      if (!t.group.visible) continue;
      for (const b of t.boxes) out.push(b);
    }
    return out;
  }

  /** Mga OBB collider ng lahat ng naka-LOAD na tile (para sa mga bahay). */
  collectObb() {
    const out = [];
    for (const t of this.tiles.values()) {
      if (!t.group.visible) continue;
      for (const o of t.obb) out.push(o);
    }
    return out;
  }

  /** Force-build every tile that has any road in it (tools / audit). */
  buildAll(predicate) {
    const seen = new Set();
    for (const rd of this.builders.roads.roads) {
      const tx = Math.floor(((rd.minX + rd.maxX) / 2) / TILE);
      const tz = Math.floor(((rd.minZ + rd.maxZ) / 2) / TILE);
      const key = tileKey(tx, tz);
      if (seen.has(key)) continue;
      seen.add(key);
      if (predicate && !predicate(tx, tz)) continue;
      this.#buildTile(tx, tz, key);
    }
    for (const t of this.tiles.values()) t.group.visible = true;
    return this.tiles.size;
  }
}

function triCount(o) {
  const g = o.geometry;
  if (!g) return 0;
  if (g.index) return g.index.count / 3;
  if (g.attributes && g.attributes.position) return g.attributes.position.count / 3;
  return 0;
}

/** I-free ang GPU buffers kapag tinanggal na ang tile. */
function disposeGroup(group) {
  group.traverse((o) => {
    if (!o.isMesh) return;
    if (o.geometry) o.geometry.dispose();
    if (o.material) {
      if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose());
      else o.material.dispose();
    }
  });
}