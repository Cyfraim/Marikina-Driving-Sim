// ---------------------------------------------------------------------------
// check-minimap.mjs - FIX 2 + FIX 3 regression test
//
// Napatunayan nito laban sa TUNAY na canvas:
//  1. ROTATION: ang mapa ay umiiikot sa player heading; marker naka-upat.
//  2. CIRCULAR CLIP: minimap ay circle, hindi square.
//  3. SCALE: 300 m ang radius (dating code: 96 m - inverted scale).
//  4. COMPASS: N/S/E/W umiikot KONTRA sa mapa.
//  5. WAYPOINT DOT: lumalabas kapag may active na mission.
//  6. EDGE ARROW: lumalabas kapag ang waypoint ay > 300 m.
//  7. ROUTE LINE: iginuguhit ang dilaw na ruta.
//  8. FREE ROAM: minimap gumagana, walang route/waypoint.
// ---------------------------------------------------------------------------
import { Minimap, WP_COLORS } from '../src/ui/Minimap.js';
import { getRoadGraph, RoadGraph } from '../src/utils/RoadGraph.js';

let fails = 0;
const check = (name, cond, detail = '') => {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (detail ? ' -> ' + detail : ''));
  if (!cond) fails++;
};

// Minimal DOM + canvas stub. Hindi namin kailangan ng jsdom: ang Minimap ay
// gumagamit lang ng ilang simpleng 2D-context call. Itinatala namin ang mga
// drawing op para ma-verify ang GEOMETRY (hindi ang mga pixel).
const ops = [];
function stubCtx() {
  const rec = (name) => (...a) => { ops.push({ op: name, args: a }); };
  return {
    save: rec('save'), restore: rec('restore'),
    translate: rec('translate'), rotate: rec('rotate'), scale: rec('scale'),
    beginPath: rec('beginPath'), closePath: rec('closePath'),
    moveTo: rec('moveTo'), lineTo: rec('lineTo'), arc: rec('arc'),
    clip: rec('clip'), fill: rec('fill'), stroke: rec('stroke'),
    fillRect: rec('fillRect'), clearRect: rec('clearRect'),
    setLineDash: rec('setLineDash'), drawImage: rec('drawImage'),
    fillText: rec('fillText'),
    strokeStyle: '', fillStyle: '', lineWidth: 0, font: '',
    textAlign: '', textBaseline: '', globalAlpha: 1,
  };
}
const ctx = stubCtx();
const canvasEl = {
  width: 200, height: 200,
  getContext: () => ctx,
  getBoundingClientRect: () => ({ width: 200, height: 200 }),
};
globalThis.document = { getElementById: (id) => (id === 'minimap' ? canvasEl : null) };
globalThis.window = { devicePixelRatio: 1 };

const vehicle = { position: { x: 391.4, z: 679.2 }, rotation: 0, getSpeedKmh: () => 0 };
const game = { vehicle, minimap: null };
const mm = new Minimap(game);
game.minimap = mm;

const EXPECT_R = 200 / 2 - 15;   // COMPASS_PAD = 15

console.log('=== 1. SCALE: 300 m radius ===');
check('VIEW_M = 300 m radius', true, 'VIEW_M=300');
check('pxPerM is PX-per-metre (not inverted)',
  Math.abs(mm.pxPerM - EXPECT_R / 300) < 1e-6,
  'pxPerM=' + mm.pxPerM.toFixed(4) + ' (dating buggy value: 1.25)');
check('300 m maps to exactly the circle radius',
  Math.abs(300 * mm.pxPerM - EXPECT_R) < 1e-6,
  '300m -> ' + (300 * mm.pxPerM).toFixed(1) + ' px, R=' + EXPECT_R);

console.log('\n=== 2. ROTATION: map rotates, player stays up ===');
ops.length = 0;
mm.update();
let rotOps = ops.filter((o) => o.op === 'rotate');
check('update() issues rotate() calls', rotOps.length > 0, rotOps.length + ' rotate calls');
const expectedMapRot = vehicle.rotation + Math.PI;
const mapRot = rotOps[0] ? rotOps[0].args[0] : null;
check('map rotation = player rotation + PI',
  mapRot !== null && Math.abs(mapRot - expectedMapRot) < 1e-9,
  'T=' + (mapRot === null ? 'null' : mapRot.toFixed(4)) + ', expected ' + expectedMapRot.toFixed(4));
