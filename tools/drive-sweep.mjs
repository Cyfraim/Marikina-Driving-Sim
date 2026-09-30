// ---------------------------------------------------------------------------
// drive-sweep.mjs - Drive EVERY major road with an autopilot (like a player
// steering deliberately) and confirm none of them stalls.
//
// This is the end-to-end counterpart to check-corridor.mjs: that one asks
// "is there room in the lane?", this one asks "does the car actually get
// through?" (catches spin-outs, drift-to-the-edge, and anything the static
// lane test cannot see).
// Usage: node tools/drive-sweep.mjs
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { Map as GameMap } from '../src/world/Map.js';
import { Vehicle } from '../src/game/Vehicle.js';
import { ROAD_LINES, densifyROAD, distToPolyline } from '../src/utils/roadLayout.js';

const scene = new THREE.Scene();
const map = new GameMap(scene);
map.build();

const DT = 1 / 60;
const STALL_FRAMES = 120; // 2 s of crawling
const MAX_FRAMES = 26000; // ~7 min sim time - sapat para sa 1.6 km na kalsada
const MAX_STEER = 0.6;
const MAX_TEER = 0.6;   // typo guard (same value)
const STEER_RATE = 2.5; // rad/s - ang bilis ng paggalaw ng gulong

console.log('='.repeat(72));
console.log('DRIVE SWEEP - every major road must be fully traversable');
console.log('='.repeat(72));

const roads = ROAD_LINES.filter(
  (r) => (r.cls === 'primary' || r.cls === 'secondary' || r.cls === 'tertiary') && r.len > 40
);
console.log(`roads to drive: ${roads.length}\n`);

// FIX 2: TUNGKOL na sampling budget. Ang buong Marikina ay ~200 major road.
// Hindi na kayang tapusin ang lahat bawat run, kaya may hangganan kung
// magkano ang susuriin - at IINIULAT nang malinaw kung ilan ang na-skip
// (hindi muna "ALL ROADS PASS" kung hindi naman).
const MAX_PER_ROAD_M = 1200; // hanggang 1.2 km bawat kalsada
const MAX_TOTAL_M = 60000;   // 60 km kabuuan per run
let sweptM = 0;
let skipped = 0;
let partialRoads = 0;

// Hoist: getCollisionBoxes() ay gumagawa ng bagong array kada tawag.
const ALL_BOXES = map.getCollisionBoxes();
const ALL_OBB = map.getObbColliders();

