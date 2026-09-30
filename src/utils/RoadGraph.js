// ---------------------------------------------------------------------------
// RoadGraph.js - FIX 3: graph ng tunay na kalsada para sa GPS navigation
//
// Bakit kailangan: ang "Turn left on JP Rizal St" ay nangangailangan ng
// TUNAY NA PATH sa kalsada - hindi tuwid na linya. Ginawa namin ang isang
// graph mula sa ROAD_LINES (na convert na sa scene units):
//
//   Nodes = mga vertex ng polyline. Ang mga node na magkasapit (magkatabi sa
//           intersection) ay NAGPAPASA sa iisang node - kaya automatic na
//           "naka-connect" ang mga kalsada sa intersection.
//   Edges = segment sa pagitan ng magkadikit na node. Weight = tunay na
//           distansya (metro).
//
// Ginawa ito ONCE sa boot at I-REUSE sa lahat ng pathfinding. Ang A* ay
// may binary heap na OpenSet para mabilis (hindi O(n^2)).
//
// NOTE: ang tolerance sa pag-merge ay 3 m - maliit sapat para hindi
// magtumbok ang magkakatabing kalsada, malaki sapat para maitumbok ang
// intersection (karaniwang 1-2 m lang ang pagkakaiba ng GPS ng magkabilang
// dulo ng kalsada sa kanto).
// ---------------------------------------------------------------------------
import { ROAD_LINES } from './roadLayout.js';

const TOL = 3;          // merge radius (m) - compass node at intersection
const CELL = 60;        // spatial hash cell (m)
const INF = Infinity;

export class RoadGraph {
  constructor() {
    this.nodeX = [];     // node -> x
    this.nodeZ = [];     // node -> z
    this.adj = [];       // node -> [{ to, w, name }]
    this.grid = new Map();
    this._heapTop = 0;
    this.build();
    this._alloc();
  }

  // Cell key para sa spatial hash (floor, para pareho ang kaso sa negatibo)
  _key(cx, cz) { return cx * 100003 + cz; }

  /** I-hahanap ang pinakamalapit na node (na < tol) sa loob ng isang cell. */
  _nodeInCell(cx, cz, x, z) {
    const list = this.grid.get(this._key(cx, cz));
    if (!list) return -1;
    let best = -1, bd = TOL * TOL;
    for (let i = 0; i < list.length; i++) {
      const n = list[i];
      const dx = this.nodeX[n] - x, dz = this.nodeZ[n] - z;
      const d = dx * dx + dz * dz;
      if (d <= bd) { bd = d; best = n; }
    }
    return best;
  }

