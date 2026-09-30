// ---------------------------------------------------------------------------
// Camera.js - Third person (chase) at first person, pinipindutan ang V
//
// THIRD: naka-lalabas ang kamera sa likod ng kotse, sumasabay sa paggawaon.
// FIRST: nasa loob ng cabin, libre ang paningin gamit ang mouse (drag)
//        o Q/E keys.
//
// Paalala: dating bersyon ay naka-camera sa HARAP ng kotse - naayos na dito.
// Ang heading ng kotse ay (sin(rot), cos(rot)) - siya ang "forward".
// ---------------------------------------------------------------------------
import * as THREE from 'three';

const MODES = ['third', 'first'];
const MODE_LABELS = { third: 'Third Person', first: 'First Person' };

export class CameraController {
  constructor(camera, vehicle) {
    this.camera = camera;
    this.vehicle = vehicle;
    this.modeIndex = 0; // 0 = third, 1 = first
    this.pos = new THREE.Vector3();
    this.look = new THREE.Vector3();
    this.lookYaw = 0;   // first-person: extra yaw (radians)
    this.lookPitch = 0;
    this.dragging = false;
    this.lastMouse = { x: 0, y: 0 };
    this.setupMouseControls();
  }

  get mode() { return MODES[this.modeIndex]; }

  setupMouseControls() {
    // Drag para mag-look around (first person)
    document.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      this.dragging = true;
      this.lastMouse.x = e.clientX;
      this.lastMouse.y = e.clientY;
    });
    document.addEventListener('mouseup', () => { this.dragging = false; });
    document.addEventListener('mousemove', (e) => {
      if (!this.dragging) return;
      const dx = e.clientX - this.lastMouse.x;
      const dy = e.clientY - this.lastMouse.y;
      this.lastMouse.x = e.clientX;
      this.lastMouse.y = e.clientY;
      this.lookYaw -= dx * 0.005;
      this.lookPitch = Math.max(-0.6, Math.min(0.6, this.lookPitch - dy * 0.004));
    });
  }

  // V key: third <-> first
  toggleMode() {
    this.modeIndex = (this.modeIndex + 1) % MODES.length;
    if (this.mode === 'third') {
      this.lookYaw = 0; // linisin ang pagtingin sa pagbalik
      this.lookPitch = 0;
    }
    const label = MODE_LABELS[this.mode];
    const el = document.createElement('div');
    el.style.cssText =
      'position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);' +
      'background:rgba(0,0,0,0.7);color:#fff;padding:10px 20px;border-radius:5px;' +
      'font-size:1.2rem;z-index:100;pointer-events:none;';
    el.textContent = label;
    document.getElementById('app').appendChild(el);
    setTimeout(() => el.remove(), 1200);
  }

  update(delta, input) {
    // Q/E para mag-look sa first person
    if (input) {
      if (input.lookLeft) this.lookYaw += 1.8 * delta;
      if (input.lookRight) this.lookYaw -= 1.8 * delta;
    }
    this.lookYaw = Math.max(-2.6, Math.min(2.6, this.lookYaw)); // limitasyon

    const vPos = this.vehicle.group.position;
    const rot = this.vehicle.rotation;
    const fwdX = Math.sin(rot);
    const fwdZ = Math.cos(rot);

    if (this.mode === 'third') {
      // kamera sa LIKOD ng kotse (9 m), taas 4.2 m
      const targetX = vPos.x - fwdX * 9;
      const targetY = vPos.y + 4.2;
      const targetZ = vPos.z - fwdZ * 9;
      // tingnan ang unahan ng kotse
      const lookX = vPos.x + fwdX * 6;
      const lookY = vPos.y + 1.2;
      const lookZ = vPos.z + fwdZ * 6;
      // smooth follow (walang lag sa maling bigat)
      const k = 1 - Math.exp(-8 * delta);
      this.pos.lerp(new THREE.Vector3(targetX, targetY, targetZ), k);
      this.look.lerp(new THREE.Vector3(lookX, lookY, lookZ), k);
    } else {
      // first person: sa loob ng cabin, unang pagtingin ayon sa heading
      this.pos.set(vPos.x - fwdX * 0.4, vPos.y + 1.45, vPos.z - fwdZ * 0.4);
      const yaw = rot + this.lookYaw;
      const pitch = this.lookPitch;
      const dirX = Math.sin(yaw) * Math.cos(pitch);
      const dirY = Math.sin(pitch);
      const dirZ = Math.cos(yaw) * Math.cos(pitch);
      this.look.set(this.pos.x + dirX * 12, this.pos.y + dirY * 12, this.pos.z + dirZ * 12);
    }

    this.camera.position.copy(this.pos);
    this.camera.lookAt(this.look);
  }
}
