// Touch-first orbit camera: one finger turns, two fingers pinch-zoom and pan, wheel zooms, a short press is a tap.
// An app can claim a pointer first (puzzle: dragging a part) by returning true from options.grab(e).
import { mat4, clamp, damp } from './math.js';

export class Orbit {
  constructor(el, { target = [0, 0.7, 0], yaw = 0.7, pitch = 0.35, distance = 6, minDistance = 1.5, maxDistance = 20, fov = 50, onTap, onDoubleTap, grab } = {}) {
    this.el = el;
    this.target = target.slice();
    this.goal = { target: target.slice(), yaw, pitch, distance };
    this.yaw = yaw;
    this.pitch = pitch;
    this.distance = distance;
    this.minDistance = minDistance;
    this.maxDistance = maxDistance;
    this.fov = (fov * Math.PI) / 180;
    this.near = 0.05;
    this.far = 200;
    this.view = mat4.create();
    this.proj = mat4.create();
    this.viewProj = mat4.create();
    this.eye = [0, 0, 0];
    this.shiftY = 0; // lens shift in NDC: > 0 moves the image up (to centre it above a bottom panel)
    this.onTap = onTap;
    this.onDoubleTap = onDoubleTap;
    this.grab = grab;
    this.enabled = true;
    this.autoRotate = 0; // rad/s while idle
    this.idle = 0;
    this.pointers = new Map();
    this.lastTap = 0;
    const opts = { passive: false };
    this._down = (e) => this.down(e);
    this._move = (e) => this.move(e);
    this._up = (e) => this.up(e);
    this._wheel = (e) => {
      e.preventDefault();
      this.goal.distance = clamp(this.goal.distance * Math.exp(e.deltaY * 0.0012), this.minDistance, this.maxDistance);
      this.idle = 0;
    };
    el.addEventListener('pointerdown', this._down, opts);
    el.addEventListener('pointermove', this._move, opts);
    el.addEventListener('pointerup', this._up, opts);
    el.addEventListener('pointercancel', this._up, opts);
    el.addEventListener('wheel', this._wheel, opts);
    el.style.touchAction = 'none';
  }

  dispose() {
    const el = this.el;
    el.removeEventListener('pointerdown', this._down);
    el.removeEventListener('pointermove', this._move);
    el.removeEventListener('pointerup', this._up);
    el.removeEventListener('pointercancel', this._up);
    el.removeEventListener('wheel', this._wheel);
  }

  down(e) {
    if (!this.enabled) return;
    if (this.pointers.size === 0 && this.grab?.(e)) return; // the app owns this drag
    this.el.setPointerCapture?.(e.pointerId);
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, t0: performance.now() });
    this.idle = 0;
  }

  move(e) {
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    e.preventDefault();
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    if (this.pointers.size === 1) {
      const s = 4.5 / Math.max(this.el.clientHeight, 1);
      this.goal.yaw -= dx * s;
      this.goal.pitch = clamp(this.goal.pitch + dy * s, -1.45, 1.45);
    } else if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      const before = Math.hypot(a.x - b.x, a.y - b.y);
      p.x = e.clientX;
      p.y = e.clientY;
      const after = Math.hypot(a.x - b.x, a.y - b.y);
      if (before > 0 && after > 0) this.goal.distance = clamp(this.goal.distance * (before / after), this.minDistance, this.maxDistance);
      this.pan(dx / 2, dy / 2);
      return;
    }
    p.x = e.clientX;
    p.y = e.clientY;
  }

  up(e) {
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    this.pointers.delete(e.pointerId);
    const moved = Math.hypot(e.clientX - p.x0, e.clientY - p.y0);
    if (moved < 8 && performance.now() - p.t0 < 350 && this.pointers.size === 0) {
      const now = performance.now();
      if (now - this.lastTap < 320 && this.onDoubleTap) {
        this.lastTap = 0;
        this.onDoubleTap(e.clientX, e.clientY);
      } else {
        this.lastTap = now;
        this.onTap?.(e.clientX, e.clientY);
      }
    }
  }

  /** Move the target in the view plane by a screen offset in CSS pixels. */
  pan(dx, dy) {
    const s = (2 * this.distance * Math.tan(this.fov / 2)) / Math.max(this.el.clientHeight, 1);
    const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
    const right = [cy, 0, -sy];
    const sp = Math.sin(this.pitch), cp = Math.cos(this.pitch);
    const up = [-sy * sp, cp, -cy * sp];
    for (let k = 0; k < 3; k++) this.goal.target[k] += (-dx * right[k] + dy * up[k]) * s;
  }

  /**
   * Distance at which a sphere of this radius fills the narrower side of the view; `free` is the fraction of the
   * height not covered by controls (see shiftY).
   */
  fitDistance(radius, aspect, free = 1) {
    const t = Math.tan(this.fov / 2);
    const half = Math.min(Math.atan(t * free), Math.atan(t * aspect));
    return radius / Math.sin(half);
  }

  /** Animate to a new framing. */
  frame({ target, distance, yaw, pitch }) {
    if (target) this.goal.target = target.slice();
    if (distance) this.goal.distance = clamp(distance, this.minDistance, this.maxDistance);
    if (yaw !== undefined) this.goal.yaw = yaw;
    if (pitch !== undefined) this.goal.pitch = pitch;
  }

  update(dt, aspect) {
    this.idle += dt;
    if (this.autoRotate && this.idle > 4 && this.pointers.size === 0) this.goal.yaw += this.autoRotate * dt;
    const r = 14;
    this.yaw = damp(this.yaw, this.goal.yaw, r, dt);
    this.pitch = damp(this.pitch, this.goal.pitch, r, dt);
    this.distance = damp(this.distance, this.goal.distance, r, dt);
    for (let k = 0; k < 3; k++) this.target[k] = damp(this.target[k], this.goal.target[k], 8, dt);
    const cp = Math.cos(this.pitch);
    this.eye = [
      this.target[0] + Math.sin(this.yaw) * cp * this.distance,
      this.target[1] + Math.sin(this.pitch) * this.distance,
      this.target[2] + Math.cos(this.yaw) * cp * this.distance,
    ];
    mat4.lookAt(this.view, this.eye, this.target);
    mat4.perspective(this.proj, this.fov, aspect, this.near, this.far);
    this.proj[9] = -this.shiftY;
    mat4.multiply(this.viewProj, this.proj, this.view);
    return this;
  }
}
