// Headless test ng camera: dapat NAKA-LIKOD ng kotse ang third-person camera.
// (Ang dating code ay naka-camera sa HARAP - dito nito naayos.)
globalThis.document = {
  addEventListener: () => {},
  getElementById: () => ({ appendChild: () => {} }),
  createElement: () => ({ style: {}, textContent: '', remove: () => {} }),
};
const THREE = await import('three');
const { CameraController } = await import('../src/game/Camera.js');

const cam = new THREE.PerspectiveCamera(60, 1.6, 0.1, 3000);
const vehicle = {
  group: new THREE.Object3D(),
  rotation: 0,
  position: new THREE.Vector3(),
};
vehicle.group.position.set(100, 0, 50);
const cc = new CameraController(cam, vehicle);
const NO_INPUT = { lookLeft: false, lookRight: false };

let failures = 0;
function check(label, cond, extra) {
  console.log((cond ? 'PASS' : 'FAIL') + ' - ' + label + (extra ? ' ' + extra : ''));
  if (!cond) failures++;
}

// 1) Third person: kamera sa LIKOD ng kotse (car faces +Z, rot 0)
for (let i = 0; i < 60; i++) cc.update(1 / 60, NO_INPUT);
const fwd = new THREE.Vector3(Math.sin(0), 0, Math.cos(0));
const toCam = new THREE.Vector3().subVectors(cam.position, vehicle.group.position);
check('third-person camera is BEHIND the car', toCam.dot(fwd) < 0,
  '(dot=' + toCam.dot(fwd).toFixed(2) + ')');
check('camera trails ~9m back', Math.abs(toCam.length() - 9.9) < 0.6,
  '(' + toCam.length().toFixed(2) + 'm)');

// 2) pagbalik ng kotse: sinusundan pa rin ng kamera
vehicle.rotation = Math.PI / 2;
vehicle.group.rotation.y = Math.PI / 2;
for (let i = 0; i < 120; i++) cc.update(1 / 60, NO_INPUT);
const fwd2 = new THREE.Vector3(Math.sin(Math.PI / 2), 0, Math.cos(Math.PI / 2));
const toCam2 = new THREE.Vector3().subVectors(cam.position, vehicle.group.position);
check('camera follows the turn (stays behind)', toCam2.dot(fwd2) < 0,
  '(dot=' + toCam2.dot(fwd2).toFixed(2) + ')');

// 3) V toggle -> first person, mata sa loob ng cabin
cc.toggleMode();
cc.update(1 / 60, NO_INPUT);
check('V switches to first person', cc.mode === 'first');
const eye = new THREE.Vector3().subVectors(cam.position, vehicle.group.position);
const horiz = Math.hypot(eye.x, eye.z);
check('first-person eye inside the car (horizontal < 1m)', horiz < 1,
  '(' + horiz.toFixed(2) + 'm)');
check('first-person eye height ~1.45m', eye.y > 1.2 && eye.y < 1.7,
  '(' + eye.y.toFixed(2) + 'm)');

// 4) Q/E look-around
const look0 = new THREE.Vector3().subVectors(cc.look, cc.pos).normalize();
for (let i = 0; i < 10; i++) cc.update(1 / 60, { lookLeft: true, lookRight: false });
const look1 = new THREE.Vector3().subVectors(cc.look, cc.pos).normalize();
check('Q rotates the view', look0.dot(look1) < 0.999,
  '(angle=' + (Math.acos(Math.min(1, look0.dot(look1))) * 57.3).toFixed(1) + ' deg)');

// 5) balik sa third person
cc.toggleMode();
check('V toggles back to third person', cc.mode === 'third');

console.log(failures === 0 ? 'ALL CAMERA CHECKS PASS' : failures + ' CHECK(S) FAILED');
process.exit(failures === 0 ? 0 : 1);
