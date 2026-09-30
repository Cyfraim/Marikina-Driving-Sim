// ---------------------------------------------------------------------------
// check-phase1.mjs - PHASE 1 (1A car, 1B NPC vehicles, 1C pedestrians)
//
// HEADLESS: nangangailangan ng THREE (naka-import sa browser) pero hindi
// nangangailangan ng WebGL - ang Scene ay gumagana nang walang renderer.
// Kaya natatala namin ang aktuwal na posisyon/motion ng NPC at pedestrian sa
// ilang simulation step.
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { NPCManager } from '../src/npcs/NPCVehicle.js';
import { PedestrianManager } from '../src/npcs/Pedestrian.js';
import { Vehicle } from '../src/game/Vehicle.js';
import { ROAD_LINES, distToPolyline } from '../src/utils/roadLayout.js';

let fails = 0;
const check = (name, cond, detail = '') => {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (detail ? ' -> ' + detail : ''));
  if (!cond) fails++;
};

const scene = new THREE.Scene();

// ===========================================================================
console.log('=== 1A - CAR MODEL ===');
{
  const v = new Vehicle(scene);
  v.build();
  let meshes = 0, tris = 0;
  const matColors = new Set();
  v.group.traverse((o) => {
    if (!o.isMesh) return;
    meshes++;
    const g = o.geometry;
    tris += g.index ? g.index.count / 3 : g.attributes.position.count / 3;
    if (o.material && o.material.color) matColors.add(o.material.color.getHex());
  });
  check('car has many meshes (not a plain box)', meshes >= 12, meshes + ' meshes');
  check('car is low-poly (< 1,200 triangles)', tris < 1200, tris + ' triangles');

  // tapered body: the lower body should be wider at the bottom than the top
  const lower = v.group.children.find((c) => c.isMesh);
  const p = lower.geometry.attributes.position;
  let minX = Infinity, maxX = -Infinity;
  let bottomSpan = null, topSpan = null;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i);
    if (y < -0.2) {
      // bottom ring
      bottomSpan = bottomSpan === null ? 1 : bottomSpan;
      if (Math.abs(x) > 0.9) bottomSpan = 2;
    }
    if (Math.abs(x) > maxX) maxX = x;
    if (Math.abs(x) > minX) minX = -minX;
  }
  const widestBottom = Math.max(...[...Array(p.count).keys()]
    .filter((i) => p.getY(i) < -0.2).map((i) => Math.abs(p.getX(i))));
  const widestTop = Math.max(...[...Array(p.count).keys()]
    .filter((i) => p.getY(i) > 0.2).map((i) => Math.abs(p.getX(i))));
  check('body is TAPERED (wider at the bottom)', widestBottom > widestTop,
    'bottom=' + widestBottom.toFixed(2) + ' top=' + widestTop.toFixed(2));

  // 4 wheels, each with a hubcap child
  check('4 wheel pivots', v.wheelPivots.length === 4, v.wheelPivots.length + ' pivots');
  check('4 wheel meshes', v.wheelMeshes.length === 4, v.wheelMeshes.length + ' meshes');
  const hubcaps = v.wheelMeshes.filter((w) => w.children.some((c) => c.isMesh));
  check('every wheel has a hubcap disc', hubcaps.length === 4, hubcaps.length + ' hubcaps');
  check('wheels are rotateZ PI/2 (laid on their side)',
    v.wheelMeshes.every((w) => Math.abs(w.rotation.z - Math.PI / 2) < 1e-6));

  // car colour: must be one of the 5 spec colours
  const ALLOWED = new Set([0xcc2200, 0xf0f0f0, 0xaaaaaa, 0x1a4fa0, 0xddcc00]);
  check('car colour is one of the 5 spec colours', ALLOWED.has(v.bodyColor),
    '#' + v.bodyColor.toString(16));

  // randomised colour over many respawns
  const seen = new Set();
  for (let i = 0; i < 60; i++) seen.add(v.randomizeColor());
  check('randomizeColor() produces multiple colours', seen.size >= 3,
    seen.size + ' distinct colours from 60 spawns');
  check('all randomised colours are in the spec list',
    [...seen].every((c) => ALLOWED.has(c)), [...seen].map((c) => '#' + c.toString(16)).join(' '));

  // emissive head/tail lights
  let emissive = [];
  v.group.traverse((o) => {
    if (o.isMesh && o.material && o.material.emissive &&
        o.material.emissive.getHex() !== 0x000000) {
      emissive.push(o.material.emissive.getHex());
    }
  });
  check('headlights are emissive 0xffffcc', emissive.includes(0xffffcc));
  check('taillights are emissive 0xff2200', emissive.includes(0xff2200));

  // side mirrors
  const mirrorMat = v.group.children.filter((c) => c.isMesh &&
    c.material && c.material.color.getHex() === 0x2a2a2a);
  check('2 side mirrors', mirrorMat.length === 2, mirrorMat.length + ' mirrors');

  // wheel spin proportional to speed
  const before = v.wheelMeshes[0].rotation.x;
  v.speed = 20;
  v.steering = 0.4;
  v.update(1 / 60, { forward: false, backward: false, left: false, right: false, handbrake: false });
  const after = v.wheelMeshes[0].rotation.x;
  check('wheels SPIN when the car moves', Math.abs(after - before) > 0.01,
    'dRotX=' + (after - before).toFixed(3) + ' rad/frame');
  check('front wheels STEER with the steering angle',
    Math.abs(v.wheelPivots[0].rotation.y - v.steering) < 1e-6 &&
    Math.abs(v.wheelPivots[1].rotation.y - v.steering) < 1e-6,
    'front pivots=' + v.wheelPivots[0].rotation.y.toFixed(3));
  check('REAR wheels do NOT steer',
    v.wheelPivots[2].rotation.y === 0 && v.wheelPivots[3].rotation.y === 0,
    'rear pivots=' + v.wheelPivots[2].rotation.y);
}

