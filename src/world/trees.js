// Instanced low-poly forest: a conifer and a broadleaf mesh, one instanced draw call each. Instances come from the
// terrain tiles (Terrain plant callback) and are re-packed when the tile set changes. Foliage sways in the wind.
import { program, buffer, vao } from '../gl/gl.js';
import { LIGHT_GLSL } from '../gl/model.js';

const VS = `
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aNormal;
layout(location = 2) in float aLeaf;      // 0 trunk, 1 foliage
layout(location = 3) in vec4 aInst;       // x y z scale
layout(location = 4) in vec2 aInst2;      // rotation, variant
uniform mat4 uViewProj;
uniform float uTime;
uniform float uWind;
out vec3 vPos;
out vec3 vNormal;
out float vLeaf;
out float vVar;
void main() {
  float c = cos(aInst2.x), s = sin(aInst2.x);
  vec3 p = aPos * aInst.w;
  p.xz = mat2(c, -s, s, c) * p.xz;
  vec3 n = aNormal;
  n.xz = mat2(c, -s, s, c) * n.xz;
  float sway = aLeaf * uWind * (p.y / (aInst.w * 10.0)) * (sin(uTime * 1.3 + aInst.x * 0.2 + aInst.z * 0.13) * 0.18 + sin(uTime * 3.1 + aInst.z) * 0.05);
  p.x += sway;
  p.z += sway * 0.6;
  vPos = p + aInst.xyz;
  vNormal = n;
  vLeaf = aLeaf;
  vVar = aInst2.y;
  gl_Position = uViewProj * vec4(vPos, 1.0);
}`;

const FS = `
in vec3 vPos;
in vec3 vNormal;
in float vLeaf;
in float vVar;
uniform vec3 uLeafA;
uniform vec3 uLeafB;
uniform vec3 uTrunk;
out vec4 fragColor;
${LIGHT_GLSL}
void main() {
  vec3 n = normalize(vNormal);
  vec3 albedo = vLeaf > 0.5 ? mix(uLeafA, uLeafB, vVar) : uTrunk;
  vec3 c = shade(vPos, n, albedo, 0.9, 0.0, 0.0);
  c += albedo * uSkyColor * 0.25 * vLeaf; // light through the leaves
  fragColor = outColor(applyFog(c, vPos), 1.0);
}`;

// ---- meshes (unit trees ≈ 10 m tall at scale 1) ----
function lathe(out, rings, sides, leaf) {
  // rings: [[y, r], ...] bottom → top; flat shaded side quads
  for (let k = 0; k < rings.length - 1; k++) {
    const [y0, r0] = rings[k], [y1, r1] = rings[k + 1];
    for (let i = 0; i < sides; i++) {
      const a0 = (i / sides) * Math.PI * 2, a1 = ((i + 1) / sides) * Math.PI * 2;
      const am = (a0 + a1) / 2;
      const slope = (r0 - r1) / Math.max(y1 - y0, 1e-3);
      const nl = Math.hypot(1, slope);
      const nrm = [Math.cos(am) / nl, slope / nl, Math.sin(am) / nl];
      const v = (a, r, y) => [Math.cos(a) * r, y, Math.sin(a) * r];
      const quad = [v(a0, r0, y0), v(a1, r0, y0), v(a1, r1, y1), v(a0, r0, y0), v(a1, r1, y1), v(a0, r1, y1)];
      for (const p of quad) out.push(...p, ...nrm, leaf);
    }
  }
}

function conifer() {
  const out = [];
  lathe(out, [[0, 0.22], [2.2, 0.16]], 5, 0);
  lathe(out, [[1.6, 2.2], [4.6, 0.9], [4.0, 1.9], [7.0, 0.6], [6.4, 1.4], [10, 0.02]], 7, 1);
  return new Float32Array(out);
}

