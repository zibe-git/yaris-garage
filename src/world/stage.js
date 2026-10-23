// Rally stage (port of drive/src/rally/stage.js): a narrow, twisty gravel road through pine-forest hills, with jumps (a ramp, a lip, and a road that
// falls away beyond it) and smaller crests. Reuses the endless Road / Terrain machinery of the scenic drive with
// rally parameters, and adds ground queries for the vehicle physics (height, normal, surface type).
import { createNoise2D, fbm, smoothstep, hash2, clamp } from '../shared/noise.js';
import { Road, DS } from './road.js';
import { World, BLEND_MAX } from './world.js';

export const STAGE_HALF = 3.3; // gravel half width (6.6 m road)
export const STAGE_SHOULDER = 0.8;
const JUMP_SPACING = 320;

/** Surface grip / drag per surface type (dry values; rain lowers grip in Stage.grip). */
export const SURFACES = {
  gravel: { mu: 0.98, roll: 0.018, id: 0 },
  verge: { mu: 0.82, roll: 0.03, id: 1 },
  forest: { mu: 0.68, roll: 0.06, id: 2 },
};

export class Stage {
  constructor(seed = 11) {
    this.seed = seed;
    this.shoulder = STAGE_SHOULDER;
    this.wetness = 0; // 0 dry … 1 soaked (set by the weather)
    const n1 = createNoise2D(seed);
    const n2 = createNoise2D(seed + 101);
    const n3 = createNoise2D(seed + 202);
    const hn = createNoise2D(seed * 7 + 3);
    // forested hills, well above the (unused) lake level of the shared terrain code
    this.baseHeight = (x, z) => 70 + 34 * fbm(n1, x / 1300, z / 1300, 3) + 16 * fbm(n2, x / 330, z / 330, 4) + 1.4 * fbm(n3, x / 45, z / 45, 2);
    const base = (s) => 1.4 * hn(s / 900, 0.5) + 1.05 * hn(s / 230, 7.5) + 0.42 * hn(s / 75, 13.1);
    // the road straightens out around each jump: hold the heading of the take-off point over the run-up and landing
    const heading = (s) => {
      const k = Math.round((s - 120 - 45) / JUMP_SPACING);
      let h = base(s);
      for (const kk of [k - 1, k, k + 1]) {
        const slot = this.slot(kk);
        if (!slot.type || slot.type === 'crest') continue;
        const c = slot.s;
        const w = smoothstep(c - 115, c - 75, s) * (1 - smoothstep(c + 55, c + 95, s));
        if (w > 0) h += (base(c) - h) * w;
      }
      return h;
    };
    this.jumps = new Map(); // slot → jump | null
    this.road = new Road({
      seed,
      baseHeight: this.baseHeight,
      minY: -1e9,
      half: STAGE_HALF,
      heading,
      maxGrade: 0.12,
      smooth: 9,
      bump: (s) => this.bump(s),
    });
    this._near = {};
  }

  /** Curvature of the centreline (1/m, + = left). */
  curvature(s) {
    return this.road.curvature(s);
  }

  /** Jump slot k: position and type from a hash only (the heading depends on it, so no road queries here). */
  slot(k) {
    const r = hash2(k, 5, this.seed);
    return { s: k * JUMP_SPACING + 120 + hash2(k, 3, this.seed) * 90, type: k < 1 ? null : r < 0.55 ? 'jump' : r < 0.85 ? 'crest' : null };
  }

  /** The jump in slot k (one candidate every JUMP_SPACING m): a ramp with a lip and a falling landing, or a crest. */
  jump(k) {
    if (this.jumps.has(k)) return this.jumps.get(k);
    const { s: c, type } = this.slot(k);
    let j = null;
    if (type === 'jump') {
      const big = hash2(k, 7, this.seed);
      const H = 1.6 + 1.6 * big;
      // approach speed: lands on the down-slope (checked in tests/rally-sim.mjs)
      j = { s: c, H, up: 34 + 8 * big, down: 32 + 12 * big, lip: 0.82, v: 25 + 3 * (1 - big), big: big > 0.5 };
    } else if (type === 'crest' && Math.abs(this.curvature(c)) < 0.015) {
      j = { s: c, H: 0.7 + 0.5 * hash2(k, 11, this.seed), up: 18, down: 18, lip: 1, v: 40, crest: true };
    }
    this.jumps.set(k, j);
    return j;
  }

