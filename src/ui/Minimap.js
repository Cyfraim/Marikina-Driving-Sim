// ---------------------------------------------------------------------------
// Minimap.js - GTA-style ROTATING minimap (FIX 2)
//
// Pag-andari: ang kotse ay NAKA-UPAT sa gitna, at ang MAPA UMIIKOT sa ilalim
// nito. Ito ay hindi "north-up" - kasi ang manununo ay nanghahabol ng papalit.
// Ang tanging nakikita nang umaikot ay ang mga kalsada, at sila ay lumilikot
// laban sa player marker na nakatigil sa gitna.
//
// FIX 2 - BUG NA HINDI NATANONG: ang dating scale ay INVERTED.
//   ctx.scale(VIEW_M / SIZE, ...) = scale(1.25) - pero ang ctx.scale ay
//   kailangan ng PX-PER-METRE, hindi metre-per-pixel. Ang tunay na factor ay
//   SIZE / VIEW_M = 0.8. Resulta: 300 m ay naging 375 px sa 240 px canvas, kaya
//   ang aktuwal na radius ay 96 m lamang - 3x mas maliit kaysa sa sinasabi.
//   Ngayon ay SIZE_px / VIEW_M ang ginagamit, kaya 300 m talaga ang nakikita.
// ---------------------------------------------------------------------------
import { MAP_ORIGIN } from '../world/roadData.js';
import { ROAD_LINES } from '../utils/roadLayout.js';
import { loadSatelliteImage, hasApiKey, metersPerPixel } from '../utils/mapLoader.js';
import { satelliteGrid } from '../utils/satelliteGrid.js';

const VIEW_M = 300;        // radius (m) ng nakikitang mundo  (spec)
const SIZE = 200;         // minimap size (CSS px) - spec: 200x200
// FIX 2: ang COMPASS (N/S/E/W) ay nasa LABAS ng circle (spec), kaya kailangan
// ng espasyo sa loob ng canvas para sa labels. Kung R = 100 (buong 200 px),
// mapupunta sa labas ng canvas ang compass. Kaya may COMPASS_PAD.
const COMPASS_PAD = 15;
const TILE = { zoom: 16, size: 640 };

// Mga kulay
const BG = '#101a12';
const ROAD_MINOR = '#5c6b60';
const ROAD_MAJOR = '#c8ccc4';
const ROUTE = '#ffd23f';      // bright yellow route line (spec)
const BORDER = 'rgba(255,255,255,0.85)';
const COMPASS = 'rgba(255,255,255,0.9)';

// Mga kulay ng waypoint kada mission (spec)
export const WP_COLORS = {
  m1: '#ffd23f',     // yellow
  m2: '#3fa9ff',     // blue
  m3: '#3fa9ff',     // blue (checkpoints)
};

export class Minimap {
  constructor(game) {
    this.game = game;
    this.canvas = document.getElementById('minimap');
    this.ctx = this.canvas.getContext('2d');
    this.size = SIZE;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = SIZE * this.dpr;
    this.canvas.height = SIZE * this.dpr;

    this.satellite = null;
    this.satelliteTiles = [];
    this.gridCenter = null;
    this.gridLoading = false;
    this.gridRetryAt = 0;
    this.usingSatellite = false;
    this.tileMPerPx = metersPerPixel(MAP_ORIGIN.lat, TILE.zoom);
    // FIX 2: PX-PER-METRE (dating: metre-per-pixel = inverted, 96 m radius).
    // Tinatakda muli sa update() mula sa aktuwal na R, pero ito ang default.
    this.pxPerM = (SIZE / 2 - COMPASS_PAD) / VIEW_M;
    this.vp = { w: SIZE, h: SIZE };
    this.updateViewport();

    // FIX 3: ang GPS route (mula sa RoadGraph) na iguguhit dito
    this.route = null;
    this.waypoint = null;
    this.wpColor = WP_COLORS.m1;

    this.load();
  }

  // Para lang kontekto; ang HUD CSS ang nagdecide ng laki ngayon
  updateViewport() {
    const r = this.canvas.getBoundingClientRect();
    if (r.width > 0) {
      this.vp.w = r.width;
      this.vp.h = r.height;
    }
  }