  /** Node id mula sa mundo (x,z) - lumilikha ng bago kung wala. */
  _nodeAt(x, z) {
    const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
    // ang intersection ay maaaring mahimog sa katabing cell dahil sa
    // rounding, kaya titingnan ang 3x3 na kapitidahan
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const n = this._nodeInCell(cx + dx, cz + dz, x, z);
        if (n >= 0) return n;
      }
    }
    const id = this.nodeX.length;
    this.nodeX.push(x);
    this.nodeZ.push(z);
    this.adj.push([]);
    let list = this.grid.get(this._key(cx, cz));
    if (!list) { list = []; this.grid.set(this._key(cx, cz), list); }
    list.push(id);
    return id;
  }

  build() {
    for (const r of ROAD_LINES) {
      const pts = r.pts;
      if (pts.length < 2) continue;
      // i-cache ang node kada polyline para hindi ulitin ang merge
      let prev = this._nodeAt(pts[0].x, pts[0].z);
      for (let i = 1; i < pts.length; i++) {
        const p = pts[i];
        const cur = this._nodeAt(p.x, p.z);
        const w = Math.hypot(p.x - pts[i - 1].x, p.z - pts[i - 1].z);
        if (w > 0.01 && cur !== prev) {
          // 1B: ini-store din ang `ri` (ROAD_LINES index) para sa NPC - kailangan
          // nila ito para malaman ALING kalsada ang isang edge (para makapili
          // ng "next road" sa dulo). Dati `name` lang ang naka-store.
          this.adj[prev].push({ to: cur, w, name: r.name || '', ri: r.i });
          this.adj[cur].push({ to: prev, w, name: r.name || '', ri: r.i });
        }
        prev = cur;
      }
    }
    this.nodeCount = this.nodeX.length;
  }

  /**
   * 1B: mga ROAD_LINES index ng mga kalsadang nakakabit sa node `n`.
   * Ginagamit ito ng NPC para magpili ng susunod na kalsada sa intersection.
   * @returns {number[]} - listahan ng `ri` (maaaring may duplicates)
   */
  candidateRoads(n) {
    const list = this.adj[n];
    if (!list) return [];
    return list.map((e) => e.ri);
  }

  _alloc() {
    const n = this.nodeCount;
    this._g = new Float64Array(n).fill(INF);
    this._f = new Float64Array(n).fill(INF);
    this._from = new Int32Array(n).fill(-1);
    this._state = new Uint8Array(n);      // 0 = bagong bisita, 1 = open, 2 = closed
    this._heap = new Int32Array(n + 1);
  }

  /** Pinakamalapit na node sa mundo (x,z), may search radius (m). */
  nearestNode(x, z, maxR = 400) {
    let best = -1, bd = maxR * maxR;
    const rings = Math.ceil(maxR / CELL);
    const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
    for (let r = 0; r <= rings; r++) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dz = -r; dz <= r; dz++) {
          // sa loob ng isang square ring, skip ang interior (na-scan na)
          if (r > 0 && Math.abs(dx) !== r && Math.abs(dz) !== r) continue;
          const list = this.grid.get(this._key(cx + dx, cz + dz));
          if (!list) continue;
          for (let i = 0; i < list.length; i++) {
            const n = list[i];
            const ddx = this.nodeX[n] - x, ddz = this.nodeZ[n] - z;
            const d = ddx * ddx + ddz * ddz;
            if (d < bd) { bd = d; best = n; }
          }
        }
      }
      if (best >= 0) break;   // nahanap na sa unang ring
    }
    return best;
  }

  // --- binary heap (min-heap sa f-score) ------------------------------------
  _heapPush(n) {
    const h = this._heap;
    let i = ++this._heapTop;
    h[i] = n;
    while (i > 1) {
      const p = i >> 1;
      if (this._f[h[p]] <= this._f[h[i]]) break;
      const t = h[p]; h[p] = h[i]; h[i] = t;
      i = p;
    }
  }
  _heapPop() {
    const h = this._heap;
    const top = h[1];
    h[1] = h[this._heapTop--];
    let i = 1;
    for (;;) {
      const l = i << 1, r = l + 1;
      let m = i;
      if (l <= this._heapTop && this._f[h[l]] < this._f[h[m]]) m = l;
      if (r <= this._heapTop && this._f[h[r]] < this._f[h[m]]) m = r;
      if (m === i) break;
      const t = h[m]; h[m] = h[i]; h[i] = t;
      i = m;
    }
    return top;
  }

  /**
   * A* mula sa pinakamalapit na node ng (fx,fz) patungo sa (tx,tz).
   * @returns {Array<{x:number,z:number}>|null} - ang landas (world points),
   *          o null kung walang daan.
   */
  findPath(fx, fz, tx, tz) {
    const s = this.nearestNode(fx, fz, 300);
    const g = this.nearestNode(tx, tz, 300);
    if (s < 0 || g < 0) return null;
    if (s === g) return [{ x: tx, z: tz }];

    const G = this._g, F = this._f, FROM = this._from, ST = this._state;
    const NX = this.nodeX, NZ = this.nodeZ;
    G.fill(INF); F.fill(INF); FROM.fill(-1); ST.fill(0);
    this._heapTop = 0;
    const h = (n) => Math.hypot(NX[n] - NX[g], NZ[n] - NZ[g]);

    G[s] = 0; F[s] = h(s); ST[s] = 1;
    this._heapPush(s);

    let found = false;
    let guard = 0;
    while (this._heapTop > 0) {
      if (++guard > 500000) break;          // safety laban
      const cur = this._heapPop();
      if (ST[cur] === 2) continue;
      ST[cur] = 2;
      if (cur === g) { found = true; break; }
      const edges = this.adj[cur];
      for (let i = 0; i < edges.length; i++) {
        const e = edges[i];
        const nb = e.to;
        if (ST[nb] === 2) continue;
        const ng = G[cur] + e.w;
        if (ng < G[nb]) {
          G[nb] = ng; F[nb] = ng + h(nb); FROM[nb] = cur; ST[nb] = 1;
          this._heapPush(nb);
        }
      }
    }
    if (!found) return null;

    const path = [];
    for (let n = g; n !== -1; n = FROM[n]) {
      path.push({ x: NX[n], z: NZ[n] });
      if (n === s) break;
    }
    path.reverse();
    if (path.length === 0) return null;
    // eksaktong puntong-destyinasyon sa dulo (para eksakto ang beacon)
    path.push({ x: tx, z: tz });
    return path;
  }

  /**
   * Alisin ang mga intermediate node na COLLINEAR (pwesto sa linya) para
   * maikli at malinis ang polyline na iguguhit sa minimap.
   */
  static simplify(path) {
    if (!path || path.length < 3) return path;
    const out = [path[0]];
    for (let i = 1; i < path.length - 1; i++) {
      const a = out[out.length - 1], b = path[i], c = path[i + 1];
      const cross = (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);
      const step = Math.hypot(b.x - a.x, b.z - a.z);
      if (Math.abs(cross) > 0.5 * step) out.push(b);   // hindi collinear
    }
    out.push(path[path.length - 1]);
    return out;
  }
}

/**
 * Impormasyon ng TURN sa index `i` ng landas.
 * @returns {{angle:number}} - angle sa RADIYAN. Positivo = kaliwa (turn left),
 *          negatibo = kanan (turn right), ~0 = tuwid.
 */
export function turnAngleAt(path, i) {
  if (!path || !path[i] || !path[i - 1] || !path[i + 1]) return 0;
  if (i <= 0 || i >= path.length - 1) return 0;
  const a = path[i - 1], b = path[i], c = path[i + 1];
  const a1 = Math.atan2(b.x - a.x, b.z - a.z);
  const a2 = Math.atan2(c.x - b.x, c.z - b.z);
  let d = a2 - a1;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/** Pangalan ng kalsada sa index `i` ng landas (gamit ang graph). */
export function roadNameAt(graph, path, i) {
  if (!graph || !path || i < 0 || i >= path.length) return '';
  const a = graph.nearestNode(path[i].x, path[i].z, 60);
  if (a < 0) return '';
  // ang edge papunta sa susunod na node ang may pangalan ng kalsada
  const nxt = graph.nearestNode(path[Math.min(i + 1, path.length - 1)].x,
                               path[Math.min(i + 1, path.length - 1)].z, 60);
  if (nxt < 0) return '';
  const e = graph.adj[a].find((e) => e.to === nxt);
  return e ? e.name : '';
}

// Ang graph ay iisa lang sa buong app (mahal ang paggawa, katamtaman ang
// paggamit). Ginawa itong lazy para hindi malagyan ang initial load ng
// 20k+ nodes kung walang naka-start na mission.
let _graph = null;
export function getRoadGraph() {
  if (!_graph) _graph = new RoadGraph();
  return _graph;
}