// ===========================================================================
console.log('\n=== 1B - NPC VEHICLES (driving) ===');
const npc = new NPCManager(scene);
{
  check('23 NPC spawned (15 tricycle + 8 jeepney)', npc.count === 23,
    npc.count + ' total, ' + npc.trikeCount + ' tricycle, ' + npc.jeepCount + ' jeepney');
  check('exactly 15 tricycles', npc.trikeCount === 15, String(npc.trikeCount));
  check('exactly 8 jeepneys', npc.jeepCount === 8, String(npc.jeepCount));

  let ntris = 0, nmesh = 0;
  npc.group.traverse((o) => {
    if (!o.isMesh) return;
    nmesh++;
    const g = o.geometry;
    ntris += g.index ? g.index.count / 3 : g.attributes.position.count / 3;
  });
  check('NPC geometry is cheap (< 12k triangles)', ntris < 12000,
    ntris.toLocaleString() + ' triangles in ' + nmesh + ' meshes');
  check('NPC are spread over different roads',
    new Set(npc.vehicles.map((v) => v.ri)).size >= 20,
    new Set(npc.vehicles.map((v) => v.ri)).size + ' distinct roads');

  // --- they must MOVE along their road ---
  const player = { x: npc.vehicles[0].x, z: npc.vehicles[0].z };
  const start = npc.vehicles.map((v) => ({ x: v.x, z: v.z }));
  for (let i = 0; i < 120; i++) npc.update(1 / 60, player, 1);
  const moved = npc.vehicles.filter((v, i) =>
    Math.hypot(v.x - start[i].x, v.z - start[i].z) > 1).length;

  // --- culling at 500 m ---
  npc.update(1 / 60, { x: 20000, z: 20000 }, 1);
  check('NPC culled beyond 500 m', npc.activeCount === 0,
    npc.activeCount + ' active at 28 km away');
  check('culled NPC are hidden', npc.vehicles.every((v) => v.group.visible === false));

  // --- head-on: player 3 m in front of an NPC -> it must stop for 3 s ---
  // FIX: gumamit ng SANG BILOG na NPC + FRESH state. Ang dating pagsubok ay
  // nagamit ng vehicles[0] AFTER 120 frames ng pagtakbo, kaya maaaring
  // NAKAHINTO na siya (waitTimer < 3) - kaya nag-fail ang assertion.
  const n0 = npc.vehicles[22];
  n0.waitTimer = 0;
  n0.speed = n0.cruise;
  const ahead = { x: n0.x + n0.forwardX * 3, z: n0.z + n0.forwardZ * 3 };
  n0.update(1 / 60, ahead, 1);
  check('head-on: NPC brakes when player is 3 m ahead', n0.speed === 0 && n0.waitTimer > 2.9,
    'speed=' + n0.speed.toFixed(2) + ' wait=' + n0.waitTimer.toFixed(2) + 's');
  for (let i = 0; i < 60; i++) n0.update(1 / 60, ahead, 1);
  check('head-on: NPC stays stopped for ~3 s', n0.speed === 0,
    'after 1 s more, speed=' + n0.speed.toFixed(2));
  for (let i = 0; i < 140; i++) n0.update(1 / 60, { x: 1e6, z: 1e6 }, 1);
  // FIX: ang dating assertion ay `n0.speed > 1` - pero habang nakapark ang
  // player sa 3 m NGUNOAN, tama pa ring nagta-trigger ang head-on (player is
  // still in front). Kailangan munang LALAYOIN ang player para makita ang
  // muling paggalaw.
  n0.update(1 / 60, { x: 1e6, z: 1e6 }, 1);
  check('head-on: timer expires after 3 s', n0.waitTimer === 0,
    'waitTimer=' + n0.waitTimer.toFixed(2));
  for (let i = 0; i < 30; i++) n0.update(1 / 60, { x: 1e6, z: 1e6 }, 1);
  // ilapit muli ang player - dapat naka-drive na ulit ang NPC.
  // NOTE: patnayan ng ng ilang frame dahil ACCEL = 3 m/s^2 - mula 0, kailangan
  // ng ~2 s para maabot ang cruise speed. Isang frame lang = 0.2 km/h.
  const clear = { x: n0.x + n0.forwardX * 200, z: n0.z + n0.forwardZ * 200 };
  for (let i = 0; i < 150; i++) n0.update(1 / 60, clear, 1);
  check('head-on: NPC resumes driving once the player moves away', n0.speed > 1,
    'speed=' + (n0.speed * 3.6).toFixed(1) + ' km/h, wait=' + n0.waitTimer.toFixed(2));

  // --- colliders for the player ---
  const boxes = npc.update(1 / 60, { x: n0.x, z: n0.z }, 1);
  check('NPC produce AABB colliders for the player', boxes.length > 0,
    boxes.length + ' collider boxes');
  check('colliders are Box3', boxes.every((b) => b.isBox3));
}

