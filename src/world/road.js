// Procedural endless road (port of drive/src/road.js without three.js): a centreline sampled every DS metres whose heading follows smooth noise of the distance
// travelled (so it meanders but never turns back), with an elevation that follows the base terrain, stays above the
// water and is grade-limited. Provides interpolated sampling by distance and nearest-point queries (spatial hash).
import { createNoise2D, clamp } from '../shared/noise.js';

export const DS = 2; // metres between centreline samples
export const ROAD_HALF = 4.2; // asphalt half width (two 3.5 m lanes + margin)
export const LANE_OFFSET = 1.85; // car drives this far right of the centreline
const CELL = 32; // spatial hash cell size
const SMOOTH = 40; // elevation smoothing half-window, samples
const MAX_GRADE = 0.065;

export class Road {
  /**
   * @param {object} o
   * @param {number} o.seed
   * @param {(x:number,z:number)=>number} o.baseHeight terrain height without the road
   * @param {number} o.minY lowest allowed road elevation (water level + freeboard)
   * @param {number} [o.sStart] the road starts this far behind s = 0
   * @param {number} [o.half] surface half width
   * @param {(s:number)=>number} [o.heading] heading noise override (radians as a function of s)
   * @param {number} [o.maxGrade] elevation grade limit
   * @param {number} [o.smooth] elevation smoothing half-window, samples
   * @param {(s:number)=>number} [o.bump] extra elevation added on top of the smoothed profile (crests, jumps)
   */
  constructor({ seed, baseHeight, minY, sStart = -1200, half = ROAD_HALF, heading, maxGrade = MAX_GRADE, smooth = SMOOTH, bump }) {
    this.noise = createNoise2D(seed * 7 + 3);
    this.half = half;
    if (heading) this.headingAt = heading;
    this.maxGrade = maxGrade;
    this.smooth = smooth;
    this.bump = bump;
    this.yb = []; // smoothed elevation before bump()
    this.baseHeight = baseHeight;
    this.minY = minY;
    this.s0 = sStart;
    this.x = [];
    this.z = [];
    this.raw = []; // clamped base height under each sample
    this.rawSum = [0]; // prefix sums of raw for windowed averages
    this.y = []; // finalised elevation (lags this.x by SMOOTH samples)
    this.cells = new Map();
    this.baseHeading = 0;
    // The road starts at sStart < 0 (so it exists behind the car); integrate backwards from the origin to find that
    // start point, so that s = 0 lies at the world origin.
    let x = 0;
    let z = 0;
    const n = Math.round(-sStart / DS);
    for (let i = 0; i < n; i++) {
      const h = this.headingAt(-i * DS - DS / 2);
      x -= Math.sin(h) * DS;
      z -= Math.cos(h) * DS;
    }
    this._place(x, z);
  }

  /** Heading (radians, 0 = +z, positive towards +x) as a function of distance along the road. */
  headingAt(s) {
    const n = this.noise;
    return this.baseHeading + 1.05 * n(s / 1400, 0.5) + 0.42 * n(s / 380, 7.5) + 0.12 * n(s / 110, 13.1);
  }

  _place(x, z) {
    const i = this.x.length;
    this.x.push(x);
    this.z.push(z);
    const r = Math.max(this.baseHeight(x, z), this.minY);
    this.raw.push(r);
    this.rawSum.push(this.rawSum[i] + r);
  }

  get length() {
    return this.y.length;
  }
  get sEnd() {
    return this.s0 + (this.y.length - 1) * DS;
  }

  _extendTo(n) {
    while (this.x.length < n) {
      const i = this.x.length;
      const h = this.headingAt(this.s0 + (i - 0.5) * DS);
      this._place(this.x[i - 1] + Math.sin(h) * DS, this.z[i - 1] + Math.cos(h) * DS);
    }
  }

  _avg(i) {
    const a = Math.max(0, i - this.smooth);
    const b = Math.min(this.raw.length - 1, i + this.smooth);
    return (this.rawSum[b + 1] - this.rawSum[a]) / (b - a + 1);
  }

  /** Generate centreline + elevation until the finalised road reaches distance s. */
  ensure(s) {
    const g = this.maxGrade * DS;
    const SMOOTH = this.smooth;
    const push = (v) => {
      this.yb.push(v);
      this.y.push(this.bump ? v + this.bump(this.s0 + (this.y.length) * DS) : v);
    };
    if (!this.y.length) {
      // Anchor the elevation at s = 0 (the start) and grade-limit backwards from there, so the start is at the
      // natural ground height whatever the terrain far behind does.
      const io = Math.round(-this.s0 / DS);
      this._extendTo(io + SMOOTH + 1);
      const y = new Array(io + 1);
      y[io] = this._avg(io);
      for (let i = io - 1; i >= 0; i--) y[i] = y[i + 1] + clamp(this._avg(i) - y[i + 1], -g, g);
      for (let i = 0; i <= io; i++) {
        push(y[i]);
        if (i > 0) this._index(i - 1);
      }
    }
    while (this.sEnd < s) {
      // extend positions so that SMOOTH samples beyond the next finalised one exist
      this._extendTo(this.y.length + SMOOTH + 1);
      const i = this.y.length;
      const prev = this.yb[i - 1];
      push(prev + clamp(this._avg(i) - prev, -g, g));
      this._index(i - 1);
    }
  }

