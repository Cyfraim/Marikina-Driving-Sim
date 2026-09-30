import * as THREE from "three";
const mk = () => ({ classList:{add(){},remove(){},toggle(){},contains(){return false;}}, style:{}, textContent:"", addEventListener(){} });
globalThis.document = { getElementById: () => mk(), createElement: () => mk(), head:{appendChild(){}} };
globalThis.window = {};
const { MissionSystem } = await import("../src/ui/MissionSystem.js");
const scene = new THREE.Scene();
const ms = new MissionSystem({
  vehicle: { rotation: 0, speed: 0, getSpeedKmhSigned: () => 0 },
});
ms.init(scene, null);
console.log("=== WAYPOINTS (scene units, snapped to real roads) ===");
for (const [k,v] of Object.entries(ms.pt)) {
  console.log("  " + k.padEnd(9) + " x=" + v.x.toFixed(1).padStart(8) + "  z=" + v.z.toFixed(1).padStart(8) + "   " + (v.road||"-"));
}
const sleep = (ms2)=>new Promise(r=>setTimeout(r,ms2));
ms.startCampaign();
console.log("");
console.log("M1 started, beacons=" + ms.beacons.length);
const t1 = ms.missions[0].target();
for(let i=0;i<10;i++) ms.update({x:t1.x,z:t1.z}, 1/60);
console.log("after sitting on M1 target 10 frames: scores=" + ms.scores.length + " (expect 1), totalTime=" + ms.totalTime.toFixed(2) + "s");
await sleep(2300);
console.log("after 2.3s wait: missionIndex=" + ms.missionIndex + " (expect 1), beacons=" + ms.beacons.length + " (expect 1)");
const t2 = ms.missions[1].target();
for(let i=0;i<10;i++) ms.update({x:t2.x,z:t2.z}, 1/60);
console.log("M2 done: scores=" + ms.scores.length + " (expect 2)");
await sleep(2300);
console.log("missionIndex=" + ms.missionIndex + " (expect 2 = City Loop), beacons=" + ms.beacons.length + " (expect 5 rings)");
for (const b of ms.beacons) { ms.update({x:b.x,z:b.z}, 1/60); }
await sleep(2300);
console.log("all rings: collected=" + ms.collected + ", scores=" + ms.scores.length);

// --- PHASE 3: M4 (Baha) - flood + timer ---
console.log("");
console.log("=== M4 'Baha! Evacuation Route' (flood) ===");
const m4 = ms.missions[ms.missionIndex];
console.log("mission=" + m4.name + ", flood flag=" + m4.flood);
console.log("flood visible=" + ms.floodGroup.visible + " (expect true)");
console.log("flood segments=" + ms.floodSegs.length + " (spec: 3)");
console.log("timer=" + ms.timerLeft.toFixed(0) + "s (spec: 180 = 3 min)");
const f0 = ms.floodSegs[0];
console.log("player in flood: " + ms.playerInFlood({ x: f0.x, z: f0.z }));
ms.game.vehicle.speed = 10;
ms.update({ x: f0.x, z: f0.z }, 1 / 60);
console.log("speed in flood: 10 -> " + ms.game.vehicle.speed.toFixed(2) + " (spec: 30%)");
const t4 = m4.target();
for (let i = 0; i < 10; i++) ms.update({ x: t4.x, z: t4.z }, 1 / 60);
console.log("M4 done: scores=" + ms.scores.length + " (expect 4)");
await sleep(2300);

// --- PHASE 3: M5 (School Run) - timer + school-zone penalty ---
console.log("");
console.log("=== M5 'Hatid Bata: School Run' (school zone) ===");
const m5 = ms.missions[ms.missionIndex];
console.log("mission=" + m5.name + ", school flag=" + m5.school);
console.log("timer=" + ms.timerLeft.toFixed(0) + "s (spec: 120 = 2 min)");
const sch = ms.pt.school;
console.log("school at (" + sch.x.toFixed(1) + "," + sch.z.toFixed(1) + ")");
console.log("in school zone at school: " + ms.inSchoolZone({ x: sch.x, z: sch.z }) + " (spec: 50 m)");
console.log("in school zone 200 m away: " + ms.inSchoolZone({ x: sch.x + 200, z: sch.z }));
const before = ms.timerLeft;
ms.tickSchoolZone({ x: sch.x, z: sch.z }, 40);   // 40 > 10 km/h
console.log("penalty: " + before.toFixed(0) + "s -> " + ms.timerLeft.toFixed(0) + "s (spec: -10 s)");
console.log("2nd call guarded: " + (ms.tickSchoolZone({ x: sch.x, z: sch.z }, 40) ? 'NO' : 'YES'));
console.log("slow driving not penalised: " +
  (ms.tickSchoolZone({ x: sch.x, z: sch.z }, 8) ? 'penalised' : 'no penalty'));
const t5 = m5.target();
for (let i = 0; i < 10; i++) ms.update({ x: t5.x, z: t5.z }, 1 / 60);
console.log("M5 done: scores=" + ms.scores.length + " (expect 5)");
await sleep(2300);

// --- PHASE 3: M6 (Palengke) - 3 crates, tapos i-deliver sa market ---
console.log("");
console.log("=== M6 'Palengke Delivery' (3 crates) ===");
const m6 = ms.missions[ms.missionIndex];
console.log("mission=" + m6.name + ", pickups=" + ms.pickups.length + " (spec: 3)");
console.log("pickups visible=" + ms.pickupGroup.visible + " (expect true)");
console.log("timer=" + ms.timerLeft.toFixed(0) + "s (spec: 240 = 4 min)");
for (const p of ms.pickups) {
  ms.update({ x: p.x, z: p.z }, 1 / 60);      // spec: within 5 m
  console.log("  crate (" + p.x.toFixed(0) + "," + p.z.toFixed(0) + ") taken=" + p.taken);
}
console.log("all 3 taken: " + ms.pickups.every((p) => p.taken));
const mkt = m6.target();                        // ngayon ay ang market
console.log("target is now the market: (" + mkt.x.toFixed(0) + "," + mkt.z.toFixed(0) + ")");
for (let i = 0; i < 10; i++) ms.update({ x: mkt.x, z: mkt.z }, 1 / 60);
console.log("M6 done: scores=" + ms.scores.length + " (expect 6)");
await sleep(2300);

// --- unlock + final completion screen ---
console.log("");
console.log("=== UNLOCK + FINAL SCREEN ===");
console.log("isLocked(3,4,5) with 5 done: " +
  [3, 4, 5].map((i) => ms.isLocked(i)).join(',') + " (expect false,false,false)");
ms.nextMission();
console.log("after last mission: allComplete=" + ms.allComplete);
console.log("FINAL scores: " +
  JSON.stringify(ms.scores.map((s) => ({ n: s.name.slice(0, 22), t: +s.seconds.toFixed(1) }))));
console.log("totalTime=" + ms.totalTime.toFixed(1) + "s = " + ms.formatTime(ms.totalTime));
console.log("");
console.log("RESULT: " + ms.scores.length + "/6 missions completed");
if (ms.scores.length < 6) { console.log("FAIL: not all 6 missions completed"); process.exit(1); }
console.log("ALL 6 MISSIONS COMPLETE");
console.log("FINAL scores: " + JSON.stringify(ms.scores.map(s=>({n:s.name.slice(0,18), t:+s.seconds.toFixed(1)}))));
console.log("totalTime=" + ms.totalTime.toFixed(1) + "s = " + ms.formatTime(ms.totalTime));