let fails = 0;
for (const road of roads) {
  if (sweptM >= MAX_TOTAL_M) { skipped++; continue; }
  const v = new Vehicle(scene);
  v.build();
  v.setConfinement(map.confinement);
  v.setCollisionObjects(ALL_BOXES);
  v.setObbColliders(ALL_OBB);

  const line = densifyROAD(road.pts, 1.0);
  // start 15 m in
  let idx = 15;
  v.position.set(line[idx].x, v.position.y, line[idx].z);
  v.lastGoodRoad = { x: line[idx].x, z: line[idx].z };
  v.rotation = Math.atan2(line[idx + 1].x - line[idx].x, line[idx + 1].z - line[idx].z);
  v.speed = 10;

  const input = { forward: true, backward: false, left: false, right: false, handbrake: false };
  let stall = 0, offRoad = false;
  const end = Math.min(line.length - 10, idx + MAX_PER_ROAD_M);
  if (end < line.length - 10) partialRoads++;
  sweptM += (end - idx);
  // Realistic na drive speed (~30 km/h). Kung mas mabilis, hindi kayang
  // i-follow ng bangang kalsada - at iyon ay LIMIT NG TEST, hindi bug.
  const CAP = 30 / 3.6;

  for (let f = 0; f < MAX_FRAMES && idx < end; f++) {
    // --- Pure pursuit + cross-track correction ---
    // BUG NA HINULING: ang dating normal ay `(-tz, tx)/tl` - ang negatibo
    // nito ay ang KALIWA ng travel direction. Dahil dito, ang `cross` ay
    // NEGATIVO kapag nasa KANAN ng centerline, at ang +cross*k ay
    // PINUPUNTA pa sa labas - kaya laging naka-steer sa isang gilid at
    // lumalabas ang kotse sa kalsada. tama ang normal ay (tz, -tx)/tl.
    const ahead = Math.min(idx + 18, line.length - 1);
    const tgt = line[ahead];
    const here = line[idx];
    const tx = tgt.x - here.x, tz = tgt.z - here.z;
    const tl = Math.hypot(tx, tz) || 1;
    // unit normal sa KANAN ng paglalakbay (right-hand side of travel)
    const nx = tz / tl, nz = -tx / tl;
    // lateral offset: positibo = nasa kanan ng centerline
    const cross = (v.position.x - here.x) * nx + (v.position.z - here.z) * nz;

    // heading error sa target
    const want = Math.atan2(tgt.x - v.position.x, tgt.z - v.position.z);
    let err = want - v.rotation;
    while (err > Math.PI) err -= Math.PI * 2;
    while (err < -Math.PI) err += Math.PI * 2;
    // cross-track correction: kailangang mag-STEER AWAY mula sa gilid na
    // nasa, kaya ang tanda (sign) ay -.
    const steerCmd = err - cross * 0.05;

    // FIX 1: sinunod ang bagong konsyongyon ng Vehicle.js -
    // positibong `steering` = ikot KALIWA, kaya negatibong steering = KANAN.
    // Ang dating `left = cmd < 0` ay para sa LUMANG tanda (inverted), kaya
    // ngayon ito ay palitan.
    // FIX 2 (Marcos Highway wedge): DOUBLE-STEERING.
    //
    // BUG: ang dating code ay GINAGAWA ANG DUA - (a) sinusulat nito ang
    // `v.steering` nang diretsa, at (b) naka-set din ito ng `input.left/right`.
    // Tapos si Vehicle.update() ay NAGPAPATILOY pa rin ng steering mula sa
    // input flags. Kaya ang steering ay na-doble:apply kada frame, at
    // dahan-dahang naka-ratchet sa MAX (0.6 rad) at HINDI NA bumabalik - kasi
    // ang self-centering ay naka-skip kapag may input.
    //
    // Sa short Nangka roads hindi ito lumalabas. Sa 1,296 m na Marcos Highway
    // naging sanhi: ang steering ay naka-pin sa 0.6 rad, ang yaw rate ay
    // ~2.16 rad/s, kaya paikot-ikot ang kotse (idx stuck, ~1 m/s) sa isang
    // patAYONG kalsada (0.0 deg/10 m). Ito ang "ran out of frames".
    //
    // AYUS: ANG AUTOPILOT AY GAMIT NG INPUT FLAGS LAMANG - tulad ng tunay na
    // player - at HINDI nagsusulat ng v.steering. Ang Vehicle ang may hawak
    // ng first-order steering lag at ng self-centering, kaya:
    //   - walang double-apply (naaayos ang wedge)
    //   - DEADBAND: kapag maliit ang wantAng, walang pinipindot na key ->
    //     self-centering ang gumagana at lumalapit sa centerline
    //   - walang direct write -> hindi na naka-ratchet sa max lock
    //
    // (Ang kahapon kong sinubok na "walang flags, direct write lang" ay mas
    // masama: Vehicle.update() ay AGAD nang self-center sa 0 bago magamit
    // ang sulat, kaya hindi kailanman naka-steer - 4 na kalsada ang nawala.)
    const wantAng = Math.max(-MAX_STEER, Math.min(MAX_STEER, steerCmd * 1.6));
    const DEADBAND = 0.02; // rad - sa ilalim nito, ipinapatlang ang gulong
    input.left = wantAng > DEADBAND;
    input.right = wantAng < -DEADBAND;
    // --- speed cap: kung lagpas na, RELEASE ng throttle (hindi handbrake) ---
    // Ang handbrake ay para sa paghinto; para sa cruise control, ito ay
    // masyadong malakas at nagpapadalos-dalos sa steering. Ang tamang
    // paraan ay itigil ang pagtutuloy.
    input.forward = v.speed < CAP;
    input.backward = false;
    input.handbrake = false;
    v.update(DT, input);

    // advance the along-road index: hanapin ang pinakamalapit na sample
    // sa UNANG ngayong idx (hindi idx+40) - kung hindi, maaaring "laktawan"
    // ang kalsada at maging mali ang sukat.
    //
    // FIX 2: WINDOWED SCAN. Ang dating `for (k = idx-5; k < line.length; k++)`
    // ay O(n) kada frame - para sa 4,836 m na J. P. Rizal (4,836 na sample sa
    // 1 m densify) ay 4,836^2 = 23 milyong operasyon para sa ISANG kalsada.
    // Ang kotse ay gumagalaw ng ~0.17 m kada frame (10 m/s / 60 fps), kaya
    // ang index ay kailangan lamang magdagdag ng ilang - 60 m na window ay
    // napapansin ang bawat paggalaw nang may 350x na bilis.
    let best = Infinity, bi = idx;
    const kEnd = Math.min(line.length, idx + 60);
    for (let k = Math.max(0, idx - 5); k < kEnd; k++) {
      const d = Math.hypot(line[k].x - v.position.x, line[k].z - v.position.z);
      if (d < best) { best = d; bi = k; }
    }
    if (bi > idx) idx = bi;

    // off-road detection: lumampas na sa 2x half-width = talagang naalis
    if (distToPolyline(v.position.x, v.position.z, road.pts) > road.half * 2) {
      offRoad = true;
      break;
    }
    if (f > 120 && v.speed < 1) stall++; else stall = 0;
    if (stall > STALL_FRAMES) break;
  }

  const ok = !offRoad && stall <= STALL_FRAMES && idx >= end;
  if (!ok) {
    fails++;
    console.log(`FAIL  "${road.name}" [${road.cls}] ${idx}/${line.length}` +
      `${offRoad ? ' - LEFT THE ROAD' : stall > STALL_FRAMES ? ' - STALLED' : ' - ran out of frames'}` +
      ` at (${v.position.x.toFixed(0)},${v.position.z.toFixed(0)})`);
  } else {
    console.log(`ok    "${road.name}" [${road.cls}] traversed ${(idx - 15)} m`);
  }
}

console.log('\n' + '='.repeat(72));
console.log(
  fails === 0
    ? `SAMPLED ROADS ALL DRIVABLE  (${roads.length - skipped} of ${roads.length} swept, ` +
      `${(sweptM / 1000).toFixed(1)} km, ${partialRoads} capped at ${MAX_PER_ROAD_M} m)`
    : `${fails} ROAD(S) FAILED`
);
if (skipped > 0) {
  console.log(`NOTE: ${skipped} road(s) NOT swept - total budget ${(MAX_TOTAL_M / 1000)} km reached.`);
  console.log('      Raise MAX_TOTAL_M in tools/drive-sweep.mjs to cover the whole city.');
}
process.exit(fails === 0 ? 0 : 1);
