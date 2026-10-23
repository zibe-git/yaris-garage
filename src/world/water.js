// Lakes: one large plane at the water level that follows the camera. Wavy normals from scrolling noise, sky
// reflection with fresnel, sun glints; the terrain shader darkens what lies below the surface.
import { program, buffer, vao } from '../gl/gl.js';
import { LIGHT_GLSL } from '../gl/model.js';
import { NOISE_GLSL } from './glsl.js';

const VS = `
layout(location = 0) in vec2 aPos;
uniform mat4 uViewProj;
uniform vec3 uCenter;
uniform float uLevel;
out vec3 vPos;
void main() {
  vPos = vec3(uCenter.x + aPos.x, uLevel, uCenter.z + aPos.y);
  gl_Position = uViewProj * vec4(vPos, 1.0);
}`;

const FS = `
in vec3 vPos;
uniform float uTime;
out vec4 fragColor;
${LIGHT_GLSL}
${NOISE_GLSL}
float waves(vec2 p) {
  return vnoise(p * 0.12 + vec2(uTime * 0.04, uTime * 0.025)) + 0.45 * vnoise(p * 0.37 - vec2(uTime * 0.07, -uTime * 0.03)) + 0.15 * vnoise(p * 1.1 + uTime * 0.15);
}
void main() {
  float e = 0.25;
  float h = waves(vPos.xz);
  // calmer further away (the noise would alias into grey speckle)
  float calm = 1.0 + length(vPos - uEye) * 0.04;
  vec3 n = normalize(vec3(h - waves(vPos.xz + vec2(e, 0.0)), e * 3.5 * calm, h - waves(vPos.xz + vec2(0.0, e))));
  vec3 V = normalize(uEye - vPos);
  float fres = 0.02 + 0.98 * pow(1.0 - max(dot(n, V), 0.0), 5.0);
  vec3 refl = envColor(reflect(-V, n));
  vec3 deep = vec3(0.008, 0.03, 0.045) * (uSkyColor + uSunColor * 0.3);
  vec3 H = normalize(uSunDir + V);
  vec3 c = mix(deep, refl, fres) + uSunColor * pow(max(dot(n, H), 0.0), 400.0) * 3.0;
  float a = mix(0.82, 1.0, fres);
  fragColor = outColor(applyFog(c, vPos), a);
}`;

export class Water {
  constructor(gl, level = 0) {
    this.gl = gl;
    this.level = level;
    this.prog = program(gl, VS, FS);
    const S = 900;
    this.vbo = buffer(gl, new Float32Array([-S, -S, S, -S, -S, S, S, S]));
    this.vao = vao(gl, [{ loc: 0, buffer: this.vbo, size: 2 }]);
  }

  draw(camera, light, time) {
    const gl = this.gl;
    this.prog.use().set({ ...light, uViewProj: camera.viewProj, uEye: camera.eye, uCenter: camera.eye, uLevel: this.level, uTime: time });
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
    gl.disable(gl.BLEND);
  }

  dispose() {
    this.gl.deleteBuffer(this.vbo);
    this.gl.deleteVertexArray(this.vao);
    this.gl.deleteProgram(this.prog.program);
  }
}
