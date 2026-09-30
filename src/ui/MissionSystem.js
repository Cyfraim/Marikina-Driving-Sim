// ---------------------------------------------------------------------------
// MissionSystem.js - 3-mission campaign para sa Marikina Driving Simulator
//
// MGA MISSION:
//  1. "Hatid Padala: Nangka to Bayan"  - isang delivery, Nangka -> Bayan
//  2. "Lakad Marikina: Bayan to Sports Center"
//  3. "Marikina City Loop" - 5 checkpoint sa buong lungsod
//
// MGA PAALALA SA PAGBABAGO:
//  - Ang mga waypoint ay TUNAY NA GPS (lat/lon) at ginoconvert sa scene units
//    sa init() gamit ang gpsToLocal(). HINDI nang hard-coded ang scene units,
//    kaya gumagana pa rin kapag nagbago ang MAP_ORIGIN.
//  - Bawat waypoint ay SNAP-SNAP sa pinakamalapit na centerline ng kalsada.
//    Ang mga GPS ng landmark ay +/- 30 m lang mula sa kalsada, at walang
//    kalsada ang mismong coordinate - kaya magiging imposibleng matapos ang
//    mission kung walang snap. Ang snap ay inaayos sa gilid ng kalsada para
//    hindi maharap ang beacon.
//  - Mission 3 ay gumamit ng TORUS RINGS sa lupa (checkpoint), hindi beacon.
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { gpsToLocal, terrainHeight } from '../utils/geo.js';
import { ROAD_LINES, distToPolyline, nearestDistanceOnRoad } from '../utils/roadLayout.js';
import { getRoadGraph, RoadGraph, turnAngleAt, roadNameAt } from '../utils/RoadGraph.js';
import { WP_COLORS } from './Minimap.js';

const REACH_M = 15;          // kailan "naihatid" ang parcelo / napuntahan
const BEACON_H = 8;          // taas ng beacon (spec)
const BEACON_PERIOD = 1.5;   // segundo kada pulse (spec)
const RING_RADIUS = 8;       // radius ng checkpoint ring (spec)
const BRIEFING_DELAY = 2.0;  // ipinapakitang briefing 2 s matapos magsimula
const BRIEFING_AUTO = 5.0;   // sarili nang natatapos pagkatapos ng 5 s
const COMPLETE_SHOW = 3.0;   // overlay ng "MISSION COMPLETE" (spec)


// --- PHASE 3: flood, timers, school zone ---
const TIME_LIMIT = [0, 0, 0, 180, 120, 240];   // spec: M4=3min, M5=2min, M6=4min
const SCHOOL_ZONE_M = 50;      // spec: school zone radius
const SCHOOL_SPEED = 10;       // km/h
const SCHOOL_PENALTY = 10;     // spec: +10 s time penalty
const FLOOD_SLOW = 0.3;        // spec: 30% speed in a flooded road
const PICKUP_REACH = 5;        // spec: 5 m to collect a crate
// Ang misyon 4-6 ay NAKA-LOCK hangga't hindi natatapos ang 1-3.
const UNLOCK_AFTER = 3;

// --- FIX 3: GPS navigation -------------------------------------------------
const REPATH_INTERVAL = 5.0;  // recalculate kada 5 s (spec)
const OFF_ROUTE_M = 30;       // deviation > 30 m = recalculate (spec)
const TURN_EPS = 0.30;        // rad (~17 deg) - ito na lang ang "turn"
const TURN_SHARP = 1.05;      // rad (~60 deg) - sharp turn
// Mga glyph ng arrow (spec: ↑ ↗ → ↘ ↓ ↙ ← ↖)
const ARROWS = ['↑', '↗', '→', '↘', '↓', '↙', '←', '↖'];

/**
 * Glyph ng arrow mula sa turn angle (radyan, CCW positif).
 * 8 gang 45 deg: ↑ = 0 (patuloy), ganoon sa ↗ = -45 (kanan), → = -90, ...
 * Ang index ay kinakalkula mula sa pinakaagwat ng 22.5 deg.
 */
function arrowGlyph(ang) {
  // hanapin ang pinakamalapit na 8 gang
  const step = Math.PI / 4;
  let idx = Math.round(-ang / step);   // negatibo: CCW -> clockwise index
  idx = ((idx % 8) + 8) % 8;
  return ARROWS[idx];
}

// --- Mga GPS waypoint (lat, lon) ------------------------------------------
// ANG MGA ITO AY APPROXIMATE NA GPS NG MGA LANDMARK. Ang init() ang nagco-
// convert at nag-snap sa tunay na kalsada, kaya hindi kritikal ang eksaktong
// coordinate - ang KALIDAD ng kalsada sa bandang iyon ang mas mahalaga.
export const WAYPOINTS = {
  m1Start:   [14.6512, 121.1086], // Bayan-Bayanan Ave / H. Bautista St (Nangka)
  m1End:     [14.6508, 121.1070], // J. P. Rizal St / Bayan-Bayanan Ave (Bayan)
  m2End:     [14.6489, 121.1028], // Marikina Sports Center (mula sa brief)
  cathedral: [14.6533, 121.1051], // Marikina Cathedral
  smCity:    [14.6442, 121.1060], // SM City Marikina
  pritil:    [14.6479, 121.1131], // Pritil Bridge
  market:    [14.6530, 121.1103], // Marikina Public Market (Bayan)
  nangka:    [14.6508, 121.1080], // Nangka - pagsisimula (para sa loop)
  // --- PHASE 3: mga bagong waypoint (M4/M5/M6) ---
  school:   [14.6520, 121.1065], // Marikina Science High School (M5 target)
  ritao:    [14.6510, 121.1100], // Nangka halalan area (M6 pickup 1)
  halalan:  [14.6535, 121.1062], // Nangka halalan (M6 pickup 2)
  tubod:    [14.6495, 121.1050], // Nangka halalan (M6 pickup 3)
};

