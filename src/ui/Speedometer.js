// ---------------------------------------------------------------------------
// Speedometer.js - Analog speedometer (baba-kanan)
//
// Canvas gauge: tick marks, needle, digital km/h readout at gitna, at gear
// indicator (R/N/D). Naka-drawing bawat frame pero maliit lang ang canvas.
// ---------------------------------------------------------------------------

const MAX_KMH = 120;   // hanggang saan umaabot ang dial
const START_ANGLE = Math.PI * 0.75;  // 135° (maliit na snowflake ng 7)
const SWEEP = Math.PI * 1.5;         // 270° sweep

export class Speedometer {
  constructor(size = 170) {
    this.size = size;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas = document.getElementById('speedometer');
    this.ctx = this.canvas.getContext('2d');
    this.canvas.width = size * this.dpr;
    this.canvas.height = size * this.dpr;
    this.needle = 0;      // current (naa-damped na degit)
    this.target = 0;      // target km/h
    this.dial();          // static na background (ticks, numbers) - isang beses
  }

  // Static na background ng dial (ticks + numero) - i-cache sa canvas na ito
  dial() {
    const S = this.size;
    const c = document.createElement('canvas');
    c.width = S * this.dpr;
    c.height = S * this.dpr;
    const g = c.getContext('2d');
    g.scale(this.dpr, this.dpr);
    const cx = S / 2;
    const cy = S / 2;
    const r = S / 2 - 6;

    // dial face
    g.beginPath();
    g.arc(cx, cy, r, 0, Math.PI * 2);
    g.fillStyle = 'rgba(10, 12, 16, 0.82)';
    g.fill();
    g.lineWidth = 2;
    g.strokeStyle = 'rgba(233, 69, 96, 0.55)';
    g.stroke();

    // arc scale (background track)
    g.beginPath();
    g.arc(cx, cy, r - 8, START_ANGLE, START_ANGLE + SWEEP);
    g.lineWidth = 5;
    g.strokeStyle = 'rgba(255, 255, 255, 0.14)';
    g.lineCap = 'round';
    g.stroke();

    // ticks + numero kada 20 km/h
    for (let v = 0; v <= MAX_KMH; v += 10) {
      const major = v % 20 === 0;
      const a = START_ANGLE + (v / MAX_KMH) * SWEEP;
      const sin = Math.sin(a);
      const cos = -Math.cos(a);
      const r1 = r - 12;
      const r2 = major ? r - 24 : r - 18;
      g.beginPath();
      g.moveTo(cx + sin * r1, cy + cos * r1);
      g.lineTo(cx + sin * r2, cy + cos * r2);
      g.lineWidth = major ? 2.5 : 1.2;
      g.strokeStyle = v >= 100 ? '#e94560' : 'rgba(255,255,255,0.75)';
      g.stroke();
      if (major && v % 40 === 0) {
        g.fillStyle = 'rgba(255,255,255,0.85)';
        g.font = 'bold 11px sans-serif';
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        const r3 = r - 36;
        g.fillText(String(v), cx + sin * r3, cy + cos * r3);
      }
    }
    this.bg = c;
  }

  // Tawag tuwing frame mula sa HUD: kmh (positivo = pasulong, negatibo = pabaligtad)
  update(kmh, gear = 'N') {
    this.target = Math.min(Math.abs(kmh), MAX_KMH);
    // damped para hindi mag-vibrate ang needle
    this.needle += (this.target - this.needle) * 0.25;
    this.render(gear);
  }

  render(gear) {
    const S = this.size;
    const ctx = this.ctx;
    const cx = S / 2;
    const cy = S / 2;
    const r = S / 2 - 6;

    ctx.save();
    ctx.scale(this.dpr, this.dpr);
    ctx.clearRect(0, 0, S, S);
    // static background
    ctx.drawImage(this.bg, 0, 0, S, S);

    // needle
    const a = START_ANGLE + (this.needle / MAX_KMH) * SWEEP;
    const sin = Math.sin(a);
    const cos = -Math.cos(a);
    ctx.beginPath();
    ctx.moveTo(cx - sin * 10, cy - cos * 10);
    ctx.lineTo(cx + sin * (r - 16), cy + cos * (r - 16));
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#e94560';
    ctx.lineCap = 'round';
    ctx.stroke();
    // hub
    ctx.beginPath();
    ctx.arc(cx, cy, 4, 0, Math.PI * 2);
    ctx.fillStyle = '#e94560';
    ctx.fill();

    // digital readout (gitna)
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 20px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(Math.round(this.needle)), cx, cy - 10);
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.font = '9px sans-serif';
    ctx.fillText('km/h', cx, cy + 6);

    // gear (R / N / D)
    ctx.fillStyle = gear === 'R' ? '#f4d03f' : 'rgba(255,255,255,0.75)';
    ctx.font = 'bold 11px sans-serif';
    ctx.fillText(gear, cx, cy + 22);

    ctx.restore();
  }
}