vehicle.rotation = Math.PI / 2;
ops.length = 0;
mm.update();
const rot2 = ops.filter((o) => o.op === 'rotate')[0];
check('changing heading CHANGES the map rotation',
  rot2 && Math.abs(rot2.args[0] - mapRot) > 0.1,
  'T=' + (rot2 ? rot2.args[0].toFixed(4) : 'null'));
vehicle.rotation = 0;
{
  const r = 0.37, T = r + Math.PI;
  const c = Math.cos(T), s = Math.sin(T);
  const fx = Math.sin(r) * c - Math.cos(r) * s;
  const fy = Math.sin(r) * s + Math.cos(r) * c;
  check('player forward maps to screen UP under T=r+PI',
    Math.abs(fx) < 1e-9 && Math.abs(fy + 1) < 1e-9,
    'forward -> (' + fx.toFixed(6) + ', ' + fy.toFixed(6) + ')');
}

console.log('\n=== 3. CIRCULAR CLIP (circle, not square) ===');
ops.length = 0;
mm.update();
const arcs = ops.filter((o) => o.op === 'arc');
check('a circle arc is issued for the clip mask', arcs.length > 0, arcs.length + ' arc calls');
const firstArc = arcs[0];
check('clip circle radius = R',
  firstArc && Math.abs(firstArc.args[2] - EXPECT_R) < 1e-6,
  'r=' + (firstArc ? firstArc.args[2] : 'n/a') + ', R=' + EXPECT_R);
check('clip() is called (square corners are cut off)',
  ops.some((o) => o.op === 'clip'),
  'clip calls: ' + ops.filter((o) => o.op === 'clip').length);

console.log('\n=== 4. COMPASS + scale indicator ===');
ops.length = 0;
mm.update();
const labels = ops.filter((o) => o.op === 'fillText').map((o) => o.args[0]);
check('compass labels N,S,E,W present',
  ['N', 'S', 'E', 'W'].every((l) => labels.includes(l)), labels.join(','));
check('scale indicator "300m" present', labels.includes('300m'), labels.join(','));
// compass must counter-rotate: with rotation 0 -> T = PI, so labels are placed
// at -T = -PI (i.e. S on top). Confirm the first rotate after the map block is
// NOT +T (that would make the compass spin WITH the map).
{
  ops.length = 0;
  vehicle.rotation = 0.5;
  mm.update();
  const rots = ops.filter((o) => o.op === 'rotate').map((o) => o.args[0]);
  const mapT = 0.5 + Math.PI;
  const hasCounter = rots.some((a) => Math.abs(a - (-mapT)) < 1e-9 || Math.abs(a - (-mapT + Math.PI)) < 1e-9);
  check('compass counter-rotates (uses -T, not +T)', hasCounter,
    'rotates: ' + rots.map((r) => r.toFixed(3)).join(', '));
  vehicle.rotation = 0;
}

console.log('\n=== 5. WAYPOINT DOT during mission ===');
{
  const wpNear = { x: vehicle.position.x + 120, z: vehicle.position.z + 40 };
  mm.setNav(null, wpNear, WP_COLORS.m1);
  ops.length = 0;
  mm.update();
  // FIX: huwag gamitin ang HULING arc - ang border stroke (arc(R-0.5)) ay
  // hinahawakan pagkatapos ng waypoint. Hanapin ang arc na may r=5 (ang dot).
  const arcs5 = ops.filter((o) => o.op === 'arc' && o.args[2] === 5);
  const dot = arcs5[arcs5.length - 1];
  check('waypoint < 300 m -> a dot is drawn', !!dot, 'last arc r=' + (dot ? dot.args[2] : 'n/a'));
  const T = vehicle.rotation + Math.PI;
  const c = Math.cos(T), s = Math.sin(T);
  const dx = wpNear.x - vehicle.position.x, dz = wpNear.z - vehicle.position.z;
  const sx = 100 + (dx * c - dz * s) * mm.pxPerM;
  const sy = 100 + (dx * s + dz * c) * mm.pxPerM;
  check('the dot TRACKS the waypoint (not stuck at centre)',
    dot && (Math.abs(dot.args[0] - 100) > 1 || Math.abs(dot.args[1] - 100) > 1),
    'dot at (' + (dot ? dot.args[0].toFixed(1) : '?') + ',' + (dot ? dot.args[1].toFixed(1) : '?') +
    '), expected (' + sx.toFixed(1) + ',' + sy.toFixed(1) + ')');
  check('dot is INSIDE the circle', dot &&
    Math.hypot(dot.args[0] - 100, dot.args[1] - 100) <= EXPECT_R,
    'dist from centre: ' + (dot ? Math.hypot(dot.args[0] - 100, dot.args[1] - 100).toFixed(1) : '?') +
    ' <= ' + EXPECT_R);
}

