// ---------------------------------------------------------------------------
// check-phase2.mjs - PHASE 2 (2A traffic lights, 2B speed signs, 2C horn,
// 2D rain/weather)
//
// HEADLESS: hindi nangangailangan ng WebGL. Ang THREE.Scene ay gumagana nang
// walang renderer. Ang AudioContext ay STUBBED (walang tunog sa node).
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { TrafficLightSystem, LIGHT_COLORS } from '../src/world/TrafficLights.js';
import { SpeedSignSystem, LIMITS } from '../src/world/SpeedSigns.js';
import { Weather, WEATHER } from '../src/world/Weather.js';
import { NPCManager } from '../src/npcs/NPCVehicle.js';
import { Input } from '../src/game/Input.js';
import { ROAD_LINES } from '../src/utils/roadLayout.js';

let fails = 0;
const check = (name, cond, detail = '') => {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (detail ? ' -> ' + detail : ''));
  if (!cond) fails++;
};

// SpeedSigns gumagamit ng document.createElement('canvas') para sa numero.
if (typeof document === 'undefined') {
  globalThis.document = {
    createElement: () => ({
      width: 0, height: 0,
      getContext: () => ({
        fillStyle: '', strokeStyle: '', lineWidth: 0, font: '',
        textAlign: '', textBaseline: '', fillText: () => {},
        beginPath: () => {}, arc: () => {}, fill: () => {}, stroke: () => {},
      }),
    }),
  };
}
if (typeof window === 'undefined') globalThis.window = { devicePixelRatio: 1 };

const scene = new THREE.Scene();

// ===========================================================================
console.log('=== 2A - TRAFFIC LIGHTS ===');
const lights = new TrafficLightSystem(scene, 20);
{
  check('20 traffic lights placed', lights.count === 20, lights.count + ' lights');
  check('all lights are on 3+ road intersections',
    lights.lights.every((l) => l.degree >= 3),
    'degrees: ' + [...new Set(lights.lights.map((l) => l.degree))].join(','));
  let minGap = Infinity;
  for (let i = 0; i < lights.lights.length; i++) {
    for (let j = i + 1; j < lights.lights.length; j++) {
      const a = lights.lights[i], b = lights.lights[j];
      minGap = Math.min(minGap, Math.hypot(a.x - b.x, a.z - b.z));
    }
  }
  check('lights are SPREAD OUT (not clustered)', minGap >= 200, 'min gap ' + minGap.toFixed(0) + ' m');
  const offs = new Set(lights.lights.map((l) => l.offset));
  check('lights have DIFFERENT offsets (not all in sync)', offs.size > 1,
    offs.size + ' distinct offsets');

  // --- cycle: green 15 -> yellow 2 -> red 15 (total 32 s) ---
  const l0 = lights.lights[0];
  const seq = [];
  for (let t = 0; t < 32; t += 0.5) seq.push(l0.update(t));
  const greenN = seq.filter((s) => s === 'green').length * 0.5;
  const yellowN = seq.filter((s) => s === 'yellow').length * 0.5;
  const redN = seq.filter((s) => s === 'red').length * 0.5;
  check('green lasts ~15 s', greenN >= 14 && greenN <= 16, greenN + ' s');
  check('yellow lasts ~2 s', yellowN >= 1.5 && yellowN <= 2.5, yellowN + ' s');
  check('red lasts ~15 s', redN >= 14 && redN <= 16, redN + ' s');
  const order = seq.filter((s, i) => i === 0 || s !== seq[i - 1]);
  check('cycle order is green -> yellow -> red',
    order.slice(0, 3).join(',') === 'green,yellow,red', order.slice(0, 6).join(','));
  check('cycle repeats every 32 s', l0.update(0) === l0.update(32), l0.update(32));

  // emissive on the active lamp only
  lights.update(20);
  const bright = Object.entries(lights.lights[0].lamps)
    .filter(([, mesh]) => mesh.material.emissiveIntensity > 1);
  check('exactly one lamp is lit', bright.length === 1, 'lit: ' + bright.map(([n]) => n).join(','));

  // --- redAhead() ---
  const red = lights.lights.find((l) => l.update(20) === 'red');
  lights.update(20);
  if (red) {
    check('redAhead: true 5 m in front of a RED light',
      lights.redAhead(red.x - 5, red.z, 1, 0, 10) === true);
    check('redAhead: false when >10 m away',
      lights.redAhead(red.x - 30, red.z, 1, 0, 10) === false);
    check('redAhead: false when the light is BEHIND',
      lights.redAhead(red.x + 5, red.z, 1, 0, 10) === false);
  } else check('found a RED light to test', false);

  // --- NPC actually stop at a red light (spec: 10 m, decelerate to 0) ---
  const npc = new NPCManager(scene);
  const target = lights.lights.find((l) => l.update(20) === 'red');
  lights.update(20);
  if (target) {
    const n = npc.vehicles[0];
    n.x = target.x - 6; n.z = target.z;
    n.group.position.set(n.x, 0, n.z);
    n.group.rotation.y = Math.PI / 2;      // facing +X (toward the light)
    n.sync = () => {};                     // freeze the position
    n.speed = n.cruise; n.waitTimer = 0; n.redStopped = false;
    const before = n.speed;
    // FIX: ang player ay dapat NEAR the NPC - kung 1e6 m away, CULLED ang NPC
    // (dati ctive=false kaya hindi pa naganap ang red check).
    const near = { x: n.x, z: n.z };
    for (let i = 0; i < 30; i++) n.update(1 / 60, near, 1, lights);
    check('NPC STOPS at a red light', n.speed === 0 && before > 0,
      'speed ' + before.toFixed(1) + ' -> ' + n.speed.toFixed(2));
    // turn the light green -> the NPC must move again
    lights.update(5);
    for (let i = 0; i < 90; i++) n.update(1 / 60, near, 1, lights);
    check('NPC RESUMES when the light turns green', n.speed > 0.5,
      'speed=' + n.speed.toFixed(2));
  }
  check('the PLAYER is never forced to stop (honor system)', !lights.playerStop,
    'redAhead() is NPC-only; no player stop hook exists');

  // --- 2A geometry ---
  let ltris = 0;
  lights.group.traverse((o) => {
    if (!o.isMesh) return;
    const g = o.geometry;
    ltris += g.index ? g.index.count / 3 : g.attributes.position.count / 3;
  });
  check('traffic light geometry is cheap (< 3k triangles)', ltris < 3000,
    ltris + ' triangles for 20 lights');
}

