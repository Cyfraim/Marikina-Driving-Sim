// ---------------------------------------------------------------------------
// 1B - NPCVehicle.js - Mga SASAKYANG NAKA-DRIVE sa kalsada
//
// Bakit kailangan: ang dating StreetObjects.js ay may STATIC na tricycle at
// jeepney - naka-park lang, walang gumagalaw. Ngayon ay may Mga NPC na talaga
// naglalakbay sa tunay na kalsada.
//
// PAANO GUMAGANA:
//  - Ang NPC ay may (ri, dir, t): kalsada `ri`, direksyon Â±1, at distansya `t`
//    mula sa simula ng polyline. Ang posisyon ay kinukuha sa sampleRoad().
//  - Kapag dating na sa dulo, hinahanap namin ang KONTEKSTUAL na kalsada mula
//    sa ROAD GRAPH (RoadGraph.js). Kung wala, REVERSE.
//  - Hindi nagbab-collide sa isa't isa (spec) pero may collision sa player.
//  - CULL: > 500 m mula sa player = itinatago at hindi na i-u-update (spec).
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { ROAD_LINES, sampleRoad, mulberry32 } from '../utils/roadLayout.js';
import { getRoadGraph } from '../utils/RoadGraph.js';
import { terrainHeight } from '../utils/geo.js';
import { canRunTraffic } from '../utils/RoadProfile.js';

const CULL_M = 500;                            // culling radius (spec)
const HEADON_M = 5;                            // player < 5 m = head-on (spec)
const HEADON_WAIT = 3.0;                       // seconds na naghihintay (spec)
const SPD_MIN = 20 / 3.6, SPD_MAX = 40 / 3.6;  // 20-40 km/h (spec)
const ACCEL = 3.0, DECEL = 6.0;

const TIRE = 0x1a1a1a;
const TRIKE_BODY = [0x00c8d7, 0xf5c518];              // cyan / yellow (spec)
const JEEP_STRIPES = [0xe91e63, 0xfdd835, 0x43a047]; // magenta/yellow/green

// 1B: ROAD_LINES ay .filter()'d, kaya ang `line.i` ay index sa ORIGINAL na
// ROADS - hindi sa ROAD_LINES. Kailangan nating i-map ang ri -> ROAD_LINES.
const _byRi = new Map();
for (const line of ROAD_LINES) _byRi.set(line.i, line);
const lineByRi = (ri) => _byRi.get(ri);

/** Isang NPC vehicle: tricycle o jeepney. */
class NPCVehicle {
  constructor(kind, roadIndex, dir, t, rnd, group) {
    this.kind = kind;
    this.ri = roadIndex;
    this.dir = lineByRi(roadIndex)?.isOneWay ? 1 : dir; // normalized geometry
    this.t = t;                     // distansya mula sa simula ng polyline
    this.speed = SPD_MIN + rnd() * (SPD_MAX - SPD_MIN);
    this.cruise = this.speed;       // "normal" na bilis (para sa weather)
    this.rnd = rnd;
    this.x = 0; this.z = 0;
    this.waitTimer = 0;             // > 0 = naghihintay (head-on)
    this.redStopped = false;        // 2A: naka-stop sa pulang ilaw
    this.active = false;            // visible + ina-update?
    this.group = new THREE.Group();
    this.build();
    group.add(this.group);
    this.sync();
  }

  get road() { return lineByRi(this.ri); }
  get halfWidth() { return this.kind === 'tricycle' ? 0.95 : 1.1; }
  get halfLength() { return this.kind === 'tricycle' ? 1.1 : 2.4; }
  get forwardX() { return Math.sin(this.group.rotation.y); }
  get forwardZ() { return Math.cos(this.group.rotation.y); }

  build() {
    this.wheels = [];
    if (this.kind === 'tricycle') this.buildTricycle();
    else this.buildJeepney();
  }

