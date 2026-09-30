// ---------------------------------------------------------------------------
// 1C - Pedestrian.js - Mga NAGLALAKBAY na tao sa sidewalk
//
// Simple low-poly na humanoid: box torso, box head, 4 cylinder limbs
// (2 braso + 2 binti). Walang skeleton - ang animasyon ay SINE WAVE sa
// rotation ng mga limb, kaya napak-mura (isang float multiply kada limb).
//
// PATROL: naglalakbay sa gilid ng sidewalk ng primary/secondary road, at
// pagdating sa dulo ay BUMABALIK (turn around) - tulad ng taong naglalakbay
// pabalik-balik sa kanyang block.
//
// CULL: > 200 m mula sa player = itinatago at hindi na i-u-update (spec).
//
// PERF: 30 pedestrian x ~110 triangles = ~3,300 triangles (0.7% ng budget).
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { ROAD_LINES, sampleRoad, mulberry32 } from '../utils/roadLayout.js';
import { terrainHeight } from '../utils/geo.js';

const CULL_M = 200;                                    // culling (spec)
const SPD_MIN = 1.2, SPD_MAX = 1.8;                     // m/s (spec)
const SKIN = [0xe8b98a, 0xd9a066, 0xc68642];            // simpleng skin tones

// 1C: 5 variants ng damit (spec)
const CLOTHES = [0xff6644, 0x4466ff, 0x44aa44, 0xffcc00, 0xffffff];

class Pedestrian {
  constructor(ri, side, t, dir, rnd, group) {
    this.ri = ri;
    this.side = side;          // +1 / -1 - kung aling gilid ng kalsada
    this.t = t;                // distansya sa polyline
    this.dir = dir;            // +1 = papunta sa dulo, -1 = pabalik
    this.speed = SPD_MIN + rnd() * (SPD_MAX - SPD_MIN);
    this.phase = rnd() * Math.PI * 2;   // para hindi sabay ang lahat ng hakbang
    this.active = false;
    this.x = 0; this.z = 0;
    this.group = new THREE.Group();
    this.build(rnd);
    group.add(this.group);
    this.sync();
  }

  get road() {
    for (const r of ROAD_LINES) if (r.i === this.ri) return r;
    return null;
  }

