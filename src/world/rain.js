// Rain streaks and lightning bolts. Drops live in a box that wraps around the camera (fixed in the world, so they
// stream past as the camera moves) and are stretched by their velocity relative to the camera; the car's lamps and
// lightning light them. One instanced draw. Bolts are jagged branching ribbons far away, shown while a flash lasts.
import { program, buffer, vao } from '../gl/gl.js';
import { LIGHT_GLSL } from '../gl/model.js';

const VS = `
layout(location = 0) in vec2 aCorner;  // x: side -1/1, y: 0 head … 1 tail
layout(location = 1) in vec3 aSeed;
uniform mat4 uViewProj;
uniform vec3 uBox;
uniform vec3 uFall;
uniform vec3 uCamVel;
uniform vec3 uEye;
uniform float uTime;
out float vAlong;
out float vSide;
out vec3 vPos;
out float vFade;
void main() {
  vec3 p = aSeed * uBox + uFall * uTime;
  p = uEye + mod(p - uEye, uBox) - uBox * 0.5;
  vec3 rel = uFall - uCamVel;
  float rl = length(rel);
  rel *= min(rl, 45.0) / max(rl, 1e-3); // camera cuts must not smear drops across the screen
  vec3 tail = p - rel * 0.045;
  vec3 q = mix(p, tail, aCorner.y);
  vec3 dir = normalize(tail - p);
  vec3 view = normalize(q - uEye);
  vec3 side = normalize(cross(dir, view));
  float dist = length(q - uEye);
  q += side * aCorner.x * (0.006 + dist * 0.0012);
  vAlong = aCorner.y;
  vSide = aCorner.x;
  vPos = q;
  vFade = smoothstep(0.6, 2.0, dist) * (1.0 - smoothstep(uBox.x * 0.32, uBox.x * 0.5, dist));
  gl_Position = uViewProj * vec4(q, 1.0);
}`;

const FS = `
in float vAlong;
in float vSide;
in vec3 vPos;
in float vFade;
uniform float uFlash;
uniform float uDensity;
out vec4 fragColor;
${LIGHT_GLSL}
void main() {
  float a = (1.0 - vSide * vSide) * sin(vAlong * 3.14159) * vFade * uDensity;
  vec3 lit = uSkyColor * 6.0 + spotLight(vPos, normalize(uSpot[0].xyz - vPos)) * 0.9 + vec3(0.7, 0.75, 1.0) * uFlash * 0.8;
  fragColor = vec4(pow(lit, vec3(1.0 / 2.2)) * a, a * 0.5);
}`;

export class Rain {
  constructor(gl, count = 2200) {
    this.gl = gl;
    this.count = count;
    this.prog = program(gl, VS, FS);
    this.quad = buffer(gl, new Float32Array([-1, 0, 1, 0, -1, 1, 1, 1]));
    const seeds = new Float32Array(count * 3);
    for (let i = 0; i < seeds.length; i++) seeds[i] = Math.random();
    this.seeds = buffer(gl, seeds);
    this.vao = vao(gl, [{ loc: 0, buffer: this.quad, size: 2 }, { loc: 1, buffer: this.seeds, size: 3, divisor: 1 }]);
    this.density = 1;
    this.wind = [1.5, 0, 0.8];
  }

  draw(camera, light, time, camVel, flash) {
    if (this.density <= 0.01) return;
    const gl = this.gl;
    const n = Math.round(this.count * Math.min(1, this.density));
    this.prog.use().set({ ...light, uViewProj: camera.viewProj, uEye: camera.eye, uBox: [26, 18, 26], uFall: [this.wind[0], -11, this.wind[2]], uCamVel: camVel, uTime: time, uFlash: flash, uDensity: 0.55 + 0.45 * this.density });
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    gl.bindVertexArray(this.vao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, n);
    gl.bindVertexArray(null);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
  }

  dispose() {
    const gl = this.gl;
    gl.deleteBuffer(this.quad);
    gl.deleteBuffer(this.seeds);
    gl.deleteVertexArray(this.vao);
    gl.deleteProgram(this.prog.program);
  }
}

const BOLT_VS = `
layout(location = 0) in vec3 aPos;
layout(location = 1) in float aGlow;
uniform mat4 uViewProj;
out float vGlow;
void main() {
  vGlow = aGlow;
  gl_Position = uViewProj * vec4(aPos, 1.0);
  gl_Position.z = gl_Position.w * 0.9999; // behind everything but the sky
}`;
const BOLT_FS = `
in float vGlow;
uniform float uFlash;
out vec4 fragColor;
void main() {
  float a = (1.0 - abs(vGlow)) * uFlash;
  fragColor = vec4(vec3(0.85, 0.9, 1.0) * a * 1.5, a);
}`;

/** A branching bolt: a jagged trunk from the cloud base to the ground with a few forks, as camera-facing ribbons. */
export class Bolt {
  constructor(gl) {
    this.gl = gl;
    this.prog = program(gl, BOLT_VS, BOLT_FS);
    this.vbo = gl.createBuffer();
    this.vao = vao(gl, [{ loc: 0, buffer: this.vbo, size: 3, stride: 16, offset: 0 }, { loc: 1, buffer: this.vbo, size: 1, stride: 16, offset: 12 }]);
    this.count = 0;
  }

  /** New bolt `dist` metres away in direction `az` from the eye. */
  strike(eye, az, dist) {
    const cx = eye[0] + Math.sin(az) * dist, cz = eye[2] + Math.cos(az) * dist;
    const right = [Math.cos(az), 0, -Math.sin(az)];
    const width = dist * 0.004;
    const tris = [];
    const ribbon = (pts, w) => {
      for (let i = 0; i < pts.length - 1; i++) {
        const [a, b] = [pts[i], pts[i + 1]];
        const wa = w * (1 - (i / pts.length) * 0.5), wb = w * (1 - ((i + 1) / pts.length) * 0.5);
        const v = (p, s, ww) => [p[0] + right[0] * s * ww, p[1], p[2] + right[2] * s * ww, s];
        tris.push(v(a, -1, wa), v(a, 1, wa), v(b, -1, wb), v(a, 1, wa), v(b, 1, wb), v(b, -1, wb));
      }
    };
    const path = (start, steps, len, drift) => {
      const pts = [start];
      let p = start;
      for (let i = 0; i < steps; i++) {
        const s = (Math.random() - 0.5) * len * 1.4 + drift * len;
        p = [p[0] + right[0] * s, p[1] - len * (0.7 + Math.random() * 0.5), p[2] + right[2] * s];
        pts.push(p);
      }
      return pts;
    };
    const top = [cx, eye[1] + 900, cz];
    const trunk = path(top, 26, 42, 0);
    ribbon(trunk, width);
    for (let k = 0; k < 4; k++) {
      const from = trunk[2 + Math.floor(Math.random() * 14)];
      ribbon(path(from, 6 + Math.floor(Math.random() * 6), 30, Math.random() < 0.5 ? -0.5 : 0.5), width * 0.6);
    }
    const data = new Float32Array(tris.flat());
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
    this.count = data.length / 4;
  }

  draw(camera, flash) {
    if (flash < 0.02 || !this.count) return;
    const gl = this.gl;
    this.prog.use().set({ uViewProj: camera.viewProj, uFlash: Math.min(1, flash * 1.5) });
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.depthMask(false);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, this.count);
    gl.bindVertexArray(null);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
  }

  dispose() {
    const gl = this.gl;
    gl.deleteBuffer(this.vbo);
    gl.deleteVertexArray(this.vao);
    gl.deleteProgram(this.prog.program);
  }
}
