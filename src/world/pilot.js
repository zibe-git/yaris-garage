// AI rally driver and pace notes. Plans a speed from the curvature ahead (and each jump's approach speed), follows a
// racing line that cuts the inside of bends with a pursuit point, counter-steers by the body slip angle, and puts
// itself back on the stage when it is stuck in the trees. Manual mode passes the touch / keyboard controls through.
import { clamp } from '../gl/math.js';
import { STAGE_HALF } from './stage.js';

const G = 9.81;

export class Pilot {
  constructor(stage, car) {
    this.stage = stage;
    this.car = car;
    this.mode = 'auto';
    this.s = 0;
    this.d = 0; // distance from the centreline
    this.targetSpeed = 0;
    this.stuck = 0;
    this.resets = 0;
    // controller gains (tuned with tests/rally-sim.mjs)
    this.tune = { latG: 0.7, line: 1.6, look: 0.42, yaw: 2.2, slide: 1.5, under: 0.003 };
    this._p = {};
    this._near = {};
  }

  toggleMode() {
    this.mode = this.mode === 'auto' ? 'manual' : 'auto';
    return this.mode;
  }

  /** Where the car is along the stage. */
  locate() {
    const c = this.car;
    const near = this.stage.road.nearestAmong(c._segments(), c.x, c.z, 80, this._near);
    if (near) {
      this.s = near.s;
      this.d = near.d;
    } else this.d = 99;
    this.stage.road.ensure(this.s + 900);
  }

  /** Racing line: lateral offset (+ left) that cuts the inside of upcoming bends. */
  line(s) {
    const k = this.stage.curvature(s + 6) * 0.6 + this.stage.curvature(s + 18) * 0.4;
    return clamp(k * 110, -1, 1) * (STAGE_HALF - this.tune.line);
  }

  plan() {
    const c = this.car;
    const mu = this.stage.grip(c.surface || { mu: 0.95, id: 0 });
    const decel = 6.5 * mu;
    let target = 48;
    const look = 30 + c.u * c.u / (2 * decel) + 20;
    for (let d = 0; d <= look; d += 5) {
      const k = Math.max(Math.abs(this.stage.curvature(this.s + d)), 1e-4);
      const vc = Math.sqrt((this.tune.latG * mu * G) / k);
      target = Math.min(target, Math.sqrt(vc * vc + 2 * decel * Math.max(0, d - 4)));
    }
    for (const j of this.stage.jumpsBetween(this.s - 5, this.s + look)) {
      const dist = j.s - j.up * j.lip - this.s;
      if (dist > -j.up) target = Math.min(target, Math.sqrt(j.v * j.v + 2 * decel * Math.max(0, dist)));
    }
    return target;
  }

  update(dt, controls) {
    const c = this.car;
    this.locate();
    c.tc = this.mode === 'auto';
    if (this.mode === 'manual') {
      c.steerInput = controls.steer;
      const reverse = controls.brake && c.u < 0.8 && !controls.gas;
      if (reverse && c.gear !== 0) c.gear = 0;
      if (!reverse && c.gear === 0 && (controls.gas || c.u > -0.3)) c.gear = 1;
      c.throttle = c.gear === 0 ? controls.brake : controls.gas;
      c.brake = c.gear === 0 ? controls.gas : controls.brake;
      c.hand = controls.hand;
      return;
    }
    const target = (this.targetSpeed = this.plan());
    // pursuit point: the curvature that reaches it, as a yaw rate to track; steer = kinematic angle, scaled up for
    // the tyres' understeer at speed, plus yaw-rate feedback and counter-steer once the rear steps out
    const T = this.tune;
    const ld = 5 + Math.abs(c.u) * T.look;
    const p = this.stage.point(this.s + ld, this.line(this.s + ld), this._p);
    const dx = p.x - c.x, dz = p.z - c.z;
    const sy = Math.sin(c.yaw), cy = Math.cos(c.yaw);
    const alpha = Math.atan2(dx * cy - dz * sy, Math.max(dx * sy + dz * cy, 0.5));
    const kappa = (2 * Math.sin(alpha)) / ld;
    const u = Math.max(Math.abs(c.u), 3);
    const beta = Math.atan2(c.v, u);
    const slide = Math.sign(beta) * Math.max(0, Math.abs(beta) - 0.06);
    const steer = Math.atan(c.L * kappa) * (1 + T.under * u * u) + (T.yaw * (u * kappa - c.r)) / u + T.slide * slide;
    const maxSteer = 0.6 / (1 + Math.abs(c.u) / 22);
    c.steerInput = clamp(steer / maxSteer, -1, 1);
    const err = target - c.u;
    c.throttle = err > 0 ? clamp(err * 0.35 + 0.35, 0, 1) * (1 - clamp(c.slip * 0.6, 0, 0.6)) : 0;
    c.brake = err < -1 ? clamp(-err * 0.18, 0, 0.9) : 0;
    c.hand = 0;
    // stuck in the scenery: back on the stage
    this.stuck = (this.d > STAGE_HALF + 7 || c.speed < 1.5) ? this.stuck + dt : 0;
    if (this.stuck > 3.5) this.recover();
  }

  recover() {
    this.resets++;
    this.stuck = 0;
    this.car.reset(this.s + 2, 0);
  }

  /** Pace note for the road 40–160 m ahead, e.g. "4 left", "jump!", "hairpin right". */
  note() {
    const c = this.car;
    for (const j of this.stage.jumpsBetween(this.s + 10, this.s + 140)) return { text: j.crest ? 'Crest' : j.big ? 'Big jump!' : 'Jump', dist: j.s - this.s };
    let best = 0, at = 0;
    for (let d = 40; d <= 160; d += 6) {
      const k = this.stage.road.curvature(this.s + d, 10);
      if (Math.abs(k) > Math.abs(best)) {
        best = k;
        at = d;
      }
    }
    const r = 1 / Math.max(Math.abs(best), 1e-6);
    if (r > 400) return { text: 'Flat out', dist: 0 };
    const side = best > 0 ? 'left' : 'right';
    const grade = r < 22 ? 'Hairpin' : r < 40 ? '2' : r < 65 ? '3' : r < 100 ? '4' : r < 160 ? '5' : '6';
    return { text: grade === 'Hairpin' ? `Hairpin ${side}` : `${grade} ${side}`, dist: at, speed: c.u };
  }
}
