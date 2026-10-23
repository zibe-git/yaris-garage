// Road ribbon in 64 m chunks along the centreline, built ahead of the car and dropped behind it. The surface is drawn
// in the shader: asphalt with lane markings and tyre wear (drive), or gravel with ruts and puddles (rally).
import { program, buffer, vao } from '../gl/gl.js';
import { LIGHT_GLSL } from '../gl/model.js';
import { NOISE_GLSL } from './glsl.js';
import { DS } from './road.js';

const CH = 32; // segments per chunk

const VS = `
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aNormal;
layout(location = 2) in vec2 aUv;   // lateral metres (+ left), distance along the road
uniform mat4 uViewProj;
out vec3 vPos;
out vec3 vNormal;
out vec2 vUv;
void main() {
  vPos = aPos;
  vNormal = aNormal;
  vUv = aUv;
  gl_Position = uViewProj * vec4(aPos, 1.0);
}`;

const FS = `
in vec3 vPos;
in vec3 vNormal;
in vec2 vUv;
uniform int uGravel;
uniform float uHalf;
uniform float uWet;
uniform float uTime;
out vec4 fragColor;
${LIGHT_GLSL}
${NOISE_GLSL}
void main() {
  vec3 n = normalize(vNormal);
  float u = vUv.x, v = vUv.y;
  // fine grain fades out where it would alias (far away / grazing angles)
  float fade = 1.0 - smoothstep(0.08, 0.4, length(fwidth(vUv)));
  float grain = mix(0.5, vnoise(vec2(u, v) * 9.0) * 0.6 + vnoise(vec2(u, v) * 23.0) * 0.4, fade);
  float blot = fbm2(vec2(u * 0.4, v * 0.08));
  vec3 albedo;
  float rough;
  if (uGravel == 0) {
    albedo = vec3(0.055, 0.056, 0.06) * (0.8 + 0.4 * grain) * (0.85 + 0.3 * blot);
    float wear = exp(-pow((abs(u + 1.85) - 0.75) / 0.35, 2.0)); // tyre tracks in the right lane, darker + smoother
    albedo *= 1.0 - 0.18 * wear;
    rough = 0.8 - 0.15 * wear;
    float au = abs(u);
    float edge = step(uHalf - 0.38, au) * step(au, uHalf - 0.24);
    float centre = step(au, 0.07) * step(fract(v / 9.0), 0.45);
    float paint = max(edge, centre) * (0.75 + 0.25 * grain);
    albedo = mix(albedo, vec3(0.62), paint);
    rough = mix(rough, 0.6, paint);
    float shoulder = smoothstep(uHalf - 0.05, uHalf + 0.25, au);
    albedo = mix(albedo, vec3(0.16, 0.15, 0.13), shoulder);
  } else {
    albedo = mix(vec3(0.16, 0.13, 0.1), vec3(0.24, 0.2, 0.15), blot) * (0.75 + 0.5 * grain);
    float rut = exp(-pow((abs(u) - 0.85) / 0.3, 2.0)) + 0.6 * exp(-pow(u / 0.4, 2.0));
    albedo *= 1.0 - 0.25 * rut;
    float stones = smoothstep(0.78, 0.86, vnoise(vec2(u, v) * 5.0)) * (1.0 - rut * 0.6) * fade;
    albedo = mix(albedo, vec3(0.32, 0.3, 0.27), stones);
    albedo *= 1.0 - 0.45 * uWet;
    rough = mix(0.95, 0.55, uWet);
    // puddles in the ruts and dips once it has rained a while
    float puddle = smoothstep(0.62, 0.7, fbm2(vec2(u * 0.7, v * 0.12)) + rut * 0.18) * uWet;
    float ripple = sin(length(fract(vec2(u, v) * 0.9) - 0.5) * 30.0 - uTime * 7.0) * 0.012 * puddle * fade;
    n = normalize(n + vec3(ripple, 0.0, ripple));
    albedo = mix(albedo, vec3(0.02, 0.02, 0.025), puddle);
    rough = mix(rough, 0.04, puddle);
  }
  vec3 c = shade(vPos, n, albedo, rough, 0.0, 0.0);
  fragColor = outColor(applyFog(c, vPos), 1.0);
}`;