  /** Itakda ang route (world points) at waypoint para iguhit. */
  setNav(route, waypoint, color) {
    this.route = route && route.length > 1 ? route : null;
    this.waypoint = waypoint || null;
    if (color) this.wpColor = color;
  }

  clearNav() {
    this.route = null;
    this.waypoint = null;
  }

  // Kunin ang satellite tile (async, may fallback kapag walang key/error)
  async load() {
    if (!hasApiKey()) {
      this.usingSatellite = false;
      return;
    }
    const p = this.game.vehicle?.position || { x: 0, z: 0 };
    return this.refreshSatellite(p);
  }

  async refreshSatellite(position, { enabled = hasApiKey, loadImage = loadSatelliteImage } = {}) {
    if (this.gridLoading || Date.now() < this.gridRetryAt || !enabled()) return;
    const center = { x: position.x, z: position.z };
    if (this.gridCenter && Math.hypot(center.x - this.gridCenter.x, center.z - this.gridCenter.z) <= 500) return;
    this.gridLoading = true;
    try {
      const tiles = satelliteGrid(center.x, center.z, TILE.zoom, TILE.size);
      await Promise.all(tiles.map(async tile => {
        tile.image = await loadImage({ center: tile.center, zoom: TILE.zoom,
          width: TILE.size, height: TILE.size, mapType: 'satellite' });
      }));
      if (tiles.every(tile => tile.image)) {
        // Swap atomically: never draw an incomplete new grid over the old one.
        this.satelliteTiles = tiles;
        this.gridCenter = center;
        this.usingSatellite = true;
      } else this.gridRetryAt = Date.now() + 60000;
    } catch (error) {
      console.warn('[Minimap] Satellite grid unavailable; retaining vector/previous grid.', error);
      this.gridRetryAt = Date.now() + 60000;
    } finally {
      this.gridLoading = false;
    }
  }

  update() {
    const v = this.game.vehicle;
    if (!v) return;
    void this.refreshSatellite(v.position);
    const ctx = this.ctx;
    const W = this.vp.w, H = this.vp.h;
    const cx = W / 2, cy = H / 2;
    // FIX 2: radius ng circle = half ng canvas MINUS ang espasyo para sa
    // compass labels sa labas. Ito rin ang batayan ng scale: 300 m = R px.
    const R = Math.min(W, H) / 2 - COMPASS_PAD;
    this.pxPerM = R / VIEW_M;      // 300 m ay eksaktong R px

    ctx.save();
    ctx.scale(this.dpr, this.dpr);
    ctx.clearRect(0, 0, W, H);

    // --- CIRCULAR CLIP MASK (spec) -----------------------------------------
    // Kinakailangan ito bago mag-draw ng kalsada, para ang mga kalsadang
    // lumalabas sa labas ng circle ay TINATAMPOK (hindi square na hangganan).
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.clip();

    ctx.fillStyle = this.usingSatellite ? '#20303a' : BG;
    ctx.fillRect(0, 0, W, H);

    // --- ROTATION: ang MAPA ang umiiikot, hindi ang marker ------------------
    // Ang convention ng Vehicle: forward = (sin(r), cos(r)). Ang gusto natin
    // ay mapuntahan ito sa (0,-1) = pataas sa screen.
    //   solve: x' = sin r cos T - cos r sin T = 0  ->  T = r
    //          y' = sin r sin T + cos r cos T = -1 ->  T = r + PI
    // kaya ang rotation ay T = r + PI.
    const T = v.rotation + Math.PI;

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(T);
    ctx.scale(this.pxPerM, this.pxPerM);   // FIX 2: px-per-metre, hindi ang baligtad
    // ngayon ang mga coordinate ay METRO, at ang player ay nasa (0,0)

    if (this.usingSatellite) this.drawSatellite(v);
    this.drawRoads(v);

    ctx.restore();  // babalik sa CSS-pixel space, naka-center pa rin

    // --- PHASE 1B: NPC vehicles bilang maliliit na PUTING DOTS ------------
    this.drawNpcDots(v, cx, cy, R, T);

    // --- PHASE 2A: traffic lights bilang maliliit na KULAY na dots -------
    this.drawLightDots(v, cx, cy, R, T);

    // --- GPS route + waypoint (FIX 3) --------------------------------------
    if (this.route) this.drawRoute(cx, cy, R, T);
    if (this.waypoint) this.drawWaypoint(v, cx, cy, R, T);

    ctx.restore();  // alisin ang circular clip

    // --- player marker: NAKA-UPAT sa gitna, puti (spec) ---------------------
    this.drawPlayer(cx, cy);

    // --- COMPASS: N/S/E/W sa labas ng circle (spec) -------------------------
    // Ibinabalik ang rotation kaya "nananatili" ang mga label habang umiiikot
    // ang mapa sa ilalim nila.
    this.drawCompass(cx, cy, R, T);

    // --- scale indicator "300m" sa ibaba (spec) -----------------------------
    this.drawScale(W, H);
    if (this.usingSatellite) this.drawSatelliteAttribution(W, H);

    // --- THIN WHITE BORDER sa paligid ng circle (spec) -----------------------
    ctx.beginPath();
    ctx.arc(cx, cy, R - 0.5, 0, Math.PI * 2);
    ctx.strokeStyle = BORDER;
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.restore();
  }