  /** Extra elevation of the road at s from jumps / crests. */
  bump(s) {
    const k = Math.floor((s - 60) / JUMP_SPACING);
    let y = 0;
    for (const kk of [k, k + 1]) {
      const j = this.jump(kk);
      if (!j) continue;
      const u = s - j.s;
      if (u < -j.up * j.lip || u > j.down) continue;
      if (u <= 0) {
        // ramp: smoothstep cut at `lip`, so the car still rises when the road drops away
        const t = (u + j.up * j.lip) / j.up;
        const top = j.lip * j.lip * (3 - 2 * j.lip);
        y += (j.H * t * t * (3 - 2 * t)) / top;
      } else {
        y += j.H * (1 - smoothstep(0, j.down, u));
      }
    }
    return y;
  }

  /** Jumps whose take-off lies in [s0, s1]. */
  jumpsBetween(s0, s1) {
    const out = [];
    for (let k = Math.floor((s0 - 60) / JUMP_SPACING) - 1; k <= Math.floor(s1 / JUMP_SPACING) + 1; k++) {
      const j = this.jump(k);
      if (j && j.s >= s0 && j.s <= s1) out.push(j);
    }
    return out;
  }

  /** Road segments near (x, z) for a batch of ground queries (avoids per-query allocation). */
  segmentsNear(x, z, r = 12) {
    return this.road.segmentsNear(x, z, x, z, BLEND_MAX + r);
  }

  /** Ground height + surface at (x, z). `segs` from segmentsNear around the query area. */
  groundAt(x, z, segs, out = {}) {
    const near = segs.length ? this.road.nearestAmong(segs, x, z, BLEND_MAX, this._near) : null;
    if (near && near.d <= STAGE_HALF + 0.1) {
      out.y = near.y;
      out.surface = SURFACES.gravel;
      out.d = near.d;
      return out;
    }
    out.y = World.blend(this.baseHeight(x, z), near, STAGE_HALF, STAGE_SHOULDER);
    out.d = near ? near.d : BLEND_MAX;
    out.surface = out.d < STAGE_HALF + STAGE_SHOULDER + 1.2 ? SURFACES.verge : SURFACES.forest;
    return out;
  }

  /** Ground point + normal (finite differences) → out {y, nx, ny, nz, surface}. */
  contact(x, z, segs, out = {}) {
    const e = 0.25;
    const g = this.groundAt(x, z, segs, out);
    const surface = g.surface;
    const y = g.y;
    const d = g.d;
    const yx = this.groundAt(x + e, z, segs, this._g1 || (this._g1 = {})).y;
    const yz = this.groundAt(x, z + e, segs, this._g2 || (this._g2 = {})).y;
    const nx = -(yx - y) / e;
    const nz = -(yz - y) / e;
    const l = Math.hypot(nx, 1, nz);
    out.y = y;
    out.d = d;
    out.surface = surface;
    out.nx = nx / l;
    out.ny = 1 / l;
    out.nz = nz / l;
    return out;
  }

  /** Grip multiplier from the weather. */
  grip(surface) {
    return surface.mu * (1 - 0.14 * this.wetness * (surface.id === 0 ? 1 : 1.6));
  }

  /** World point at distance s with lateral offset `left` (m, + = left of travel). */
  point(s, left, out) {
    const p = this.road.sample(s, this._p || (this._p = {}));
    out.x = p.x + Math.cos(p.heading) * left;
    out.z = p.z - Math.sin(p.heading) * left;
    out.y = p.y;
    out.heading = p.heading;
    return out;
  }
}

export { DS, clamp };
