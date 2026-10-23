// Rally car physics, simplified for phones (the desktop rally runs a 6-DOF rigid body at 1 kHz): a two-axle
// "bicycle" model at 240 Hz with magic-formula tyres on a friction circle, longitudinal weight transfer, rear-biased
// AWD through a 5-speed box, brakes and a handbrake that locks the rears. Vertically the car follows the ground until
// the ground falls away faster than gravity, then flies (jumps and crests) and lands on its suspension.
import { clamp, vec3 } from '../gl/math.js';

const G = 9.81;

export const SPEC = {
  mass: 1240,
  iz: 1900,
  a: 1.25, // CG → front axle
  b: 1.29, // CG → rear axle
  h: 0.47, // CG height
  track: 1.49,
  radius: 0.302,
  torque: [[800, 150], [2000, 300], [3000, 400], [4500, 440], [6000, 420], [7200, 370], [8000, 300]],
  idle: 1100,
  redline: 7900,
  gears: [-3.1, 3.0, 2.14, 1.68, 1.37, 1.15],
  final: 4.3,
  front: 0.4, // drive torque share
  rearB: 10.5, // stiffer rear tyres: a stable car that still slides when provoked
  brakeFront: 0.66,
  maxSteer: 0.6,
};

function torqueAt(rpm) {
  const t = SPEC.torque;
  if (rpm <= t[0][0]) return t[0][1];
  for (let i = 1; i < t.length; i++)
    if (rpm <= t[i][0]) {
      const [r0, q0] = t[i - 1], [r1, q1] = t[i];
      return q0 + ((q1 - q0) * (rpm - r0)) / (r1 - r0);
    }
  return t[t.length - 1][1];
}

// lateral tyre curve: peak near 7° slip, ~80 % retained when sliding (catchable slides on gravel)
// share of the tyre's grip a slip angle uses (for traction control)
const latLoad = (alpha) => Math.min(1, Math.abs(Math.sin(1.45 * Math.atan(9 * alpha))));
const tyre = (alpha, B = 9) => Math.sin(1.45 * Math.atan(B * alpha - 0.6 * (B * alpha - Math.atan(B * alpha))));

export class Vehicle {
  constructor(stage) {
    this.stage = stage;
    this.L = SPEC.a + SPEC.b;
    this.x = 0;
    this.z = 0;
    this.y = 0;
    this.vy = 0;
    this.yaw = 0;
    this.u = 0; // forward speed (car frame)
    this.v = 0; // lateral speed, + left
    this.r = 0; // yaw rate, + left
    this.steer = 0;
    this.throttle = 0;
    this.brake = 0;
    this.hand = 0;
    this.steerInput = 0;
    this.gear = 1;
    this.rpm = SPEC.idle;
    this.shift = 0;
    this.ax = 0;
    this.ay = 0;
    this.airborne = false;
    this.airTime = 0;
    this.pitch = 0; // nose up +
    this.pitchRate = 0;
    this.roll = 0; // left side up +
    this.heave = 0; // body on its springs, visual
    this.heaveV = 0;
    this.bodyPitch = 0;
    this.bodyPitchV = 0;
    this.bodyRoll = 0;
    this.bodyRollV = 0;
    this.spin = 0; // wheel rotation angle
    this.slip = 0; // how much the tyres are sliding / spinning (0…1) for sound and spray
    this.surface = null;
    this.landing = 0; // last landing impact (m/s), for sound / camera shake
    this.distance = 0;
    this.tc = false;
    this._g = {};
    this._segs = null;
    this._segsAt = [1e9, 1e9];
  }

  /** Place the car on the stage at distance s, facing along the road. */
  reset(s, left = 0) {
    const p = this.stage.point(s, left, {});
    this.x = p.x;
    this.z = p.z;
    this.yaw = p.heading;
    this.u = this.v = this.r = 0;
    this.vy = 0;
    this.airborne = false;
    this.gear = 1;
    this.rpm = SPEC.idle;
    this._segs = null;
    this.y = this.groundY(this.x, this.z);
    this.pitch = this.roll = this.pitchRate = 0;
  }

  _segments() {
    if (!this._segs || Math.hypot(this.x - this._segsAt[0], this.z - this._segsAt[1]) > 8) {
      this._segs = this.stage.segmentsNear(this.x, this.z, 16);
      this._segsAt = [this.x, this.z];
    }
    return this._segs;
  }

  groundY(x, z) {
    return this.stage.groundAt(x, z, this._segments(), this._g).y;
  }

  get speed() {
    return Math.hypot(this.u, this.v);
  }

  get kmh() {
    return Math.abs(this.u) * 3.6;
  }

