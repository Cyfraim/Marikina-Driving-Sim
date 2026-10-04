import * as THREE from 'three';
import { terrainHeight, gpsToLocal } from '../utils/geo.js';
import { SPAWN_GPS } from '../world/landmarkData.js';
import { applyRoadConfinement, clampToMap } from '../utils/boundary.js';
import { ROAD_LINES, pickSpawnRoad, nearestDistanceOnRoad, sampleRoad } from '../utils/roadLayout.js';

// Vehicle Physics Constants
const MAX_SPEED = 60;
const MAX_REVERSE_SPEED = 20;
const ACCELERATION = 25;
const BRAKE_FORCE = 40;
const STEERING_SPEED = 2.5;
const FRICTION = 8;
const HANDBRAKE_FORCE = 60;
const MAX_STEER_ANGLE = 0.6; // rad (~34 deg) - lock-to-lock sa isang gilid
// FIX invisible-wall: bicycle-model steering (tuned for real driving)
// - STEER_GAIN: dami ng turning kada unit ng steering angle
// - MAX_YAW_RATE: pinakamalaking turn rate (rad/s) - humihigpit sa mabilis
// - STEER_DAMP: pagkawala ng steering habang nagta-tangkang mag-steer
// - STEER_RETURN: pagbabalik ng steering sa 0 kapag walang input
const STEER_GAIN = 0.9;
const MAX_YAW_RATE = 1.4;      // rad/s (~80 deg/s) - makatotohan para sa kotse
const STEER_RETURN = 2.5;      // rad/s - pagbabalik ng gulong sa center
const WHEELBASE = 2.6;         // m - pagitan ng unang at huling gulong
// Wheels ay nasa 0.35 m radius, kaya kailangan ng clearance para hindi
// sumasabog ang kotse sa kalsada habang naka-upo ang chassis
const GROUND_CLEARANCE = 0.02;

/**
 * OBB ng kotse, naka-rotate sa heading niya.
 * Ang "forward" ng kotse ay (sin(rot), cos(rot)), kaya:
 *   local X (lapad)  = (cos(rot), -sin(rot))
 *   local Z (haba)  = (sin(rot),  cos(rot))
 */
function carObb(pos, rot) {
  return {
    cx: pos.x, cy: pos.y, cz: pos.z,
    ex: 1.0, ey: 0.75, ez: 2.1,
    ax: Math.cos(rot), az: -Math.sin(rot), // local X
  };
}

/** OBB (kotse) vs AABB (world box) - SAT sa 4 axes ng XZ. */
function obbVsAabb(o, box) {
  const bx = (box.min.x + box.max.x) / 2;
  const bz = (box.min.z + box.max.z) / 2;
  const bex = (box.max.x - box.min.x) / 2;
  const bez = (box.max.z - box.min.z) / 2;
  const by = (box.min.y + box.max.y) / 2;
  const bey = (box.max.y - box.min.y) / 2;
  if (Math.abs(o.cy - by) > o.ey + bey) return false; // Y overlap

  const dx = o.cx - bx, dz = o.cz - bz;
  const zx = -o.az, zz = o.ax; // local Z = perp ng X
  for (const [ax, az] of [[1, 0], [0, 1], [o.ax, o.az], [zx, zz]]) {
    const rA = Math.abs(ax) * bex + Math.abs(az) * bez;
    const rO = Math.abs(o.ax * ax + o.az * az) * o.ex
      + Math.abs(zx * ax + zz * az) * o.ez;
    if (Math.abs(dx * ax + dz * az) > rA + rO) return false;
  }
  return true;
}

/** OBB vs OBB (kotse vs building) - SAT sa 4 axes. */
function obbVsObb(a, b) {
  if (Math.abs(a.cy - b.y) > a.ey + b.hy) return false;
  const dx = a.cx - b.x, dz = a.cz - b.z;
  const azx = -a.az, azz = a.ax;   // a local Z
  for (const [ax, az] of [[1, 0], [0, 1], [a.ax, a.az], [azx, azz],
    [b.cos, -b.sin], [b.sin, b.cos]]) {
    const rA = Math.abs(a.ax * ax + a.az * az) * a.ex
      + Math.abs(azx * ax + azz * az) * a.ez;
    const rB = Math.abs(b.cos * ax - b.sin * az) * b.hx
      + Math.abs(b.sin * ax + b.cos * az) * b.hz;
    if (Math.abs(dx * ax + dz * az) > rA + rB) return false;
  }
  return true;
}

