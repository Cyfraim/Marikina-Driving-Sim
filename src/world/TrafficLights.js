// ---------------------------------------------------------------------------
// 2A - TrafficLights.js - Mga SEMAFORO sa pinakamatao na intersection
//
// Paano natutpuan ang "pinakamatao": ang ROAD GRAPH (RoadGraph.js) ang may mga
// NODE na intersection. Ang BUSAY (degree) ng isang node = ilang kalsada ang
// naka-connect. Hinahanap namin ang mga node na degree >= 3, tapos ang TOP 20.
//
// CYCLE (spec): green 15 s -> yellow 2 s -> red 15 s.  Total = 32 s.
// Ang bawat intersection ay may `offset` na HINNIHANTIHI sa simula nito - kaya
// hindi sabay-sabay ang lahat ng semaphore (mas makatotohan).
//
// Ang STATE ay PURE FUNCTION ng absolute time - madaling i-test, at walang
// state na nakalimutang ma-reset.
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { getRoadGraph } from '../utils/RoadGraph.js';
import { terrainHeight } from '../utils/geo.js';

const GREEN_T = 15;    // spec
const YELLOW_T = 2;    // spec
const RED_T = 15;      // spec
const CYCLE = GREEN_T + YELLOW_T + RED_T;   // 32 s

const POLE_H = 5;                     // spec: 5 m
const POLE_COLOR = 0x9e9e9e;          // gray
const BOX_COLOR = 0x212121;           // dark housing
export const LIGHT_COLORS = { green: 0x2ecc40, yellow: 0xf1c40f, red: 0xe74c3c };
const MIN_GAP = 250;                  // metro - para may pantay na pagkakalat

/** Isang semaphore. Ang state ay nakatala sa absolute `time`. */
class TrafficLight {
  constructor(x, z, offset, degree) {
    this.x = x; this.z = z;
    this.offset = offset;      // segundos
    this.degree = degree;      // ilang kalsada
    this.group = new THREE.Group();
    this.state = 'green';
    this.build();
  }

  build() {
    const gy = terrainHeight(this.x, this.z);
    // poste (5 m, gray cylinder)
    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.12, 0.16, POLE_H, 6),
      new THREE.MeshStandardMaterial({ color: POLE_COLOR, roughness: 0.7 })
    );
    pole.position.y = gy + POLE_H / 2;
    pole.castShadow = true;
    this.group.add(pole);
    // housing box
    const box = new THREE.Mesh(
      new THREE.BoxGeometry(0.48, 1.35, 0.34),
      new THREE.MeshStandardMaterial({ color: BOX_COLOR, roughness: 0.6 })
    );
    box.position.y = gy + POLE_H - 0.55;
    this.group.add(box);
    // 3 lamps: red (taas), yellow (gitna), green (baba) - ganito ang pagkakasunod
    // ng tunay na semaphore sa Pilipinas.
    this.lamps = {};
    const order = [['red', 0.42], ['yellow', 0.0], ['green', -0.42]];
    for (const [name, dy] of order) {
      const mat = new THREE.MeshStandardMaterial({
        color: LIGHT_COLORS[name],
        emissive: LIGHT_COLORS[name],
        emissiveIntensity: 0.1,       // patay lahat sa simula
        roughness: 0.4,
      });
      const lamp = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.08, 8), mat);
      // ang cylinder ay nasa Y; i-rotate sa X para makaharap sa '+Z'
      lamp.rotation.x = Math.PI / 2;
      lamp.position.set(0, gy + POLE_H - 0.55 + dy, 0.19);
      this.group.add(lamp);
      this.lamps[name] = lamp;
    }
    this.group.position.set(this.x, 0, this.z);
  }

  /**
   * I-set ang state mula sa absolute time.
   * @returns {string} 'green' | 'yellow' | 'red'
   */
  update(time) {
    const phase = ((time + this.offset) % CYCLE + CYCLE) % CYCLE;
    let s;
    if (phase < GREEN_T) s = 'green';
    else if (phase < GREEN_T + YELLOW_T) s = 'yellow';
    else s = 'red';
    this.state = s;
    // i-toggle ang emissive: yung aktibo = bright, iba = halos patay
    for (const name of ['red', 'yellow', 'green']) {
      const on = name === s;
      const m = this.lamps[name].material;
      m.emissiveIntensity = on ? 1.6 : 0.06;
      m.color.setHex(on ? LIGHT_COLORS[name] : 0x1a1a1a);
    }
    return s;
  }

  get color() { return LIGHT_COLORS[this.state]; }
}

export class TrafficLightSystem {
  /**
   * @param scene THREE.Scene
   * @param count ilang semaphore (spec: top 20)
   */
  constructor(scene, count = 20) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.group.name = 'traffic-lights';
    scene.add(this.group);
    this.lights = [];
    this.time = 0;
    this.build(count);
  }

  build(count) {
    const g = getRoadGraph();
    // 1) kandidato: nodes na may 3+ kalsada
    const cands = [];
    for (let n = 0; n < g.nodeCount; n++) {
      const deg = g.adj[n].length;
      if (deg >= 3) cands.push({ n, deg, x: g.nodeX[n], z: g.nodeZ[n] });
    }
    // pinakamatao muna
    cands.sort((a, b) => b.deg - a.deg);
    // 2) greedy pick na may MIN_GAP - para HINDI magkakalat sa iisang kanto
    const chosen = [];
    for (const c of cands) {
      if (chosen.length >= count) break;
      let ok = true;
      for (const p of chosen) {
        if (Math.hypot(p.x - c.x, p.z - c.z) < MIN_GAP) { ok = false; break; }
      }
      if (ok) chosen.push(c);
    }
    // 3) gumawa ng semaphore, may magkakaibang offset (hindi sabay lahat)
    for (let i = 0; i < chosen.length; i++) {
      const c = chosen[i];
      const offset = (i * 4) % CYCLE;
      const tl = new TrafficLight(c.x, c.z, offset, c.deg);
      this.group.add(tl.group);
      this.lights.push(tl);
    }
  }

  /** I-update lahat: absolute time -> state. */
  update(time) {
    this.time = time;
    for (const l of this.lights) l.update(time);
  }

  /**
   * May RED ba na semaphore malapit sa (x,z) sa direksyon (dirX,dirZ)?
   * Ito ang ginagamit ng NPC para huminto.
   * @param maxDist 10 m (spec)
   */
  redAhead(x, z, dirX, dirZ, maxDist = 10) {
    const m2 = maxDist * maxDist;
    for (const l of this.lights) {
      if (l.state !== 'red') continue;
      const dx = l.x - x, dz = l.z - z;
      const d2 = dx * dx + dz * dz;
      if (d2 > m2) continue;
      const d = Math.sqrt(d2) || 1;
      // nasa HARAP ba? (dot > 0.3)
      if ((dx * dirX + dz * dirZ) / d > 0.3) return true;
    }
    return false;
  }

  get count() { return this.lights.length; }
  /** Para sa minimap (2A). */
  get forMinimap() { return this.lights; }
  get redCount() { return this.lights.filter((l) => l.state === 'red').length; }
  get greenCount() { return this.lights.filter((l) => l.state === 'green').length; }
  get yellowCount() { return this.lights.filter((l) => l.state === 'yellow').length; }
}