// ===========================================================================
console.log('\n=== 2B - SPEED LIMIT SIGNS ===');
const signs = new SpeedSignSystem(scene);
{
  check('speed signs placed', signs.count > 0, signs.count + ' signs');
  const by = signs.byLimit;
  check('60 km/h signs (primary) exist', by[60] > 0, String(by[60]) + ' signs');
  check('40 km/h signs (secondary) exist', by[40] > 0, String(by[40]) + ' signs');
  let st = 0;
  signs.group.traverse((o) => {
    if (!o.isMesh) return;
    const g = o.geometry;
    st += g.index ? g.index.count / 3 : g.attributes.position.count / 3;
  });
  check('sign geometry is cheap (< 40 triangles per sign)', st < signs.count * 40,
    st + ' triangles for ' + signs.count + ' signs');

  // currentLimitAt: residential -> 20, secondary -> 40, primary -> 60
  const prim = ROAD_LINES.find((r) => r.cls === 'primary');
  const sec = ROAD_LINES.find((r) => r.cls === 'secondary');
  const res = ROAD_LINES.find((r) => r.cls === 'residential' && r.len > 100);
  check('primary road limit is 60',
    prim && signs.currentLimitAt(prim.pts[0].x, prim.pts[0].z).limit === 60,
    prim ? prim.name : 'none');
  check('secondary road limit is 40',
    sec && signs.currentLimitAt(sec.pts[0].x, sec.pts[0].z).limit === 40,
    sec ? sec.name : 'none');
  check('residential road limit is 20',
    res && signs.currentLimitAt(res.pts[0].x, res.pts[0].z).limit === 20,
    res ? res.name : 'none');
  check('LIMITS constant matches the spec',
    LIMITS.primary === 60 && LIMITS.secondary === 40 && LIMITS.residential === 20);
}

