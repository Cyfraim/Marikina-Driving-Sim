// Priority 1 regressions: real simulation methods, no WebGL required.
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { applyRoadConfinement, KERB_SOFT, KERB_HARD } from '../src/utils/boundary.js';
import { Vehicle } from '../src/game/Vehicle.js';
import { NPCManager } from '../src/npcs/NPCVehicle.js';
import { Input } from '../src/game/Input.js';
import { Game } from '../src/game/Game.js';
import { Menu } from '../src/ui/Menu.js';
import { Roads } from '../src/world/Roads.js';
import { ROAD_LINES, sampleRoad } from '../src/utils/roadLayout.js';

function check(name, fn) {
  fn();
  console.log(`PASS  ${name}`);
}

check('1A: soft push is inward and signed drag decelerates both directions', () => {
  for (const angle of [0, Math.PI / 2, Math.PI, -Math.PI / 2, 0.7]) {
    const nx = Math.cos(angle), nz = Math.sin(angle);
    for (const over of [KERB_SOFT + 0.1, 3, KERB_HARD - 0.1]) {
      const confinement = { queryAll: () => ({ over, nx, nz, px: 0, pz: 0 }) };
      const r = applyRoadConfinement(confinement, { x: nx * 10, z: nz * 10 }, 1 / 60);
      assert.ok(r.pushX * nx + r.pushZ * nz < 0);
      assert.ok(r.drag < 0);
      for (const speed of [10, -10]) {
        const v = new Vehicle(new THREE.Scene());
        v.build();
        v.speed = speed;
        v.setConfinement(confinement);
        v.update(1 / 60, {});
        assert.ok(Math.abs(v.speed) < Math.abs(speed));
      }
    }
  }
  const stranded = applyRoadConfinement({ queryAll: () => null }, { x: 10, z: 0 }, 1 / 60, { x: 0, z: 0 });
  assert.ok(stranded.pushX < 0 && stranded.drag < 0);
});

const npc = new NPCManager(new THREE.Scene(), { tricycle: 1, jeepney: 0 });
check('1B: reverse distance decreases, position matches t, heading opposes forward', () => {
  const v = npc.vehicles[0];
  const road = ROAD_LINES.find((r) => r.len > 150 && r.i === ROAD_LINES.indexOf(r));
  v.ri = road.i;
  v.t = road.len / 2;
  v.dir = 1;
  v.sync();
  const forward = new THREE.Vector2(v.forwardX, v.forwardZ);
  v.dir = -1;
  v.sync();
  assert.ok(forward.dot(new THREE.Vector2(v.forwardX, v.forwardZ)) < -0.999999);
  for (let i = 0; i < 60; i++) {
    const before = v.t;
    const x = v.x, z = v.z;
    const fx = v.forwardX, fz = v.forwardZ;
    v.update(1 / 60, { x: x + 100, z: z + 100 });
    assert.ok(v.t < before);
    const expected = sampleRoad(v.ri, v.t, road.half * 0.35 * v.dir);
    assert.ok(Math.hypot(v.x - expected.x, v.z - expected.z) < 1e-8);
    assert.ok((v.x - x) * fx + (v.z - z) * fz > 0);
  }
});

class Target {
  constructor() { this.handlers = new Map(); }
  addEventListener(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type).add(fn);
  }
  removeEventListener(type, fn) { this.handlers.get(type)?.delete(fn); }
  emit(type, e = {}) { for (const fn of this.handlers.get(type) || []) fn(e); }
  get count() { return [...this.handlers.values()].reduce((n, list) => n + list.size, 0); }
}
const win = new Target();
const doc = new Target();
const elements = new Map();
doc.hidden = false;
doc.getElementById = (id) => {
  if (!elements.has(id)) elements.set(id, new Target());
  return elements.get(id);
};
globalThis.window = win;
globalThis.document = doc;