  // --- Tricycle: box body + 3 cylinder wheels (cyan/yellow) ---------------
  buildTricycle() {
    const col = TRIKE_BODY[Math.floor(this.rnd() * TRIKE_BODY.length)];
    const bodyMat = new THREE.MeshStandardMaterial({ color: col, roughness: 0.6 });
    const roofMat = new THREE.MeshStandardMaterial({ color: 0x37474f, roughness: 0.7 });
    const tireMat = new THREE.MeshStandardMaterial({ color: TIRE, roughness: 0.9 });
    const b = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.55, 1.9), bodyMat);
    b.position.y = 0.55; b.castShadow = true; this.group.add(b);
    const seat = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.4, 0.7), roofMat);
    seat.position.set(0, 0.95, -0.15); this.group.add(seat);
    // sidecar - ang kakaiba sa tricycle
    const sc = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.6, 1.5), bodyMat);
    sc.position.set(0.85, 0.5, 0.05); sc.castShadow = true; this.group.add(sc);
    const scRoof = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.08, 1.5), roofMat);
    scRoof.position.set(0.85, 1.05, 0.05); this.group.add(scRoof);
    // 3 gulong: 1 sa harap, 2 sa sidecar
    const wg = new THREE.CylinderGeometry(0.28, 0.28, 0.16, 8);
    [[0, 0.85], [0.85, -0.6], [0.85, 0.7]].forEach(([x, z], i) => {
      const w = new THREE.Mesh(wg, tireMat);
      w.position.set(x, 0.28, z);
      // ang axle ng cylinder ay Y. Para maging "gulong" (nakaharap sa gilid),
      // i-rotate: front = Z (axle -> X), sidecar = X (axle -> Z)
      if (i === 0) w.rotation.z = Math.PI / 2; else w.rotation.x = Math.PI / 2;
      w.userData.spinAxis = i === 0 ? 'y' : 'x';
      this.group.add(w);
      this.wheels.push(w);
    });
  }

  // --- Jeepney: mahabang box + kulay na stripes + chrome grille ----------
  buildJeepney() {
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0xeceff1, roughness: 0.55 });
    const roofMat = new THREE.MeshStandardMaterial({ color: 0xb0bec5, roughness: 0.6 });
    const chrome = new THREE.MeshStandardMaterial({
      color: 0xcfd8dc, metalness: 0.8, roughness: 0.25,
    });
    const tireMat = new THREE.MeshStandardMaterial({ color: TIRE, roughness: 0.9 });
    const b = new THREE.Mesh(new THREE.BoxGeometry(2.0, 1.5, 4.4), bodyMat);
    b.position.y = 1.15; b.castShadow = true; this.group.add(b);
    const roof = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.2, 4.2), roofMat);
    roof.position.y = 2.0; this.group.add(roof);
    // kulay na stripes (magenta/yellow/green) - tatlong guhit
    JEEP_STRIPES.forEach((c, i) => {
      const mat = new THREE.MeshStandardMaterial({ color: c, roughness: 0.5 });
      const s = new THREE.Mesh(new THREE.BoxGeometry(2.04, 0.16, 3.8), mat);
      s.position.set(0, 1.0 + i * 0.28, 0); this.group.add(s);
    });
    // chrome grille sa harap
    const grill = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.6, 0.14), chrome);
    grill.position.set(0, 1.0, 2.25); this.group.add(grill);
    const hlMat = new THREE.MeshStandardMaterial({
      color: 0xfff9c4, emissive: 0xfff9c4, emissiveIntensity: 0.6,
    });
    const tlMat = new THREE.MeshStandardMaterial({
      color: 0xff1744, emissive: 0xff1744, emissiveIntensity: 0.5,
    });
    [-0.7, 0.7].forEach((x) => {
      const h = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.25, 0.1), hlMat);
      h.position.set(x, 1.0, 2.3); this.group.add(h);
      const t = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.2, 0.1), tlMat);
      t.position.set(x, 1.0, -2.25); this.group.add(t);
    });
    // 4 gulong
    const wg = new THREE.CylinderGeometry(0.36, 0.36, 0.22, 8);
    [[-0.95, 1.5], [0.95, 1.5], [-0.95, -1.5], [0.95, -1.5]].forEach(([x, z]) => {
      const w = new THREE.Mesh(wg, tireMat);
      w.position.set(x, 0.36, z);
      w.rotation.z = Math.PI / 2;
      w.userData.spinAxis = 'y';
      this.group.add(w);
      this.wheels.push(w);
    });
  }

  /** I-synchronize ang posisyon/yaw mula sa polyline (ri, dir, t). */
  sync() {
    const r = this.road;
    if (!r || r.pts.length < 2) return;
    // t is always measured from the first road point, kahit reverse.
    const d = this.t;
    // lateral offset: slight na kanan ng centerline (like a real lane)
    const s = sampleRoad(this.ri, d, r.half * 0.35 * this.dir);
    this.x = s.x; this.z = s.z;
    this.group.position.set(s.x, terrainHeight(s.x, s.z), s.z);
    this.group.rotation.y = s.yaw + (this.dir > 0 ? 0 : Math.PI);
  }

  /**
   * Isang update step.
   * @param playerPos   {x,z} - para sa cull at head-on
   * @param speedScale  1.0 = normal; 0.7 = heavy rain (Phase 2D)
   */
  update(delta, playerPos, speedScale = 1, lights = null) {
    const d2 = (this.x - playerPos.x) ** 2 + (this.z - playerPos.z) ** 2;
    // CULL (spec: 500 m) - itinatago at HINDI na i-u-update
    this.active = d2 < CULL_M * CULL_M;
    if (!this.active) {
      this.group.visible = false;
      // FIX: kahit culled, dapat PUMALAWAG na ang naghihintay (head-on timer).
      // Dati naiiwasan ito ng early `return`, kaya kapag bumalik ang player
      // (>500 m -> <500 m) at NAKAHINTO pa ang NPC, na-stuck siya nang
      // 3 segundong frame - hindi na makakilos. Ang timer ay oras ng laro,
      // hindi oras ng "visibility", kaya dapat tumutoy parin.
      if (this.waitTimer > 0) this.waitTimer = Math.max(0, this.waitTimer - delta);
      return;
    }
    this.group.visible = true;

    const r = this.road;
    if (!r) return;

    // --- 2A: RED LIGHT: kung may pulang semaphore <= 10 m sa HARAP, huminto ---
    // Ang mismong ILAW ang humihinto (walang sariling timer), kaya kapag
    // naging GREEN ay magpapatuloy agad - walang "lag" sa pagpapalit ng ilaw.
    //
    // BUG NA HINULING (Phase 2): ang dating guard ay `this.speed > 0`. pero
    // pagkatapos huminto, speed = 0 - kaya NAGHIHINTI TALA sa susunod na
    // frame at hindi na malilinis ang `redStopped`. Resulta: NAKAKANANTO sa
    // pulang ilaw kahit naging GREEN na. Ang tamang guard: huwag nating
    // alingawnan ang pagsusuri kahit nakatigil na (i-clear lang, walang
    // accel - ang accel ay sa drive() sa ibaba).
    if (lights) {
      if (lights.redAhead(this.x, this.z, this.forwardX, this.forwardZ, 10)) {
        if (this.speed > 0) this.speed = 0;     // brake (decay handled below)
        this.redStopped = true;
      } else if (this.redStopped) {
        this.redStopped = false;               // green -> puwedeng umandar na
      }
    }

    // --- head-on: player < 5 m sa HARAP ng NPC -> brake at maghintay 3 s --
    if (this.waitTimer > 0) {
      this.waitTimer -= delta;
      this.speed = 0;
    } else {
      const dist = Math.sqrt(d2);
      // head-on = player ay nasa FRAP ng NPC (magkasalubong na direksyon)
      const ahead = dist < HEADON_M && dist > 0.01 &&
        this.forwardX * ((playerPos.x - this.x) / dist) +
        this.forwardZ * ((playerPos.z - this.z) / dist) > 0.5;
      if (ahead) {
        this.waitTimer = HEADON_WAIT;
        this.speed = 0;
      } else if (!this.redStopped) {
        this.drive(delta, speedScale);
      }
    }

    // --- galaw sa kalsada, at pagtawid sa dulo ---------------------------
    this.t += this.speed * delta * this.dir;
    if (this.t >= r.len || this.t <= 0) {
      this.t = Math.max(0, Math.min(r.len, this.t));
      this.pickNextRoad();
    }
    this.sync();
    // wheel spin: angular na bilis = v / r
    const spin = (this.speed / 0.3) * delta;
    for (const w of this.wheels) {
      const ax = w.userData.spinAxis;
      if (ax === 'y') w.rotation.y += spin;
      else if (ax === 'x') w.rotation.x += spin;
    }
  }

  drive(delta, speedScale) {
    const target = this.cruise * speedScale;
    if (this.speed < target) this.speed += ACCEL * delta;
    else this.speed -= DECEL * delta;
    this.speed = Math.max(0, Math.min(this.speed, target));
  }

  /**
   * Pumili ng susunod na kalsada sa dulo ng kasalukuyan, gamit ang ROAD GRAPH.
   * Kung wala, REVERSE sa parehong kalsada (spec).
   */
  pickNextRoad() {
    const g = getRoadGraph();
    const r = this.road;
    const last = r.pts[r.pts.length - 1];
    const atEnd = this.dir > 0
      ? { x: last.x, z: last.z }
      : { x: r.pts[0].x, z: r.pts[0].z };
    const node = g.nearestNode(atEnd.x, atEnd.z, 60);
    if (node >= 0) {
      // Ang mga kandidat ay mga kalsadang NAKA-IBA at may dulo malapit sa
      // dulo ng kasalukuyan (para tuloy-tuloy ang pagmamarcha).
      const cand = [];
      for (const ri of g.candidateRoads(node)) {
        if (ri === this.ri) continue;
        const nr = lineByRi(ri);
        if (!nr || nr.pts.length < 2 || !canRunTraffic(nr)) continue;
        const d0 = Math.hypot(nr.pts[0].x - atEnd.x, nr.pts[0].z - atEnd.z);
        const d1 = Math.hypot(nr.pts[nr.pts.length - 1].x - atEnd.x,
                              nr.pts[nr.pts.length - 1].z - atEnd.z);
        if (nr.isOneWay && d0 > d1) continue;
        cand.push({ ri, nr, d: Math.min(d0, d1) });
      }
      // ayusin ang pinakamalapit na dulo para magmamarcha nang maayos
      cand.sort((a, b) => a.d - b.d);
      const pick = cand[0];
      if (pick && pick.d < 60) {
        const nr = pick.nr;
        const d0 = Math.hypot(nr.pts[0].x - atEnd.x, nr.pts[0].z - atEnd.z);
        const d1 = Math.hypot(nr.pts[nr.pts.length - 1].x - atEnd.x,
                              nr.pts[nr.pts.length - 1].z - atEnd.z);
        this.ri = pick.ri;
        this.dir = d0 <= d1 ? 1 : -1;
        this.t = d0 <= d1 ? 0 : nr.len;
        return;
      }
    }
    // walang konektadong kalsada -> REVERSE (spec)
    if (r.isOneWay) { this.speed = 0; return; } // no illegal U-turn at dead end
    this.dir *= -1;
    this.t = this.dir > 0 ? 0 : this.road.len;
  }
}

