// Terrain tiles around the car: a height grid per tile (two levels of detail, with skirts hiding the cracks between
// them), built row by row as time-sliced jobs, nearest tiles first. Colour comes from the shader (meadow, rock on
// slopes, sand at the shore, gravel verges; forest floor at night). Trees are placed while a tile is built.
import { program, buffer, vao } from '../gl/gl.js';
import { LIGHT_GLSL } from '../gl/model.js';
import { NOISE_GLSL } from './glsl.js';
import { hash2 } from '../shared/noise.js';

const VS = `
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aNormal;
layout(location = 2) in float aRoad;
uniform mat4 uViewProj;
out vec3 vPos;
out vec3 vNormal;
out float vRoad;
void main() {
  vPos = aPos;
  vNormal = aNormal;
  vRoad = aRoad;
  gl_Position = uViewProj * vec4(aPos, 1.0);
}`;

const FS = `
in vec3 vPos;
in vec3 vNormal;
in float vRoad;
uniform int uNight;
uniform float uRoadHalf;
uniform float uWet;
uniform float uWaterLevel;
out vec4 fragColor;
${LIGHT_GLSL}
${NOISE_GLSL}
void main() {
  vec3 n = normalize(vNormal);
  float slope = 1.0 - n.y;
  float big = fbm2(vPos.xz * 0.012);
  float fine = vnoise(vPos.xz * 0.35);
  vec3 albedo;
  float rough = 0.95;
  float verge = 1.0 - smoothstep(uRoadHalf + 0.6, uRoadHalf + 2.6 + fine, vRoad);
  if (uNight == 0) {
    vec3 meadow = mix(vec3(0.075, 0.16, 0.03), vec3(0.17, 0.22, 0.05), big);
    meadow = mix(meadow, vec3(0.2, 0.2, 0.07), smoothstep(0.55, 0.8, fine) * 0.5);
    vec3 rock = mix(vec3(0.2, 0.19, 0.17), vec3(0.3, 0.28, 0.25), fine);
    vec3 sand = vec3(0.28, 0.24, 0.16);
    albedo = mix(meadow, rock, smoothstep(0.22, 0.38, slope + (big - 0.5) * 0.15));
    albedo = mix(albedo, sand, 1.0 - smoothstep(uWaterLevel + 0.8, uWaterLevel + 2.2 + fine, vPos.y));
    albedo = mix(albedo, vec3(0.2, 0.19, 0.17), verge);
    // under water: darker, greener with depth
    albedo = mix(albedo, vec3(0.04, 0.07, 0.06), smoothstep(uWaterLevel, uWaterLevel - 4.0, vPos.y));
  } else {
    vec3 floorC = mix(vec3(0.05, 0.04, 0.03), vec3(0.05, 0.07, 0.03), big);
    floorC = mix(floorC, vec3(0.09, 0.07, 0.05), smoothstep(0.6, 0.85, fine));
    vec3 rock = vec3(0.12, 0.115, 0.11);
    albedo = mix(floorC, rock, smoothstep(0.3, 0.5, slope));
    albedo = mix(albedo, vec3(0.14, 0.12, 0.1), verge);
    albedo *= 1.0 - uWet * 0.35;
    rough = mix(0.95, 0.5, uWet * verge);
  }
  vec3 c = shade(vPos, n, albedo, rough, 0.0, 0.0);
  fragColor = outColor(applyFog(c, vPos), 1.0);
}`;

function gridIndices(n) {
  // grid (n×n) + skirt ring (4(n-1) extra vertices, one per edge vertex in loop order)
  const idx = [];
  for (let j = 0; j < n - 1; j++)
    for (let i = 0; i < n - 1; i++) {
      const a = j * n + i;
      idx.push(a, a + n, a + 1, a + 1, a + n, a + n + 1);
    }
  const ring = edgeLoop(n);
  const base = n * n;
  for (let k = 0; k < ring.length; k++) {
    const a = ring[k], b = ring[(k + 1) % ring.length];
    const sa = base + k, sb = base + ((k + 1) % ring.length);
    idx.push(a, sa, b, b, sa, sb);
  }
  return new Uint16Array(idx);
}

function edgeLoop(n) {
  const out = [];
  for (let i = 0; i < n - 1; i++) out.push(i);
  for (let j = 0; j < n - 1; j++) out.push(j * n + n - 1);
  for (let i = n - 1; i > 0; i--) out.push((n - 1) * n + i);
  for (let j = n - 1; j > 0; j--) out.push(j * n);
  return out;
}

