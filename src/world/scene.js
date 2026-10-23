// Pieces shared by Drive and Rally: camera matrices, the camera rig (chase / low / bumper / roadside / heli), the car's
// pose matrices, a soft contact shadow under the car, and touch / keyboard driving controls.
import { program, buffer, vao } from '../gl/gl.js';
import { mat4, clamp, damp } from '../gl/math.js';
import { h } from '../shell.js';

export class Camera {
  constructor() {
    this.view = mat4.create();
    this.proj = mat4.create();
    this.viewProj = mat4.create();
    this.eye = [0, 2, -5];
    this.target = [0, 1, 0];
    this.fov = (60 * Math.PI) / 180;
  }

  set(eye, target, aspect, near = 0.1, far = 1500) {
    this.eye = eye;
    this.target = target;
    // keep the horizontal field of view usable in portrait
    const fov = aspect < 1 ? 2 * Math.atan(Math.tan(this.fov / 2) / Math.max(aspect, 0.45) * 0.62) : this.fov;
    mat4.lookAt(this.view, eye, target);
    mat4.perspective(this.proj, Math.min(fov, 1.75), aspect, near, far);
    mat4.multiply(this.viewProj, this.proj, this.view);
    return this;
  }
}

/** Car placement: position of the car frame origin + its basis (left, up, forward unit vectors). */
export function poseMatrix(out, pos, left, up, fwd) {
  out[0] = left[0]; out[1] = left[1]; out[2] = left[2]; out[3] = 0;
  out[4] = up[0]; out[5] = up[1]; out[6] = up[2]; out[7] = 0;
  out[8] = fwd[0]; out[9] = fwd[1]; out[10] = fwd[2]; out[11] = 0;
  out[12] = pos[0]; out[13] = pos[1]; out[14] = pos[2]; out[15] = 1;
  return out;
}

/** Body on its suspension: pitch (+ nose down) and roll (+ lean right) about a point `pivotY` up, plus heave. */
export function bodyMatrix(out, pitch, roll, heave = 0, pivotY = 0.5) {
  const cp = Math.cos(pitch), sp = Math.sin(pitch), cr = Math.cos(roll), sr = Math.sin(roll);
  // R = Rx(pitch) * Rz(roll) in the car frame (x left, y up, z forward), column-major
  const c0 = [cr, cp * sr, sp * sr], c1 = [-sr, cp * cr, sp * cr], c2 = [0, -sp, cp];
  out.fill(0);
  out.set(c0, 0);
  out.set(c1, 4);
  out.set(c2, 8);
  // rotate about (0, pivotY, 0): t = P - R P
  out[12] = -c1[0] * pivotY;
  out[13] = pivotY - c1[1] * pivotY + heave;
  out[14] = -c1[2] * pivotY;
  out[15] = 1;
  return out;
}

const transform = (m, p) => [
  m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
  m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
  m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
];
export { transform };

/**
 * Camera rig following a car pose (model.world). modes: chase, low, bumper, roadside, heli.
 * ground(x, z) keeps the camera above the terrain; roadsideSpot(sAhead) gives a spectator spot ahead.
 */
export class CameraRig {
  constructor(modes, { ground, roadsideSpot }) {
    this.modes = modes;
    this.mode = modes[0];
    this.ground = ground;
    this.roadsideSpot = roadsideSpot;
    this.eye = null;
    this.look = null;
    this.spot = null;
    this.heliAngle = 0;
  }

  next() {
    this.mode = this.modes[(this.modes.indexOf(this.mode) + 1) % this.modes.length];
    this.eye = null;
    this.spot = null;
    return this.mode;
  }

  update(dt, world, car, camera, aspect) {
    const pos = [world[12], world[13], world[14]];
    const fwd = [world[8], world[9], world[10]];
    const flat = Math.hypot(fwd[0], fwd[2]) || 1;
    const fx = fwd[0] / flat, fz = fwd[2] / flat;
    let eye, target, snap = false;
    const portrait = aspect < 1 ? 1.35 : 1;
    switch (this.mode) {
      case 'chase': {
        const d = 6.2 * portrait + car.speed * 0.03;
        eye = [pos[0] - fx * d, pos[1] + 2.3 * portrait, pos[2] - fz * d];
        target = [pos[0] + fx * 3, pos[1] + 0.9, pos[2] + fz * 3];
        break;
      }
      case 'low': {
        const d = 4.4 * portrait;
        eye = [pos[0] - fx * d, pos[1] + 1.0, pos[2] - fz * d];
        target = [pos[0] + fx * 6, pos[1] + 0.8, pos[2] + fz * 6];
        break;
      }
      case 'bumper': {
        eye = transform(world, [0, 0.62, 2.35]);
        target = transform(world, [0, 0.4, 30]);
        snap = true;
        break;
      }
      case 'hood': {
        eye = transform(world, [0, 1.28, 0.55]);
        target = transform(world, [0, 0.9, 30]);
        snap = true;
        break;
      }
      case 'roadside': {
        if (!this.spot || car.s - this.spot.s > 25) this.spot = this.roadsideSpot(car.s + 70 + car.speed * 1.5);
        eye = this.spot.eye;
        target = [pos[0], pos[1] + 0.7, pos[2]];
        snap = true;
        break;
      }
      case 'heli': {
        this.heliAngle += dt * 0.15;
        const a = Math.atan2(fx, fz) + Math.PI * 0.75 + Math.sin(this.heliAngle) * 0.6;
        eye = [pos[0] + Math.sin(a) * 18, pos[1] + 13, pos[2] + Math.cos(a) * 18];
        target = [pos[0] + fx * 4, pos[1], pos[2] + fz * 4];
        break;
      }
    }
    if (!this.eye || snap) {
      this.eye = eye;
      this.look = target;
    } else {
      for (let k = 0; k < 3; k++) {
        this.eye[k] = damp(this.eye[k], eye[k], k === 1 ? 4 : 6, dt);
        this.look[k] = damp(this.look[k], target[k], 12, dt);
      }
    }
    if (!snap) {
      const g = this.ground(this.eye[0], this.eye[2]);
      this.eye[1] = Math.max(this.eye[1], g + 0.6);
    }
    camera.set(this.eye.slice(), this.look.slice(), aspect, this.mode === 'bumper' || this.mode === 'hood' ? 0.05 : 0.15);
  }
}

