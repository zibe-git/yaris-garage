// Sky as one fullscreen pass behind everything: day gradient with sun and drifting clouds, or a night sky with stars,
// a moon, moonlit storm clouds and lightning flashes lighting them from inside. Horizon colour = fog colour.
import { program, FULLSCREEN_VS } from '../gl/gl.js';
import { LIGHT_GLSL } from '../gl/model.js';
import { NOISE_GLSL } from './glsl.js';
import { mat4 } from '../gl/math.js';

const FS = `
in vec2 vUv;
uniform mat4 uInvViewProj;
uniform int uNight;
uniform float uTime;
uniform float uCloud;
uniform float uFlash;
uniform vec3 uMoonDir;
out vec4 fragColor;
${LIGHT_GLSL}
${NOISE_GLSL}
void main() {
  vec4 p = uInvViewProj * vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
  vec3 d = normalize(p.xyz / p.w); // view rotation only: precise far from the origin
  float up = d.y;
  vec3 sky = mix(uHorizonColor, uSkyColor, pow(smoothstep(0.0, 0.6, up), 0.6));
  vec3 c;
  vec2 cuv = d.xz / max(up + 0.12, 0.04);
  if (uNight == 0) {
    float sd = max(dot(d, uSunDir), 0.0);
    c = sky + uSunColor * (pow(sd, 1500.0) * 25.0 + pow(sd, 12.0) * 0.18 + pow(sd, 3.0) * 0.06);
    float n = fbm2(cuv * 0.9 + vec2(uTime * 0.012, uTime * 0.004));
    float dens = smoothstep(0.62 - uCloud * 0.3, 0.85, n) * smoothstep(0.0, 0.18, up);
    vec3 cloud = mix(uHorizonColor * 0.9, vec3(1.0) * (0.7 + uSunColor * 0.25), smoothstep(0.5, 0.9, n));
    cloud += uSunColor * pow(sd, 6.0) * 0.4;
    c = mix(c, cloud, dens * 0.9);
  } else {
    c = sky;
    // stars
    vec3 g = floor(d * 260.0);
    float star = step(0.9965, hash13(g)) * smoothstep(0.0, 0.25, up);
    float tw = 0.6 + 0.4 * sin(uTime * (2.0 + hash13(g + 7.0) * 5.0) + hash13(g) * 40.0);
    c += vec3(0.8, 0.85, 1.0) * star * tw * 1.6;
    // moon
    float md = dot(d, uMoonDir);
    float disc = smoothstep(0.99955, 0.99965, md);
    float maria = fbm2(d.xy * 900.0) * 0.35;
    c += vec3(1.0, 0.97, 0.9) * disc * (2.6 - maria * 2.0);
    c += vec3(0.5, 0.55, 0.7) * (pow(max(md, 0.0), 300.0) * 0.6 + pow(max(md, 0.0), 30.0) * 0.08);
    // storm clouds lit by the moon, and by lightning from inside
    float n = fbm2(cuv * 0.55 + vec2(uTime * 0.02, uTime * 0.006));
    float n2 = fbm2(cuv * 1.7 - vec2(uTime * 0.03, 0.0));
    float dens = smoothstep(0.42 - uCloud * 0.25, 0.8, n * 0.8 + n2 * 0.35) * smoothstep(-0.02, 0.15, up);
    float edge = smoothstep(0.75, 0.45, n) * pow(max(md, 0.0), 8.0);
    vec3 cloud = vec3(0.012, 0.014, 0.022) + vec3(0.18, 0.2, 0.26) * edge;
    cloud += vec3(0.6, 0.65, 1.0) * uFlash * (0.4 + n2);
    c = mix(c, cloud, dens);
    c += vec3(0.35, 0.38, 0.55) * uFlash * 0.25 * (1.0 - dens);
  }
  c = mix(c, uFogColor, smoothstep(0.06, -0.02, up));
  fragColor = outColor(c, 1.0);
}`;

export class Sky {
  constructor(gl, { night = false } = {}) {
    this.gl = gl;
    this.night = night;
    this.prog = program(gl, FULLSCREEN_VS, FS);
    this.vao = gl.createVertexArray();
    this.inv = mat4.create();
    this.cloud = 0.4;
    this.flash = 0;
    this.moonDir = [-0.35, 0.42, 0.84];
  }

  draw(camera, light, time) {
    const gl = this.gl;
    const rot = Float32Array.from(camera.view);
    rot[12] = rot[13] = rot[14] = 0;
    mat4.invert(this.inv, mat4.multiply(this.inv, camera.proj, rot));
    this.prog.use().set({ ...light, uInvViewProj: this.inv, uEye: camera.eye, uNight: this.night ? 1 : 0, uTime: time, uCloud: this.cloud, uFlash: this.flash, uMoonDir: this.moonDir });
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
    gl.depthMask(true);
    gl.enable(gl.DEPTH_TEST);
  }

  dispose() {
    this.gl.deleteVertexArray(this.vao);
    this.gl.deleteProgram(this.prog.program);
  }
}