  // Satellite tile, naka-center sa player at naka-zoom sa VIEW_M
  // NOTE: nasa loob na ito ng rotate+scale transform, kaya METRO ang unit.
  drawSatellite(v) {
    const ctx = this.ctx;
    // scale: tile pixel -> minimap pixel
    if (this.satelliteTiles?.length) {
      for (const tile of this.satelliteTiles) {
        ctx.drawImage(tile.image, tile.minX - v.position.x, tile.minZ - v.position.z,
          tile.maxX - tile.minX, tile.maxZ - tile.minZ);
      }
      return;
    }
    const scale = this.tileMPerPx;
    const w = TILE.size * scale;
    // player pos sa tile pixel (tile center = MAP_ORIGIN = scene 0,0)
    const imgX = TILE.size / 2 + v.position.x / this.tileMPerPx;
    const imgY = TILE.size / 2 + v.position.z / this.tileMPerPx;
    ctx.drawImage(this.satellite, -imgX * scale, -imgY * scale, w, w);
  }

  drawSatelliteAttribution(W, H) {
    // Keep source attribution visible outside the rotating/circular clip.
    // Distinct provider credits can vary by tile; show each source footer.
    if (!this.attribution) {
      this.attribution = document.createElement('div');
      this.attribution.style.cssText = 'position:absolute;right:0;top:100%;background:#fff;width:640px;max-width:calc(100vw - 24px);overflow:auto;max-height:72px;z-index:2;line-height:0;';
      this.canvas.parentElement?.appendChild(this.attribution);
    }
    if (this.attributionGrid === this.satelliteTiles) return;
    this.attributionGrid = this.satelliteTiles;
    this.attribution.replaceChildren();
    for (const tile of this.satelliteTiles) {
      const footer = document.createElement('canvas');
      footer.width = tile.image.naturalWidth || TILE.size;
      footer.height = 24;
      footer.style.cssText = 'display:block;';
      footer.getContext('2d').drawImage(tile.image, 0, (tile.image.naturalHeight || TILE.size) - 24,
        footer.width, 24, 0, 0, footer.width, 24);
      this.attribution.appendChild(footer);
    }
  }