const SHADOW_VS = `
layout(location = 0) in vec2 aPos;
uniform mat4 uViewProj;
uniform mat4 uWorld;
uniform vec2 uSize;
out vec2 vUv;
void main() {
  vUv = aPos;
  gl_Position = uViewProj * uWorld * vec4(aPos.x * uSize.x, 0.04, aPos.y * uSize.y - 0.08, 1.0);
}`;
const SHADOW_FS = `
in vec2 vUv;
uniform float uStrength;
out vec4 fragColor;
void main() {
  vec2 q = max(abs(vUv) - vec2(0.45, 0.62), 0.0) / vec2(0.55, 0.38);
  float a = pow(1.0 - min(length(q), 1.0), 1.6);
  fragColor = vec4(0.0, 0.0, 0.0, a * uStrength);
}`;

/** Soft rounded-rectangle shadow under the car (in the car frame, so it tilts with the ground). */
export class ContactShadow {
  constructor(gl) {
    this.gl = gl;
    this.prog = program(gl, SHADOW_VS, SHADOW_FS);
    this.vbo = buffer(gl, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]));
    this.vao = vao(gl, [{ loc: 0, buffer: this.vbo, size: 2 }]);
  }

  draw(camera, world, strength = 0.7, lift = 0) {
    const gl = this.gl;
    const w = Float32Array.from(world);
    w[13] -= lift;
    this.prog.use().set({ uViewProj: camera.viewProj, uWorld: w, uSize: [1.12 + lift * 0.3, 2.4 + lift * 0.3], uStrength: strength / (1 + lift * 1.5) });
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(-2, -8);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
    gl.disable(gl.POLYGON_OFFSET_FILL);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
  }

  dispose() {
    this.gl.deleteBuffer(this.vbo);
    this.gl.deleteVertexArray(this.vao);
    this.gl.deleteProgram(this.prog.program);
  }
}

/**
 * On-screen pedals: steer pads bottom-left, gas / brake (and optional handbrake) bottom-right, plus WASD / arrows /
 * Space on a keyboard. Read .steer (-1 right … 1 left), .gas, .brake, .hand (0/1).
 */
export class DriveControls {
  constructor(parent, { handbrake = false } = {}) {
    this.input = { left: 0, right: 0, gas: 0, brake: 0, hand: 0 };
    const pad = (label, key, aria) => {
      const b = h('button', { class: 'pad', type: 'button', 'aria-label': aria }, label);
      const on = (v) => (e) => {
        e.preventDefault();
        this.input[key] = v;
        b.classList.toggle('on', !!v);
        if (v) {
          try {
            b.setPointerCapture(e.pointerId);
          } catch {
            // synthetic or already released pointer: nothing to capture
          }
        }
      };
      b.addEventListener('pointerdown', on(1));
      b.addEventListener('pointerup', on(0));
      b.addEventListener('pointercancel', on(0));
      b.addEventListener('lostpointercapture', on(0));
      b.addEventListener('contextmenu', (e) => e.preventDefault());
      return b;
    };
    this.el = h('div', { class: 'drive-controls' },
      h('div', { class: 'pedals left' }, pad('◀', 'left', 'Steer left'), pad('▶', 'right', 'Steer right')),
      h('div', { class: 'pedals right' }, pad('Brake', 'brake', 'Brake'), pad('Gas', 'gas', 'Accelerate')),
      // the handbrake sits above the brake so four pads still fit across a narrow phone
      handbrake ? h('div', { class: 'pedals right', style: { bottom: 'calc(98px + var(--safe-b))', right: '96px' } }, pad('HB', 'hand', 'Handbrake')) : null);
    this.el.hidden = true;
    parent.append(this.el);
    const KEYS = { ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right', ArrowUp: 'gas', KeyW: 'gas', ArrowDown: 'brake', KeyS: 'brake', Space: 'hand' };
    this._key = (e) => {
      const k = KEYS[e.code];
      if (!k || e.repeat) return;
      this.keyboard = true;
      this.input[k] = e.type === 'keydown' ? 1 : 0;
      if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
    };
    window.addEventListener('keydown', this._key);
    window.addEventListener('keyup', this._key);
  }

  set visible(v) {
    this.el.hidden = !v;
  }

  get steer() {
    return clamp(this.input.left - this.input.right, -1, 1);
  }
  get gas() {
    return this.input.gas;
  }
  get brake() {
    return this.input.brake;
  }
  get hand() {
    return this.input.hand;
  }

  dispose() {
    window.removeEventListener('keydown', this._key);
    window.removeEventListener('keyup', this._key);
  }
}