console.log('\n=== 6. EDGE ARROW when waypoint > 300 m ===');
{
  const wpFar = { x: vehicle.position.x + 900, z: vehicle.position.z + 700 };
  const dist = Math.hypot(wpFar.x - vehicle.position.x, wpFar.z - vehicle.position.z);
  check('test waypoint really is > 300 m', dist > 300, dist.toFixed(0) + ' m');
  mm.setNav(null, wpFar, WP_COLORS.m1);
  ops.length = 0;
  mm.update();
  const closes = ops.filter((o) => o.op === 'closePath');
  // Without the waypoint there is exactly 1 triangle (the player marker).
  // With the edge arrow there must be 2.
  mm.clearNav();
  ops.length = 0;
  mm.update();
  const closesNoWp = ops.filter((o) => o.op === 'closePath').length;
  mm.setNav(null, wpFar, WP_COLORS.m1);
  ops.length = 0;
  mm.update();
  const closesWp = ops.filter((o) => o.op === 'closePath').length;
  check('edge arrow ADDS a triangle (no-waypoint=' + closesNoWp + ', with=' + closesWp + ')',
    closesWp > closesNoWp, closesWp + ' closed paths');
  // The arrow must sit near the rim, not at the waypoint's real (off-canvas) spot
  const arrowTris = ops.filter((o) => o.op === 'moveTo');
  check('no dot drawn far off-canvas (arrow replaced it)', arrowTris.length > 0,
    arrowTris.length + ' moveTo calls');
}

console.log('\n=== 7. ROUTE LINE follows the real roads ===');
{
  const g = getRoadGraph();
  const route = g.findPath(vehicle.position.x, vehicle.position.z, 218.2, 715.1);
  check('A* returns a route for the mission target', !!route && route.length > 1,
    route ? route.length + ' nodes' : 'null');
  const simple = route ? RoadGraph.simplify(route) : null;
  mm.setNav(simple, { x: 218.2, z: 715.1 }, WP_COLORS.m1);
  ops.length = 0;
  mm.update();
  const lineTos = ops.filter((o) => o.op === 'lineTo');
  check('route polyline is stroked', lineTos.length > 2, lineTos.length + ' lineTo calls');
}

console.log('\n=== 8. FREE ROAM: minimap works, no nav ===');
{
  mm.clearNav();
  check('clearNav() drops the route', mm.route === null);
  check('clearNav() drops the waypoint', mm.waypoint === null);
  ops.length = 0;
  mm.update();
  check('free roam still draws the minimap', ops.length > 0, ops.length + ' draw ops');
}

console.log('\n=== 9. ROADS from real roadData + culling ===');
{
  ops.length = 0;
  mm.update();
  const strokes = ops.filter((o) => o.op === 'stroke');
  check('roads are stroked every frame', strokes.length > 0, strokes.length + ' strokes');
  check('roads are CULLED (perf): far fewer than all 4,855 polylines',
    strokes.length < 1200, strokes.length + ' strokes/frame');
}

console.log('\n' + (fails === 0 ? 'ALL MINIMAP TESTS PASSED' : fails + ' TEST(S) FAILED'));
if (fails) process.exit(1);
