// ---------------------------------------------------------------------------
// boundary.js - Invisible na hangganan para sa kotse
//
// Dalawang uri ng hadlang (WALANG visible mesh - collision/force lang):
// 1) ROAD CONFINEMENT - para sa likod ng kalsada (para hindi makapasok sa
//    mga building o sa berdeng lote sa pagitan ng kalsada)
// 2) MAP BOUNDARY - square na paligid ng buong mapa (para hindi lumabas
//    sa empty space)
//
// Physics: SOFT muna (malakas na opposing force, parang nababanga ang kerb),
// saka HARD clamp kapag malalim na sa loob ng labas.
// ---------------------------------------------------------------------------

// Square boundary ng buong mapa.
//
// FIX 2: ang map ay lumipat sa Nangka (1200 m) patungong sa BUONG Marikina
// City. Nasuri ang aktuwal na extents ng roadData.js:
//   x -2692 .. +3769 m,  z -4223 .. +4112 m
// Kailangan ng MAP_BOUND na sakopin ang lahat ng kalsada, kaya 4500 m
// (±4500 = 9000 x 9000 m square) - mas malaki pa sa 4223 m na pinakamalayo.
export const MAP_BOUND = 4500;
const CAR_HALF = 1.4;        // half-width ng kotse (para hindi mag-cling sa gilid)

// --- Drivable corridor (Fix 1 follow-up) ---
// Ang kotse ay HINDI dapat makapasok sa corridor na ito: dito nakatayo ang
// mga poste, ilaw, puno at kanal. Kung pumasok ang box dito, naiipit ang
// kotse (speed *= -0.3 bawat frame) - yan ang "invisible wall" sa screenshot.
// KERB_ROOM: maliit na allowance para kayang i-mount ang curb.
export const KERB_ROOM = 0.3;
export const CAR_HALF_WIDTH = 1.0; // half ng 2 m wide car box

// Road confinement tuning (metres, mula sa gilid ng kalsada)
export const KERB_SOFT = 2.0;   // dito nagsisimula ang push-back force
export const KERB_HARD = 6.0;   // dito hard-clamp na + zero ang velocity
const SOFT_PUSH = 26.0;         // lakas ng push-back (m/s^2)
const SOFT_DRAG = 1.6;          // bumabagal habang nasa labas (per second)

/**
 * Spatial grid ng mga kalsada para mabilis ang "saan ako malapit na
 * kalsada?" lookup kada frame (139 roads x ~4000 segments = masyadong marami
 * para i-scan bawat frame).
 */
export class RoadConfinement {
  // Ang search radius ay MALAKI (150 m) dahil dapat HINDI ma-null ang query
  // kahit lumabas na nang marami ang kotse - kung null, mawawala ang
  // confinement at makakapasok sa walang-lupa na espasyo. Kaya naka-granular
  // ang cell (40 m) para mabilis pa rin ang lookup.
  constructor(roads, { cell = 40, search = 150 } = {}) {
    this.cell = cell;
    this.search = search;
    this.roads = roads;
    this.grid = new Map();
    this._build();
  }

  key(cx, cz) { return `${cx},${cz}`; }

