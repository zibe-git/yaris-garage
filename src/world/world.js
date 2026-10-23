// Scenic-drive world (port of drive/src/world.js): base terrain height field (noise), the road through it, and the final ground height where the terrain is
// cut / filled to meet the road (embankments, cuttings, causeways over water).
import { createNoise2D, fbm, smoothstep, lerp, mulberry32 } from '../shared/noise.js';
import { Road, ROAD_HALF } from './road.js';

export const WATER_LEVEL = 0;
export const SHOULDER = 1.8; // flat verge beyond the asphalt
export const ROAD_DROP = 0.12; // terrain under the road sits this far below the asphalt
export const BLEND_MAX = 70; // max distance from the road centreline that the road affects the terrain

export class World {
  constructor(seed = 7) {
    this.seed = seed;
    const n1 = createNoise2D(seed);
    const n2 = createNoise2D(seed + 101);
    const n3 = createNoise2D(seed + 202);
    const n4 = createNoise2D(seed + 303);
    this.noises = { n1, n2, n3, n4 };
    this.offset = { x: 0, z: 0 };
    const base = (x, z) => {
      x += this.offset.x;
      z += this.offset.z;
      const continent = fbm(n1, x / 1900, z / 1900, 3);
      const hills = fbm(n2, x / 520, z / 520, 4);
      const ridge = 1 - Math.abs(n4(x / 900, z / 900));
      const detail = fbm(n3, x / 85, z / 85, 3);
      const land = 95 * continent + 9;
      // hills grow with altitude so shores stay gentle and inland gets rolling / mountainous
      const relief = smoothstep(-5, 40, land);
      return land + (16 + 30 * relief) * hills + 26 * relief * ridge * ridge + 2.2 * detail;
    };
    this.baseHeight = base;
    this._findSpawn();
    this.road = new Road({ seed, baseHeight: base, minY: WATER_LEVEL + 1.3 });
    this._near = {};
  }

  // Shift the noise domain so the start of the road (world origin) is on a low shore with open water nearby.
  _findSpawn() {
    const rand = mulberry32(this.seed * 13 + 1);
    let best = null;
    for (let k = 0; k < 400; k++) {
      this.offset.x = (rand() - 0.5) * 60000;
      this.offset.z = (rand() - 0.5) * 60000;
      const h0 = this.baseHeight(0, 0);
      if (h0 < 1 || h0 > 8) continue;
      // water on one side within 60..220 m, land ahead along +z
      let water = 0;
      for (let a = 0; a < 16; a++) {
        const ang = (a / 16) * Math.PI * 2;
        for (const r of [70, 140, 220]) if (this.baseHeight(Math.sin(ang) * r, Math.cos(ang) * r) < -2) water++;
      }
      const score = Math.min(water, 18) - Math.abs(h0 - 3) * 0.5;
      if (water > 4 && (!best || score > best.score)) best = { score, x: this.offset.x, z: this.offset.z };
      if (best && best.score > 15) break;
    }
    if (best) Object.assign(this.offset, { x: best.x, z: best.z });
  }

  /** Terrain height after blending into the road, given a nearest-road result (or null) and the base height. */
  static blend(h0, near, half = ROAD_HALF, shoulder = SHOULDER) {
    if (!near) return h0;
    const bed = near.y - ROAD_DROP;
    const dh = h0 - bed;
    const w = Math.min(BLEND_MAX - half - shoulder, Math.max(5, Math.abs(dh) * 1.7));
    const t = smoothstep(half + shoulder, half + shoulder + w, near.d);
    return lerp(bed, h0, t);
  }

  /** Final ground height at (x, z) (terrain, not the asphalt). */
  heightAt(x, z) {
    const h0 = this.baseHeight(x, z);
    return World.blend(h0, this.road.nearest(x, z, BLEND_MAX, this._near));
  }

  /** Drivable surface height: the asphalt on the road, the terrain elsewhere (but never below the water surface bed). */
  surfaceAt(x, z) {
    const near = this.road.nearest(x, z, BLEND_MAX, this._near);
    if (near && near.d <= ROAD_HALF + 0.2) return near.y;
    return World.blend(this.baseHeight(x, z), near);
  }
}