export class Terrain {
  /**
   * @param {object} o
   * @param {(x0:number, z0:number, x1:number, z1:number) => any} o.prepare per-tile setup (road segments near it)
   * @param {(x:number, z:number, prep:any, out:{y:number, d:number}) => void} o.ground height + distance to the road
   * @param {number} o.tile tile size (m)
   * @param {number} o.radius tiles are kept within this distance of the focus
   * @param {(tile, heightAt) => void} [o.plant] tree placement callback
   */
  constructor(gl, jobs, { prepare, ground, tile = 80, radius = 420, lodNear = 33, lodFar = 13, plant, night = false, roadHalf = 4.2 }) {
    this.gl = gl;
    this.jobs = jobs;
    this.prepare = prepare;
    this.ground = ground;
    this.T = tile;
    this.radius = radius;
    this.lods = [lodNear, lodFar].map((n) => ({ n, ibo: buffer(gl, gridIndices(n), gl.ELEMENT_ARRAY_BUFFER), count: gridIndices(n).length }));
    this.plant = plant;
    this.night = night;
    this.roadHalf = roadHalf;
    this.tiles = new Map(); // key → { ix, iz, lod, vbo, vao, ready, job, trees }
    this.prog = program(gl, VS, FS);
    this.version = 0; // bumps when the tile set (and so the forest) changes
    this.wet = 0;
    this.waterLevel = 0;
  }

  /** Queue builds / rebuilds / removals for the area around (x, z), heading (hx, hz). */
  update(x, z) {
    const T = this.T;
    const R = this.radius;
    const r = Math.ceil(R / T);
    const cx = Math.floor(x / T), cz = Math.floor(z / T);
    const want = new Set();
    for (let iz = cz - r; iz <= cz + r; iz++)
      for (let ix = cx - r; ix <= cx + r; ix++) {
        const mx = (ix + 0.5) * T, mz = (iz + 0.5) * T;
        const d = Math.hypot(mx - x, mz - z);
        if (d > R + T * 0.71) continue;
        const key = `${ix},${iz}`;
        want.add(key);
        const lod = d < T * 1.9 ? 0 : 1;
        let t = this.tiles.get(key);
        if (!t) {
          t = { ix, iz, lod: -1, want: lod, vbo: null, vao: null, job: null, trees: null };
          this.tiles.set(key, t);
        }
        t.want = lod;
        if (t.lod !== lod && (!t.job || t.job.done || t.job.lod !== lod)) {
          if (t.job && !t.job.done) t.job.cancelled = true;
          t.job = this.jobs.add(this.build(t, lod), d / T + (t.lod < 0 ? 0 : 0.5));
          t.job.lod = lod;
        } else if (t.job && !t.job.done) t.job.priority = d / T + (t.lod < 0 ? 0 : 0.5);
      }
    for (const [key, t] of this.tiles)
      if (!want.has(key)) {
        if (t.job) t.job.cancelled = true;
        this.free(t);
        this.tiles.delete(key);
        this.version++;
      }
  }

  free(t) {
    const gl = this.gl;
    if (t.vbo) gl.deleteBuffer(t.vbo);
    if (t.vao) gl.deleteVertexArray(t.vao);
    t.vbo = t.vao = null;
  }