/**
 * NPCManager: ang manager ng lahat ng NPC vehicle.
 * 15 tricycle + 8 jeepney (spec), paunawa sa buong lungsod.
 *
 * PERF: 23 NPC. Ang tricycle ay ~250 triangles, ang jeepney ~450, kaya
 * kabuuan ay ~9,000 triangles - 2% lang ng 454k na budget.
 */
export class NPCManager {
  constructor(scene, counts = { tricycle: 15, jeepney: 8 }) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.group.name = 'npc-vehicles';
    scene.add(this.group);
    this.vehicles = [];
    this.colliderBoxes = [];   // AABB para sa player (inau-update kada frame)
    this.enabled = true;
    this.spawn(counts);
  }

  spawn(counts) {
    const rnd = mulberry32(0x4e5043);   // "NPC" seed - deterministic
    // Kandidato: kalsadang hindi masyadong maikli, at hindi alley/track
    const candidates = [];
    for (const r of ROAD_LINES) {
      if (r.len < 80 || !canRunTraffic(r)) continue;
      if (r.cls === 'service' || r.cls === 'track') continue;
      candidates.push(r.i);
    }
    const total = counts.tricycle + counts.jeepney;
    for (let k = 0; k < total; k++) {
      const kind = k < counts.tricycle ? 'tricycle' : 'jeepney';
      // stride 97 - para i-spread sa magkakaibang kalsada, hindi magkakatabi
      const ri = candidates[(k * 97) % candidates.length];
      const r = lineByRi(ri);
      if (!r) continue;
      this.vehicles.push(
        new NPCVehicle(kind, ri, rnd() < 0.5 ? 1 : -1, rnd() * r.len, rnd, this.group)
      );
    }
  }

  /**
   * I-update lahat ng NPC + bumuo ng AABB collider boxes para sa player.
   * @param speedScale 1.0 = normal; 0.7 = heavy rain (Phase 2D)
   * @param lights     TrafficLightSystem (2A) - NPC huminto sa pulang ilaw
   * @returns {THREE.Box3[]} - i-reuse na array (walang allocation kada frame)
   */
  setEnabled(enabled) {
    this.enabled = !!enabled;
    this.group.visible = this.enabled;
    if (!this.enabled) {
      this.colliderBoxes.length = 0;
      for (const v of this.vehicles) v.active = false;
    }
  }

  update(delta, playerPos, speedScale = 1, lights = null) {
    if (!this.enabled) return this.colliderBoxes;
    for (const v of this.vehicles) v.update(delta, playerPos, speedScale, lights);
    // Mga AABB collider para sa player - i-clear ang lumang (walang bagong array)
    const out = this.colliderBoxes;
    out.length = 0;
    for (const v of this.vehicles) {
      if (!v.active) continue;
      out.push(new THREE.Box3().setFromCenterAndSize(
        new THREE.Vector3(v.x, 0.6, v.z),
        new THREE.Vector3(v.halfWidth * 2, 1.2, v.halfLength * 2)
      ));
    }
    return out;
  }

  get count() { return this.vehicles.length; }
  /** Bilang ng aktibong (hindi culled) NPC - para sa HUD/debug. */
  get activeCount() { return this.vehicles.reduce((n, v) => n + (v.active ? 1 : 0), 0); }
  /** Para sa minimap (1B: maliit na puting dots). */
  get forMinimap() { return this.vehicles; }
  get trikeCount() { return this.vehicles.filter((v) => v.kind === 'tricycle').length; }
  get jeepCount() { return this.vehicles.filter((v) => v.kind === 'jeepney').length; }
}