  _build() {
    for (const road of this.roads) {
      const pts = road.pts;
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i];
        const b = pts[i + 1];
        // drivable half-width: asphalt + kerb room. HINDI kasama ang bangketa -
        // dito nakatayo ang poste/ilaw/puno/kanal, kaya dapat manatili ang
        // kotse sa loob ng ASPHALT (Fix 1 invisible-wall fix).
        const limit = (road.profile ? road.profile.carriageWidth / 2 : road.half) + KERB_ROOM;
        // NOTE: i-remember ang road index - kailangan para malaman kung
        // ANG KALSAYANG inyakan ay ibang kalsada (cross-road conflict).
        // Kasama rin ang TANGENT (direksyon ng kalsada) - stable ito kahit
        // ilipat ang kotse sa kabilang gilid (unlike the normal, which
        // flips 180 deg). Ito ang ginagamit ng heading alignment.
        const dx = b.x - a.x, dz = b.z - a.z;
        const l = Math.hypot(dx, dz) || 1;
        const seg = { a, b, limit, ri: road.i, tx: dx / l, tz: dz / l };
        // ilagay sa lahat ng cells na tinatakpan ng segment (+ search radius)
        const pad = this.search + limit;
        const c0 = Math.floor((Math.min(a.x, b.x) - pad) / this.cell);
        const c1 = Math.floor((Math.max(a.x, b.x) + pad) / this.cell);
        const d0 = Math.floor((Math.min(a.z, b.z) - pad) / this.cell);
        const d1 = Math.floor((Math.max(a.z, b.z) + pad) / this.cell);
        for (let cx = c0; cx <= c1; cx++) {
          for (let cz = d0; cz <= d1; cz++) {
            const k = this.key(cx, cz);
            let list = this.grid.get(k);
            if (!list) { list = []; this.grid.set(k, list); }
            list.push(seg);
          }
        }
      }
    }
  }

  /**
   * Lahat ng kalsadang saklaw ang posisyon (x, z).
   *
   * BUG NA HINULING DITO: ang dating `query()` ay nagbabalik ng PINAKA-
   * MALAPIT na kalsada lang. Eto ang sanhi ng "invisible wall" sa gitna ng
   * Bayan-Bayanan Avenue: kapag bahagyang nag-drift ang kotse, nakakahanap
   * ito ng mas maliit na side road (limit 6 m) kahit ang mismong kalsada
   * ay malaki (limit 10 m) at nasa loob pa rin ang kotse. Resulta: naiipit
   * ang kotse sa kalsadang wala nang hadlang.
   *
   * FIX: isinama ang LAHAT ng kalsada sa range at piliin ang pinaka-
   * MALAWAK na limit (i.e. "okay ka dito" kung loob ka man kahit isa).
   * `nearest` ay pinakamaliit na distansya (para sa push-back direction).
   */
  queryAll(x, z, nearestOnly = false) {
    const c0 = Math.floor((x - this.search) / this.cell);
    const c1 = Math.floor((x + this.search) / this.cell);
    const d0 = Math.floor((z - this.search) / this.cell);
    const d1 = Math.floor((z + this.search) / this.cell);
    let nearest = null;   // pinakamalapit (para sa push direction)
    let bestRoom = null;  // pinakamaliit na (dist - limit) = pinaka-permissive
    const seen = new Set(); // dedupe: isang polyline ay naka-many segments
    for (let cx = c0; cx <= c1; cx++) {
      for (let cz = d0; cz <= d1; cz++) {
        const list = this.grid.get(this.key(cx, cz));
        if (!list) continue;
        for (const s of list) {
          const { a, b, limit, ri, tx, tz } = s;
          const dx = b.x - a.x;
          const dz = b.z - a.z;
          const l2 = dx * dx + dz * dz;
          let t = l2 ? ((x - a.x) * dx + (z - a.z) * dz) / l2 : 0;
          t = Math.max(0, Math.min(1, t));
          const px = a.x + dx * t;
          const pz = a.z + dz * t;
          const ox = x - px;
          const oz = z - pz;
          const dist = Math.hypot(ox, oz);
          const key = `${ri}:${a.x},${a.z}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const rec = {
            dist, px, pz, ri, limit,
            nx: dist > 1e-6 ? ox / dist : 0,
            nz: dist > 1e-6 ? oz / dist : 0,
            over: dist - limit, // <= 0 => nasa loob ng kalsadang ito
            // heading ng kalsada (atan2(tx, tz)) - stable, unlike the normal
            roadHeading: Math.atan2(tx, tz),
          };
          if (!nearest || dist < nearest.dist) nearest = rec;
          if (!bestRoom || rec.over < bestRoom.over) bestRoom = rec;
        }
      }
    }
    if (!bestRoom) return null;
    // Ang diagnostics/tests ay humihingi ng TUNAY na pinakamalapit.
    if (nearestOnly) {
      const r = { ...nearest };
      r.inside = r.dist <= r.limit;
      return r;
    }
    // Ibalik ang pinakamaperositibong kalsada, pero ang push direction ay
    // mula sa PINAKAMALAPIT (doon ka talaga papuntahin).
    return { ...bestRoom, nearestDist: nearest.dist, nearestRi: nearest.ri };
  }

  /**
   * BACKWARDS-COMPATIBLE: "pinakamalapit" na kalsada.
   * Ito lang ang ginagamit ng diagnostics/tests. Ang actual physics ay gumagamit
   * ng queryAll() (pinakamaperositibo) - tingnan applyRoadConfinement.
   */
  query(x, z) {
    return this.queryAll(x, z, true);
  }
}

/**
 * I-apply ang road confinement sa isang posisyon. Mula sa `near` ang
 * push-back vector { px, pz } at ang hard-clamp flag.
 * Gumagalaw ang `pos` in-place.
 */
export function applyRoadConfinement(confinement, pos, delta, lastGood = null) {
  // FIX: queryAll() = pinakamaperositibong kalsada. Ang dating query() (pinaka-
  // MALAPIT) ang sanhi ng invisible wall - pumipili ito ng maliit na side road
  // (limit 6 m) kahit nasa loob pa ng wide road (limit 10 m) ang kotse.
  const near = confinement.queryAll(pos.x, pos.z);
  if (!near) {
    // WALANG kalsada sa 150 m - kumpara sa LAST na kilalang nasa kalsada.
    // Ito ang safety net: puwedeng mangyari kung biglaang tumalon/kailangang
    // i-teleport, at hindi dapat maging "free pass" papunta sa void.
    if (lastGood) {
      const dx = lastGood.x - pos.x;
      const dz = lastGood.z - pos.z;
      const d = Math.hypot(dx, dz) || 1;
      return {
        pushX: (dx / d) * SOFT_PUSH, pushZ: (dz / d) * SOFT_PUSH,
        hard: false, offRoad: true, drag: -SOFT_DRAG, strayed: true,
      };
    }
    return { pushX: 0, pushZ: 0, hard: true, offRoad: true, strayed: true };
  }
  // Ang `over` ay batay sa PINAKAMAPERSITIBONG kalsada. Kung <= 0, nasa loob
  // ang kotse kahit man kahit sa alin man kalsada - walang push.
  const over = near.over;
  if (over <= KERB_SOFT) {
    // nasa loob pa (o kaunti lang ang labas) - walang action
    return { pushX: 0, pushZ: 0, hard: false, offRoad: false };
  }
  // Positive magnitude; negate the outward normal para pabalik sa kalsada.
  const push = Math.min(1, (over - KERB_SOFT) / (KERB_HARD - KERB_SOFT));
  const px = -near.nx * push * SOFT_PUSH;
  const pz = -near.nz * push * SOFT_PUSH;
  const hard = over >= KERB_HARD;
  if (hard) {
    // clamp papunta sa gilid ng kalsada (sa loob ng corridor)
    pos.x = near.px - near.nx * 0.1;
    pos.z = near.pz - near.nz * 0.1;
  }
  return { pushX: px, pushZ: pz, hard, offRoad: true, drag: -SOFT_DRAG * push };
}

/** Clamp sa square boundary ng mapa. Zero ang velocity component na tinamaan. */
export function clampToMap(pos) {
  let hit = false;
  const lim = MAP_BOUND - CAR_HALF;
  if (pos.x > lim) { pos.x = lim; hit = true; }
  if (pos.x < -lim) { pos.x = -lim; hit = true; }
  if (pos.z > lim) { pos.z = lim; hit = true; }
  if (pos.z < -lim) { pos.z = -lim; hit = true; }
  return hit;
}