/**
 * Spawn point: eksaktong centerline ng Bayan-Bayanan Avenue, nakaharap
 * ALONG direksyon ng kalsada (hindi patungo sa 'X axis').
 * Cache ang resulta - kailangan lang minsan.
 */
let _spawnInfo = null;
export function spawnRoadInfo() {
  if (_spawnInfo) return _spawnInfo;
  // FIX 2: ang pagpili ay NASA roadLayout.pickSpawnRoad() - primary/secondary
  // na loob ng SPAWN_SEARCH mula sa center ng mapa, pinakamahaba. Dati ay
  // pinipili rito ang pinakamahabang arteryal sa BUONG mapa, na sa
  // Marikina ay nasa malayong sulog - kaya hindi na nagre-appear ang
  // spawn-visible tricycle row (nasa ibang kalsada).
  const best = pickSpawnRoad();
  if (!best) {
    _spawnInfo = { x: 0, z: 0, heading: Math.PI / 2 };
    return _spawnInfo;
  }
  const requested = gpsToLocal(...SPAWN_GPS);
  const near = nearestDistanceOnRoad(best.i, requested.x, requested.z);
  const point = sampleRoad(best.i, near.along, 0);
  _spawnInfo = { x: point.x, z: point.z, heading: point.yaw, road: best.name, ri: best.i };
  return _spawnInfo;
}

// ---------------------------------------------------------------------------
// 1A - CAR MODEL (PHASE 1 VISUAL POLISH)
// Ang dating modelo ay isang plain BoxGeometry(2, 0.8, 4.2) - "box car".
// Ngayon ay tunay na low-poly na hugis ng kotse: tapered body, hiwalay na
// hood/trunk/cabin, tinted windshield, 4 na gulong na may hubcap, headlight/
// taillight, at side mirror.
//
// PANSIN sa STEERING SPIN: ang bawat gulong ay may TATLO (3) antas -
//   pivot (steer sa Y) > mesh (rotateZ=PI/2 + spin sa X)
// Bakit hindi sapat ang isang mesh? Dahil sa Euler order na 'XYZ', ang
// matrix ay R = RX * RY * RZ, i.e. RZ ang unang naaapply, saka RY, saka RX.
// Kung sabay ang spin (RX) at steer (RY) sa iisang object, naaapply ang
// steer BAGO mag-spin - kaya ang gulong ay umiikot sa isang TILT na axle
// (mukhang naka-bank). Sa pamamagitan ng pivot, ang steer ay nasa labas ng
// spin axis at tama ang dating.
// ---------------------------------------------------------------------------

/** Box na tapered: `wBot` ang lapad sa ibaba, `wTop` sa itaas. */
function taperedBox(wBot, wTop, h, d) {
  const g = new THREE.BoxGeometry(1, h, d);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const t = (p.getY(i) + h / 2) / h;          // 0 = ibaba, 1 = itaas
    p.setX(i, p.getX(i) * (wBot + (wTop - wBot) * t));
  }
  g.computeVertexNormals();
  return g;
}

// Mga pinapiling kulay ng kotse (spec) - pinipili nang random sa bawat spawn
const CAR_COLORS = [0xcc2200, 0xf0f0f0, 0xaaaaaa, 0x1a4fa0, 0xddcc00];
const WHEELBASE_HALF = 1.35;   // +-1.35 m mula sa gitna (harapan/l Likuran)
const TRACK_HALF = 0.95;       // +-0.95 m mula sa gitna (gilid)