/** I-convert ang GPS sa scene units, tapos I-SNAP sa pinakamalapit na kalsada. */
function snapToRoad(lat, lon) {
  const p = gpsToLocal(lat, lon);
  let best = null;
  for (let i = 0; i < ROAD_LINES.length; i++) {
    const r = ROAD_LINES[i];
    // ang malalaking kalsada lang ang kailangan (huwag pumunta sa driveway)
    if (r.cls === 'service' || r.cls === 'track') continue;
    const d = distToPolyline(p.x, p.z, r.pts);
    if (!best || d < best.d) best = { d, i };
  }
  if (!best) return { x: p.x, z: p.z, snapped: false };
  const r = ROAD_LINES[best.i];
  const near = nearestDistanceOnRoad(best.i, p.x, p.z);
  // ilagay sa gilid ng kalsada (hindi sa centerline) para hindi maharap
  const off = r.half + 3.5;
  // hahanapin ang tunay na projection point para maging eksakto
  let bi = 0, bd = Infinity;
  for (let k = 0; k < r.pts.length; k++) {
    const d = Math.hypot(r.pts[k].x - p.x, r.pts[k].z - p.z);
    if (d < bd) { bd = d; bi = k; }
  }
  const q = r.pts[bi];
  const a = r.pts[Math.max(0, bi - 1)];
  const b = r.pts[Math.min(r.pts.length - 1, bi + 1)];
  const dx = b.x - a.x, dz = b.z - a.z;
  const l = Math.hypot(dx, dz) || 1;
  const nx = -dz / l, nz = dx / l;
  return {
    x: q.x + nx * off,
    z: q.z + nz * off,
    snapped: true,
    along: near.along,
    road: r.name || r.cls,
  };
}
export class MissionSystem {
  constructor(game) {
    this.game = game;
    this.scene = null;
    this.camera = null;
    this.audioCtx = null;
    this.group = null;        // THREE.Group na may mga beacon/ring
    this.beacons = [];
    this.active = false;
    this.missionIndex = -1;
    this.checkpoints = [];    // aktibong mission 3 checkpoints
    this.collected = 0;
    this.missionStartTime = 0;
    this.totalTime = 0;       // kabuuang oras ng 3 mission
    this.time = 0;
    this.completeUntil = 0;
    this.briefingUntil = 0;
    this.briefingShown = false;
    this.scores = [];
    this.completing = false;   // guard: bawal mag-complete nang sunod-sunod

    // HUD elements (maaaring null kapag wala ang DOM - para sa tools/tests)
    const el = (id) => (typeof document !== 'undefined' ? document.getElementById(id) : null);
    this.elName = el('mission-name');
    this.elTarget = el('mission-target');
    this.elLabel = el('mission-label');
    this.elDist = el('mission-dist');
    this.elArrow = el('mission-arrow');
    // FIX 3: turn-by-turn instruction (top-center) - nagsisilbing kapalit ng raw
    // distance habang may active na mission.
    this.elNav = el('nav-turn');
    this.elNavText = el('nav-turn-text');
    this.elNavArrow = el('nav-turn-arrow');
    this.elBriefing = el('mission-briefing');
    this.elBriefingTitle = el('mission-briefing-title');
    this.elBriefingText = el('mission-briefing-text');
    this.elTimer = el('mission-timer');
    this.elWarn = el('mission-warn');
    this.elMissionList = el('mission-list');
    this.elComplete = el('mission-complete');
    this.elCompleteTitle = el('mission-complete-title');
    this.elCompleteSub = el('mission-complete-sub');

    // Ang 3 mission, na-pre-solve na sa scene units sa init().
    this.missions = [
      {
        id: 'delivery',
        name: 'Hatid Padala: Nangka to Bayan',
        brief: 'May package na kailangang ihatid! Pumunta ka sa Bayan mula Nangka.',
        target: () => this.pt.m1End,
        targetLabel: 'Bayan',
        color: 0xffdd00,
        kind: 'beacon',
        complete: 'Naihatid na!',
      },
      {
        id: 'sports',
        name: 'Lakad Marikina: Bayan to Sports Center',
        brief: 'Magpatuloy sa Sports Center. Ingatan ang mga pedestrian!',
        target: () => this.pt.m2End,
        targetLabel: 'Sports Center',
        color: 0x00aaff,
        kind: 'beacon',
        complete: 'Nabot mo ang Sports Center!',
      },
      {
        id: 'loop',
        name: 'Marikina City Loop',
        brief: 'I-explore ang buong Marikina! Daanan ang lahat ng checkpoint.',
        target: null,
        targetLabel: 'Checkpoints',
        color: 0x00aaff,
        kind: 'rings',
        complete: 'MARIKINA EXPLORED! Tapos na ang laro!',
      },
      // --- PHASE 3: M4 - "Baha! Evacuation Route" ---------------------------
      // 3 min timer + 3 baha; 30% speed kapag nasa baha (spec).
      {
        kind: 'beacon', name: 'Baha! Evacuation Route',
        targetLabel: 'Marikina Sports Center',
        brief: 'Bumabaha na sa Marikina! Dalhin ang pamilya sa sports center. Iwasan ang mga baha!',
        color: 0x00e5ff,
        flood: true,          // i-activate ang flood mechanic
        complete: 'LIGTAS NA! Nakarating sa sports center!',
        // NOTE: arrow function - dahil method-shorthand ay bubindin ang `this`
        // sa mismong mission object, hindi sa MissionSystem.
        target: () => this.sports,
      },
      // --- PHASE 3: M5 - "Hatid Bata: School Run" --------------------------
      // 2 min timer; +10 s parusa kapag >10 km/h sa loob ng 50 m (spec).
      {
        kind: 'beacon', name: 'Hatid Bata: School Run',
        targetLabel: 'Marikina Science High School',
        brief: 'Huwag mahuli ang bata sa klase! Dalhin sa Marikina Science High School.',
        color: 0xffc400,
        school: true,         // i-activate ang school-zone mechanic
        complete: 'Nakarating sa tamang oras! Magaling na driver!',
        target: () => this.school,
      },
      // --- PHASE 3: M6 - "Palengke Delivery" -------------------------------
      // 3 pickup point (green crate) sa Nangka, tapos i-deliver sa market.
      {
        kind: 'pickup', name: 'Palengke Delivery',
        targetLabel: 'Marikina Public Market',
        brief: 'I-deliver ang tatlong kaha ng gulay sa Marikina Public Market bago mag-alas singko!',
        color: 0x66bb6a,
        pickups: ['ritao', 'halalan', 'tubod'],   // mga halalan/sari-sari store
        complete: 'Salamat! Kumpleto na ang delivery!',
        target: () => {
          // ang susunod na HINDI-PAUNANG pickup, o ang market kapos nakuha lahat
          if (this.pickups) {
            const next = this.pickups.find((p) => !p.taken);
            if (next) return { x: next.x, z: next.z };
          }
          return this.market;
        },
      },
    ];
  }

