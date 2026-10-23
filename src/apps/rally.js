// Rally: the Yaris flat out on a night gravel stage in a thunderstorm. An AI drives the physical car (jumps, slides,
// handbrake) until you take over with the pedals; headlights light the road, the rain and the trees, lightning
// lights the clouds, the engine is synthesised.
import { h } from '../shell.js';
import { CarModel, loadCarData, defaultLight } from '../gl/model.js';
import { loop } from '../gl/gl.js';
import { hexRGB, vec3, clamp } from '../gl/math.js';
import { Stage, STAGE_HALF } from '../world/stage.js';
import { BLEND_MAX } from '../world/world.js';
import { Terrain, scatter } from '../world/terrain.js';
import { Forest, treeLists } from '../world/trees.js';
import { RoadMesh } from '../world/roadmesh.js';
import { Sky } from '../world/sky.js';
import { Rain, Bolt } from '../world/rain.js';
import { Jobs } from '../world/jobs.js';
import { Vehicle } from '../world/vehicle.js';
import { Pilot } from '../world/pilot.js';
import { RallyAudio } from '../world/audio.js';
import { Camera, CameraRig, ContactShadow, DriveControls, poseMatrix, bodyMatrix, transform } from '../world/scene.js';
import { createNoise2D } from '../shared/noise.js';

export const title = 'Rally';

const WEATHER = [
  { name: 'Thunderstorm', rain: 1, lightning: true, cloud: 0.85 },
  { name: 'Clear night', rain: 0, lightning: false, cloud: 0.05 },
  { name: 'Drizzle', rain: 0.35, lightning: false, cloud: 0.55 },
  { name: 'Downpour', rain: 1, lightning: false, cloud: 1 },
];

const NIGHT = {
  uSunDir: vec3.norm([-0.35, 0.42, 0.84]), // the moon
  uSunColor: [0.07, 0.08, 0.11],
  uSkyColor: [0.006, 0.008, 0.016],
  uHorizonColor: [0.011, 0.013, 0.02],
  uGroundColor: [0.004, 0.004, 0.005],
  uFogDensity: 1 / 150,
  uExposure: 1.7,
  uSpotColor: [1.25, 1.12, 0.92],
};

// lamps in the car frame (+x left, +y up, +z forward): two headlights and a four-lamp pod on the bonnet
const LAMPS = [
  { at: [0.55, 0.68, 2.0], down: 0.06, cos: 0.9 },
  { at: [-0.55, 0.68, 2.0], down: 0.06, cos: 0.9 },
  { at: [0, 0.98, 1.6], down: 0.03, cos: 0.94 },
  { at: [0, 0.9, 1.7], down: 0.1, cos: 0.84 },
];

