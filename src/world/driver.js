// Drive's car motion (after drive/src/driver.js). Auto mode follows the right-hand lane at a cruise speed, slowing for
// bends; manual mode is a kinematic bicycle model on the ground (gas / brake / steer). The body rolls and pitches
// on damped springs.
import { LANE_OFFSET } from './road.js';
import { clamp, vec3 } from '../gl/math.js';

const KMH = 1 / 3.6;

export class Driver {
  constructor(world, car) {
    this.world = world;
    this.road = world.road;
    this.wb = car.wheelbase;
    this.mode = 'auto';
    this.s = 0;
    this.v = 0;
    this.cruise = 75 * KMH;
    this.maxLateral = 2.6;
    this.distance = 0;
    this.steer = 0;
    this.accel = 0;
    this.latAccel = 0;
    this.heading = 0;
    this.px = 0;
    this.pz = 0;
    this.position = [0, 0, 0];
    this.left = [1, 0, 0];
    this.up = [0, 1, 0];
    this.fwd = [0, 0, 1];
    this.roll = 0;
    this.pitch = 0;
    this.rollV = 0;
    this.pitchV = 0;
    this._blend = 0;
    this._from = null;
    this._a = [0, 0, 0];
    this._b = [0, 0, 0];
  }

  toggleMode() {
    this._from = { position: this.position.slice(), fwd: this.fwd.slice() };
    this._blend = 0.8;
    if (this.mode === 'auto') {
      this.mode = 'manual';
      this.heading = Math.atan2(this.fwd[0], this.fwd[2]);
      this.px = this.position[0];
      this.pz = this.position[2];
    } else {
      this.mode = 'auto';
      const near = this.road.nearest(this.position[0], this.position[2], 400);
      if (near) this.s = near.s;
      this.v = Math.min(this.v, 15);
    }
    return this.mode;
  }

  _curveSpeed() {
    let k = 0;
    const look = Math.max(40, this.v * 4);
    for (let d = 0; d <= look; d += 8) k = Math.max(k, Math.abs(this.road.curvature(this.s + d)) * (1 - (d / look) * 0.35));
    return Math.sqrt(this.maxLateral / Math.max(k, 1e-5));
  }

  _poseFrom(front, rear) {
    const z = vec3.norm(vec3.sub(front, rear));
    const x = vec3.norm([z[2], 0, -z[0]]);
    this.fwd = z;
    this.left = x;
    this.up = vec3.cross(z, x);
    this.position = vec3.scale(vec3.add(front, rear), 0.5);
  }

  /** controls: { steer (-1 right … 1 left), gas, brake } — used in manual mode. */
  update(dt, controls) {
    const wb = this.wb;
    const prevV = this.v;
    if (this.mode === 'auto') {
      const target = Math.min(this.cruise, this._curveSpeed());
      const a = target > this.v ? Math.min(2.2, (target - this.v) * 0.8) : Math.max(-4.5, (target - this.v) * 1.5);
      this.v = Math.max(0, this.v + a * dt);
      this.s += this.v * dt;
      this.road.ensure(this.s + 1500);
      const front = this.road.lanePoint(this.s + wb / 2, LANE_OFFSET, this._a);
      const rear = this.road.lanePoint(this.s - wb / 2, LANE_OFFSET, this._b);
      this._poseFrom(front, rear);
      this.steer = Math.atan(wb * this.road.curvature(this.s + wb / 2));
      this.latAccel = this.v * this.v * this.road.curvature(this.s);
    } else {
      const throttle = controls.gas - controls.brake;
      let a;
      if (throttle > 0) a = this.v >= 0 ? 3.2 : 8;
      else if (throttle < 0) a = this.v > 0.5 ? -8 : -2.5;
      else a = -Math.sign(this.v) * Math.min(Math.abs(this.v) / dt, 0.6);
      a -= 0.0012 * this.v * Math.abs(this.v);
      this.v = clamp(this.v + a * dt, -8, 55);
      const maxSteer = 0.55 / (1 + Math.abs(this.v) / 12);
      this.steer += clamp(controls.steer * maxSteer - this.steer, -1.6 * dt, 1.6 * dt);
      const yawRate = (this.v / wb) * Math.tan(this.steer);
      this.heading += yawRate * dt;
      this.latAccel = this.v * yawRate;
      this.px += Math.sin(this.heading) * this.v * dt;
      this.pz += Math.cos(this.heading) * this.v * dt;
      const fx = Math.sin(this.heading) * (wb / 2), fz = Math.cos(this.heading) * (wb / 2);
      const surf = (x, z) => Math.max(this.world.surfaceAt(x, z), -0.6);
      const front = [this.px + fx, 0, this.pz + fz];
      front[1] = surf(front[0], front[2]);
      const rear = [this.px - fx, 0, this.pz - fz];
      rear[1] = surf(rear[0], rear[2]);
      this._poseFrom(front, rear);
      const near = this.road.nearest(this.position[0], this.position[2], 200);
      if (near) this.s = near.s;
      this.road.ensure(this.s + 1500);
    }
    this.accel = dt > 0 ? (this.v - prevV) / dt : 0;
    this.distance += this.v * dt;

    const spring = (x, v, t) => {
      v += ((t - x) * 60 - v * 11) * dt;
      return [x + v * dt, v];
    };
    [this.roll, this.rollV] = spring(this.roll, this.rollV, clamp(this.latAccel * 0.011, -0.05, 0.05));
    [this.pitch, this.pitchV] = spring(this.pitch, this.pitchV, clamp(-this.accel * 0.006, -0.03, 0.03));

    if (this._blend > 0) {
      this._blend = Math.max(0, this._blend - dt);
      const t = 1 - this._blend / 0.8;
      const e = t * t * (3 - 2 * t);
      this.position = vec3.lerp(this._from.position, this.position, e);
      this.fwd = vec3.norm(vec3.lerp(this._from.fwd, this.fwd, e));
      this.left = vec3.norm([this.fwd[2], 0, -this.fwd[0]]);
      this.up = vec3.cross(this.fwd, this.left);
    }
  }

  get speedKmh() {
    return Math.abs(this.v) * 3.6;
  }
}
