// Headless rally drive (no GPU): runs the AI pilot on the physics for N seconds and prints how it went.
// Usage: node tests/rally-sim.mjs [seconds] [seed] [wet 0..1]
import { Stage, STAGE_HALF } from '../src/world/stage.js';
import { Vehicle } from '../src/world/vehicle.js';
import { Pilot } from '../src/world/pilot.js';

const [secs = 180, seed = 11, wet = 0] = process.argv.slice(2).map(Number);
const stage = new Stage(seed);
stage.wetness = wet;
stage.road.ensure(900);
const car = new Vehicle(stage);
car.reset(4, -1);
const pilot = new Pilot(stage, car);
const none = { steer: 0, gas: 0, brake: 0, hand: 0 };
const dt = 1 / 60;
let off = 0, maxD = 0, air = 0, maxAir = 0, flights = 0, maxSpeed = 0, wasAir = false, hardLand = 0;
const t0 = performance.now();
for (let i = 0; i < secs * 60; i++) {
  pilot.update(dt, none);
  car.update(dt);
  if (pilot.d > STAGE_HALF) off += dt;
  maxD = Math.max(maxD, pilot.d);
  maxSpeed = Math.max(maxSpeed, car.kmh);
  if (car.airborne) {
    air += dt;
    maxAir = Math.max(maxAir, car.airTime);
    if (!wasAir) flights++;
  } else if (wasAir && car.landing > 6) hardLand++;
  wasAir = car.airborne;
}
const ms = performance.now() - t0;
console.log(JSON.stringify({ distance: Math.round(car.distance), avgKmh: Math.round((car.distance / secs) * 3.6), maxKmh: Math.round(maxSpeed), resets: pilot.resets, offRoadS: +off.toFixed(1), maxOff: +maxD.toFixed(1), flights, airS: +air.toFixed(1), longestFlight: +maxAir.toFixed(2), hardLandings: hardLand, msPerSimSecond: +(ms / secs).toFixed(2) }));
