// ---------------------------------------------------------------------------
// 2D - Weather.js - Clear / Light Rain / Heavy Rain
//
// Spec (F key): Clear -> Light Rain -> Heavy Rain -> Clear
//
//   Light Rain:  500 particles, sky 0x6699aa, specular 0x444444,
//                rain sound gain 0.15
//   Heavy Rain: 1500 particles, sky 0x445566, stronger specular,
//                rain sound gain 0.4, fog distance -40%, NPC speed x0.7
//
// PERF - ANG PARTICLES: hindi ito 1,500 na MESH! Ang bawat particle ay
// ISA LANG line segment (2 vertices) sa iisang THREE.LineSegments object.
// Ang lahat ng 1,500 particles ay magagamit sa ISE buffer lang - kaya ito
// 1 draw call, hindi 1,500. (Ang dating "billboarded quad" na ideya ay
// masyadong mahal - 1,500 quads x 2 triangles = 3,000 triangles + 1,500
// objects. Ang LineSegments approach: 1,500 lines, 1 draw call, 0 extra
// triangles.)
//
// Ang bawat particle ay may (x, y, z) naRelative sa PLAYER, kaya kapag
// nawala sa "box" na nakadikit sa player, RECYCLE sa itaas (reset to top).
// Ito ay ang dahilan hindi natin gumagamit ng world-space positions.
// ---------------------------------------------------------------------------
import * as THREE from 'three';

export const WEATHER = {
  clear:  { key: 'clear',  name: 'Clear',     particles: 0,    sky: 0x87ceeb, specular: 0x111111, rainGain: 0,    fogScale: 1.0,  npcScale: 1.0 },
  light:  { key: 'light',  name: 'Light Rain', particles: 500,  sky: 0x6699aa, specular: 0x444444, rainGain: 0.15, fogScale: 1.0,  npcScale: 1.0 },
  heavy:  { key: 'heavy',  name: 'Heavy Rain', particles: 1500, sky: 0x445566, specular: 0x666666, rainGain: 0.4,  fogScale: 0.6,  npcScale: 0.7 },
};
const ORDER = ['clear', 'light', 'heavy'];

// Ang "box" sa paligid ng player kung saan gumagalaw ang ulan
const BOX = 90;        // metro (radius ng XZ)
const TOP = 45;        // itaas ng player
const BOTTOM = -6;     // ibaba (sa lupa)
const FALL = 38;       // m/s - bilis ng pagbagsak
const WIND = 6;        // m/s - hangin mula silangang (spec: "wind from east")

export class Weather {
  constructor(scene) {
    this.scene = scene;
    this.index = 0;                        // 0 = clear
    this.time = 0;
    this.player = new THREE.Vector3();

    // --- LineSegments: 1,500 lines max, 2 vertices each = 3,000 vertices ---
    this.maxParticles = 1500;
    const positions = new Float32Array(this.maxParticles * 2 * 3);
    this.posAttr = new THREE.BufferAttribute(positions, 3);
    this.posAttr.setUsage(THREE.DynamicDrawUsage);   // madalas magbago
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', this.posAttr);
    this.lines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0.55,
    }));
    this.lines.frustumCulled = false;   // always around the player
    this.lines.visible = false;
    scene.add(this.lines);

    // per-particle offsets (relative sa player)
    this.ox = new Float32Array(this.maxParticles);
    this.oy = new Float32Array(this.maxParticles);
    this.oz = new Float32Array(this.maxParticles);
    this._seed();
    this.state = WEATHER.clear;
  }

  _seed() {
    // deterministic-ish random spread sa box
    for (let i = 0; i < this.maxParticles; i++) {
      this.ox[i] = (Math.random() * 2 - 1) * BOX;
      this.oy[i] = BOTTOM + Math.random() * (TOP - BOTTOM);
      this.oz[i] = (Math.random() * 2 - 1) * BOX;
    }
  }

  get current() { return ORDER[this.index]; }
  get info() { return this.state; }
  get isRaining() { return this.index > 0; }
  get npcSpeedScale() { return this.state.npcScale; }

  /** I-cycle: Clear -> Light -> Heavy -> Clear (spec). */
  cycle() {
    this.index = (this.index + 1) % ORDER.length;
    this.apply();
    return this.state;
  }

  set(key) {
    const i = ORDER.indexOf(key);
    if (i < 0) return this.state;
    this.index = i;
    this.apply();
    return this.state;
  }

  apply() {
    this.state = WEATHER[this.current];
    this.lines.visible = this.state.particles > 0;
    // dahil LineSegments ay isang object, ang "bilang ng particles" ay
    // ginagawa sa draw range - hindi kailangan gumawa ng bagong object.
    this.posAttr.array.fill(0);
    for (let i = this.state.particles; i < this.maxParticles; i++) {
      this.posAttr.array[i * 6 + 0] = 0;
      this.posAttr.array[i * 6 + 1] = 0;
      this.posAttr.array[i * 6 + 2] = 0;
    }
    this.posAttr.needsUpdate = true;
  }

  /**
   * I-update ang positions ng ulan.
   * @param playerPos THREE.Vector3 - ang box ay nakadikit dito
   */
  update(delta, playerPos) {
    this.time += delta;
    this.player.copy(playerPos);
    if (!this.isRaining) return;
    const n = this.state.particles;
    const arr = this.posAttr.array;
    const px = playerPos.x, py = playerPos.y, pz = playerPos.z;
    for (let i = 0; i < n; i++) {
      // fall + wind drift
      this.oy[i] -= FALL * delta;
      this.ox[i] += WIND * delta;         // hangin mula silangan -> +X
      // RECYCLE: kapag below ground, i-reset sa itaas
      if (this.oy[i] < BOTTOM) {
        this.oy[i] = TOP;
        this.ox[i] = (Math.random() * 2 - 1) * BOX;
        this.oz[i] = (Math.random() * 2 - 1) * BOX;
      }
      // i-wrap sa X box (kung malayo na sa player)
      if (Math.abs(this.ox[i]) > BOX) this.ox[i] -= Math.sign(this.ox[i]) * BOX * 2;
      // 2 vertices: ang upper point at ang lower point (isang "line")
      const o = i * 6;
      arr[o + 0] = px + this.ox[i];
      arr[o + 1] = py + this.oy[i];
      arr[o + 2] = pz + this.oz[i];
      // ang lower point: mas mababa at slight na na-back sa hangin
      arr[o + 3] = px + this.ox[i] - WIND * 0.03;
      arr[o + 4] = py + this.oy[i] - 1.6;
      arr[o + 5] = pz + this.oz[i];
    }
    this.posAttr.needsUpdate = true;
  }
}
