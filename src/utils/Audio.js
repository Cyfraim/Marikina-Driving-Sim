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
  }

  /** Ang AudioContext ay kailangang gawin sa user gesture (browser rule). */
  ensure() {
    if (this.ctx) return this.ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { this.enabled = false; return null; }
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.5;
    this.master.connect(this.ctx.destination);
    this.#buildRain();
    return this.ctx;
  }

  resume() {
    const ctx = this.ensure();
    if (ctx && ctx.state === 'suspended') ctx.resume();
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
    src.buffer = buf;
    src.loop = true;                        // <-- LOOPING
    const g = ctx.createGain();
    g.gain.value = 0;                       // 0 = tahimik sa simula
    // light lowpass para hindi sobrang dinagat ang tunog
    const filt = ctx.createBiquadFilter();
    filt.type = 'lowpass';
    filt.frequency.value = 1400;
    src.connect(filt).connect(g).connect(this.master);
    src.start();
    this.rainGainNode = g;
  }

  /** Itakda ang lakas ng tunog ng ulan (spec: 0.15 light, 0.4 heavy, 0 clear). */
  setRainGain(v) {
    if (!this.enabled) return;
    const ctx = this.ensure();
    if (!ctx || !this.rainGainNode) return;
    // smooth ang pagbabago para hindi "click"
    this.rainGainNode.gain.setTargetAtTime(v, ctx.currentTime, 0.3);
  }

  // --- 2C: horn ------------------------------------------------------------
  /**
   * Patugtog ang bugtong: 440 Hz -> 550 Hz, dalawang beep ng 0.15 s,
   * may 0.1 s na agwat. May 1 s cooldown.
   * @returns {boolean} true kung napatugtog, false kung nasa cooldown
   */
  horn() {
    if (!this.enabled) return false;
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
    osc.start(at);
    osc.stop(at + dur + 0.02);
  }
}