// ===========================================================================
console.log('\n=== 1C - PEDESTRIANS ===');
const ped = new PedestrianManager(scene);
{
  check('30 pedestrians spawned', ped.count === 30, ped.count + ' pedestrians');
  let ptri = 0;
  ped.group.traverse((o) => {
    if (!o.isMesh) return;
    const g = o.geometry;
    ptri += g.index ? g.index.count / 3 : g.attributes.position.count / 3;
  });
  check('pedestrian geometry is cheap (< 6k triangles)', ptri < 6000,
    ptri.toLocaleString() + ' triangles');

  const p0 = ped.pedestrians[0];
  const before = { x: p0.x, z: p0.z };
  const player = { x: p0.x, z: p0.z };
  for (let i = 0; i < 60; i++) ped.update(1 / 60, player);
  check('pedestrians WALK', Math.hypot(p0.x - before.x, p0.z - before.z) > 0.5,
    'moved ' + Math.hypot(p0.x - before.x, p0.z - before.z).toFixed(2) + ' m in 1 s');

  const spd = ped.pedestrians.map((p) => p.speed);
  check('walk speed within 1.2-1.8 m/s', spd.every((s) => s >= 1.2 && s <= 1.8),
    Math.min(...spd).toFixed(2) + '-' + Math.max(...spd).toFixed(2) + ' m/s');

  const a0 = p0.arms[0].rotation.x, l0 = p0.legs[0].rotation.x;
  for (let i = 0; i < 30; i++) ped.update(1 / 60, player);
  check('arms SWING (sine animation)', Math.abs(p0.arms[0].rotation.x - a0) > 0.01,
    'dArm=' + (p0.arms[0].rotation.x - a0).toFixed(3) + ' rad');
  check('legs SWING', Math.abs(p0.legs[0].rotation.x - l0) > 0.01);

  ped.update(1 / 60, { x: 1e6, z: 1e6 });
  check('pedestrians culled beyond 200 m', ped.activeCount === 0, ped.activeCount + ' active');
  check('culled pedestrians are hidden',
    ped.pedestrians.every((p) => p.group.visible === false));

  // patrol: reverse at the end of the road
  const p1 = ped.pedestrians[0];
  const r0 = p1.road;
  p1.t = r0.len + 1;                     // force past the end
  const dirBefore = p1.dir;
  p1.update(1 / 60, { x: p1.x, z: p1.z });
  check('pedestrian TURNS AROUND at the end of the road', p1.dir === -dirBefore,
    'dir ' + dirBefore + ' -> ' + p1.dir);
  check('pedestrian stays within the road length', p1.t <= r0.len + 0.01, 't=' + p1.t.toFixed(1));
}

console.log('\n' + (fails === 0 ? 'ALL PHASE 1 TESTS PASSED' : fails + ' TEST(S) FAILED'));
if (fails) process.exit(1);