  // Vector: tunay na kalsada mula sa roadData (naka-rotate na ang context)
  //
  // FIX 2 - CULLING: ang dating bersyon ay nag-draw ng LAHAT ng 4,855
  // polyline kada frame. Ngayon ay tinitapon ang malayo (>VIEW_M) gamit ang
  // AABB at ang box-to-player distance. Kasi naka-rotate ang context, hindi
  // na tayo makapag-decide ng screen-space, kaya METRO (world space) ang
  // culling - tama pa rin dahil distance-preserving ang rotation.
  drawRoads(v) {
    const ctx = this.ctx;
    const px = v.position.x, pz = v.position.z;
    const reach = VIEW_M + 40;   // metro; konting margin para sa half-width
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    for (const r of ROAD_LINES) {
      // 1) cheap AABB reject
      if (r.maxX + reach < px || r.minX - reach > px ||
          r.maxZ + reach < pz || r.minZ - reach > pz) continue;
      // 2) circle test: dist(player, box) <= reach ?
      const bx = (r.minX + r.maxX) / 2, bz = (r.minZ + r.maxZ) / 2;
      const hx = (r.maxX - r.minX) / 2, hz = (r.maxZ - r.minZ) / 2;
      const ddx = Math.max(Math.abs(px - bx) - hx, 0);
      const ddz = Math.max(Math.abs(pz - bz) - hz, 0);
      if (Math.hypot(ddx, ddz) > reach) continue;

      const major = r.cls === 'primary' || r.cls === 'secondary';
      ctx.strokeStyle = major ? ROAD_MAJOR : ROAD_MINOR;
      ctx.lineWidth = Math.max(1.5, r.half * 2);
      ctx.beginPath();
      ctx.moveTo(r.pts[0].x - px, r.pts[0].z - pz);
      for (let i = 1; i < r.pts.length; i++) {
        ctx.lineTo(r.pts[i].x - px, r.pts[i].z - pz);
      }
      ctx.stroke();
    }
  }

  // FIX 3: bright yellow GPS route na sumusunod sa TUNAY na kalsada (A* path)
  drawRoute(cx, cy, R, T) {
    const ctx = this.ctx;
    const v = this.game.vehicle;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(T);
    ctx.scale(this.pxPerM, this.pxPerM);
    ctx.strokeStyle = ROUTE;
    ctx.lineWidth = 3 / this.pxPerM;          // ~3 px mananalap sa anumang zoom
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    let started = false;
    for (const p of this.route) {
      const dx = p.x - v.position.x, dz = p.z - v.position.z;
      if (Math.hypot(dx, dz) > VIEW_M + 150) { started = false; continue; }
      if (!started) { ctx.moveTo(dx, dz); started = true; }
      else ctx.lineTo(dx, dz);
    }
    ctx.stroke();
    ctx.restore();
  }