  build(rnd) {
    const cloth = CLOTHES[Math.floor(rnd() * CLOTHES.length)];
    const skin = SKIN[Math.floor(rnd() * SKIN.length)];
    const clothMat = new THREE.MeshStandardMaterial({ color: cloth, roughness: 0.8 });
    const skinMat = new THREE.MeshStandardMaterial({ color: skin, roughness: 0.85 });
    // 1) torso
    const torso = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.52, 0.20), clothMat);
    torso.position.y = 1.10;      // 0.84 -> 1.36 m
    torso.castShadow = true;
    this.group.add(torso);
    // 2) head
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.20, 0.22, 0.20), skinMat);
    head.position.y = 1.48;
    head.castShadow = true;
    this.group.add(head);
    // 3) 4 limbs (2 braso, 2 binti) - naka-swing
    const limbMat = new THREE.MeshStandardMaterial({ color: cloth, roughness: 0.85 });
    const armGeom = new THREE.CylinderGeometry(0.055, 0.055, 0.50, 5);
    const legGeom = new THREE.CylinderGeometry(0.075, 0.065, 0.84, 5);
    this.arms = []; this.legs = [];
    // arms - nasa gilid ng torso
    [-1, 1].forEach((s) => {
      const pivot = new THREE.Group();
      pivot.position.set(s * 0.21, 1.30, 0);
      const arm = new THREE.Mesh(armGeom, limbMat);
      arm.position.y = -0.25;     // naka-lower mula sa pivot
      pivot.add(arm);
      this.group.add(pivot);
      this.arms.push(pivot);
    });
    // legs - nasa ilalim ng torso
    [-1, 1].forEach((s) => {
      const pivot = new THREE.Group();
      pivot.position.set(s * 0.09, 0.84, 0);
      const leg = new THREE.Mesh(legGeom, limbMat);
      leg.position.y = -0.42;
      pivot.add(leg);
      this.group.add(pivot);
      this.legs.push(pivot);
    });
  }

  sync() {
    const r = this.road;
    if (!r || r.pts.length < 2) return;
    // nasa gilid ng centerline: half-width + 1.6 m (sa loob ng sidewalk)
    const off = (r.half + 1.6) * this.side;
    const d = this.dir > 0 ? this.t : r.len - this.t;
    const s = sampleRoad(this.ri, d, off);
    this.x = s.x; this.z = s.z;
    this.group.position.set(s.x, terrainHeight(s.x, s.z), s.z);
    this.group.rotation.y = s.yaw + (this.dir > 0 ? 0 : Math.PI);
  }

  /**
   * @param time  - pumipasa mula sa manager para sa sine-wave phase
   */
  update(delta, playerPos, time) {
    const d2 = (this.x - playerPos.x) ** 2 + (this.z - playerPos.z) ** 2;
    // CULL (spec: 200 m) - itinatago at HINDI na i-u-update
    this.active = d2 < CULL_M * CULL_M;
    if (!this.active) { this.group.visible = false; return; }
    this.group.visible = true;

    const r = this.road;
    if (!r) return;

    // galaw, at pagdating sa dulo ay BUMABALIK (patrol)
    this.t += this.speed * delta * this.dir;
    if (this.t >= r.len || this.t <= 0) {
      this.t = Math.max(0, Math.min(r.len, this.t));
      this.dir *= -1;           // turn around
    }
    this.sync();

    // --- walking animation: sine wave sa rotation ng mga limb --------------
    // ~2 hakbang/segundo para sa 1.2-1.8 m/s. Ang braso at binti ay
    // magkatalitaw (counter-swing) - mas katoto-toto ang dating ng paglakad.
    const swing = Math.sin(time * 7 + this.phase) * 0.55;
    this.arms[0].rotation.x = swing;
    this.arms[1].rotation.x = -swing;
    this.legs[0].rotation.x = -swing;
    this.legs[1].rotation.x = swing;
  }
}

/**
 * PedestrianManager: 30 pedestrian (spec) sa buong lungsod.
 * "near buildings at sari-sari stores" - nasa primary/secondary ang pinakamataas
 * na dami ng tindaha, kaya doon namin ito nakakalat.
 */
export class PedestrianManager {
  constructor(scene, count = 30) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.group.name = 'pedestrians';
    scene.add(this.group);
    this.pedestrians = [];
    this.time = 0;
    this.spawn(count);
  }

  spawn(count) {
    const rnd = mulberry32(0x50454444);   // "PEDD" seed - deterministic
    // Kandidato: primary/secondary na may sidewalk (spec) at sapat ang haba
    const candidates = [];
    for (const r of ROAD_LINES) {
      if (r.cls !== 'primary' && r.cls !== 'secondary') continue;
      if (r.len < 120) continue;
      candidates.push(r.i);
    }
    if (!candidates.length) return;
    for (let k = 0; k < count; k++) {
      // stride 41 - para i-spread sa magkakaibang kalsada
      const ri = candidates[(k * 41) % candidates.length];
      const r = ROAD_LINES.find((x) => x.i === ri);
      if (!r) continue;
      const p = new Pedestrian(
        ri,
        rnd() < 0.5 ? 1 : -1,        // random na gilid
        r.len * (0.15 + rnd() * 0.7),  // nasa gitna ng kalsada, hindi sa dulo
        rnd() < 0.5 ? 1 : -1,
        rnd,
        this.group
      );
      this.pedestrians.push(p);
    }
  }

  update(delta, playerPos) {
    this.time += delta;
    for (const p of this.pedestrians) p.update(delta, playerPos, this.time);
  }

  get count() { return this.pedestrians.length; }
  get activeCount() { return this.pedestrians.reduce((n, p) => n + (p.active ? 1 : 0), 0); }
}