export class Vehicle {
  constructor(scene) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.speed = 0;
    this.steering = 0;
    this.position = new THREE.Vector3(0, 0.5, 0);
    this.rotation = 0;
    this.pitch = 0;   // terrain pitch
    this.roll = 0;    // terrain roll
    this.collisionObjects = [];
    // 1B: dynamic na collider ng mga NPC (inau-update kada frame)
    this.npcColliders = [];
    this.confinement = null;
    // OBB colliders (buildings) - oriented boxes, hindi AABB
    this.obbColliders = [];
    // FIX 1: last valid na posisyon sa kalsada (safety net kung ma-stray)
    this.lastGoodRoad = { x: 0, z: 0 };
    this.strayTimer = 0;
    scene.add(this.group);
  }

  build() {
    // --- body: tapered, may hiwalay na hood (rapas) at trunk (likuran) -----
    const color = CAR_COLORS[Math.floor(Math.random() * CAR_COLORS.length)];
    this.bodyColor = color;
    const bodyMat = new THREE.MeshStandardMaterial({ color, metalness: 0.55, roughness: 0.42 });
    this._bodyMat = bodyMat;      // para sa randomizeColor()

    // lower body: malaki sa baba (1.95), mas makitid sa itaas (1.78)
    const lower = new THREE.Mesh(taperedBox(1.95, 1.78, 0.62, 4.2), bodyMat);
    lower.position.y = 0.62;
    lower.castShadow = true;
    this.group.add(lower);

    // hood: mas mababa at mas makitid, nasa harap
    const hood = new THREE.Mesh(taperedBox(1.86, 1.70, 0.30, 1.55), bodyMat);
    hood.position.set(0, 1.02, 1.15);
    hood.castShadow = true;
    this.group.add(hood);

    // trunk: mas mababa, nasa likuran
    const trunk = new THREE.Mesh(taperedBox(1.86, 1.70, 0.28, 1.10), bodyMat);
    trunk.position.set(0, 1.00, -1.50);
    trunk.castShadow = true;
    this.group.add(trunk);

    // cabin: tapered, mas makitid sa itaas (tilted greenhouse look)
    const cabinMat = new THREE.MeshStandardMaterial({ color, metalness: 0.45, roughness: 0.5 });
    this._cabinMat = cabinMat;
    const cabin = new THREE.Mesh(taperedBox(1.70, 1.30, 0.58, 2.05), cabinMat);
    cabin.position.set(0, 1.28, -0.20);
    cabin.castShadow = true;
    this.group.add(cabin);

    // --- windshield (front) + rear window, tinted 0x111111 opacity 0.7 -----
    const glassMat = new THREE.MeshStandardMaterial({
      color: 0x111111, transparent: true, opacity: 0.7, metalness: 0.85, roughness: 0.08,
    });
    const windshield = new THREE.Mesh(new THREE.PlaneGeometry(1.52, 0.78), glassMat);
    windshield.position.set(0, 1.30, 0.84);
    windshield.rotation.x = -0.42;   // baling pababa sa harap
    this.group.add(windshield);

    const rearWindow = new THREE.Mesh(new THREE.PlaneGeometry(1.44, 0.62), glassMat);
    rearWindow.position.set(0, 1.30, -1.22);
    rearWindow.rotation.x = 0.40;    // baling pababa sa likuran
    this.group.add(rearWindow);

    // side glass (maliliit, dalawa) - nagpapasukha sa cabin
    const sideGlass = new THREE.MeshStandardMaterial({
      color: 0x111111, transparent: true, opacity: 0.55, metalness: 0.8, roughness: 0.1,
    });
    [-1, 1].forEach((s) => {
      const g = new THREE.Mesh(new THREE.PlaneGeometry(1.25, 0.42), sideGlass);
      g.position.set(s * 0.86, 1.34, -0.30);
      g.rotation.y = s * Math.PI / 2;
      this.group.add(g);
    });

    // --- wheels: 4 na itim na cylinder, rotateZ PI/2, may gray hubcap ------
    // ANG LAPAD (0.28) ay slighty mas malaki sa katawan upang "lumabas" sa
    // gilid - ito ang normal sa real na kotse.
    const tireGeom = new THREE.CylinderGeometry(0.36, 0.36, 0.28, 14);
    const tireMat = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.85 });
    const hubMat = new THREE.MeshStandardMaterial({ color: 0x9a9a9a, metalness: 0.7, roughness: 0.35 });
    this.wheelPivots = [];
    this.wheelMeshes = [];
    // [sx, sz] - sz > 0 = FRAP (naka-steer), sz < 0 = likuran
    [[-1, 1], [1, 1], [-1, -1], [1, -1]].forEach(([sx, sz]) => {
      // 1) pivot: ito lamang ang nag-i-steer (Y axis)
      const pivot = new THREE.Group();
      pivot.position.set(sx * TRACK_HALF, 0.36, sz * WHEELBASE_HALF);
      // 2) mesh: rotateZ PI/2 (ilagay ang cylinder sa gilid) + spin (X)
      const tire = new THREE.Mesh(tireGeom, tireMat);
      // AXLE: ang cylinder ay may axis sa Y. Para maging "gulong" (naka-patong
      // sa gilid), i-rotate nang PI/2 sa Z -> axis becomes X. Ito rin ang
      // spin axis: rotation.x = pag-ikot.
      tire.rotation.z = Math.PI / 2;
      tire.castShadow = true;
      // hubcap: disk sa labas ng gulong
      const hub = new THREE.Mesh(new THREE.CircleGeometry(0.19, 12), hubMat);
      hub.position.y = 0.145;
      hub.rotation.x = -Math.PI / 2;   // nakaharap sa labas (eksis sa Y ng cyl)
      tire.add(hub);
      pivot.add(tire);
      this.group.add(pivot);
      this.wheelPivots.push(pivot);
      this.wheelMeshes.push(tire);
    });

    // --- headlights (0xffffcc emissive) sa harap ---------------------------
    const hlMat = new THREE.MeshStandardMaterial({
      color: 0xffffcc, emissive: 0xffffcc, emissiveIntensity: 0.7, roughness: 0.3,
    });
    this.headlights = [];
    [-0.62, 0.62].forEach((x) => {
      const l = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.20, 0.08), hlMat);
      l.position.set(x, 0.82, 2.08);
      this.group.add(l);
      this.headlights.push(l);
    });

    // --- taillights (0xff2200 emissive) sa likuran -------------------------
    const tlMat = new THREE.MeshStandardMaterial({
      color: 0xff2200, emissive: 0xff2200, emissiveIntensity: 0.6, roughness: 0.35,
    });
    [-0.68, 0.68].forEach((x) => {
      const l = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.22, 0.08), tlMat);
      l.position.set(x, 0.86, -2.08);
      this.group.add(l);
    });

    // --- side mirrors: maliit na box sa bawat gilid ng cabin ----------------
    const mirrorMat = new THREE.MeshStandardMaterial({ color: 0x2a2a2a, metalness: 0.5, roughness: 0.4 });
    [-1, 1].forEach((s) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(0.20, 0.12, 0.10), mirrorMat);
      m.position.set(s * 0.98, 1.24, 0.42);
      this.group.add(m);
    });

    // bumpers
    const bumperMat = new THREE.MeshStandardMaterial({ color: 0x3a3a3a, roughness: 0.6 });
    const fb = new THREE.Mesh(new THREE.BoxGeometry(1.90, 0.24, 0.18), bumperMat);
    fb.position.set(0, 0.42, 2.12);
    this.group.add(fb);
    const rb = new THREE.Mesh(new THREE.BoxGeometry(1.90, 0.24, 0.18), bumperMat);
    rb.position.set(0, 0.42, -2.12);
    this.group.add(rb);
  }

  /** 1A: palitan ang kulay ng kotse (spec: random on spawn). */
  randomizeColor() {
    const c = CAR_COLORS[Math.floor(Math.random() * CAR_COLORS.length)];
    this.bodyColor = c;
    if (this._bodyMat) this._bodyMat.color.setHex(c);
    if (this._cabinMat) this._cabinMat.color.setHex(c);
    return c;
  }


  update(delta, input) {
    this.impactStrength = 0;
    delta = Math.min(delta, 0.05);
    if (input.forward) this.speed += ACCELERATION * delta;
    if (input.backward) {
      if (this.speed > 0.5) this.speed -= BRAKE_FORCE * delta;
      else this.speed -= ACCELERATION * 0.5 * delta;
    }
    if (input.handbrake) {
      this.speed *= (1 - HANDBRAKE_FORCE * delta / 60);
      if (Math.abs(this.speed) < 0.1) this.speed = 0;
    }
    if (!input.forward && !input.backward) {
      if (this.speed > 0) { this.speed -= FRICTION * delta; if (this.speed < 0) this.speed = 0; }
      else if (this.speed < 0) { this.speed += FRICTION * delta; if (this.speed > 0) this.speed = 0; }
    }
    this.speed = Math.max(-MAX_REVERSE_SPEED, Math.min(MAX_SPEED, this.speed));
    // NOTE: ang steering ay kinakalkula sa ibaba (bicycle model, may
    // self-centering). DITO hindi na dapat may dagdag na steering update -
    // ang dating duplicate ay nag-aalis ng sarili nito (add-then-decay),
    // kaya ZERO steering ang resulta kahit may input.
    // --- FIX invisible-wall: heading stabilization -----------------------
    // BUG: ang kotse ay maaaring pumunta sa 60+ deg na tilt laban sa kalsada
    // (halos patagong). Sa ganitong tilt, ang 4.2 m na haba ng kotse ay
    // nasa crosswise - kaya umaabot ito sa mga poste sa 8.6 m at na-stall.
    // Sa totoong pagmamaneho, hindi ito nangyayari nang basta-basta.
    //
    // FIX: kapag nasa loob ng kalsada at malaki na ang tilt (> 25 deg),
    // mag-apply ng banayad na torque papunta sa kalsada - parang
    // "self-centering" ng kotse. Hindi ito overtaking sa player, kasi
    // pinipigilan lamang ang malubha na spin habang naka-drive sa kalsada.
    // NOTE: dating may "heading alignment" torque dito na nakatulong sa
    // pagbabawal ng spin-out. INALIS: hindi nito alam kung forward o backward
    // ang tunay na direksyon ng kalsada (magka-180 deg ito sa dulo ng
    // polyline), kaya nililingo nito ang kotse sa maling direksyon. Ang
    // tunay na solusyon ay ang OBB collision + ang tamang lane clearance
    // (tools/check-corridor.mjs, tools/drive-sweep.mjs) - hindi ang torque.
    // --- FIX invisible-wall: bicycle-model steering ---------------------
    // BUG: ang dating `steering * speed * delta * 0.05` ay (a) frame-rate
    // dependent sa maling parawan at (b) HINDI naka-damp - kaya sa
    // makatuwirang bilis, ang kotse ay umiikot nang walang hanggang at
    // nakakapagulo sa kalsada.
    //
    // FIX: (1) steering bilang first-order LAG papunta sa target angle
    //         (hindi ang dating add-then-damp na nag-aalis ng sarili), at
    //         (2) frame-rate-independent yaw rate (bicycle model):
    //         yawRate = (speed / wheelbase) * tan(steerAngle) * STEER_GAIN
    const speedAbs = Math.abs(this.speed);

    // 1) steering target: mag-apply ng STEER_SPEED kapag may input,
    //    at mag-return papunta sa 0 (self-centering) kapag wala.
    // FIX 1 (inverted controls):dating nasa itaas ang tanda -
    //   left  -> steering -  -> yaw -  -> ikot KALIWA (pero nasa kanan!)
    //   right -> steering +  -> yaw +  -> ikot KANAN (pero nasa kaliwa!)
    // Tama sa three.js Y-up right-handed frame: rotation ay counter-clockwise
    // kapag tinitingnan mula sa itaas. Para KALIWA ang turn, kailangan ang
    // POSITIBONG yaw, kaya positibo rin ang steering.
    let target = this.steering;
    if (input.left) target = this.steering + STEERING_SPEED * delta;
    else if (input.right) target = this.steering - STEERING_SPEED * delta;
    else {
      // self-centering: bumalik sa 0 nang smooth
      const ret = STEER_RETURN * delta;
      target = Math.abs(this.steering) <= ret ? 0 : this.steering - Math.sign(this.steering) * ret;
    }
    this.steering = Math.max(-MAX_STEER_ANGLE, Math.min(MAX_STEER_ANGLE, target));

    // 2) yaw rate mula sa bicycle model
    const yawRate = (this.speed / WHEELBASE) * Math.tan(this.steering) * STEER_GAIN;
    // limit: humihigpit ang turning sa mabilis (mas makatotohan)
    const maxYaw = MAX_YAW_RATE * Math.min(1, speedAbs / 6);
    this.rotation += Math.max(-maxYaw, Math.min(maxYaw, yawRate)) * delta;

    // NOTE: hindi na kailangan ang dating "heading alignment" torque - ang
    // bicycle-model steering + damping ang humihigpit sa spin-out, at hindi
    // nito kailangang "alam" kung forward o backward ang kalsada.
    const moveX = Math.sin(this.rotation) * this.speed * delta;
    const moveZ = Math.cos(this.rotation) * this.speed * delta;
    const newPos = new THREE.Vector3(this.position.x + moveX, this.position.y, this.position.z + moveZ);
    if (!this.checkCollision(newPos)) { this.position.copy(newPos); }
    else { this.impactStrength = Math.abs(this.speed); this.speed *= -0.3; }

    // --- FIX 1: INVISIBLE BOUNDARY WALLS (physics lang, walang mesh) ---
    // 1a) ROAD CONFINEMENT: kapag lumabas ang kotse sa gilid ng kalsada
    //     (labas ng bangketa), may malakas na opposing force muna (parang
    //     binabanga ang kerb), saka hard clamp + zero ang velocity.
    if (this.confinement) {
      const r = applyRoadConfinement(this.confinement, this.position, delta, this.lastGoodRoad);
      if (r.offRoad) {
        // soft push-back force (integrate sa position, parang acceleration)
        this.position.x += r.pushX * delta;
        this.position.z += r.pushZ * delta;
        // kerb drag: bumabagal habang naglalabas (exponential, frame-rate safe)
        // Signed damping rate is negative; never accelerate forward or reverse.
        if (r.drag) this.speed *= Math.exp(Math.min(0, r.drag) * delta);
        if (r.hard) {
          // hard stop: zero ang velocity component na pababa sa gilid
          this.speed *= 0.35;
          this.steering *= 0.5;
        }
        // kapag STRANDED (walang kalsada sa 150 m), ibalik sa last known
        if (r.strayed) {
          this.strayTimer = (this.strayTimer || 0) + delta;
          if (this.strayTimer > 2.0) {
            // 2 s na stranded = ipatungo pabalik sa kalsada
            this.position.x = this.lastGoodRoad.x;
            this.position.z = this.lastGoodRoad.z;
            this.speed = 0;
            this.strayTimer = 0;
          }
        }
      } else {
        // nasa kalsada: i-record ang last valid na posisyon (safety net)
        this.lastGoodRoad = { x: this.position.x, z: this.position.z };
        this.strayTimer = 0;
      }
    }
    // 1b) MAP BOUNDARY: square na Â±MAP_BOUND - last line of defense para
    //     hindi lumabas sa scene. Zero velocity sa pinundan na axis.
    if (clampToMap(this.position)) {
      // hanapin kung aling axis ang tumama para i-zero ang tamang bahagi
      const lim = 1600 - 1.4;
      if (Math.abs(this.position.x) >= lim) this.speed = 0; // hard clamp sa gilid
      // sa x-z plain (walang vector velocity), speed=0 ang safe na tugon
    }

    // --- Terrain: sumusunod ang kotse sa slope ng lupa ---
    const groundY = terrainHeight(this.position.x, this.position.z);
    // damped vertical follow para hindi maugoy-ugoy pagpapataas-baba
    this.position.y += (groundY + GROUND_CLEARANCE - this.position.y) * Math.min(1, delta * 10);
    this.group.position.copy(this.position);
    this.group.rotation.y = this.rotation;
    // pitch/roll mula sa terrain sa harap at gilid ng kotse
    const halfL = 1.6;
    const halfW = 0.9;
    const fwdX = Math.sin(this.rotation);
    const fwdZ = Math.cos(this.rotation);
    const sideX = Math.cos(this.rotation);
    const sideZ = -Math.sin(this.rotation);
    const yF = terrainHeight(this.position.x + fwdX * halfL, this.position.z + fwdZ * halfL);
    const yB = terrainHeight(this.position.x - fwdX * halfL, this.position.z - fwdZ * halfL);
    const yL = terrainHeight(this.position.x - sideX * halfW, this.position.z - sideZ * halfW);
    const yR = terrainHeight(this.position.x + sideX * halfW, this.position.z + sideZ * halfW);
    // pitch: positibo = pataas sa harap; roll: positibo = tilt sa kanan
    const pitch = Math.atan2(yB - yF, halfL * 2);
    const roll = Math.atan2(yL - yR, halfW * 2);
    this.pitch = this.pitch + (pitch - this.pitch) * Math.min(1, delta * 8);
    this.roll = this.roll + (roll - this.roll) * Math.min(1, delta * 8);
    this.group.rotation.set(this.pitch, this.rotation, this.roll, 'YXZ');
    // 1A: wheel spin - ang bilis ng pag-ikot ay PROPORSYONAL sa bilis ng
    // kotse. radius 0.36 m, kaya ang angular na bilis = v / r.
    const spin = (this.speed / 0.36) * delta;
    for (const m of this.wheelMeshes) m.rotation.x -= spin;
    // 1A: steering - ang FRAP na gulong lang ang umiikot (index 0 at 1),
    // at ang halaga ay ang mismong steering angle (hindi na ang 0.5 scale).
    for (let i = 0; i < 4; i++) {
      this.wheelPivots[i].rotation.y = (i < 2) ? this.steering : 0;
    }
  }

  checkCollision(newPos) {
    // --- AABB colliders (poste, puno, NPC, kanal) ---
    // FIX invisible-wall: ang dating box ay `setFromCenterAndSize(2,1.5,4.2)`
    // na HINDI naka-rotate - kaya kapag naka-pa-side ang kotse, ang 4.2 m
    // HABA nito ay nasa crosswise sa kalsada, at nakabara sa lane/mga poste.
    // Ngayon: OBB na naka-rotate sa kasalukuyang heading ng kotse.
    const car = carObb(newPos, this.rotation);
    for (const obj of this.collisionObjects) { if (obbVsAabb(car, obj)) return true; }
    // --- 1B: NPC vehicles (dynamic, ina-update kada frame) -----------------
    for (const obj of this.npcColliders) { if (obbVsAabb(car, obj)) return true; }
    // --- OBB colliders (buildings) ---
    for (const o of this.obbColliders) { if (obbVsObb(car, o)) return true; }
    return false;
  }

  setCollisionObjects(objects) { this.collisionObjects = objects; }
  // 1B: NPC AABB colliders - naiipapasa mula NPCManager bawat frame
  setNpcColliders(boxes) { this.npcColliders = boxes; }
  // FIX 1: i-hook ang road confinement index
  setConfinement(confinement) { this.confinement = confinement; }
  // OBB colliders (buildings) - oriented, eksakto sa hugis
  setObbColliders(obbs) { this.obbColliders = obbs; }

  reset() {
    this.speed = 0; this.steering = 0;
    // 1A: random na kulay bawat spawn (spec)
    if (this._bodyMat) this.randomizeColor();
    // i-reset ang wheel spin + steer (hindi na dapat mag-iikot mula sa reset)
    if (this.wheelMeshes) for (const m of this.wheelMeshes) m.rotation.x = 0;
    if (this.wheelPivots) for (const p of this.wheelPivots) p.rotation.y = 0;
    // FIX invisible-wall (screenshot!): ang dating spawn ay (0,0) na
    // 3.36 m OFF ang centerline at 14 deg na hihindi sa direksyon ng kalsada.
    // Kapag pindutin ang W, diretsyong tuwir ang paggalaw kaya nagtutuloy sa
    // mga poste sa gilid - at na-stall sa ~20 m (speed * -0.3 bawat frame).
    //
    // FIX: ilagay ang kotse EKSAKTO sa centerline ng Bayan-Bayanan Avenue,
    // nakaharap ALONG direksyon ng kalsada. Ito rin ang "0,0" ng map.
    const r = spawnRoadInfo();
    this.position.set(r.x, terrainHeight(r.x, r.z) + GROUND_CLEARANCE, r.z);
    this.rotation = r.heading;
    this.pitch = 0;
    this.roll = 0;
    this.group.position.copy(this.position);
    this.group.rotation.set(0, this.rotation, 0, 'YXZ');
    // i-reset ang boundary state (last valid na posisyon = spawn)
    this.lastGoodRoad = { x: this.position.x, z: this.position.z };
    this.strayTimer = 0;
  }

  getSpeedKmh() { return Math.abs(Math.round(this.speed * 3.6)); }
  // Signed speed (para sa speedometer: negative = pabaligtad / R gear)
  getSpeedKmhSigned() { return Math.round(this.speed * 3.6); }
}



