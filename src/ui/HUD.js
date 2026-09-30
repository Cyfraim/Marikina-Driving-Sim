// ---------------------------------------------------------------------------
// HUD.js - Speedometer (baba-kanan) + watermark (baba-kaliwa)
//
// - Analog speedometer na may digital km/h readout at gear indicator
// - Subtle watermark: "Nangka, Marikina City" + pangalan ng kalsada na
//   kasalukuyan mong binabagohan (mula sa tunay na road data)
// ---------------------------------------------------------------------------
import { Speedometer } from './Speedometer.js';
import { ROAD_LINES, distToPolyline } from '../utils/roadLayout.js';

const STREET_INTERVAL = 400; // ms - bakit mag-i-update ang street name

export class HUD {
  constructor(game) {
    this.game = game;
    this.hudEl = document.getElementById('hud');
    this.streetEl = document.getElementById('street-name');
    this.speedometer = new Speedometer(170);
    this.lastStreetUpdate = -Infinity; // agad munang i-update ang street name
    this.currentStreet = '';
    // PHASE 2B: speed limit warning
    this.warnEl = document.getElementById('speed-warning');
    this.warnUntil = 0;
  }

  show() {
    this.hudEl.classList.remove('hidden');
  }

  hide() {
    this.hudEl.classList.add('hidden');
  }

  update(vehicle) {
    // Speedometer: km/h + gear (R = pabaligtad, D = pasulong, N = nakatayo)
    const signed = vehicle.getSpeedKmhSigned ? vehicle.getSpeedKmhSigned() : vehicle.getSpeedKmh();
    const gear = vehicle.speed < -0.2 ? 'R' : (vehicle.speed > 0.2 ? 'D' : 'N');
    this.speedometer.update(signed, gear);

    // PHASE 2B: speed limit warning (spec: pula, naka-flash ng 3 s)
    this.updateSpeedWarning(vehicle, signed);

    // Street name (throttled - hindi kailangan bawat frame)
    const now = performance.now();
    if (now - this.lastStreetUpdate > STREET_INTERVAL) {
      this.lastStreetUpdate = now;
      this.updateStreet(vehicle);
    }
  }

  /** "⚠ Speed Limit: 40 km/h" kapag lampas sa limit (naka-flash ng 3 s). */
  updateSpeedWarning(vehicle, kmh) {
    if (!this.warnEl) return;
    const signs = this.game.speedSigns;
    if (!signs) return;
    const now = performance.now();
    const { limit } = signs.currentLimitAt(vehicle.position.x, vehicle.position.z);
    if (kmh > limit + 2) {
      // naka-flash ulit kada 3 s habang lumalampas
      if (now > this.warnUntil) {
        this.warnUntil = now + 3000;
        this.warnEl.textContent = `⚠ Speed Limit: ${limit} km/h`;
      }
      this.warnEl.classList.remove('hidden');
    } else if (now > this.warnUntil) {
      // tumigil na sa paglampas -> itago
      this.warnEl.classList.add('hidden');
    }
  }

  // Pinakamalapit na kalsada ng player (para sa watermark)
  updateStreet(vehicle) {
    const x = vehicle.position.x;
    const z = vehicle.position.z;
    let best = null;
    let bestDist = Infinity;
    for (const line of ROAD_LINES) {
      if (x < line.minX - 30 || x > line.maxX + 30 ||
          z < line.minZ - 30 || z > line.maxZ + 30) continue; // bbox reject
      const d = distToPolyline(x, z, line.pts) - line.half;
      if (d < bestDist) { bestDist = d; best = line; }
    }
    const name = best && bestDist < 25 && best.name ? best.name : '';
    if (name !== this.currentStreet) {
      this.currentStreet = name;
      if (this.streetEl) this.streetEl.textContent = name;
    }
  }
}

