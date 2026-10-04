import assert from 'node:assert/strict';
import { AudioFX, drivingSoundState } from '../src/utils/Audio.js';

class Param {
  constructor() { this.value = 0; }
  setTargetAtTime(v) { this.value = v; }
  setValueAtTime(v) { this.value = v; }
  linearRampToValueAtTime(v) { this.value = v; }
  exponentialRampToValueAtTime(v) { this.value = v; }
}
class Node {
  constructor() { this.gain = new Param(); this.frequency = new Param(); this.Q = new Param(); }
  connect(node) { return node; }
  disconnect() { this.disconnected = true; }
  start() { this.started = true; }
  stop() { this.stopped = true; }
}
class Context {
  constructor() { this.sampleRate = 100; this.currentTime = 0; this.state = 'suspended'; this.destination = new Node(); this.created = []; }
  node() { const node = new Node(); this.created.push(node); return node; }
  createGain() { return this.node(); }
  createOscillator() { return this.node(); }
  createBiquadFilter() { return this.node(); }
  createBufferSource() { return this.node(); }
  createBuffer(channels, length) { return { getChannelData: () => new Float32Array(length) }; }
  async resume() { this.state = 'running'; }
  async close() { this.state = 'closed'; }
}
const oldWindow = globalThis.window;
globalThis.window = { AudioContext: Context };
try {
  const audio = new AudioFX();
  audio.setRainGain(.15);
  audio.update({ speed: 10 }, { forward: true });
  assert.equal(audio.ctx, null, 'frame/weather updates must not unlock audio');
  audio.setActive(true); audio.resume();
  const ctx = audio.ctx;
  assert.equal(ctx.state, 'running');
  assert.equal(audio.rainGainNode.gain.value, .15);
  audio.update({ speed: 0 }, {});
  const idle = audio.engine.engine.frequency.value;
  audio.update({ speed: 5 }, { forward: true });
  assert.ok(audio.engine.engine.frequency.value > idle);
  assert.ok(audio.road.gain.gain.value > 0);
  const count = ctx.created.length;
  for (let i = 0; i < 100; i++) audio.update({ speed: 15 }, { backward: true });
  assert.equal(ctx.created.length, count, 'no new nodes per frame');
  assert.ok(audio.brake.gain.gain.value > 0);
  audio.update({ speed: -5 }, { backward: true });
  assert.equal(audio.brake.gain.gain.value, 0, 'reverse acceleration is not braking');
  assert.equal(drivingSoundState(0, { handbrake: true }).brakeGain, 0);
  assert.ok(drivingSoundState(15, { handbrake: true }).brakeGain > drivingSoundState(15, { backward: true }).brakeGain);
  assert.equal(audio.horn(), true);
  assert.equal(audio.horn(), false, 'horn cooldown');
  assert.equal(audio.impact(10), true);
  assert.equal(audio.impact(10), false, 'impact cooldown');
  audio.setActive(false);
  assert.equal(audio.master.gain.value, 0);
  assert.equal(audio.horn(), false);
  audio.setVolume(2); audio.setActive(true);
  assert.equal(audio.master.gain.value, 1);
  audio.setVolume(0);
  assert.equal(audio.master.gain.value, 0);
  const nodes = [...audio.nodes];
  audio.destroy(); audio.destroy();
  assert.equal(ctx.state, 'closed');
  assert.ok(nodes.every(node => node.disconnected));
  assert.equal(audio.sources.size, 0);
  assert.equal(audio.ensure(), null);
  console.log('PASS engine/gas, road noise, brake/reverse distinction, handbrake, horn and impact cooldowns, volume, pause mute, allocation stability, and disposal.');
  globalThis.window = {};
  assert.equal(new AudioFX().ensure(), null);
  console.log('PASS unsupported audio gracefully disables SFX.');
} finally { globalThis.window = oldWindow; }