  update(dt) {
    const n = Math.max(1, Math.ceil(dt * 240));
    const h = dt / n;
    for (let i = 0; i < n; i++) this.step(h);
    // visual body motion on the springs
    const spring = (x, v, t, k = 70, c = 9) => {
      v += ((t - x) * k - v * c) * dt;
      return [x + v * dt, v];
    };
    [this.bodyPitch, this.bodyPitchV] = spring(this.bodyPitch, this.bodyPitchV, this.airborne ? 0 : clamp(-this.ax * 0.007, -0.05, 0.05));
    [this.bodyRoll, this.bodyRollV] = spring(this.bodyRoll, this.bodyRollV, this.airborne ? 0 : clamp(this.ay * 0.009, -0.07, 0.07));
    [this.heave, this.heaveV] = spring(this.heave, this.heaveV, this.airborne ? 0.05 : 0, 90, 8);
    this.heave = clamp(this.heave, -0.12, 0.1);
  }

  step(dt) {
    const S = SPEC;
    const { a, b, h, radius } = S;
    const L = this.L;
    const m = S.mass;
    const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
    // ground under the axles and the sides
    const yF = this.groundY(this.x + sy * a, this.z + cy * a);
    const yR = this.groundY(this.x - sy * b, this.z - cy * b);
    const surface = this._g.surface;
    const yLft = this.groundY(this.x + cy * S.track * 0.5, this.z - sy * S.track * 0.5);
    const yRgt = this.groundY(this.x - cy * S.track * 0.5, this.z + sy * S.track * 0.5);
    const gy = (yF * b + yR * a) / L;
    const grade = (yF - yR) / L;
    const bank = (yLft - yRgt) / S.track;
    this.surface = surface;
    const mu = this.stage.grip(surface);

    // ---- vertical: follow the ground, or fly when it falls away faster than gravity ----
    if (this.airborne) {
      this.vy -= G * dt;
      this.y += this.vy * dt;
      this.pitchRate -= 0.35 * dt;
      this.pitch += this.pitchRate * dt;
      this.airTime += dt;
      if (this.y <= gy) {
        this.landing = Math.max(0, this.u * grade - this.vy);
        this.heaveV -= Math.min(4, this.landing) * 0.9;
        this.bodyPitchV += (this.pitch - Math.atan(grade)) * 6;
        this.airborne = false;
        this.y = gy;
        this.vy = this.u * grade;
        this.u *= 1 - Math.min(0.15, this.landing * 0.012);
      }
    } else {
      this.y = gy;
      this.vy = this.u * grade; // from the axle heights: smooth, unlike differences of the road's 2 m samples
      this.pitch = Math.atan(grade);
      this.roll = Math.atan(bank);
      // would a body thrown with this vertical speed clear the ground 0.12 s ahead? then it's a jump
      if (this.u > 6) {
        const t = 0.12;
        const xt = this.x + (sy * this.u + cy * this.v) * t, zt = this.z + (cy * this.u - sy * this.v) * t;
        const yBall = gy + this.vy * t - 0.5 * G * t * t;
        if (this.groundY(xt, zt) < yBall - 0.06) {
          this.airborne = true;
          this.airTime = 0;
          this.pitchRate = 0;
        }
      }
    }

    // ---- inputs ----
    const maxSteer = S.maxSteer / (1 + Math.abs(this.u) / 22);
    const target = clamp(this.steerInput, -1, 1) * maxSteer;
    this.steer += clamp(target - this.steer, -2.5 * dt, 2.5 * dt);
    const d = this.steer;

    // ---- drivetrain ----
    const ratio = S.gears[this.gear] * S.final;
    const wheelRpm = (this.u / radius) * ratio * (60 / (2 * Math.PI));
    this.shift = Math.max(0, this.shift - dt);
    let thr = this.shift > 0 ? 0 : this.throttle;
    let rpm = Math.max(S.idle, Math.abs(wheelRpm));
    if (this.airborne || this.slip > 0.5) rpm = Math.max(rpm, this.rpm + (S.idle + 6500 * thr - this.rpm) * Math.min(1, dt * 6));
    if (rpm > S.redline) thr = 0;
    this.rpm += (Math.min(rpm, S.redline + 150) - this.rpm) * Math.min(1, dt * 20);
    let drive = (torqueAt(this.rpm) * thr * ratio * 0.9) / radius;
    if (thr < 0.05 && this.gear > 0) drive -= Math.sign(this.u) * Math.min(Math.abs(this.u) * 40, (30 + this.rpm * 0.006) * Math.abs(ratio) / radius) * (this.rpm > S.idle + 300 ? 1 : 0);
    // automatic sequential box
    if (this.gear > 0 && !this.airborne && this.shift <= 0) {
      if (this.rpm > S.redline - 400 && this.gear < S.gears.length - 1) {
        this.gear++;
        this.shift = 0.12;
      } else if (this.gear > 1 && this.rpm < 3600) {
        this.gear--;
        this.shift = 0.1;
      }
    }

    // ---- tyre forces ----
    let Fyf = 0, Fyr = 0, Fxf = 0, Fxr = 0;
    let slip = 0;
    if (!this.airborne) {
      const Fz = m * G * Math.cos(Math.atan(grade));
      const Fzf = Math.max(0, Fz * (b / L) - (m * this.ax * h) / L);
      const Fzr = Math.max(0, Fz * (a / L) + (m * this.ax * h) / L);
      const ua = Math.max(Math.abs(this.u), 1.5);
      const af = Math.atan2(this.v + a * this.r, ua) - d * Math.sign(this.u || 1);
      const ar = Math.atan2(this.v - b * this.r, ua);
      const capF = mu * Fzf, capR = mu * Fzr;
      // traction control (the AI uses it): keep the drive under what the tyres can take while cornering
      if (this.tc && drive > 0) {
        const room = (cap, Fy) => Math.sqrt(Math.max(0, cap * cap - Fy * Fy)) * 0.9;
        const lf = latLoad(af) * capF, lr = latLoad(ar) * capR;
        drive = Math.min(drive, room(capF, lf) / S.front, room(capR, lr) / (1 - S.front));
      }
      // longitudinal requests
      let xf = drive * S.front;
      let xr = drive * (1 - S.front);
      const brakeF = this.brake * mu * m * G * 0.95;
      const dir = Math.sign(this.u) || 0;
      xf -= dir * brakeF * S.brakeFront;
      xr -= dir * brakeF * (1 - S.brakeFront);
      let spinF = Math.abs(xf) > capF ? Math.min(1, Math.abs(xf) / capF - 1) : 0;
      let spinR = Math.abs(xr) > capR ? Math.min(1, Math.abs(xr) / capR - 1) : 0;
      xf = clamp(xf, -capF, capF);
      xr = clamp(xr, -capR, capR);
      if (this.hand > 0.5 && Math.abs(this.u) > 0.5) {
        xr = -dir * capR * 0.85;
        spinR = 1;
      }
      // friction circle: what is used along the tyre is not available sideways
      // a spinning or locked tyre still grips sideways a little (kinetic friction)
      const latF = Math.max(Math.sqrt(Math.max(0, capF * capF - xf * xf)), capF * 0.35 * spinF);
      const latR = Math.max(Math.sqrt(Math.max(0, capR * capR - xr * xr)), capR * 0.35 * spinR) * (this.hand > 0.5 ? 0.45 : 1);
      Fyf = -latF * tyre(af);
      Fyr = -latR * tyre(ar, S.rearB);
      Fxf = xf;
      Fxr = xr;
      slip = Math.max(spinF, spinR, clamp((Math.abs(ar) - 0.08) * 4, 0, 1), clamp((Math.abs(af) - 0.1) * 3, 0, 1));
    }
    this.slip += (slip - this.slip) * Math.min(1, dt * 10);

    // ---- integrate the planar motion ----
    const cd = Math.cos(d), sd = Math.sin(d);
    const drag = 0.42 * this.u * Math.abs(this.u);
    const rollRes = (surface ? surface.roll : 0.03) * m * G * Math.sign(this.u) * Math.min(1, Math.abs(this.u));
    const fx = Fxf * cd - Fyf * sd + Fxr - drag - rollRes - m * G * Math.sin(Math.atan(grade)) * (this.airborne ? 0 : 1);
    const fy = Fyf * cd + Fxf * sd + Fyr + m * G * Math.sin(Math.atan(bank)) * (this.airborne ? 0 : -1);
    const mz = a * (Fyf * cd + Fxf * sd) - b * Fyr;
    this.ax = fx / m;
    this.ay = fy / m;
    this.u += (this.ax + this.v * this.r) * dt;
    this.v += (this.ay - this.u * this.r) * dt;
    this.r += (mz / S.iz) * dt;
    if (this.airborne) this.r *= 1 - dt * 0.3;
    // stop creeping at standstill
    if (!this.airborne && Math.abs(this.u) < 0.3 && this.throttle < 0.05 && Math.abs(drive) < 1) {
      this.u *= 1 - Math.min(1, dt * 4);
      this.v *= 1 - Math.min(1, dt * 4);
      this.r *= 1 - Math.min(1, dt * 4);
    }
    this.yaw += this.r * dt;
    const s2 = Math.sin(this.yaw), c2 = Math.cos(this.yaw);
    this.x += (s2 * this.u + c2 * this.v) * dt;
    this.z += (c2 * this.u - s2 * this.v) * dt;
    this.spin += (this.u / radius) * dt * (this.hand > 0.5 && !this.airborne ? 0 : 1);
    this.distance += Math.abs(this.u) * dt;
  }

  /** Car frame basis in the world: { pos, left, up, fwd } (pitch / roll from the ground or the flight). */
  pose() {
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
    const fwd = [sy * cp, sp, cy * cp];
    let left = [cy, 0, -sy];
    let up = vec3.cross(fwd, left);
    // roll about the forward axis (left side up = positive)
    const cr = Math.cos(this.roll), sr = Math.sin(this.roll);
    const l2 = vec3.add(vec3.scale(left, cr), vec3.scale(up, sr));
    const u2 = vec3.sub(vec3.scale(up, cr), vec3.scale(left, sr));
    left = l2;
    up = u2;
    return { pos: [this.x, this.y, this.z], left, up, fwd };
  }
}
