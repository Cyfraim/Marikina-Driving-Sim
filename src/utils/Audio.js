// ---------------------------------------------------------------------------
// Audio.js - Web Audio: 2C (horn) + 2D (rain sound)
//
// 2C HORN (spec): short beep sequence 440 Hz -> 550 Hz, two beeps, 0.15 s
//                each, with a 0.1 s gap. 1 s cooldown para hindi ma-spam.
//
// 2D RAIN (spec): LOOPING white noise via Web Audio, gain 0.15 (light)
//                / 0.4 (heavy).
//
// PERF: ang rain noise ay isang buffer lang (2 s) na LOOOPED - hindi ito
// gumagawa ng bagong buffer kada frame. Ang gain ay pinapataas/napapababa
// lamang (0 = clear, 0.15 = light, 0.4 = heavy).
// ---------------------------------------------------------------------------
export class AudioFX {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.hornCooldown = 0;
    this.rainGainNode = null;
    this.enabled = true;
    this.volume = 0.5;
    this.active = false;
    this.rainLevel = 0;
    this.sources = new Set();
    this.nodes = new Set();
    this.destroyed = false;
    this.impactCooldown = 0;
  }

  /** Ang AudioContext ay kailangang gawin sa user gesture (browser rule). */
  ensure() {
    if (this.destroyed || !this.enabled) return null;
    if (this.ctx) return this.ctx;
    const AC = globalThis.window?.AudioContext || globalThis.window?.webkitAudioContext;
    if (!AC) { this.enabled = false; return null; }
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.active ? this.volume : 0;
    this.master.connect(this.ctx.destination);
    this.#buildRain();
    this.#buildDriving();
    return this.ctx;
  }

  resume() {
    const ctx = this.ensure();
    if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
  }

  setVolume(value) {
    this.volume = Math.max(0, Math.min(1, Number(value) || 0));
    if (this.ctx) this.master.gain.setTargetAtTime(this.active ? this.volume : 0, this.ctx.currentTime, 0.03);
  }

  setActive(active) {
    this.active = !!active;
    if (!this.ctx) return; // Never create a context in the animation loop.
    this.master.gain.setTargetAtTime(this.active ? this.volume : 0, this.ctx.currentTime, 0.02);
  }

  #track(source, ...nodes) {
    this.sources.add(source);
    for (const node of [source, ...nodes]) this.nodes.add(node);
    source.onended = () => {
      this.sources.delete(source);
      for (const node of [source, ...nodes]) { node.disconnect(); this.nodes.delete(node); }
    };
  }

  #buildDriving() {
    const ctx = this.ctx;
    const engine = ctx.createOscillator(), harmonic = ctx.createOscillator();
    const filter = ctx.createBiquadFilter(), gain = ctx.createGain(), harmonicGain = ctx.createGain();
    engine.type = 'sawtooth'; harmonic.type = 'triangle';
    engine.frequency.value = 38; harmonic.frequency.value = 76;
    filter.type = 'lowpass'; filter.frequency.value = 250;
    gain.gain.value = 0; harmonicGain.gain.value = 0.25;
    engine.connect(filter); harmonic.connect(harmonicGain).connect(filter);
    filter.connect(gain).connect(this.master);
    this.#track(engine, filter, gain); this.#track(harmonic, harmonicGain);
    engine.start(); harmonic.start();
    this.engine = { engine, harmonic, filter, gain };
    for (const [name, type, frequency] of [['road', 'lowpass', 550], ['brake', 'bandpass', 1800]]) {
      const source = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
      source.buffer = this.noiseBuffer; source.loop = true;
      f.type = type; f.frequency.value = frequency; f.Q.value = name === 'brake' ? 3 : 0.7;
      g.gain.value = 0;
      source.connect(f).connect(g).connect(this.master);
      this.#track(source, f, g); source.start();
      this[name] = { gain: g, filter: f };
    }
  }

  update(vehicle, input) {
    if (!this.ctx || !this.engine) return;
    const state = drivingSoundState(vehicle.speed, input);
    const t = this.ctx.currentTime;
    this.engine.engine.frequency.setTargetAtTime(state.frequency, t, 0.09);
    this.engine.harmonic.frequency.setTargetAtTime(state.frequency * 2, t, 0.09);
    this.engine.filter.frequency.setTargetAtTime(250 + state.throttle * 650 + state.speed * 12, t, 0.1);
    this.engine.gain.gain.setTargetAtTime(state.engineGain, t, 0.08);
    this.road.gain.gain.setTargetAtTime(state.roadGain, t, 0.1);
    this.brake.gain.gain.setTargetAtTime(state.brakeGain, t, 0.035);
    this.brake.filter.frequency.setTargetAtTime(1200 + state.speed * 30, t, 0.05);
  }

  impact(strength) {
    if (!this.active || !this.ctx || strength < 1 || this.ctx.currentTime < this.impactCooldown) return false;
    const ctx = this.ctx, at = ctx.currentTime;
    this.impactCooldown = at + 0.3;
    const source = ctx.createBufferSource(), filter = ctx.createBiquadFilter(), gain = ctx.createGain();
    source.buffer = this.noiseBuffer;
    filter.type = 'lowpass'; filter.frequency.value = 240;
    gain.gain.setValueAtTime(Math.min(0.6, strength / 30), at);
    gain.gain.exponentialRampToValueAtTime(0.001, at + 0.22);
    source.connect(filter).connect(gain).connect(this.master);
    this.#track(source, filter, gain);
    source.start(at); source.stop(at + 0.25);
    return true;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const source of this.sources) { source.onended = null; try { source.stop(); } catch { /* already stopped */ } }
    for (const node of this.nodes) node.disconnect();
    this.sources.clear(); this.nodes.clear();
    this.master?.disconnect();
    this.ctx?.close().catch(() => {});
    this.ctx = this.master = this.engine = this.road = this.brake = this.rainGainNode = this.noiseBuffer = null;
  }

  // --- 2D: looping white noise buffer (2 s) -------------------------------
  #buildRain() {
    const ctx = this.ctx;
    const len = ctx.sampleRate * 2;         // 2 segundo
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) {
      // white noise = random -1..1
      data[i] = Math.random() * 2 - 1;
    }
    const src = ctx.createBufferSource();
    this.noiseBuffer = buf;
    src.buffer = buf;
    src.loop = true;                        // <-- LOOPING
    const g = ctx.createGain();
    g.gain.value = 0;                       // 0 = tahimik sa simula
    // light lowpass para hindi sobrang dinagat ang tunog
    const filt = ctx.createBiquadFilter();
    filt.type = 'lowpass';
    filt.frequency.value = 1400;
    src.connect(filt).connect(g).connect(this.master);
    this.#track(src, filt, g);
    src.start();
    this.rainGainNode = g;
    g.gain.value = this.rainLevel;
  }

  /** Itakda ang lakas ng tunog ng ulan (spec: 0.15 light, 0.4 heavy, 0 clear). */
  setRainGain(v) {
    if (!this.enabled) return;
    this.rainLevel = Math.max(0, Math.min(0.4, v));
    const ctx = this.ctx;
    if (!ctx || !this.rainGainNode) return;
    // smooth ang pagbabago para hindi "click"
    this.rainGainNode.gain.setTargetAtTime(this.rainLevel, ctx.currentTime, 0.3);
  }

  // --- 2C: horn ------------------------------------------------------------
  /**
   * Patugtog ang bugtong: 440 Hz -> 550 Hz, dalawang beep ng 0.15 s,
   * may 0.1 s na agwat. May 1 s cooldown.
   * @returns {boolean} true kung napatugtog, false kung nasa cooldown
   */
  horn() {
    if (!this.enabled || !this.active) return false;
    const ctx = this.ensure();
    if (!ctx) return false;
    this.resume();
    if (this.ctx.currentTime < this.hornCooldown) return false;
    this.hornCooldown = this.ctx.currentTime + 1.0;    // 1 s cooldown (spec)
    const t0 = this.ctx.currentTime;
    // beep 1: 440 Hz
    this.#beep(440, t0, 0.15);
    // beep 2: 550 Hz, 0.1 s GAP pagkatapos ng una
    this.#beep(550, t0 + 0.15 + 0.1, 0.15);
    return true;
  }

  #beep(freq, at, dur) {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    osc.type = 'square';                 // matap ang bugtong
    osc.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(0.25, at + 0.01);   // quick attack
    g.gain.setValueAtTime(0.25, at + dur - 0.02);
    g.gain.linearRampToValueAtTime(0, at + dur);        // quick release
    osc.connect(g).connect(this.master);
    this.#track(osc, g);
    osc.start(at);
    osc.stop(at + dur + 0.02);
  }
}

export function drivingSoundState(speed, input = {}) {
  const signed = Number.isFinite(speed) ? speed : 0;
  const magnitude = Math.min(60, Math.abs(signed));
  const braking = input.handbrake || (input.backward && signed > 0.5);
  const throttle = !braking && (input.forward || (input.backward && signed <= 0.5)) ? 1 : 0;
  // Simulated gear bands keep engine pitch in a comfortable range.
  const gearSpeed = magnitude % 11;
  return { speed: magnitude, throttle, frequency: 38 + gearSpeed * 4 + throttle * 25,
    engineGain: 0.07 + throttle * 0.09 + magnitude / 60 * 0.03,
    roadGain: Math.min(0.12, magnitude / 60 * 0.12),
    brakeGain: braking && magnitude > 1 ? Math.min(0.18, magnitude / 35 * (input.handbrake ? 0.18 : 0.09)) : 0 };
}