export async function mount(shell) {
  const { ctx, gl, hud, root } = shell;
  const seed = Number(shell.params.get('seed')) || 11;
  shell.setProgress(0, 'Loading the car…');
  const data = await loadCarData((f) => shell.setProgress(f * 0.6, `Loading the car… ${Math.round(f * 100)}%`));
  shell.setProgress(0.6, 'Building the stage…');

  const stage = new Stage(seed);
  const road = stage.road;
  road.ensure(900);
  const jobs = new Jobs();
  const clearing = createNoise2D(seed + 77);
  const terrain = new Terrain(gl, jobs, {
    tile: 64,
    radius: 230,
    lodNear: 33,
    lodFar: 13,
    night: true,
    roadHalf: STAGE_HALF,
    prepare: (x0, z0, x1, z1) => road.segmentsNear(x0, z0, x1, z1, BLEND_MAX),
    ground: (x, z, segs, out) => stage.groundAt(x, z, segs, out),
    plant: (t, at) => {
      const lists = treeLists();
      scatter(t, 64, 6.4, 91, (x, z, r1, r2) => {
        const g = at(x, z);
        if (g.d < STAGE_HALF + 2.4 + r2 * 3 || g.slope > 0.9) return;
        const dense = clearing(x / 170, z / 170) > -0.35 ? 0.72 : 0.12;
        if (r1 > dense) return;
        const birch = r2 > 0.93;
        lists[birch ? 1 : 0].push(x, g.y - 0.3, z, birch ? 0.6 + r1 * 0.3 : 0.8 + r2 * 0.75, r1 * 50, r2);
      });
      return lists;
    },
  });
  const forest = new Forest(gl, { leafA: [0.008, 0.02, 0.01], leafB: [0.02, 0.032, 0.014], trunk: [0.05, 0.035, 0.025], wind: 1.6 });
  const roadMesh = new RoadMesh(gl, road, { half: STAGE_HALF, gravel: true, ahead: 420, behind: 120 });
  const sky = new Sky(gl, { night: true });
  sky.moonDir = NIGHT.uSunDir;
  const rain = new Rain(gl);
  const bolt = new Bolt(gl);
  const shadow = new ContactShadow(gl);
  const model = new CarModel(ctx, data).dressAsCar(hexRGB('#e8e8e4'));
  const tailLights = data.layout.parts.map((p, i) => (p.render === 'taillight' ? i : -1)).filter((i) => i >= 0);
  const car = new Vehicle(stage);
  car.reset(4, -1);
  const pilot = new Pilot(stage, car);
  const audio = new RallyAudio();
  const camera = new Camera();
  const segAt = {};
  const camGround = (x, z) => stage.groundAt(x, z, road.segmentsNear(x, z, x, z, BLEND_MAX), segAt).y;
  const rig = new CameraRig(['chase', 'bumper', 'heli', 'roadside'], {
    ground: camGround,
    roadsideSpot: (s) => {
      const side = Math.floor(s / 90) % 2 ? 1 : -1;
      const p = stage.point(s, side * (STAGE_HALF + 3.2), {});
      return { s, eye: [p.x, camGround(p.x, p.z) + 1.5, p.z] };
    },
  });

  let weatherIndex = Number(shell.params.get('weather')) || 0;
  let weather = WEATHER[weatherIndex];
  let wet = weather.rain;
  const light = { ...defaultLight(), ...NIGHT };

  // ---- HUD ----
  const speedEl = h('b', {}, '0');
  const gearEl = h('small', {}, 'km/h · 1');
  const rpmFill = h('i', { style: { display: 'block', height: '100%', background: 'var(--accent)', transformOrigin: 'left', transform: 'scaleX(0)' } });
  hud.append(h('div', { class: 'speedo', 'aria-live': 'off' }, speedEl, gearEl,
    h('div', { style: { width: '84px', height: '4px', marginTop: '6px', marginLeft: 'auto', background: '#ffffff26', borderRadius: '2px', overflow: 'hidden' } }, rpmFill)));
  const noteEl = h('div', { 'aria-live': 'off', style: { position: 'absolute', left: '50%', top: 'calc(62px + var(--safe-t))', transform: 'translateX(-50%)', width: '180px', height: '34px', lineHeight: '34px', textAlign: 'center', borderRadius: '17px', background: '#000a', fontWeight: '600', fontSize: '15px', whiteSpace: 'nowrap', overflow: 'hidden' } }, '');
  hud.append(noteEl);
  const controls = new DriveControls(hud, { handbrake: true });
  const modeBtn = shell.button('🕹', () => {
    const m = pilot.toggleMode();
    modeBtn.setAttribute('aria-pressed', m === 'manual');
    controls.visible = m === 'manual';
    shell.toast(m === 'manual' ? 'You drive' : 'AI driver');
  }, { 'aria-label': 'Drive yourself', 'aria-pressed': 'false' });
  shell.button('🎥', () => shell.toast(`Camera: ${rig.next()}`), { 'aria-label': 'Change camera' });
  shell.button('🌧', () => {
    weatherIndex = (weatherIndex + 1) % WEATHER.length;
    weather = WEATHER[weatherIndex];
    shell.toast(weather.name);
  }, { 'aria-label': 'Weather' });
  const soundBtn = shell.button('🔊', () => {
    audio.start();
    audio.setMuted(!audio.muted);
    soundBtn.textContent = audio.muted ? '🔇' : '🔊';
  }, { 'aria-label': 'Sound on or off' });
  shell.button('⟲', () => {
    pilot.locate();
    car.reset(pilot.s + 2, 0);
  }, { 'aria-label': 'Back on the stage' });
  // Starting Web Audio can take 100+ ms (audio device start-up): do it after the tap's frame is painted, while the
  // tap still counts as the user gesture that allows sound.
  const unlock = () => requestAnimationFrame(() => setTimeout(() => audio.start(), 0));
  root.addEventListener('pointerdown', unlock);
  window.addEventListener('keydown', unlock);

  // ---- build the stage around the start (time-sliced) ----
  pilot.locate();
  terrain.update(car.x, car.z);
  roadMesh.update(pilot.s);
  await jobs.drain(12, (f) => shell.setProgress(0.6 + f * 0.4, `Building the stage… ${Math.round(f * 100)}%`));
  shell.setProgress(1);

  // ---- lightning ----
  let nextStrike = 3;
  let strikeT = -10;
  const strokes = [0, 0.09, 0.21, 0.42];
  const flashAt = (t) => strokes.reduce((s, t0, i) => (t >= t0 ? Math.max(s, Math.exp(-(t - t0) * 16) * (i ? 0.75 : 1)) : s), 0);

  let time = 0;
  let lastTerrain = 0;
  let lastEye = null;
  let camVel = [0, 0, 0];
  let lastHud = 0;
  const spot = new Float32Array(16);
  const spotDir = new Float32Array(16);
  const frame = (dt) => {
    time += dt;
    pilot.update(dt, controls);
    car.update(dt);
    const pose = car.pose();
    poseMatrix(model.world, pose.pos, pose.left, pose.up, pose.fwd);
    bodyMatrix(model.body, car.bodyPitch, car.bodyRoll, car.heave);
    model.setWheels(car.spin, car.steer);
    model.mud = Math.min(0.85, car.distance / 2500 + wet * 0.15);
    for (const i of tailLights) model.setColor(i, car.brake > 0.1 ? [3, 0.12, 0.08] : [0.5, 0.015, 0.015]);

    if (time - lastTerrain > 0.25) {
      lastTerrain = time;
      terrain.update(car.x + pose.fwd[0] * 40, car.z + pose.fwd[2] * 40);
    }
    roadMesh.update(pilot.s);
    jobs.run(4);
    forest.sync(terrain, dt);

    // weather: wetness follows the rain slowly
    wet += (weather.rain - wet) * Math.min(1, dt / 25);
    terrain.wet = roadMesh.wet = wet;
    rain.density += (weather.rain - rain.density) * Math.min(1, dt * 0.5);
    sky.cloud += (weather.cloud - sky.cloud) * Math.min(1, dt * 0.3);
    if (weather.lightning && time > nextStrike) {
      strikeT = time;
      nextStrike = time + 5 + Math.random() * 11;
      const dist = 500 + Math.random() * 1500;
      const az = Math.atan2(pose.fwd[0], pose.fwd[2]) + (Math.random() - 0.5) * 2.2;
      bolt.strike(camera.eye, az, dist);
      audio.thunder(dist / 343, 1 - (dist - 500) / 1600);
    }
    const flash = flashAt(time - strikeT);
    sky.flash = flash;
    const boost = (c, k) => c.map((v, i) => v + flash * k[i]);
    light.uSkyColor = boost(NIGHT.uSkyColor, [0.12, 0.13, 0.2]);
    light.uHorizonColor = boost(NIGHT.uHorizonColor, [0.1, 0.11, 0.17]);
    light.uGroundColor = boost(NIGHT.uGroundColor, [0.05, 0.05, 0.07]);
    light.uSunColor = boost(NIGHT.uSunColor, [0.4, 0.42, 0.6]);
    light.uFogColor = light.uHorizonColor;
    light.uFogDensity = NIGHT.uFogDensity * (1 + weather.rain * 0.4);

    // headlights
    const down = pose.up;
    LAMPS.forEach((l, i) => {
      const p = transform(model.world, l.at);
      const d = vec3.norm(vec3.sub(pose.fwd, vec3.scale(down, l.down)));
      spot.set([...p, 1], i * 4);
      spotDir.set([...d, l.cos], i * 4);
    });
    light.uSpot = spot;
    light.uSpotDir = spotDir;

    rig.update(dt, model.world, { speed: Math.abs(car.u), s: pilot.s }, camera, ctx.aspect);
    if (lastEye && dt > 0) {
      const step = vec3.len(vec3.sub(camera.eye, lastEye)) / dt;
      if (step < 80) camVel = camVel.map((v, k) => v + ((camera.eye[k] - lastEye[k]) / dt - v) * Math.min(1, dt * 10));
      else camVel = [0, 0, 0]; // a camera cut, not motion
    }
    lastEye = camera.eye.slice();
    light.uEye = camera.eye;

    gl.viewport(0, 0, ctx.width, ctx.height);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    sky.draw(camera, light, time);
    bolt.draw(camera, flash);
    terrain.draw(camera, light);
    roadMesh.draw(camera, light, time);
    forest.draw(camera, light, time);
    if (!car.airborne || car.y - camGround(car.x, car.z) < 3) shadow.draw(camera, model.world, 0.6, car.airborne ? car.y - camGround(car.x, car.z) : 0);
    model.draw(camera, light, { range: 'exterior' });
    rain.draw(camera, light, time, camVel, flash);

    audio.update({ rpm: car.rpm, throttle: car.throttle, speed: car.speed, slip: car.slip, airborne: car.airborne, rain: rain.density });
    if (time - lastHud > 0.1) {
      lastHud = time;
      speedEl.textContent = String(Math.round(car.kmh));
      gearEl.textContent = `km/h · ${car.gear === 0 ? 'R' : car.gear}`;
      rpmFill.style.transform = `scaleX(${clamp(car.rpm / 8000, 0, 1).toFixed(3)})`;
      const note = pilot.note();
      const text = car.airborne ? 'Airborne!' : note.dist ? `${note.text} · ${Math.round(note.dist / 10) * 10}` : note.text;
      if (noteEl.textContent !== text) noteEl.textContent = text;
    }
  };
  const running = loop(ctx, frame);

  return {
    car,
    pilot,
    terrain,
    forest,
    camera,
    get speed() {
      return car.kmh;
    },
    get distance() {
      return car.distance;
    },
    get position() {
      return [car.x, car.y, car.z];
    },
    /** Lightning now (when the weather has it). */
    strike() {
      nextStrike = 0;
    },
    unmount() {
      running.stop();
      jobs.clear();
      root.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
      controls.dispose();
      audio.dispose();
      terrain.dispose();
      forest.dispose();
      roadMesh.dispose();
      sky.dispose();
      rain.dispose();
      bolt.dispose();
      shadow.dispose();
      model.dispose();
    },
  };
}