  *build(t, lod) {
    const n = this.lods[lod].n;
    const T = this.T;
    const x0 = t.ix * T, z0 = t.iz * T;
    const step = T / (n - 1);
    const prep = this.prepare(x0 - step, z0 - step, x0 + T + step, z0 + T + step);
    yield;
    const N1 = n + 2;
    const H = new Float32Array(N1 * N1);
    const D = new Float32Array(N1 * N1);
    const out = { y: 0, d: 0 };
    for (let j = 0; j < N1; j++) {
      for (let i = 0; i < N1; i++) {
        this.ground(x0 + (i - 1) * step, z0 + (j - 1) * step, prep, out);
        H[j * N1 + i] = out.y;
        D[j * N1 + i] = out.d;
      }
      yield;
    }
    const nv = n * n + 4 * (n - 1);
    const data = new Float32Array(nv * 7);
    const put = (v, x, y, z, nx, ny, nz, d) => {
      const o = v * 7;
      data[o] = x; data[o + 1] = y; data[o + 2] = z;
      data[o + 3] = nx; data[o + 4] = ny; data[o + 5] = nz; data[o + 6] = d;
    };
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) {
        const k = (j + 1) * N1 + i + 1;
        const nx = H[k - 1] - H[k + 1], nz = H[k - N1] - H[k + N1], ny = 2 * step;
        const l = Math.hypot(nx, ny, nz);
        put(j * n + i, x0 + i * step, H[k], z0 + j * step, nx / l, ny / l, nz / l, D[k]);
      }
    const ring = edgeLoop(n);
    const skirt = Math.max(1.5, step * 0.6);
    ring.forEach((v, k) => {
      const o = v * 7;
      put(n * n + k, data[o], data[o + 1] - skirt, data[o + 2], data[o + 3], data[o + 4], data[o + 5], data[o + 6]);
    });
    yield;
    const trees = this.plant && !t.trees ? this.plant(t, (x, z) => {
      const fi = (x - x0) / step + 1, fj = (z - z0) / step + 1;
      const i = Math.max(0, Math.min(N1 - 2, Math.floor(fi))), j = Math.max(0, Math.min(N1 - 2, Math.floor(fj)));
      const u = fi - i, w = fj - j;
      const k = j * N1 + i;
      const h = (H[k] * (1 - u) + H[k + 1] * u) * (1 - w) + (H[k + N1] * (1 - u) + H[k + N1 + 1] * u) * w;
      const d = (D[k] * (1 - u) + D[k + 1] * u) * (1 - w) + (D[k + N1] * (1 - u) + D[k + N1 + 1] * u) * w;
      return { y: h, d, slope: Math.hypot(H[k + 1] - H[k], H[k + N1] - H[k]) / step };
    }) : null;
    const gl = this.gl;
    this.free(t);
    t.vbo = buffer(gl, data);
    t.vao = vao(gl, [
      { loc: 0, buffer: t.vbo, size: 3, stride: 28, offset: 0 },
      { loc: 1, buffer: t.vbo, size: 3, stride: 28, offset: 12 },
      { loc: 2, buffer: t.vbo, size: 1, stride: 28, offset: 24 },
    ], this.lods[lod].ibo);
    t.lod = lod;
    if (trees) {
      t.trees = trees;
      this.version++;
    }
  }

  /** Fraction of wanted tiles that are built (for the loading screen). */
  get progress() {
    let built = 0;
    for (const t of this.tiles.values()) if (t.vao) built++;
    return this.tiles.size ? built / this.tiles.size : 0;
  }

  draw(camera, light) {
    const gl = this.gl;
    this.prog.use().set({ ...light, uViewProj: camera.viewProj, uEye: camera.eye, uNight: this.night ? 1 : 0, uRoadHalf: this.roadHalf, uWet: this.wet, uWaterLevel: this.waterLevel });
    gl.enable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE); // skirts face both ways
    const vp = camera.viewProj;
    const T = this.T;
    for (const t of this.tiles.values()) {
      if (!t.vao) continue;
      if (!tileVisible(vp, t.ix * T, t.iz * T, T)) continue;
      gl.bindVertexArray(t.vao);
      gl.drawElements(gl.TRIANGLES, this.lods[t.lod].count, gl.UNSIGNED_SHORT, 0);
    }
    gl.bindVertexArray(null);
  }

  dispose() {
    for (const t of this.tiles.values()) this.free(t);
    for (const l of this.lods) this.gl.deleteBuffer(l.ibo);
    this.gl.deleteProgram(this.prog.program);
  }
}

/** Rough frustum test of a tile column (y range ±400 m) against clip space. */
function tileVisible(m, x0, z0, T) {
  let left = 0, right = 0, behind = 0, below = 0, above = 0;
  for (const y of [-150, 400])
    for (const [x, z] of [[x0, z0], [x0 + T, z0], [x0, z0 + T], [x0 + T, z0 + T]]) {
      const cx = m[0] * x + m[4] * y + m[8] * z + m[12];
      const cy = m[1] * x + m[5] * y + m[9] * z + m[13];
      const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
      if (cx < -cw) left++;
      if (cx > cw) right++;
      if (cw < 0.1) behind++;
      if (cy < -cw) below++;
      if (cy > cw) above++;
    }
  return left < 8 && right < 8 && behind < 8 && below < 8 && above < 8;
}

/** Deterministic jittered-grid scatter inside a tile: calls fn(x, z, r1, r2) for each cell. */
export function scatter(t, T, cell, salt, fn) {
  const n = Math.round(T / cell);
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const gi = t.ix * n + i, gj = t.iz * n + j;
      const r1 = hash2(gi, gj, salt);
      const r2 = hash2(gi, gj, salt + 1);
      fn(t.ix * T + (i + r1) * cell, t.iz * T + (j + r2) * cell, hash2(gi, gj, salt + 2), hash2(gi, gj, salt + 3));
    }
}