  // PHASE 1B: Mga NPC vehicle bilang maliliit na puting dots sa minimap.
  // Naka-rotate sa parehong T ng mapa, at culled sa 300 m (mas maliit sa
  // CULL_M ng NPC manager na 500 m - sa minimap hindi na kita kahit 300+ m).
  drawNpcDots(v, cx, cy, R, T) {
    const npc = this.game.npcManager;
    if (!npc) return;
    const ctx = this.ctx;
    const c = Math.cos(T), s = Math.sin(T);
    const R2 = VIEW_M * VIEW_M;
    ctx.save();
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    for (const n of npc.forMinimap) {
      const dx = n.x - v.position.x, dz = n.z - v.position.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > R2) continue;              // labas sa tanaw
      const sx = cx + (dx * c - dz * s) * this.pxPerM;
      const sy = cy + (dx * s + dz * c) * this.pxPerM;
      ctx.beginPath();
      ctx.arc(sx, sy, 2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  // PHASE 2A: traffic lights - maliit na colored dots na SUMASALAMIN sa
  // kasalukuyang estado (pula / dilaw / berde).
  drawLightDots(v, cx, cy, R, T) {
    const tl = this.game.trafficLights;
    if (!tl) return;
    const ctx = this.ctx;
    const c = Math.cos(T), s = Math.sin(T);
    const R2 = VIEW_M * VIEW_M;
    const HEAT = { green: '#2ecc40', yellow: '#f1c40f', red: '#e74c3c' };
    for (const l of tl.forMinimap) {
      const dx = l.x - v.position.x, dz = l.z - v.position.z;
      if (dx * dx + dz * dz > R2) continue;
      const sx = cx + (dx * c - dz * s) * this.pxPerM;
      const sy = cy + (dx * s + dz * c) * this.pxPerM;
      ctx.fillStyle = HEAT[l.state] || '#fff';
      ctx.beginPath();
      ctx.arc(sx, sy, 2.6, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Player marker: PUTI, naka-upat sa gitna, hindi nag-iikot (spec).
  // Ito ang tanging nakakatigil sa screen habang umiiikot ang mapa.
  drawPlayer(cx, cy) {
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = 'rgba(0,0,0,0.65)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(0, -8);
    ctx.lineTo(5.5, 7);
    ctx.lineTo(0, 4);
    ctx.lineTo(-5.5, 7);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  // COMPASS (spec): N/S/E/W sa LABAS ng circle, nagbabago ang posisyon habang
  // umiiikot ang mapa. Dito naka-anchor ang "north" sa screen: dahil ang mapa
  // ay naka-rotate ng T, ang north direction sa mundo ay nasa screen angle na
  // -T mula sa "up" pagkatapos ng rotation.
  drawCompass(cx, cy, R, T) {
    const ctx = this.ctx;
    const rr = R + 8;                    // labas ng circle
    ctx.save();
    ctx.translate(cx, cy);
    ctx.font = 'bold 9px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const put = (label, ang, color) => {
      ctx.save();
      ctx.rotate(ang);
      ctx.fillStyle = color;
      ctx.fillText(label, 0, -rr);
      ctx.restore();
    };
    // Kung naka-rotate ang mapa ng T, kailangan ng mga label ang -T para
    // maisilba sila sa mundo (hindi umaikot kasama ng mapa).
    const north = COMPASS;
    put('N', -T, north);
    put('S', -T + Math.PI, 'rgba(255,255,255,0.55)');
    put('E', -T + Math.PI / 2, 'rgba(255,255,255,0.7)');
    put('W', -T - Math.PI / 2, 'rgba(255,255,255,0.7)');
    ctx.restore();
  }

  // Scale indicator: "300m" sa ibaba ng circle (spec).
  drawScale(W, H) {
    const ctx = this.ctx;
    ctx.save();
    ctx.font = '9px sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(VIEW_M + 'm', W / 2, H - 2);
    ctx.restore();
  }

  // Waypoint: may kulay na dot + linya mula sa gitna (spec). Kung LUMAMPAS
  // sa 300 m radius, gumagawa ng ARROW sa gilid ng circle (GTA-style).
  drawWaypoint(v, cx, cy, R, T) {
    const ctx = this.ctx;
    const wp = this.waypoint;
    // relative sa player, naka-rotate sa parehong T
    const dx = wp.x - v.position.x, dz = wp.z - v.position.z;
    const dist = Math.hypot(dx, dz);
    const col = this.wpColor;
    // world -> screen (parehong rotation ng mapa)
    const c = Math.cos(T), s = Math.sin(T);
    const sx = cx + (dx * c - dz * s) * this.pxPerM;
    const sy = cy + (dx * s + dz * c) * this.pxPerM;

    if (dist <= VIEW_M) {
      // nasa loob: linya mula sa gitna + kulay na dot
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(sx, sy);
      ctx.strokeStyle = col;
      ctx.globalAlpha = 0.75;
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 3]);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      ctx.beginPath();
      ctx.arc(sx, sy, 5, 0, Math.PI * 2);
      ctx.fillStyle = col;
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx.lineWidth = 1.2;
      ctx.stroke();
      ctx.restore();
    } else {
      // LABAS: arrow sa gilid ng circle na nakatuturo sa direksyon nito
      const ux = (dx * c - dz * s);          // screen-space na direksyon
      const uy = (dx * s + dz * c);
      const len = Math.hypot(ux, uy) || 1;
      const nx = ux / len, ny = uy / len;
      const ax = cx + nx * (R - 10);
      const ay = cy + ny * (R - 10);
      const ang = Math.atan2(ny, nx);
      ctx.save();
      ctx.translate(ax, ay);
      ctx.rotate(ang + Math.PI / 2);          // arrow points "up" = outward
      ctx.beginPath();
      ctx.moveTo(0, -9);
      ctx.lineTo(6, 6);
      ctx.lineTo(0, 3);
      ctx.lineTo(-6, 6);
      ctx.closePath();
      ctx.fillStyle = col;
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.7)';
      ctx.lineWidth = 1.2;
      ctx.stroke();
      ctx.restore();
    }
  }
}
