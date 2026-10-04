import * as THREE from 'three';
import { Roads } from './Roads.js';
import { Buildings } from './Buildings.js';
import { Vegetation } from './Vegetation.js';
import { StreetObjects } from './StreetObjects.js';
import { Landmarks } from './Landmarks.js';
import { River } from './River.js';
import { TileManager } from './tiles.js';
import { terrainHeight } from '../utils/geo.js';
import { RoadConfinement, MAP_BOUND } from '../utils/boundary.js';
import { MAP_EXTENT } from '../utils/geo.js';
import { spawnRoadInfo } from '../game/Vehicle.js';

// Preload follows the road-snapped spawn, not the geographic projection origin.

export class Map {
  constructor(scene) {
    this.scene = scene;
    // Lahat ng bagay ay road-relative na ang placement (see utils/roadLayout.js)
    this.roads = new Roads(scene);
    this.buildings = new Buildings(scene);
    this.vegetation = new Vegetation(scene);
    this.streetObjects = new StreetObjects(scene);
    this.landmarks = new Landmarks(scene);
    this.river = new River();
    this.collisionBoxes = [];
    this.group = new THREE.Group();
    scene.add(this.group);
  }

  build() {
    // Ground plane - base terrain
    this.createGround();

    // FIX 2: ang buong Marikina ay 1.4M+ triangles kung isang buong build, so
    // ang lahat ng kalsada/bahay/puno/post ay GINAWA PER TILE (400 m) at
    // ini-load nang LATE habang naglalakbay ang player. Ang ground plane at
    // ang mga landmark ay nananatiling isang mesh (mahalaga at maliit).
    this.tiles = new TileManager(this.scene, {
      roads: this.roads,
      river: this.river,
      buildings: this.buildings,
      vegetation: this.vegetation,
      streetObjects: this.streetObjects,
    });

    // Checked landmark anchors; the river streams independently in road tiles.
    this.landmarks.build();

    // FIX 2: PRE-LOAD ang mga tile sa palibut ng pinagsisimulan ng player
    // (MAP_ORIGIN, approximate sa Bayan-Bayanan spawn). Bakit:
    //  a) hindi ka magsisimula sa blangkong mundo, at
    //  b) ang mga tool sa tools/ (check-corridor, drive-sweep, ...) ay
    //     tumatawag ng build() tapos getCollisionBoxes() - kung hindi
    //     nalo-load ang tile, walang makikitang collider at magpapakita ang
    //     tool ng maling "0 boxes = malinis".
    const spawn = spawnRoadInfo();
    this.settleAt(spawn.x, spawn.z);

    // FIX 1: invisible boundary system (collision/force lang, walang mesh)
    this.buildBoundaries();
  }

  /**
   * I-load ang lahat ng tile sa palibut ng (x, z) hanggang wala nang pending.
   * Synchronous - ginagamit sa build() at sa mga tool.
   */
  settleAt(x, z, maxPasses = 400) {
    const t0 = Date.now();
    let passes = 0;
    // FIX: huwag tingnan ang `pending` bago pa ang unang update() - ang
    // `queue` ay `undefined` hanggang doon, kaya `pending` ay 0 at hindi
    // kailanman maglo-loop. Kaya: tumawag muna ng update() kahit isang beses,
    // saka magpapatuloy habang may pending.
    while (passes < maxPasses) {
      this.tiles.update(x, z);
      passes++;
      if (this.tiles.pending === 0) break;
    }
    return { passes, ms: Date.now() - t0 };
  }

  /**
   * Tawag-tawag ito ng game loop. I-load/unload/cull ang mga tile ayon sa
   * posisyon ng player. Ito ang pinaka-hot path, kaya dapat mabilis.
   */
  update(playerPos) {
    if (!this.tiles) return null;
    return this.tiles.update(playerPos.x, playerPos.z);
  }

  /**
   * FIX 1 - Invisible na hangganan.
   *  a) ROAD CONFINEMENT: naka-grid na spatial index ng lahat ng kalsada.
   *     Bawat segment ay may "limit" (half-width + bangketa) = ang distansya
   *     na puwedeng abutin ng kotse mula sa centerline. Lumalabas = may push.
   *  b) MAP BOUNDARY: square na ±1600 m (MAP_BOUND) - hard clamp.
   * Walang visible mesh ang dalawa - para sa physics lamang.
   */
  buildBoundaries() {
    this.confinement = new RoadConfinement(this.roads.roadLines);
    this.mapBounds = MAP_BOUND;
    this.boundaryWallCount = this.roads.roadLines.reduce(
      (n, r) => n + Math.max(1, r.pts.length - 1) * (r.hasSW ? 2 : 1), 0
    );
  }

  createGround() {
    // Ground plane na SUMUSUNOD sa terrain ng Marikina (0-3 m slope).
    // FIX 2: ang dating 3200 m / 96 segments (~33 m per cell) ay para sa
    // Nangka lang. Para sa buong Marikina (±4500 m) kailangan nating
    // magpili: mas malaking SIZE pero mas kaunting segments, kaya
    // 9600 m / 160 = 60 m per cell. 160x160x2 = 51,200 triangles - isang
    // mesh lang, at ang terrain ay banayad na gradient kaya puwede na.
    const SIZE = 9600;
    const SEG = 160;
    const groundGeom = new THREE.PlaneGeometry(SIZE, SIZE, SEG, SEG);
    groundGeom.rotateX(-Math.PI / 2);
    // itakda ang bawat vertex sa taas ng lupa
    const pos = groundGeom.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      pos.setY(i, terrainHeight(x, z) - 0.02); // bahagyang ibaba sa kalsada
    }
    pos.needsUpdate = true;
    groundGeom.computeVertexNormals();
    const groundMat = new THREE.MeshStandardMaterial({ color: 0x4a7c3f, roughness: 0.9 });
    const ground = new THREE.Mesh(groundGeom, groundMat);
    ground.receiveShadow = true;
    this.group.add(ground);
  }

  /**
   * FIX 2: ang mga collider ay IBA PER TILE ngayon, kaya ang mga ito ay
   * pinagkukunan na lang sa mga naka-LOAD na tile. Bago, ginagawa ito minsan
   * lang pagkatapos ng buong build - pero sa tiling, may bagong kalsada/bahay
   * na lilitaw habang naglalakbay.
   *
   * Ang mga LANDMARK ay nananatiling isang beses (sila ay global at maliit).
   */
  getObbColliders() {
    if (!this.tiles) return this.obbColliders || [];
    return this.tiles.collectObb().concat(this.landmarks.obbColliders);
  }

  getCollisionBoxes() {
    const out = [];
    // FIX 2: kailangan ding isama ang naka-unload na tile boxes? Hindi -
    // ang mga ito ay wala nang nasa scene, kaya hindi dapat makipag-away sa
    // kotse ang player. Ang tinatawag namin ay "loaded" lang.
    if (this.tiles) this.tiles.collectBoxes(out);
    for (const b of this.landmarks.getCollisionBoxes()) out.push(b);
    return out;
  }
}
