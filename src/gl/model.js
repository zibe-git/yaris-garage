// The Yaris as one GPU mesh (public/model/car.bin from tools/bake.mjs) drawn in a single call. Everything that differs
// per part lives in a float "part table" texture the vertex shader reads with the vertex's part index:
//   row 0  offset xyz (model mm), alpha (0 = hidden, < 1 = drawn in the transparent pass)
//   row 1  colour rgb, highlight (mixed towards uHighlight)
//   row 2  pivot xyz (model mm) the rotation turns around
//   row 3  rotation quaternion xyzw
//   row 4  wheel index (-1 = body), material code, -, -
// Apps only write rows and call upload(); explode, puzzle, wheel spin and colour modes are all table writes.
// Model mm (+x fwd, +y left, +z up) → car frame metres (+x left, +y up, +z fwd, origin on the ground between axles)
// by uModel; uBody moves the body on its suspension (wheels skip it); uWorld places the car in the world.
import { program, buffer, vao, texture, framebuffer } from './gl.js';
import { mat4, hexRGB } from './math.js';

export const MAT = { metal: 0, paint: 1, glass: 2, chrome: 3, rubber: 4, lamp: 5, matte: 6 };
const RENDER_MAT = { paint: MAT.paint, glass: MAT.glass, interior: MAT.matte, chassis: MAT.metal, trim: MAT.matte, tire: MAT.rubber, rim: MAT.chrome, brake: MAT.metal, headlight: MAT.chrome, taillight: MAT.lamp };
const ROWS = 5;

let cache = null;

// Read a response with progress; null on 404.
async function fetchProgress(url, onProgress) {
  const res = await fetch(url);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  if (!res.body || !total) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    onProgress?.(Math.min(1, got / total));
  }
  const out = new Uint8Array(got);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

