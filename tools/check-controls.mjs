// ---------------------------------------------------------------------------
// check-controls.mjs - FIX 1 validation: W/S/A/D must not be inverted, and
// the chase camera must sit BEHIND the car (not mirrored in front).
// Usage: node tools/check-controls.mjs
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { Vehicle } from '../src/game/Vehicle.js';
import { CameraController } from '../src/game/Camera.js';

let fail = 0;
const check = (name, cond, detail = '') => {
  if (!cond) fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' -> ' + detail : ''}`);
};

const scene = new THREE.Scene();

console.log('='.repeat(72));
console.log('CONTROLS + CAMERA AUDIT (FIX 1)');
console.log('='.repeat(72));

const FWD = new THREE.Vector3(0, 0, 1);
const RIGHT_VEC = new THREE.Vector3().crossVectors(FWD, new THREE.Vector3(0, 1, 0));

function turnTest(left, right) {
  const v = new Vehicle(scene);
  v.build(); v.reset();
  v.position.set(0, 0, 0);
  v.rotation = 0;
  v.speed = 10;
  const f0 = new THREE.Vector3(Math.sin(v.rotation), 0, Math.cos(v.rotation));
  const rv = new THREE.Vector3().crossVectors(f0, new THREE.Vector3(0, 1, 0));
  const input = { forward: true, backward: false, left, right, handbrake: false };
  for (let i = 0; i < 30; i++) v.update(1 / 60, input);
  const f1 = new THREE.Vector3(Math.sin(v.rotation), 0, Math.cos(v.rotation));
  // positive = turned toward the camera's right
  return new THREE.Vector3().subVectors(f1, f0).dot(rv);
}

const a = turnTest(true, false);
const d = turnTest(false, true);
console.log(`\n  A / ArrowLeft  -> lateral ${a.toFixed(2)} (negative = LEFT)`);
console.log(`  D / ArrowRight -> lateral ${d.toFixed(2)} (positive = RIGHT)\n`);
check('A turns LEFT', a < 0, `lateral ${a.toFixed(2)}`);
check('D turns RIGHT', d > 0, `lateral ${d.toFixed(2)}`);

// --- W / S ---
function driveTest(forward, backward) {
  const v = new Vehicle(scene);
  v.build(); v.reset();
  v.position.set(0, 0, 0);
  v.rotation = 0; v.speed = 0;
  for (let i = 0; i < 30; i++) {
    v.update(1 / 60, { forward, backward, left: false, right: false, handbrake: false });
  }
  return { moved: v.position.clone(), speed: v.speed };
}
const w = driveTest(true, false);
const s = driveTest(false, true);
const wDot = w.moved.dot(FWD);
const sDot = s.moved.dot(FWD);
console.log(`  W -> speed ${w.speed.toFixed(1)}, moved along forward = ${wDot.toFixed(2)}`);
console.log(`  S -> speed ${s.speed.toFixed(1)}, moved along forward = ${sDot.toFixed(2)}\n`);
check('W drives FORWARD', wDot > 0 && w.speed > 0, `${wDot.toFixed(2)}`);
check('S drives REVERSE', sDot < 0 && s.speed < 0, `${sDot.toFixed(2)}`);

// --- camera behind, not mirrored ---
globalThis.document = {
  addEventListener() {},
  createElement: () => ({ style: { cssText: '' }, remove() {} }),
  getElementById: () => null,
};
const cv = new Vehicle(scene);
cv.build(); cv.reset();
const cam = new CameraController(new THREE.PerspectiveCamera(60, 1.6, 0.1, 1000), cv);
for (let i = 0; i < 200; i++) cam.update(1 / 60, null);
const fcv = new THREE.Vector3(Math.sin(cv.rotation), 0, Math.cos(cv.rotation));
const toCam = new THREE.Vector3().subVectors(cam.camera.position, cv.group.position);
const camDot = toCam.clone().setY(0).normalize().dot(fcv);
console.log(`  third-person camera dotForward = ${camDot.toFixed(2)} (negative = behind)\n`);
check('chase camera is BEHIND the car', camDot < -0.5, `${camDot.toFixed(2)}`);

console.log('\n' + '='.repeat(72));
console.log(fail === 0 ? 'ALL CONTROLS CORRECT' : `${fail} CONTROL(S) WRONG`);
process.exit(fail === 0 ? 0 : 1);