// ===========================================================================
console.log('\n=== 2C - HORN + 2D WEATHER keys ===');
{
  const input = new Input();
  let hornFired = 0, weatherFired = 0;
  input.onHorn = () => { hornFired++; };
  input.onWeatherToggle = () => { weatherFired++; };
  // H = horn
  input.onKeyDown({ code: 'KeyH', preventDefault: () => {} });
  input.onKeyDown({ code: 'KeyH', preventDefault: () => {} });   // held (no re-fire)
  check('H fires the horn once per press (no repeat while held)', hornFired === 1,
    hornFired + ' fire(s)');
  input.onKeyUp({ code: 'KeyH' });
  input.onKeyDown({ code: 'KeyH', preventDefault: () => {} });
  check('releasing and pressing H again re-fires', hornFired === 2, hornFired + ' fire(s)');
  // F = weather
  input.onKeyDown({ code: 'KeyF', preventDefault: () => {} });
  check('F toggles the weather', weatherFired === 1, weatherFired + ' fire(s)');
  // R must STILL be reset (F must not have taken it over)
  let resetFired = 0;
  input.onReset = () => { resetFired++; };
  input.onKeyDown({ code: 'KeyR', preventDefault: () => {} });
  check('R is still Reset (F did not steal it)', resetFired === 1, resetFired + ' reset(s)');
  check('F is not wired to reset', weatherFired === 1 && resetFired === 1);
}

// ===========================================================================
console.log('\n=== 2D - WEATHER (rain) ===');
const weather = new Weather(scene);
{
  check('starts Clear', weather.current === 'clear', weather.info.name);
  check('Clear has no particles', weather.state.particles === 0);
  check('rain lines hidden when clear', weather.lines.visible === false);

  const w1 = weather.cycle();
  check('1st F press -> Light Rain', w1.key === 'light', w1.name);
  check('Light Rain = 500 particles', w1.particles === 500, String(w1.particles));
  check('Light Rain sky is 0x6699aa', w1.sky === 0x6699aa, '#' + w1.sky.toString(16));
  check('Light Rain rain gain 0.15', w1.rainGain === 0.15, String(w1.rainGain));
  check('rain lines visible in the rain', weather.lines.visible === true);

  const w2 = weather.cycle();
  check('2nd F press -> Heavy Rain', w2.key === 'heavy', w2.name);
  check('Heavy Rain = 1500 particles', w2.particles === 1500, String(w2.particles));
  check('Heavy Rain sky is 0x445566', w2.sky === 0x445566, '#' + w2.sky.toString(16));
  check('Heavy Rain rain gain 0.4', w2.rainGain === 0.4, String(w2.rainGain));
  check('Heavy Rain fog -40% (0.6)', w2.fogScale === 0.6, String(w2.fogScale));
  check('Heavy Rain slows NPC to 70%', w2.npcScale === 0.7, String(w2.npcScale));

  const w3 = weather.cycle();
  check('3rd F press -> back to Clear', w3.key === 'clear', w3.name);

  // --- the rain actually animates and recycles ---
  weather.set('heavy');
  const pos = weather.posAttr.array;
  const player = new THREE.Vector3(100, 2, -50);
  weather.update(1 / 60, player);
  const firstY = pos[1];
  check('rain particles move every frame', firstY !== 0, 'y=' + firstY.toFixed(2));
  // particles should be relative to the player
  check('rain follows the player', Math.abs(pos[0] - (100 + weather.ox[0])) < 1e-3,
    'x=' + pos[0].toFixed(1));
  // force everything to the ground -> must recycle to the top
  for (let i = 0; i < weather.maxParticles; i++) weather.oy[i] = -100;
  weather.update(1 / 60, player);
  check('rain RECYCLES when it hits the ground',
    weather.oy.every((y) => y > -100), 'min y after recycle = ' + Math.min(...weather.oy).toFixed(1));
  // 1 draw call, not 1500
  check('rain is 1 LineSegments object (not 1500 meshes)', weather.lines.isLineSegments === true);
  // NOTE: i-count ang meshes BAGO ang rain (ang traffic lights + signs ay
  // umiiral na). Ang hinahanap namin: 0 MGA BAGONG mesh mula sa rain.
  const before2 = new Set();
  scene.traverse((o) => { if (o.isMesh) before2.add(o); });
  weather.set('heavy'); weather.update(1/60, new THREE.Vector3());
  const after2 = new Set();
  scene.traverse((o) => { if (o.isMesh) after2.add(o); });
  let added = 0;
  for (const o of after2) if (!before2.has(o)) added++;
  check('rain adds no triangle meshes (it is 1 line object)', added === 0,
    added + ' new mesh(es) added by the rain');
}

console.log('\n' + (fails === 0 ? 'ALL PHASE 2 TESTS PASSED' : fails + ' TEST(S) FAILED'));
if (fails) process.exit(1);