  /** Tawag-tawag ng Game sa simula (isang beses). */
  init(scene, camera) {
    this.scene = scene;
    this.camera = camera;

    // i-solve ang lahat ng waypoint sa scene units
    this.pt = {};
    for (const [k, [la, lo]] of Object.entries(WAYPOINTS)) this.pt[k] = snapToRoad(la, lo);

    // PHASE 3: ang scene ay kailangan para sa 3D flood water plane at crates
    this.setupFlood(scene);
    this.setupPickups(scene);
    this.sports = this.pt.m2End;   // evacuation center para sa M4
    this.school = this.pt.school;  // paaralan para sa M5
    this.renderMissionList();

    this.group = new THREE.Group();
    this.group.name = 'missions';
    scene.add(this.group);

    // Web Audio: kailangan ng user gesture bago magbukas ang context
    this.bindBriefingDismiss();
    this.hideAllOverlays();
    this.setHudName('');
    return this;
  }

  /** Gumawa ng AudioContext sa unang click (tinatawag ng browser policy). */
  ensureAudio() {
    if (this.audioCtx) return;
    const AC = typeof window !== 'undefined'
      ? (window.AudioContext || window.webkitAudioContext)
      : null;
    if (!AC) return;
    try { this.audioCtx = new AC(); } catch { this.audioCtx = null; }
  }

  /** Maikling beep. `freq` Hz, `dur` segundo. */
  beep(freq, dur = 0.5, type = 'sine', gain = 0.16) {
    if (!this.audioCtx) return;
    try {
      const t0 = this.audioCtx.currentTime;
      const osc = this.audioCtx.createOscillator();
      const g = this.audioCtx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, t0);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(gain, t0 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      osc.connect(g).connect(this.audioCtx.destination);
      osc.start(t0);
      osc.stop(t0 + dur + 0.02);
    } catch { /* audio ay optional - huwag i-crash ang laro */ }
  }

  /** Fanfare: 3 beep na umaakyat (spec para sa Mission 3). */
  fanfare() {
    [523.25, 659.25, 880.0].forEach((f, i) => {
      setTimeout(() => this.beep(f, 0.5, 'triangle', 0.18), i * 320);
    });
  }

  // =========================================================================
  // BUHAY NG MGA BEACON / RING
  // =========================================================================

  clearMarkers() {
    for (const b of this.beacons) {
      if (b.mesh && b.mesh.parent) b.mesh.parent.remove(b.mesh);
      if (b.mesh && b.mesh.geometry) b.mesh.geometry.dispose();
    }
    this.beacons.length = 0;
  }

  /** Vertical light beacon: cylinder, 8 m, translucent. */
  makeBeacon(x, z, color) {
    const geo = new THREE.CylinderGeometry(2.2, 2.2, BEACON_H, 18, 1, true);
    const mat = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.55,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, terrainHeight(x, z) + BEACON_H / 2, z);
    this.group.add(mesh);