function broadleaf() {
  const out = [];
  lathe(out, [[0, 0.3], [3.6, 0.2]], 5, 0);
  const blob = (cx, cy, cz, r) => {
    const rings = [];
    for (let k = 0; k <= 4; k++) {
      const a = (k / 4) * Math.PI;
      rings.push([cy - Math.cos(a) * r * 0.85, Math.sin(a) * r + 0.01]);
    }
    const start = out.length;
    lathe(out, rings, 7, 1);
    for (let i = start; i < out.length; i += 7) {
      out[i] += cx;
      out[i + 2] += cz;
    }
  };
  blob(0, 6.2, 0, 3.2);
  blob(1.2, 8.2, 0.6, 2.1);
  blob(-1.1, 7.6, -0.8, 2.2);
  return new Float32Array(out);
}

export class Forest {
  constructor(gl, { leafA = [0.03, 0.09, 0.025], leafB = [0.07, 0.13, 0.03], trunk = [0.09, 0.06, 0.04], wind = 1 } = {}) {
    this.gl = gl;
    this.prog = program(gl, VS, FS);
    this.colors = { uLeafA: leafA, uLeafB: leafB, uTrunk: trunk };
    this.wind = wind;
    this.kinds = [conifer(), broadleaf()].map((mesh) => {
      const vbo = buffer(gl, mesh);
      const inst = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, inst);
      gl.bufferData(gl.ARRAY_BUFFER, 24, gl.DYNAMIC_DRAW);
      const v = vao(gl, [
        { loc: 0, buffer: vbo, size: 3, stride: 28, offset: 0 },
        { loc: 1, buffer: vbo, size: 3, stride: 28, offset: 12 },
        { loc: 2, buffer: vbo, size: 1, stride: 28, offset: 24 },
        { loc: 3, buffer: inst, size: 4, stride: 24, offset: 0, divisor: 1 },
        { loc: 4, buffer: inst, size: 2, stride: 24, offset: 16, divisor: 1 },
      ]);
      return { vbo, inst, vao: v, verts: mesh.length / 7, count: 0, capacity: 1 };
    });
    this.version = -1;
    this.timer = 0;
  }

  /** Re-pack instances from the terrain tiles when they changed (at most 4× a second). */
  sync(terrain, dt) {
    this.timer -= dt;
    if (terrain.version === this.version || this.timer > 0) return;
    this.version = terrain.version;
    this.timer = 0.25;
    const gl = this.gl;
    for (const [k, kind] of this.kinds.entries()) {
      let n = 0;
      for (const t of terrain.tiles.values()) if (t.trees) n += t.trees[k].length;
      const data = new Float32Array(n);
      let o = 0;
      for (const t of terrain.tiles.values())
        if (t.trees) {
          data.set(t.trees[k], o);
          o += t.trees[k].length;
        }
      gl.bindBuffer(gl.ARRAY_BUFFER, kind.inst);
      if (data.byteLength > kind.capacity) {
        kind.capacity = Math.max(data.byteLength, kind.capacity * 2);
        gl.bufferData(gl.ARRAY_BUFFER, kind.capacity, gl.DYNAMIC_DRAW);
      }
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, data);
      kind.count = n / 6;
    }
  }

  get count() {
    return this.kinds[0].count + this.kinds[1].count;
  }

  draw(camera, light, time) {
    const gl = this.gl;
    this.prog.use().set({ ...light, ...this.colors, uViewProj: camera.viewProj, uEye: camera.eye, uTime: time, uWind: this.wind });
    gl.enable(gl.DEPTH_TEST);
    for (const k of this.kinds) {
      if (!k.count) continue;
      gl.bindVertexArray(k.vao);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, k.verts, k.count);
    }
    gl.bindVertexArray(null);
  }

  dispose() {
    const gl = this.gl;
    for (const k of this.kinds) {
      gl.deleteBuffer(k.vbo);
      gl.deleteBuffer(k.inst);
      gl.deleteVertexArray(k.vao);
    }
    gl.deleteProgram(this.prog.program);
  }
}

/** Helper for Terrain.plant: arrays of instance floats per kind [conifers, broadleaves]. */
export function treeLists() {
  return [[], []];
}