check('1C: listeners clean up, setup is idempotent, blur/hidden/touchcancel release keys', () => {
  const input = new Input();
  input.setup();
  const count = win.count + doc.count + [...elements.values()].reduce((n, e) => n + e.count, 0);
  input.setup();
  assert.equal(win.count + doc.count + [...elements.values()].reduce((n, e) => n + e.count, 0), count);
  for (const code of ['KeyW', 'KeyS', 'KeyA', 'KeyD', 'Space', 'KeyQ', 'KeyE', 'KeyH', 'KeyF', 'KeyR', 'KeyV', 'KeyM']) {
    win.emit('keydown', { code, preventDefault() {} });
  }
  win.emit('blur');
  assert.ok(Object.values(input.keys).every((pressed) => pressed === false));
  for (const prop of ['forward', 'backward', 'left', 'right', 'handbrake', 'lookLeft', 'lookRight', 'horn', 'weatherToggle', 'reset', 'cameraToggle', 'satelliteToggle']) assert.equal(input[prop], false);
  win.emit('keydown', { code: 'KeyW' });
  doc.hidden = true;
  doc.emit('visibilitychange');
  assert.equal(input.forward, false);
  const gas = elements.get('touch-gas');
  gas.emit('touchstart', { preventDefault() {} });
  assert.equal(input.forward, true);
  gas.emit('touchcancel', { preventDefault() {} });
  assert.equal(input.forward, false);
  input.destroy();
  assert.equal(win.count + doc.count + [...elements.values()].reduce((n, e) => n + e.count, 0), 0);
  win.emit('keydown', { code: 'KeyW' });
  assert.equal(input.forward, false);
  input.setup();
  assert.equal(win.count + doc.count + [...elements.values()].reduce((n, e) => n + e.count, 0), count);
  input.destroy();
});

function frameGame() {
  const game = new Game();
  game.scene = new THREE.Scene();
  game.clock = { getDelta: () => 1 / 60, elapsedTime: 0 };
  game.cameraController = { camera: {}, update() {} };
  game.renderer = { render() {} };
  game.vehicle = { position: { x: 0, z: 0 }, update() {}, setNpcColliders(boxes) { this.boxes = boxes; } };
  game.updateTiles = () => {};
  game.hud = { update() {} };
  game.minimap = { update() {} };
  game.showError = () => { game.errors = (game.errors || 0) + 1; };
  return game;
}

check('1D: successful/paused frames schedule once; failed update/render schedules nothing', () => {
  let scheduled = 0;
  globalThis.requestAnimationFrame = () => { scheduled++; };
  const game = frameGame();
  game.animate();
  assert.equal(scheduled, 1);
  game.isPaused = false;
  game.animate();
  assert.equal(scheduled, 2);
  const originalError = console.error;
  console.error = () => {};
  try {
    game.vehicle.update = () => { throw new Error('test update failure'); };
    game.animate();
    assert.equal(scheduled, 2);
    assert.equal(game.errors, 1);
    game.vehicle.update = () => {};
    game.renderer.render = () => { throw new Error('test render failure'); };
    game.animate();
    assert.equal(scheduled, 2);
    assert.equal(game.errors, 2);
  } finally { console.error = originalError; }
});

check('1E: menu disables traffic immediately and frames skip NPC updates until re-enabled', () => {
  const game = frameGame();
  game.npcManager = npc;
  new Menu(game);
  npc.colliderBoxes.push(new THREE.Box3());
  elements.get('setting-traffic').emit('change', { target: { value: 'off' } });
  assert.equal(npc.group.visible, false);
  assert.equal(npc.activeCount, 0);
  assert.equal(npc.colliderBoxes.length, 0);
  assert.equal(game.vehicle.boxes.length, 0);
  const before = npc.vehicles[0].t;
  npc.update(1, game.vehicle.position);
  assert.equal(npc.vehicles[0].t, before);
  let updates = 0;
  const originalUpdate = npc.update.bind(npc);
  npc.update = (...args) => { updates++; return originalUpdate(...args); };
  game.isPaused = false;
  game.animate();
  assert.equal(updates, 0);
  elements.get('setting-traffic').emit('change', { target: { value: 'on' } });
  assert.equal(npc.group.visible, true);
  game.animate();
  assert.equal(updates, 1);
});

check('1E: streamed road materials inherit rain and return to dry', () => {
  const game = frameGame();
  const roads = new Roads(game.scene);
  game.map = { roads };
  const p = ROAD_LINES[0].pts[0];
  const bounds = { minX: p.x - 20, maxX: p.x + 20, minZ: p.z - 20, maxZ: p.z + 20 };
  game.setWetness(0x666666);
  const tile = new THREE.Group();
  roads.build(bounds, tile);
  game.scene.add(tile);
  let materials = 0;
  tile.traverse((o) => {
    if (!o.material?.__isRoad) return;
    materials++;
    assert.ok(Math.abs(o.material.roughness - 0.4) < 1e-9);
  });
  assert.ok(materials > 0);
  game.setWetness(0x111111);
  tile.traverse((o) => {
    if (o.material?.__isRoad) assert.equal(o.material.roughness, 0.95);
  });
  const nextTile = new THREE.Group();
  roads.build(bounds, nextTile);
  nextTile.traverse((o) => {
    if (o.material?.__isRoad) assert.equal(o.material.roughness, 0.95);
  });
});

console.log('ALL PRIORITY 1 CHECKS PASSED');