    // maliit na umbok sa itaas para kitang-hinahawag mula sa malayo
    const capGeo = new THREE.SphereGeometry(1.4, 12, 8);
    const cap = new THREE.Mesh(capGeo, new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.8, depthWrite: false,
    }));
    cap.position.set(x, terrainHeight(x, z) + BEACON_H, z);
    this.group.add(cap);
    return { mesh, cap, kind: 'beacon', x, z, y: terrainHeight(x, z) };
  }

  /** Checkpoint ring: torus sa lupa, radius 8 m. */
  makeRing(x, z, color) {
    const geo = new THREE.TorusGeometry(RING_RADIUS, 0.45, 8, 40);
    const mat = new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.85, depthWrite: false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.x = -Math.PI / 2;   // patahin sa lupa
    mesh.position.set(x, terrainHeight(x, z) + 0.35, z);
    this.group.add(mesh);

    // pangalawang panaloob na ring para mas makita ang "checkpoint"
    const inner = new THREE.Mesh(
      new THREE.TorusGeometry(RING_RADIUS * 0.55, 0.3, 8, 32),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.5, depthWrite: false })
    );
    inner.rotation.x = -Math.PI / 2;
    inner.position.set(x, terrainHeight(x, z) + 0.5, z);
    this.group.add(inner);
    return { mesh, inner, kind: 'ring', x, z, y: terrainHeight(x, z), taken: false };
  }

  // =========================================================================
  // FLOW NG MISSION
  // =========================================================================

  /** Simulan ang campaign (mula sa "START MISSIONS"). */
  startCampaign() {
    this.ensureAudio();
    this.active = true;
    this.missionIndex = -1;
    this.collected = 0;
    this.totalTime = 0;
    this.scores = [];
    this.completing = false;   // huwag manaig ang guard mula sa nakaraang run
    this.nextMission();
  }

  /** Free Roam: walang mission, basta mag-drive. */
  startFreeRoam() {
    this.ensureAudio();
    this.active = false;
    this.clearMarkers();
    this.hideAllOverlays();
    this.setHudName('FREE ROAM');
    if (this.elTarget) this.elTarget.classList.add('hidden');
    // FIX 3: sa free roam, WALANG nav HUD pero NASA minimap (spec)
    this.clearNav();
  }

  nextMission() {
    this.missionIndex++;
    this.clearMarkers();
    if (this.missionIndex >= this.missions.length) {
      this.finishCampaign();
      return;
    }
    const m = this.missions[this.missionIndex];
    this.activeMission = m;
    this.missionStartTime = this.time;
    this.setHudName(m.name);

    // PHASE 3: i-reset ang state ng bawat mechanic
    this.setFloodVisible(false);
    this.setPickupsVisible(false);
    this.schoolPenalized = false;
    if (this.pickups) for (const p of this.pickups) { p.taken = false; p.group.visible = true; }
    this.setTimer(TIME_LIMIT[this.missionIndex] || 0);

    if (m.kind === 'pickup') {
      // PHASE 3 M6: 3 crate, tapos i-deliver sa market. Ang unang crate lang
      // ang may beacon (ang susunod ay magiging target kapos nakolekta).
      this.setPickupsVisible(true);
      const t = m.target();
      this.beacons.push(this.makeBeacon(t.x, t.z, 0xffdd00));
    } else if (m.kind === 'beacon') {
      let t = m.target();
      // PHASE 3 safety net: huwag i-crash kung may nawawalang waypoint.
      if (!t || t.x === undefined) {
        console.warn('[MissionSystem] missing target for mission', m.name);
        this.nextMission();
        return;
      }
      this.beacons.push(this.makeBeacon(t.x, t.z, m.color));
      // PHASE 3 M4: i-activate ang baha
      if (m.flood) this.setFloodVisible(true);
    } else {
      // Mission 3: 5 checkpoint na nakakalat sa buong lungsod, sa pagkakasunod
      const order = ['cathedral', 'smCity', 'pritil', 'market', 'nangka'];
      for (const k of order) {
        const p = this.pt[k];
        this.beacons.push(this.makeRing(p.x, p.z, m.color));
      }
      this.collected = 0;
    }
    this.showBriefing(m);
    this.renderMissionList();
  }

  finishCampaign() {
    this.clearMarkers();
    this.setHudName('');
    this.hideAllOverlays();
    this.setFloodVisible(false);
    this.setPickupsVisible(false);
    this.setTimer(0);
    this.renderMissionList();
    // PHASE 3: "MARIKINA MASTER!" kapag lahat ng 6 ay tapos na
    this.showComplete(
      this.allComplete ? 'MARIKINA MASTER! Natapos mo ang lahat ng misyon!'
                       : 'MARIKINA EXPLORED! Tapos na ang laro!',
      this.formatTime(this.totalTime),
      true
    );
    this.fanfare();
  }

  formatTime(sec) {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  // =========================================================================
  // UI HELPERS
  // =========================================================================

  setHudName(text) {
    if (this.elName) this.elName.textContent = text;
  }

  hideAllOverlays() {
    if (this.elBriefing) this.elBriefing.classList.add('hidden');
    if (this.elComplete) this.elComplete.classList.add('hidden');
    if (this.elTarget) this.elTarget.classList.add('hidden');
    // FIX 3: itago ang nav HUD kapag walang active na mission
    if (this.elNav) this.elNav.classList.add('hidden');
  }

  bindBriefingDismiss() {
    if (!this.elBriefing) return;
    this.elBriefing.addEventListener('click', () => {
      this.elBriefing.classList.add('hidden');
      this.briefingUntil = 0;
    });
  }

  /** Briefing popup: lumitaw 2 s matapos magsimula, masisira sa click o 5 s. */
  showBriefing(m) {
    this.briefingShown = true;
    this.briefingAt = this.time + BRIEFING_DELAY;
    this.briefingUntil = this.time + BRIEFING_DELAY + BRIEFING_AUTO;
    if (this.elBriefingTitle) this.elBriefingTitle.textContent = m.name.toUpperCase();
    if (this.elBriefingText) this.elBriefingText.textContent = m.brief;
    if (this.elBriefing) this.elBriefing.classList.add('hidden'); // ipinapakita sa update()
  }

  showComplete(title, sub, isScore = false) {
    if (this.elCompleteTitle) this.elCompleteTitle.textContent = title;
    if (this.elCompleteSub) {
      this.elCompleteSub.textContent = isScore
        ? `Kabuuang oras: ${sub}`
        : sub;
    }
    if (this.elComplete) this.elComplete.classList.remove('hidden');
    this.completeUntil = this.time + (isScore ? 1e9 : COMPLETE_SHOW);
  }

  // =========================================================================
  // UPDATE - tinatawag ng Game kada frame
  // =========================================================================

  // =========================================================================
  // FIX 3 - GPS NAVIGATION (A* sa tunay na kalsada)
  // =========================================================================

  /**
   * Itakda ang aktibong navigation target (waypoint) + kulay ng minimap.
   *
   * FIX 3 - PERF: ang dating bersyon ay naglalagay ng `navRepathAt = 0` sa
   * BAWAT FRAME (dahil tinatawag ito mula sa update()), kaya naka-force ang
   * A* kada frame - mabigat sa 25k-node graph. Ngayon, ang repath ay AWSA
   * lumilipat sa bagong target (o kung kulang ang route), hindi kada frame.
   */
  setNavTarget(target, color) {
    const same = this.navTarget && target &&
                 Math.abs(this.navTarget.x - target.x) < 0.5 &&
                 Math.abs(this.navTarget.z - target.z) < 0.5;
    this.navTarget = target;
    this.navColor = color || this.navColor || WP_COLORS.m1;
    if (!same) {
      this.route = null;
      this.navRepathAt = 0;     // force repath para sa BAGONG target
      this.navTurn = null;
    }
  }

  /** Itigil ang navigation (free roam, o mission tapos na). */
  clearNav() {
    this.navTarget = null;
    this.route = null;
    this.navTurn = null;
    if (this.elNav) this.elNav.classList.add('hidden');
    const mm = this.game && this.game.minimap;
    if (mm && mm.clearNav) mm.clearNav();
  }

  /**
   * Kalkulahin ang route ngayon (A*) at i-push sa minimap.
   * Ginawa itong lazy ang graph - ang unang A* (~25 ms) lang ang nagbu-build.
   */
  repath(playerPos) {
    if (!this.navTarget || !playerPos) return;
    const g = getRoadGraph();
    const raw = g.findPath(playerPos.x, playerPos.z, this.navTarget.x, this.navTarget.z);
    if (!raw) { this.route = null; return; }
    this.route = RoadGraph.simplify(raw);
    const mm = this.game && this.game.minimap;
    if (mm && mm.setNav) mm.setNav(this.route, this.navTarget, this.navColor);
  }

  /**
   * Ano ang susunod na turn sa kasalukuyang posisyon?
   * Hinahanap ang pinakamalapit na punto ng route, tapos ang SUSUNOD na
   * makabulugang kanto (sa itaas ng TURN_EPS).
   * @returns {{text:string, arrow:string, dist:number}|null}
   */
  computeTurn(playerPos) {
    if (!this.route || this.route.length < 2 || !this.navTarget) return null;
    const g = getRoadGraph();
    // index ng pinakamalapit na punto ng route
    let bi = 0, bd = Infinity;
    for (let i = 0; i < this.route.length; i++) {
      const d = (this.route[i].x - playerPos.x) ** 2 + (this.route[i].z - playerPos.z) ** 2;
      if (d < bd) { bd = d; bi = i; }
    }
    const remain = Math.hypot(this.route[this.route.length - 1].x - playerPos.x,
                              this.route[this.route.length - 1].z - playerPos.z);
    if (remain <= REACH_M) return { text: 'You have arrived!', arrow: '🎉', dist: 0 };

    // hanapin ang susunod na kanto
    for (let i = bi + 1; i < this.route.length - 1; i++) {
      const ang = turnAngleAt(this.route, i);
      if (Math.abs(ang) < TURN_EPS) continue;   // patuloy lang, hindi kanto
      const node = this.route[i];
      const dist = Math.round(Math.hypot(node.x - playerPos.x, node.z - playerPos.z));
      const road = roadNameAt(g, this.route, i) || roadNameAt(g, this.route, i - 1);
      const name = road || 'the road';
      const left = ang > 0;
      // FIX: ang dating `word` ay isang NO-OP ternary (parehong 'Turn left'),
      // kaya LAGING "Turn left" ang ipinapakita kahit kaliwa o kanan. Ginawa
      // nating itong totoo: kaliwa = positive angle (CCW sa XZ plane).
      const word = left ? 'Turn left' : 'Turn right';
      return {
        text: `${word} on ${name} in ${dist}m`,
        arrow: arrowGlyph(ang),
        dist,
        left,
      };
    }
    // walang kanto na natatira = tuwid papunta sa destination
    const road = roadNameAt(g, this.route, this.route.length - 2) || 'the road';
    return {
      text: `Continue straight on ${road}`,
      arrow: '↑',
      dist: Math.round(remain),
    };
  }

  /** I-update ang nav HUD + repath kapag kailangan. */
  tickNav(playerPos, dt) {
    if (!this.navTarget) {
      if (this.elNav) this.elNav.classList.add('hidden');
      return;
    }
    // repath kada 5 s, o kapag >30 m na layo sa route (spec)
    let needRepath = this.time >= this.navRepathAt;
    if (this.route && !needRepath) {
      // off-route check: dist sa route polyline > 30 m
      const d = this.distToRoute(playerPos);
      if (d > OFF_ROUTE_M) needRepath = true;
    }
    if (needRepath) {
      this.repath(playerPos);
      this.navRepathAt = this.time + REPATH_INTERVAL;
    }

    if (!this.elNav) return;
    const turn = this.computeTurn(playerPos);
    this.elNav.classList.remove('hidden');
    if (turn) {
      this.elNavText.textContent = turn.text;
      this.elNavArrow.textContent = turn.arrow;
    } else {
      this.elNavText.textContent = 'Calculating route...';
      this.elNavArrow.textContent = '↑';
    }
  }

  /** Pinakamalapit na distansya mula sa point sa route polyline. */
  distToRoute(p) {
    if (!this.route || this.route.length < 2) return Infinity;
    let best = Infinity;
    for (let i = 0; i < this.route.length - 1; i++) {
      const a = this.route[i], b = this.route[i + 1];
      const dx = b.x - a.x, dz = b.z - a.z;
      const l2 = dx * dx + dz * dz;
      let t = l2 ? ((p.x - a.x) * dx + (p.z - a.z) * dz) / l2 : 0;
      t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(p.x - (a.x + dx * t), p.z - (a.z + dz * t));
      if (d < best) best = d;
    }
    return best;
  }

  // =========================================================================

  // =========================================================================
  // PHASE 3 - FLOOD (M4)
  // =========================================================================

  /**
   * I-takda ang 3 BAHAGI ng kalsadang malapit sa Marikina River bilang
   * BAHALA (flooded). Ang bawat isa ay may blue water plane (spec).
   */
  setupFlood(scene) {
    if (this.floodGroup) return;
    this.floodGroup = new THREE.Group();
    this.floodGroup.name = 'flood';
    scene.add(this.floodGroup);
    // malapit sa ilog (RIVER_X = 860 sa utils/geo.js), bahagyang kaliit pa
    const spots = [
      { x: 700, z: 200, len: 60, ang: 0 },
      { x: 760, z: -150, len: 60, ang: 0.4 },
      { x: 640, z: 480, len: 60, ang: -0.3 },
    ];
    this.floodSegs = [];
    for (const sp of spots) {
      const g = new THREE.Group();
      const plane = new THREE.Mesh(
        new THREE.PlaneGeometry(sp.len, 16),
        new THREE.MeshStandardMaterial({
          color: 0x1e88e5, transparent: true, opacity: 0.55,
          roughness: 0.15, metalness: 0.2, side: THREE.DoubleSide,
        })
      );
      plane.rotation.x = -Math.PI / 2;
      plane.position.y = terrainHeight(sp.x, sp.z) + 0.06;
      g.add(plane);
      g.position.set(sp.x, 0, sp.z);
      g.rotation.y = sp.ang;
      this.floodGroup.add(g);
      this.floodSegs.push({ ...sp, group: g, plane });
    }
    this.floodGroup.visible = false;
  }

  setFloodVisible(v) { if (this.floodGroup) this.floodGroup.visible = !!v; }

  /** Nasa baha ba ang player? (para sa speed reduction + warning) */
  playerInFlood(playerPos) {
    if (!this.floodSegs) return false;
    for (const f of this.floodSegs) {
      if (Math.hypot(playerPos.x - f.x, playerPos.z - f.z) < f.len / 2) return true;
    }
    return false;
  }

  // =========================================================================
  // PHASE 3 - PICKUP CRATES (M6)
  // =========================================================================

  /** 3 GREEN CRATE sa lupa (spec: "green crate box on the ground"). */
  setupPickups(scene) {
    if (this.pickupGroup) return;
    this.pickupGroup = new THREE.Group();
    this.pickupGroup.name = 'pickups';
    scene.add(this.pickupGroup);
    this.pickups = [];
    const m = this.missions.find((x) => x.kind === 'pickup');
    if (!m) return;
    // PHASE 3: itakda ang delivery target (ang market) - kailangan ng
    // `target()` pagkatapos ng 3 crate.
    this.market = this.pt.market;
    for (const key of m.pickups) {
      const p = this.pt[key];
      if (!p) continue;
      const g = new THREE.Group();
      const crate = new THREE.Mesh(
        new THREE.BoxGeometry(1.1, 0.8, 1.1),
        new THREE.MeshStandardMaterial({ color: 0x2e7d32, roughness: 0.8 })
      );
      // ang gulay ay nakikita sa itaas ng crate
      const veg = new THREE.Mesh(
        new THREE.SphereGeometry(0.32, 6, 5),
        new THREE.MeshStandardMaterial({ color: 0x66bb6a, roughness: 0.7 })
      );
      veg.position.y = 0.55;
      g.add(crate, veg);
      g.position.set(p.x, terrainHeight(p.x, p.z) + 0.4, p.z);
      this.pickupGroup.add(g);
      this.pickups.push({ x: p.x, z: p.z, group: g, taken: false });
    }
    this.pickupGroup.visible = false;
  }

  setPickupsVisible(v) { if (this.pickupGroup) this.pickupGroup.visible = !!v; }

  /** Nasunod ba ang player sa isang pickup? (spec: within 5 m) */
  tickPickups(playerPos) {
    if (!this.pickups || !this.activeMission || this.activeMission.kind !== 'pickup') return 0;
    let got = 0;
    for (const p of this.pickups) {
      if (p.taken) continue;
      if (Math.hypot(playerPos.x - p.x, playerPos.z - p.z) <= PICKUP_REACH) {
        p.taken = true;
        p.group.visible = false;
        got++;
        this.beep(880, 0.15, 'triangle', 0.16);
      }
    }
    return got;
  }
  // =========================================================================
  // PHASE 3 - TIMER (M4/M5/M6)
  // =========================================================================

  setTimer(seconds) {
    this.timerLimit = seconds || 0;
    this.timerLeft = this.timerLimit;
    if (this.elTimer) this.elTimer.classList.toggle('hidden', !this.timerLimit);
    this.updateTimerEl();
  }

  updateTimerEl() {
    if (!this.elTimer || !this.timerLimit) return;
    const t = Math.max(0, this.timerLeft);
    const m = Math.floor(t / 60);
    const sec = Math.floor(t % 60);
    this.elTimer.textContent = `${m}:${String(sec).padStart(2, '0')}`;
    this.elTimer.classList.toggle('urgent', t < 30);
  }

  tickTimer(dt) {
    if (!this.timerLimit || !this.active) return;
    this.timerLeft -= dt;
    this.updateTimerEl();
    if (this.timerLeft <= 0) { this.timerLeft = 0; this.failMission('Nakatimes! Subukan muli.'); }
  }

  failMission(msg) {
    if (this.completing) return;
    this.completing = true;
    this.clearMarkers();
    this.setFloodVisible(false);
    this.setPickupsVisible(false);
    this.setTimer(0);
    this.hideAllOverlays();
    this.showComplete('MISSION FAILED', msg);
    this.beep(220, 0.6, 'sawtooth', 0.18);
    setTimeout(() => {
      this.completing = false;
      this.missionIndex = 0;
      this.startMission(0);
    }, 2600);
  }

  // =========================================================================
  // PHASE 3 - SCHOOL ZONE (M5)
  // =========================================================================

  /** Nasa school zone ba? (spec: within 50 m of the school) */
  inSchoolZone(playerPos) {
    const s = this.pt.school;
    if (!s) return false;
    return Math.hypot(playerPos.x - s.x, playerPos.z - s.z) <= SCHOOL_ZONE_M;
  }

  /**
   * Masyadong mabilis ba sa school zone? -> warning + 10 s penalty.
   * @returns {boolean} true kung may nangyaring parusa
   */
  tickSchoolZone(playerPos, kmh) {
    if (!this.activeMission || !this.activeMission.school) return false;
    if (!this.inSchoolZone(playerPos)) { this.schoolPenalized = false; return false; }
    if (kmh <= SCHOOL_SPEED) { this.schoolPenalized = false; return false; }
    if (this.schoolPenalized) return false;    // huwagulit ang parusa
    this.schoolPenalized = true;
    this.timerLeft -= SCHOOL_PENALTY;             // spec: +10 s
    this.updateTimerEl();
    this.beep(300, 0.3, 'square', 0.16);
    this.schoolWarnUntil = this.time + 3;
    return true;
  }

  // =========================================================================
  // PHASE 3 - MISSION SELECT / UNLOCK
  // =========================================================================

  /** Naka-lock ba? (M4-6 ay naka-lock hanggang matapos ang 1-3) */
  isLocked(index) {
    return index >= UNLOCK_AFTER && this.scores.length < UNLOCK_AFTER;
  }

  /** I-render ang mission list sa start screen (may padlock para sa locked). */
  renderMissionList() {
    const el = this.elMissionList;
    if (!el) return;
    let html = '';
    for (let i = 0; i < this.missions.length; i++) {
      const m = this.missions[i];
      const locked = this.isLocked(i);
      const done = i < this.scores.length;
      html += '<div class="mission-row' + (locked ? ' locked' : '') + '">' +
        '<span class="mi">' + (locked ? '&#128274;' : (i + 1)) + '</span>' +
        '<span class="mn">' + m.name + '</span>' +
        (done ? '<span class="mdone">&#10003;</span>' : '') + '</div>';
    }
    el.innerHTML = html;
  }

  /** Lahat na ba ang 6 misyon? -> "MARIKINA MASTER!" */
  get allComplete() {
    return this.missions.every((m, i) => i < this.scores.length);
  }

  // =========================================================================

  update(playerPos, dt = 1 / 60) {
    this.time += dt;
    if (!this.active) {
      // briefing/complete overlay ay dapat tumatago pa rin sa free roam
      this.tickOverlays();
      return;
    }

    // FIX 3: GUARD. Ang susunod na mission ay nagsisimula sa setTimeout(2 s),
    // kaya sa dalawang frame na ito ay NASA PA RIN ang player sa target at
    // muling mag-tatanggap ng `completeMission`. Bago, nangyayari ito kada
    // frame: 400+ na "MISSION COMPLETE", 400 entries sa scores, at
    // totalTime na 1,336 s. Ito ang humihinto sa double/triple-complete.
    if (this.completing) {
      this.tickOverlays();
      return;
    }

    const m = this.missions[this.missionIndex];
    if (!m) return;

    // 1) briefing popup: lumitaw 2 s matapos magsimula ang mission
    if (this.briefingShown && this.elBriefing && this.time >= this.briefingAt) {
      this.elBriefing.classList.remove('hidden');
    }

    // 2) pulse animation ng beacon / ring
    this.animateMarkers();

    // 3) progress check
    if (m.kind === 'pickup') {
      // PHASE 3 M6: kunin ang gulay (5 m), tapos i-deliver sa market
      const got = this.tickPickups(playerPos);
      const t = m.target();           // ang susunod na crate, o ang market
      const d = Math.hypot(playerPos.x - t.x, playerPos.z - t.z);
      const done = this.pickups.every((p) => p.taken);
      this.setTargetHud(m, d, playerPos, t,
        done ? 'I-deliver sa palengke' : `Nakuha: ${this.pickups.filter((p) => p.taken).length}/3 na gulay`);
      this.setNavTarget(t, WP_COLORS.m1);
      if (got > 0) this.moveBeaconTo(0, t);   // ilipat ang beacon sa susunod
      if (d <= REACH_M) this.completeMission(m);
    } else if (m.kind === 'beacon') {
      const t = m.target();
      const d = Math.hypot(playerPos.x - t.x, playerPos.z - t.z);
      this.setTargetHud(m, d, playerPos, t);
      // FIX 3: M1 = yellow, M2 = blue (spec). Ang minimap at GPS ay sumusunod
      // sa aktibong beacon.
      this.setNavTarget(t, this.missionIndex === 0 ? WP_COLORS.m1 : WP_COLORS.m2);
      if (d <= REACH_M) this.completeMission(m);
    } else {
      this.tickRings(m, playerPos);
    }

    // --- PHASE 3: timer + school zone + flood -----------------------------
    this.tickTimer(dt);
    const veh = this.game && this.game.vehicle;
    const kmh = veh ? Math.abs(veh.getSpeedKmhSigned ? veh.getSpeedKmhSigned() : 0) : 0;
    if (m.school && this.tickSchoolZone(playerPos, kmh)) {
      this.flashWarn('SCHOOL ZONE! Bagalan!');
    }
    if (m.flood && this.playerInFlood(playerPos)) {
      // spec: speed 30% + "BAHA! Bumalik ka!"
      if (veh) veh.speed *= FLOOD_SLOW;
      this.flashWarn('BAHA! Bumalik ka!');
    }

    // FIX 3: GPS navigation (repath kada 5 s / kapag off-route, turn HUD)
    this.tickNav(playerPos, dt);
    this.tickOverlays();
  }

  /** I-ilipat ang beacon `idx` sa bagong (x,z) - para sa M6 na magpapalit. */
  moveBeaconTo(idx, p) {
    const b = this.beacons[idx];
    if (!b) return;
    b.x = p.x; b.z = p.z;
    if (b.mesh) b.mesh.position.set(p.x, terrainHeight(p.x, p.z), p.z);
    if (b.cap) b.cap.position.set(p.x, terrainHeight(p.x, p.z), p.z);
  }

  /** Pansamantalang pula na mensahe sa HUD (spec: "BAHA!", "SCHOOL ZONE!"). */
  flashWarn(text) {
    if (!this.elWarn) return;
    this.elWarn.textContent = text;
    this.elWarn.classList.remove('hidden');
    this.warnUntil = this.time + 3;
  }

  animateMarkers() {
    // sine wave sa opacity (beacon) at scale 0.95-1.05 (ring) - spec
    const t = this.time;
    const pulse = 0.5 + 0.5 * Math.sin((t / BEACON_PERIOD) * Math.PI * 2);
    for (const b of this.beacons) {
      if (b.taken) continue;
      if (b.kind === 'beacon') {
        const o = 0.25 + 0.45 * pulse;
        b.mesh.material.opacity = o;
        b.cap.material.opacity = 0.4 + 0.5 * pulse;
        b.cap.scale.setScalar(0.9 + 0.25 * pulse);
      } else {
        const s = 0.95 + 0.10 * pulse;
        b.mesh.scale.setScalar(s);
        b.inner.scale.setScalar(1 / s);
        b.mesh.material.opacity = 0.5 + 0.4 * pulse;
      }
    }
  }

  tickRings(m, playerPos) {
    // susunod na hindi pa nasisimulan na ring = ang aktibong target
    const next = this.beacons.find((b) => !b.taken);
    // FIX 3: ang minimap at GPS ay sumusunod sa SUSUNOD na checkpoint (M3 = blue)
    if (next) this.setNavTarget({ x: next.x, z: next.z }, WP_COLORS.m3);
    this.setTargetHud(m, 0, playerPos, next, `${this.collected}/${this.beacons.length}`);
    if (!next) return;
    const d = Math.hypot(playerPos.x - next.x, playerPos.z - next.z);
    if (d <= REACH_M) {
      next.taken = true;
      this.collected++;
      this.beep(660, 0.25, 'sine', 0.14);
      if (this.collected >= this.beacons.length) this.completeMission(m);
    }
  }

  setTargetHud(m, dist, playerPos, target, overrideLabel) {
    if (!this.elTarget) return;
    this.elTarget.classList.remove('hidden');
    if (overrideLabel) {
      this.elLabel.textContent = `${overrideLabel}`;
    } else {
      this.elLabel.textContent = `\u{1F3AF} ${m.targetLabel}`;
    }
    this.elDist.textContent = `${Math.round(dist)}m`;

    //ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â§ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â®ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â­ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¥ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¤ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â´: i-rotate sa direksyon ng target, na-relative sa heading ng kotse
    if (this.elArrow && target) {
      const worldAng = Math.atan2(target.x - playerPos.x, target.z - playerPos.z);
      const carAng = this.game && this.game.vehicle ? this.game.vehicle.rotation : 0;
      let rel = worldAng - carAng;
      while (rel > Math.PI) rel -= Math.PI * 2;
      while (rel < -Math.PI) rel += Math.PI * 2;
      this.elArrow.style.transform = `rotate(${-rel * 180 / Math.PI}deg)`;
    }
  }

  tickOverlays() {
    // PHASE 3: itago ang pansamantalang warning pagkatapos ng 3 s
    if (this.elWarn && !this.elWarn.classList.contains('hidden') &&
        this.time > (this.warnUntil || 0)) {
      this.elWarn.classList.add('hidden');
    }
    // auto-dismiss ng briefing pagkatapos ng 5 s
    if (this.briefingShown && this.elBriefing &&
        !this.elBriefing.classList.contains('hidden') && this.time > this.briefingUntil) {
      this.elBriefing.classList.add('hidden');
    }
    // auto-dismiss ng complete overlay pagkatapos ng 3 s (maliban sa score)
    if (this.elComplete && !this.elComplete.classList.contains('hidden') &&
        this.time > this.completeUntil) {
      this.elComplete.classList.add('hidden');
    }
  }

  completeMission(m) {
    // FIX 3: i-set ang guard para hindi mag-complete nang paulit-ulit habang
    // nasa target pa rin ang player (ang susunod ay setTimeout sa 2 s).
    if (this.completing) return;
    this.completing = true;
    const dur = this.time - this.missionStartTime;
    this.totalTime += dur;
    this.scores.push({ name: m.name, seconds: dur });
    this.clearMarkers();
    this.setFloodVisible(false);
    this.setPickupsVisible(false);
    this.setTimer(0);
    if (this.elWarn) this.elWarn.classList.add('hidden');
    this.hideAllOverlays();
    this.briefingShown = false;
    this.showComplete('MISSION COMPLETE!', m.complete);
    this.beep(440, 0.5, 'sine', 0.2);
    // 2 s pagkatapos, susunod na mission
    setTimeout(() => {
      this.completing = false;
      if (this.active) this.nextMission();
    }, 2000);
  }
}
/** Isinusing ang mission CSS sa page (idempotent). */