// The bake also writes car.bin.gz (half the size) because static hosts such as GitHub Pages don't compress binary
// files. The browser's own DecompressionStream unpacks it, off the main thread; if the server already decoded it
// (Content-Encoding), the gzip magic bytes are gone and the data is used as is.
async function fetchCarBin(base, onProgress) {
  if (typeof DecompressionStream !== 'undefined') {
    const gz = await fetchProgress(`${base}/car.bin.gz`, onProgress);
    if (gz) {
      if (gz[0] !== 0x1f || gz[1] !== 0x8b) return gz.buffer;
      return new Response(new Blob([gz]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
    }
  }
  const raw = await fetchProgress(`${base}/car.bin`, onProgress);
  if (!raw) throw new Error('car.bin not found — run "npm run model" first');
  return raw.buffer;
}

/** Download the baked car once per page; later apps reuse it. */
export function loadCarData(onProgress) {
  if (!cache) {
    const base = `${import.meta.env.BASE_URL}model`;
    cache = Promise.all([fetch(`${base}/car.json`).then((r) => {
      if (!r.ok) throw new Error(`car.json: HTTP ${r.status} — run "npm run model" first`);
      return r.json();
    }), fetchCarBin(base, (f) => listeners.forEach((l) => l(f)))]).then(([layout, bin]) => ({ layout, bin }));
    cache.catch(() => (cache = null));
  }
  if (onProgress) listeners.add(onProgress);
  return cache.finally(() => listeners.delete(onProgress));
}
const listeners = new Set();

export const LIGHT_GLSL = `
uniform vec3 uEye;
uniform vec3 uSunDir;      // towards the sun
uniform vec3 uSunColor;
uniform vec3 uSkyColor;    // zenith
uniform vec3 uHorizonColor;
uniform vec3 uGroundColor;
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform float uExposure;
uniform vec4 uSpot[4];      // xyz position, w = on (rally headlights; car frame lights in world space)
uniform vec4 uSpotDir[4];   // xyz direction, w = cos cut-off
uniform vec3 uSpotColor;

vec3 envColor(vec3 d) {
  float up = clamp(d.y, -1.0, 1.0);
  vec3 sky = mix(uHorizonColor, uSkyColor, pow(max(up, 0.0), 0.6));
  vec3 c = mix(uGroundColor * 0.6, sky, smoothstep(-0.08, 0.04, up));
  return c + uSunColor * pow(max(dot(d, uSunDir), 0.0), 600.0) * 4.0;
}
vec3 spotLight(vec3 p, vec3 n) {
  vec3 sum = vec3(0.0);
  for (int i = 0; i < 4; i++) {
    if (uSpot[i].w < 0.5) continue;
    vec3 L = uSpot[i].xyz - p;
    float d = length(L);
    L /= d;
    float cone = smoothstep(uSpotDir[i].w, mix(uSpotDir[i].w, 1.0, 0.35), dot(-L, uSpotDir[i].xyz));
    sum += uSpotColor * cone * max(dot(n, L), 0.0) * 60.0 / (1.0 + d * d * 0.35);
  }
  return sum;
}
vec3 applyFog(vec3 c, vec3 p) {
  float d = length(p - uEye);
  float f = 1.0 - exp(-uFogDensity * uFogDensity * d * d);
  return mix(c, uFogColor, clamp(f, 0.0, 1.0));
}
vec3 aces(vec3 x) {
  x *= uExposure;
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}
vec4 outColor(vec3 c, float a) { return vec4(pow(aces(c), vec3(1.0 / 2.2)), a); }
// shared lit surface: albedo, normal facing the viewer, roughness 0..1, metal 0..1, clearcoat 0..1
vec3 shade(vec3 p, vec3 n, vec3 albedo, float rough, float metal, float coat) {
  vec3 V = normalize(uEye - p);
  float ndl = max(dot(n, uSunDir), 0.0);
  vec3 hemi = mix(uGroundColor, uSkyColor * 1.1 + uHorizonColor * 0.4, n.y * 0.5 + 0.5);
  vec3 H = normalize(uSunDir + V);
  float shin = mix(600.0, 8.0, rough);
  float spec = pow(max(dot(n, H), 0.0), shin) * (shin + 8.0) / 25.0;
  float fres = pow(1.0 - max(dot(n, V), 0.0), 5.0);
  vec3 F0 = mix(vec3(0.04), albedo, metal);
  vec3 F = F0 + (1.0 - F0) * fres;
  vec3 diffuse = albedo * (1.0 - metal) * (hemi * 0.85 + uSunColor * ndl + spotLight(p, n));
  vec3 refl = envColor(reflect(-V, n));
  vec3 c = diffuse + F * refl * (1.0 - rough * 0.85) + uSunColor * F * spec * ndl;
  c += coat * (0.04 + 0.96 * fres) * envColor(reflect(-V, n)) * 0.9 + coat * uSunColor * pow(max(dot(n, H), 0.0), 900.0) * 5.0 * ndl;
  return c;
}
`;

const VS = `
layout(location = 0) in uvec4 aPos;   // quantised position xyz + part index
layout(location = 1) in vec4 aNormal;
uniform highp sampler2D uParts;
uniform vec3 uBMin;
uniform vec3 uBSize;
uniform mat4 uModel;
uniform mat4 uBody;
uniform mat4 uWorld;
uniform mat4 uViewProj;
uniform int uPass;        // 0 opaque, 1 transparent, 2 pick
out vec3 vWorld;
out vec3 vNormal;
out vec4 vColor;
out float vAlpha;
flat out int vPart;
flat out int vMat;
vec3 qrot(vec4 q, vec3 v) { return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v); }
void main() {
  int part = int(aPos.w);
  vec4 off = texelFetch(uParts, ivec2(part, 0), 0);
  vec4 col = texelFetch(uParts, ivec2(part, 1), 0);
  vec3 pivot = texelFetch(uParts, ivec2(part, 2), 0).xyz;
  vec4 q = texelFetch(uParts, ivec2(part, 3), 0);
  vec4 flags = texelFetch(uParts, ivec2(part, 4), 0);
  bool skip = off.w <= 0.0 || (uPass == 0 && off.w < 0.999) || (uPass == 1 && off.w >= 0.999) || (uPass == 2 && off.w < 0.5);
  if (skip) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  vec3 p = uBMin + vec3(aPos.xyz) / 65535.0 * uBSize;
  p = pivot + qrot(q, p - pivot) + off.xyz;
  vec3 n = qrot(q, aNormal.xyz);
  mat4 m = flags.x < 0.0 ? uWorld * uBody * uModel : uWorld * uModel;
  vec4 w = m * vec4(p, 1.0);
  vWorld = w.xyz;
  vNormal = mat3(m) * n;
  vColor = col;
  vAlpha = off.w;
  vPart = part;
  vMat = int(flags.y + 0.5);
  gl_Position = uViewProj * w;
}`;

const FS = `
in vec3 vWorld;
in vec3 vNormal;
in vec4 vColor;
in float vAlpha;
flat in int vPart;
flat in int vMat;
uniform int uPass;
uniform vec3 uHighlight;
uniform float uMudLevel;
out vec4 fragColor;
${LIGHT_GLSL}
void main() {
  if (uPass == 2) {
    int id = vPart + 1;
    fragColor = vec4(float(id & 255), float((id >> 8) & 255), float((id >> 16) & 255), 255.0) / 255.0;
    return;
  }
  vec3 n = normalize(vNormal);
  if (length(vNormal) < 1e-4) n = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
  vec3 V = normalize(uEye - vWorld);
  if (dot(n, V) < 0.0) n = -n; // FE shells are single surfaces with arbitrary orientation
  vec3 albedo = vColor.rgb;
  float rough = 0.55, metal = 0.0, coat = 0.0;
  if (vMat == 1) { rough = 0.35; metal = 0.25; coat = 1.0; }
  else if (vMat == 2) { rough = 0.05; }
  else if (vMat == 3) { rough = 0.25; metal = 1.0; }
  else if (vMat == 4) { rough = 0.9; }
  else if (vMat == 6) { rough = 0.85; }
  // mud splashed up from the wheels (rally): low on the body, more towards the wheel arches
  if (uMudLevel > 0.0 && vMat != 2) {
    float h = clamp(1.0 - (vWorld.y - 0.0) / 0.75, 0.0, 1.0);
    float m = smoothstep(0.2, 0.9, h * uMudLevel + 0.15 * sin(vWorld.x * 23.0 + vWorld.z * 17.0));
    albedo = mix(albedo, vec3(0.16, 0.12, 0.08), m);
    rough = mix(rough, 0.95, m);
    coat *= 1.0 - m;
  }
  vec3 c = shade(vWorld, n, albedo, rough, metal, coat);
  if (vMat == 5) c += albedo * 1.4;
  c = mix(c, uHighlight * 1.4 + c * 0.4, vColor.a);
  float a = vAlpha;
  if (uPass == 1) {
    float rim = pow(1.0 - abs(dot(n, V)), 2.0);
    a = clamp(vAlpha + rim * vAlpha * 2.5, 0.0, 1.0);
  }
  if (vMat == 2 && uPass == 1) a = max(a, 0.35);
  fragColor = outColor(applyFog(c, vWorld), a);
}`;

/** Light settings with sensible daytime defaults; apps override per scene. */
export function defaultLight() {
  return {
    uSunDir: normalizeArr([0.45, 0.8, 0.35]),
    uSunColor: [2.2, 2.1, 1.95],
    uSkyColor: [0.32, 0.5, 0.82],
    uHorizonColor: [0.75, 0.82, 0.9],
    uGroundColor: [0.28, 0.27, 0.25],
    uFogColor: [0.75, 0.82, 0.9],
    uFogDensity: 0,
    uExposure: 1,
    uSpot: new Float32Array(16),
    uSpotDir: new Float32Array(16),
    uSpotColor: [1, 0.95, 0.85],
  };
}
export function normalizeArr(v) {
  const l = Math.hypot(...v) || 1;
  return v.map((x) => x / l);
}

// Part id nearest to the tap in a small read-back window (thin parts stay tappable with a finger), or -1.
function nearestId(buf, { x0, y0, ww, hh, px, py }) {
  let best = -1;
  let bestD = Infinity;
  for (let j = 0; j < hh; j++)
    for (let i = 0; i < ww; i++) {
      const o = (j * ww + i) * 4;
      const id = buf[o] | (buf[o + 1] << 8) | (buf[o + 2] << 16);
      const d = (x0 + i - px) ** 2 + (y0 + j - py) ** 2;
      if (id && d < bestD) {
        bestD = d;
        best = id - 1;
      }
    }
  return best;
}

export class CarModel {
  constructor(ctx, { layout, bin }) {
    const gl = (this.gl = ctx.gl);
    this.ctx = ctx;
    this.layout = layout;
    this.parts = layout.parts;
    this.n = layout.parts.length;
    this.byPid = new Map(layout.parts.map((p, i) => [p.pid, i]));
    const vbuf = new Uint8Array(bin, 0, layout.vertexBytes);
    const ibuf = new Uint8Array(bin, layout.vertexBytes, layout.indexBytes);
    this.vbo = buffer(gl, vbuf);
    this.ibo = buffer(gl, ibuf, gl.ELEMENT_ARRAY_BUFFER);
    this.vao = vao(gl, [
      { loc: 0, buffer: this.vbo, size: 4, type: gl.UNSIGNED_SHORT, integer: true, stride: 12, offset: 0 },
      { loc: 1, buffer: this.vbo, size: 4, type: gl.BYTE, normalized: true, stride: 12, offset: 8 },
    ], this.ibo);
    this.prog = program(gl, VS, FS);
    this.table = new Float32Array(this.n * ROWS * 4);
    this.tex = texture(gl, { width: this.n, height: ROWS, data: this.table, internal: gl.RGBA32F, format: gl.RGBA, type: gl.FLOAT, filter: gl.NEAREST });
    this.dirty = true;
    this.pickFb = framebuffer(gl);
    const [ox, oy, oz] = layout.origin;
    // model mm → car frame metres: x_car = y_model, y_car = z_model, z_car = x_model
    this.modelMatrix = new Float32Array([0, 0, 0.001, 0, 0.001, 0, 0, 0, 0, 0.001, 0, 0, -oy / 1000, -oz / 1000, -ox / 1000, 1]);
    this.body = mat4.create();
    this.world = mat4.create();
    this.highlight = [1, 0.62, 0.15];
    this.mud = 0;
    this.groupColor = new Map(layout.groups.map((g) => [g.id, hexRGB(g.color)]));
    this.reset();
  }

  /** Every part visible, in its place, coloured by group (explorer default). */
  reset() {
    for (let i = 0; i < this.n; i++) {
      const p = this.parts[i];
      this.setOffset(i, 0, 0, 0, 1);
      this.setColor(i, this.groupColor.get(p.group) || [0.7, 0.7, 0.7], 0);
      this.setPivot(i, p.centroid);
      this.setRotation(i, [0, 0, 0, 1]);
      this.row(i, 4).set([p.wheel, p.group === 'glazing' ? MAT.glass : MAT.metal, 0, 0]);
    }
    return this;
  }

  /** Drive / Rally look: exterior parts only, real-ish colours and materials, wheels pivot on their axles. */
  dressAsCar(paint = [0.55, 0.02, 0.03]) {
    const colors = { paint, glass: [0.02, 0.03, 0.035], interior: [0.08, 0.08, 0.085], chassis: [0.05, 0.05, 0.055], trim: [0.03, 0.03, 0.035], tire: [0.035, 0.035, 0.035], rim: [0.75, 0.77, 0.8], brake: [0.3, 0.3, 0.32], headlight: [0.8, 0.82, 0.85], taillight: [0.6, 0.02, 0.02] };
    for (let i = 0; i < this.n; i++) {
      const p = this.parts[i];
      this.setOffset(i, 0, 0, 0, !p.render ? 0 : p.render === 'glass' ? 0.55 : 1);
      this.setColor(i, colors[p.render] || [0.5, 0.5, 0.5], 0);
      this.setPivot(i, p.wheel >= 0 ? this.layout.wheels[p.wheel] : p.centroid);
      this.setRotation(i, [0, 0, 0, 1]);
      this.row(i, 4).set([p.wheel, RENDER_MAT[p.render] ?? MAT.metal, 0, 0]);
    }
    this.paintParts = this.parts.map((p, i) => (p.render === 'paint' ? i : -1)).filter((i) => i >= 0);
    this.wheelParts = this.parts.map((p, i) => (p.wheel >= 0 ? i : -1)).filter((i) => i >= 0);
    return this;
  }

  setPaint(rgb) {
    for (const i of this.paintParts || []) this.row(i, 1).set([...rgb, 0]);
    this.dirty = true;
  }

  /** Wheel spin (rolled angle, radians) and front steer (radians, + = left). Model frame: axle = y, steer axis = z. */
  setWheels(spin, steer) {
    const s = Math.sin(spin / 2), c = Math.cos(spin / 2);
    const spinQ = [0, s, 0, c];
    const ss = Math.sin(steer / 2), sc = Math.cos(steer / 2);
    const front = [-ss * s, sc * s, ss * c, sc * c]; // qSteer(z) * qSpin(y)
    for (const i of this.wheelParts || []) this.row(i, 3).set(this.parts[i].wheel < 2 ? front : spinQ);
    this.dirty = true;
  }

  row(i, r) {
    const o = (r * this.n + i) * 4;
    this.dirty = true;
    return this.table.subarray(o, o + 4);
  }
  setOffset(i, x, y, z, alpha) {
    const r = this.row(i, 0);
    r[0] = x; r[1] = y; r[2] = z;
    if (alpha !== undefined) r[3] = alpha;
  }
  setAlpha(i, a) {
    this.row(i, 0)[3] = a;
  }
  alpha(i) {
    return this.table[i * 4 + 3];
  }
  setColor(i, rgb, highlight) {
    const r = this.row(i, 1);
    r[0] = rgb[0]; r[1] = rgb[1]; r[2] = rgb[2];
    if (highlight !== undefined) r[3] = highlight;
  }
  setHighlight(i, h) {
    this.row(i, 1)[3] = h;
  }
  setPivot(i, p) {
    this.row(i, 2).set([p[0], p[1], p[2], 0]);
  }
  setRotation(i, q) {
    this.row(i, 3).set(q);
  }
  offset(i) {
    return this.table.subarray(i * 4, i * 4 + 3);
  }

  upload() {
    if (!this.dirty) return;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.n, ROWS, gl.RGBA, gl.FLOAT, this.table);
    this.dirty = false;
  }

  /** Model mm point → world metres (ignores uBody). */
  toWorld(p) {
    const m = mat4.multiply(mat4.create(), this.world, this.modelMatrix);
    const r = mat4.project(m, p);
    return [r[0], r[1], r[2]];
  }

  _uniforms(camera, light, pass) {
    const L = this.layout;
    this.prog.use().set({
      ...light,
      uParts: this.tex,
      uBMin: L.bboxMin,
      uBSize: L.bboxMax.map((v, i) => v - L.bboxMin[i]),
      uModel: this.modelMatrix,
      uBody: this.body,
      uWorld: this.world,
      uViewProj: camera.viewProj,
      uEye: camera.eye,
      uPass: pass,
      uHighlight: this.highlight,
      uMudLevel: this.mud,
    });
  }

  /**
   * Draw. range: 'all' | 'exterior' (opaque + glass tiers) | [firstIndex, count].
   * Opaque pass first, then parts with 0 < alpha < 1 blended (ghosts, glass) without depth writes.
   */
  draw(camera, light, { range = 'all', transparent = true } = {}) {
    const gl = this.gl;
    this.upload();
    const L = this.layout.ranges;
    const [first, count] = range === 'all' ? [0, this.layout.triangles * 3] : range === 'exterior' ? [0, L.glass[0] + L.glass[1]] : range;
    gl.bindVertexArray(this.vao);
    gl.enable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    this._uniforms(camera, light, 0);
    gl.drawElements(gl.TRIANGLES, count, gl.UNSIGNED_INT, first * 4);
    if (transparent) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);
      this.prog.set({ uPass: 1 });
      gl.drawElements(gl.TRIANGLES, count, gl.UNSIGNED_INT, first * 4);
      gl.depthMask(true);
      gl.disable(gl.BLEND);
    }
    gl.bindVertexArray(null);
  }

  /**
   * pick() without stalling the GPU pipeline: the id buffer is read into a pixel-pack buffer and fetched once a fence
   * says the GPU is done, a frame or two later. Keeps taps responsive (INP) on slow phones.
   */
  pickAsync(camera, light, x, y) {
    const gl = this.gl;
    const area = this._renderPick(camera, light, x, y);
    if (!area) return Promise.resolve(-1);
    const { x0, y0, ww, hh } = area;
    const pbo = gl.createBuffer();
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo);
    gl.bufferData(gl.PIXEL_PACK_BUFFER, ww * hh * 4, gl.STREAM_READ);
    gl.readPixels(x0, y0, ww, hh, gl.RGBA, gl.UNSIGNED_BYTE, 0);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.ctx.width, this.ctx.height);
    const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
    return new Promise((resolve) => {
      const poll = () => {
        if (gl.isContextLost()) return resolve(-1);
        const s = gl.clientWaitSync(sync, 0, 0);
        if (s === gl.TIMEOUT_EXPIRED) return requestAnimationFrame(poll);
        gl.deleteSync(sync);
        const buf = new Uint8Array(ww * hh * 4);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo);
        gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, buf);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
        gl.deleteBuffer(pbo);
        resolve(nearestId(buf, area));
      };
      requestAnimationFrame(poll);
    });
  }

  _renderPick(camera, light, x, y) {
    const gl = this.gl;
    const rect = this.ctx.canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width / 2));
    const h = Math.max(1, Math.round(rect.height / 2));
    this.pickFb.resize(w, h);
    this.upload();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.pickFb.fbo);
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.bindVertexArray(this.vao);
    this._uniforms(camera, light, 2);
    gl.drawElements(gl.TRIANGLES, this.layout.triangles * 3, gl.UNSIGNED_INT, 0);
    gl.bindVertexArray(null);
    const R = 6;
    const px = Math.round(((x - rect.left) / rect.width) * w);
    const py = Math.round((1 - (y - rect.top) / rect.height) * h);
    const x0 = Math.max(0, px - R), y0 = Math.max(0, py - R);
    const ww = Math.min(w, px + R + 1) - x0, hh = Math.min(h, py + R + 1) - y0;
    if (ww <= 0 || hh <= 0) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, this.ctx.width, this.ctx.height);
      return null;
    }
    return { x0, y0, ww, hh, px, py };
  }

  /** Index of the part under a CSS-pixel point, or -1. Renders a part-id buffer (parts with alpha >= 0.5). */
  pick(camera, light, x, y) {
    const gl = this.gl;
    const area = this._renderPick(camera, light, x, y);
    if (!area) return -1;
    const buf = new Uint8Array(area.ww * area.hh * 4);
    gl.readPixels(area.x0, area.y0, area.ww, area.hh, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.ctx.width, this.ctx.height);
    return nearestId(buf, area);
  }

  dispose() {
    const gl = this.gl;
    gl.deleteBuffer(this.vbo);
    gl.deleteBuffer(this.ibo);
    gl.deleteVertexArray(this.vao);
    gl.deleteTexture(this.tex);
  }
}