export class RoadMesh {
  constructor(gl, road, { half, gravel = false, ahead = 700, behind = 160 }) {
    this.gl = gl;
    this.road = road;
    this.half = half;
    this.gravel = gravel;
    this.ahead = ahead;
    this.behind = behind;
    this.chunks = new Map();
    this.prog = program(gl, VS, FS);
    // lateral columns: skirt, edge, …, edge, skirt (skirts dip into the ground to hide gaps at embankments)
    const cols = [-half - 0.6, -half, -half / 2, 0, half / 2, half, half + 0.6];
    this.cols = cols;
    const idx = [];
    const nc = cols.length;
    for (let i = 0; i < CH; i++)
      for (let c = 0; c < nc - 1; c++) {
        const a = i * nc + c;
        idx.push(a, a + 1, a + nc, a + 1, a + nc + 1, a + nc);
      }
    this.count = idx.length;
    this.ibo = buffer(gl, new Uint16Array(idx), gl.ELEMENT_ARRAY_BUFFER);
    this.wet = 0;
  }

  chunkS(c) {
    return this.road.s0 + c * CH * DS;
  }

  update(s) {
    const c0 = Math.floor((s - this.behind - this.road.s0) / (CH * DS));
    const c1 = Math.floor((s + this.ahead - this.road.s0) / (CH * DS));
    for (const [c, ch] of this.chunks)
      if (c < c0 || c > c1) {
        this.gl.deleteBuffer(ch.vbo);
        this.gl.deleteVertexArray(ch.vao);
        this.chunks.delete(c);
      }
    let built = 0;
    for (let c = Math.max(0, c0); c <= c1 && built < 3; c++) {
      if (this.chunks.has(c)) continue;
      this.chunks.set(c, this.build(c));
      built++;
    }
  }

  build(c) {
    const gl = this.gl;
    const nc = this.cols.length;
    const data = new Float32Array((CH + 1) * nc * 8);
    const p = {};
    const sStart = this.chunkS(c);
    for (let i = 0; i <= CH; i++) {
      const s = sStart + i * DS;
      this.road.sample(s, p);
      const h = p.heading;
      const t = [Math.sin(h), p.grade, Math.cos(h)];
      const left = [Math.cos(h), 0, -Math.sin(h)];
      let n = [t[1] * left[2] - t[2] * left[1], t[2] * left[0] - t[0] * left[2], t[0] * left[1] - t[1] * left[0]];
      const l = Math.hypot(...n);
      n = n.map((x) => x / l);
      for (let k = 0; k < nc; k++) {
        const u = this.cols[k];
        const skirt = k === 0 || k === nc - 1;
        const crown = this.gravel ? 0.06 * (1 - (u / this.half) ** 2) : 0.04 * (1 - (u / this.half) ** 2);
        const o = (i * nc + k) * 8;
        data[o] = p.x + left[0] * u;
        data[o + 1] = p.y + (skirt ? -0.45 : crown + (this.gravel ? 0.03 : 0.01));
        data[o + 2] = p.z + left[2] * u;
        data[o + 3] = n[0]; data[o + 4] = n[1]; data[o + 5] = n[2];
        data[o + 6] = u;
        data[o + 7] = s;
      }
    }
    const vbo = buffer(gl, data);
    return {
      vbo,
      vao: vao(gl, [
        { loc: 0, buffer: vbo, size: 3, stride: 32, offset: 0 },
        { loc: 1, buffer: vbo, size: 3, stride: 32, offset: 12 },
        { loc: 2, buffer: vbo, size: 2, stride: 32, offset: 24 },
      ], this.ibo),
    };
  }

  draw(camera, light, time) {
    const gl = this.gl;
    this.prog.use().set({ ...light, uViewProj: camera.viewProj, uEye: camera.eye, uGravel: this.gravel ? 1 : 0, uHalf: this.half, uWet: this.wet, uTime: time });
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(-1, -4);
    for (const ch of this.chunks.values()) {
      gl.bindVertexArray(ch.vao);
      gl.drawElements(gl.TRIANGLES, this.count, gl.UNSIGNED_SHORT, 0);
    }
    gl.bindVertexArray(null);
    gl.disable(gl.POLYGON_OFFSET_FILL);
  }

  dispose() {
    const gl = this.gl;
    for (const ch of this.chunks.values()) {
      gl.deleteBuffer(ch.vbo);
      gl.deleteVertexArray(ch.vao);
    }
    gl.deleteBuffer(this.ibo);
    gl.deleteProgram(this.prog.program);
  }
}