  _index(i) {
    const add = (x, z) => {
      const k = `${Math.floor(x / CELL)},${Math.floor(z / CELL)}`;
      let c = this.cells.get(k);
      if (!c) this.cells.set(k, (c = []));
      if (c[c.length - 1] !== i) c.push(i);
    };
    add(this.x[i], this.z[i]);
    add(this.x[i + 1], this.z[i + 1]);
  }

  indexAt(s) {
    return (s - this.s0) / DS;
  }

  /** Interpolated sample at distance s → {x, y, z, heading, grade}; writes into `out` if given. */
  sample(s, out = {}) {
    this.ensure(s + DS * 2);
    const f = clamp(this.indexAt(s), 0, this.y.length - 1.001);
    const i = Math.floor(f);
    const t = f - i;
    const x0 = this.x[i];
    const z0 = this.z[i];
    const x1 = this.x[i + 1];
    const z1 = this.z[i + 1];
    out.x = x0 + (x1 - x0) * t;
    out.z = z0 + (z1 - z0) * t;
    out.y = this.y[i] + (this.y[i + 1] - this.y[i]) * t;
    out.heading = Math.atan2(x1 - x0, z1 - z0);
    out.grade = (this.y[i + 1] - this.y[i]) / DS;
    out.i = i;
    out.t = t;
    return out;
  }

  /** Signed curvature (1/m, positive = turning left/+x) around distance s. */
  curvature(s, span = 6) {
    const h0 = this.headingAt(s - span);
    const h1 = this.headingAt(s + span);
    return (h1 - h0) / (2 * span);
  }

  /**
   * Candidate segment indices near an axis-aligned rectangle (expanded by `margin`).
   * Use with nearestAmong() for many queries in one area (terrain tiles).
   */
  segmentsNear(minX, minZ, maxX, maxZ, margin) {
    const out = new Set();
    const cx0 = Math.floor((minX - margin) / CELL);
    const cx1 = Math.floor((maxX + margin) / CELL);
    const cz0 = Math.floor((minZ - margin) / CELL);
    const cz1 = Math.floor((maxZ + margin) / CELL);
    for (let cx = cx0; cx <= cx1; cx++)
      for (let cz = cz0; cz <= cz1; cz++) {
        const c = this.cells.get(`${cx},${cz}`);
        if (c) for (const i of c) if (i + 1 < this.y.length) out.add(i);
      }
    return Int32Array.from(out);
  }

  /**
   * Nearest point on the given segments to (px, pz) → writes {d (unsigned distance), side (+1 left / -1 right),
   * s, y} into out and returns it, or null when there are no segments within maxDist.
   */
  nearestAmong(segs, px, pz, maxDist, out = {}) {
    let best = maxDist * maxDist;
    let bi = -1;
    let bt = 0;
    const X = this.x;
    const Z = this.z;
    for (let k = 0; k < segs.length; k++) {
      const i = segs[k];
      const ax = X[i];
      const az = Z[i];
      const dx = X[i + 1] - ax;
      const dz = Z[i + 1] - az;
      let t = ((px - ax) * dx + (pz - az) * dz) / (dx * dx + dz * dz);
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const ex = ax + dx * t - px;
      const ez = az + dz * t - pz;
      const d2 = ex * ex + ez * ez;
      if (d2 < best) {
        best = d2;
        bi = i;
        bt = t;
      }
    }
    if (bi < 0) return null;
    const dx = X[bi + 1] - X[bi];
    const dz = Z[bi + 1] - Z[bi];
    // cross of tangent with (p - a): positive when p is to the +x side of a +z-heading road, i.e. the left
    const cross = dz * (px - X[bi]) - dx * (pz - Z[bi]);
    out.d = Math.sqrt(best);
    out.side = cross >= 0 ? 1 : -1;
    out.s = this.s0 + (bi + bt) * DS;
    out.y = this.y[bi] + (this.y[bi + 1] - this.y[bi]) * bt;
    out.heading = Math.atan2(dx, dz);
    return out;
  }

  nearest(px, pz, maxDist, out) {
    return this.nearestAmong(this.segmentsNear(px, pz, px, pz, maxDist), px, pz, maxDist, out);
  }

  /** World position [x, y, z] of a point `offset` metres right of the centreline at distance s. */
  lanePoint(s, offset, target = [0, 0, 0]) {
    const p = this.sample(s, this._tmp || (this._tmp = {}));
    // right of travel direction (sin h, cos h) is (-cos h, sin h)
    target[0] = p.x - Math.cos(p.heading) * offset;
    target[1] = p.y;
    target[2] = p.z + Math.sin(p.heading) * offset;
    return target;
  }
}
