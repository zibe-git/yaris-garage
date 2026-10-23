// Drive: a calm endless road in the spirit of slow roads. The Yaris drives itself along a procedural road over hills,
// lakes and forest; take over with the on-screen pedals, change the camera, the time of day and the paint.
import { h } from '../shell.js';
import { CarModel, loadCarData, defaultLight, normalizeArr } from '../gl/model.js';
import { loop } from '../gl/gl.js';
import { hexRGB } from '../gl/math.js';
import { World, WATER_LEVEL, BLEND_MAX } from '../world/world.js';
import { ROAD_HALF } from '../world/road.js';
import { Terrain, scatter } from '../world/terrain.js';
import { Forest, treeLists } from '../world/trees.js';
import { RoadMesh } from '../world/roadmesh.js';
import { Water } from '../world/water.js';
import { Sky } from '../world/sky.js';
import { Jobs } from '../world/jobs.js';
import { Driver } from '../world/driver.js';
import { Camera, CameraRig, ContactShadow, DriveControls, poseMatrix, bodyMatrix } from '../world/scene.js';
import { createNoise2D, smoothstep } from '../shared/noise.js';

export const title = 'Drive';

const PAINTS = [
  ['Absolutely Red', '#9b0f16'],
  ['Blue Streak', '#1b4b8f'],
  ['Super White', '#e8e8e4'],
  ['Black Sand', '#15161a'],
  ['Silver', '#9aa0a6'],
];

const sunAt = (elev, az) => {
  const e = (elev * Math.PI) / 180, a = (az * Math.PI) / 180;
  return normalizeArr([Math.cos(e) * Math.sin(a), Math.sin(e), Math.cos(e) * Math.cos(a)]);
};
const TIMES = [
  { name: 'Late afternoon', sun: sunAt(26, 140), uSunColor: [2.4, 2.2, 1.9], uSkyColor: [0.16, 0.34, 0.75], uHorizonColor: [0.6, 0.7, 0.84], uGroundColor: [0.16, 0.18, 0.11], fog: 1 / 700, exposure: 1 },
  { name: 'Golden hour', sun: sunAt(9, 120), uSunColor: [2.6, 1.65, 0.85], uSkyColor: [0.16, 0.27, 0.55], uHorizonColor: [0.92, 0.66, 0.42], uGroundColor: [0.18, 0.14, 0.09], fog: 1 / 620, exposure: 1.1 },
  { name: 'Sunset', sun: sunAt(2.5, 110), uSunColor: [2.3, 0.9, 0.38], uSkyColor: [0.09, 0.12, 0.3], uHorizonColor: [0.9, 0.46, 0.28], uGroundColor: [0.1, 0.075, 0.06], fog: 1 / 560, exposure: 1.25 },
  { name: 'Midday', sun: sunAt(62, 160), uSunColor: [2.7, 2.6, 2.45], uSkyColor: [0.13, 0.33, 0.85], uHorizonColor: [0.58, 0.73, 0.92], uGroundColor: [0.19, 0.21, 0.13], fog: 1 / 760, exposure: 0.92 },
];

export async function mount(shell) {
  const { ctx, gl, hud } = shell;
  const seed = Number(shell.params.get('seed')) || 7;
  shell.setProgress(0, 'Loading the car…');
  const data = await loadCarData((f) => shell.setProgress(f * 0.6, `Loading the car… ${Math.round(f * 100)}%`));
  shell.setProgress(0.6, 'Building the world…');

  const world = new World(seed);
  const road = world.road;
  road.ensure(1500);
  const jobs = new Jobs();
  const forestNoise = createNoise2D(seed + 505);
  const kindNoise = createNoise2D(seed + 606);
  const near = {};
  const terrain = new Terrain(gl, jobs, {
    tile: 80,
    radius: 440,
    roadHalf: ROAD_HALF,
    prepare: (x0, z0, x1, z1) => road.segmentsNear(x0, z0, x1, z1, BLEND_MAX),
    ground: (x, z, segs, out) => {
      const n = road.nearestAmong(segs, x, z, BLEND_MAX, near);
      out.y = World.blend(world.baseHeight(x, z), n);
      out.d = n ? n.d : BLEND_MAX;
    },
    plant: (t, at) => {
      const lists = treeLists();
      scatter(t, 80, 9, 41, (x, z, r1, r2) => {
        const g = at(x, z);
        if (g.d < ROAD_HALF + 4 || g.y < WATER_LEVEL + 1.2 || g.slope > 0.75) return;
        const forest = smoothstep(0.05, 0.45, forestNoise(x / 420, z / 420));
        const edge = g.d < 22 ? 0.25 : 0;
        if (r1 > Math.max(forest * 0.85, 0.035 + edge * forest)) return;
        const conifer = kindNoise(x / 260, z / 260) + (g.y - 25) / 40 > 0.1;
        lists[conifer ? 0 : 1].push(x, g.y - 0.2, z, 0.65 + r2 * 0.75, r1 * 40, r2);
      });
      return lists;
    },
  });
  terrain.waterLevel = WATER_LEVEL;
  const forest = new Forest(gl, { leafA: [0.03, 0.08, 0.02], leafB: [0.08, 0.13, 0.03], trunk: [0.08, 0.055, 0.035] });
  const roadMesh = new RoadMesh(gl, road, { half: ROAD_HALF, ahead: 700 });
  const water = new Water(gl, WATER_LEVEL);
  const sky = new Sky(gl);
  const shadow = new ContactShadow(gl);
  let paint = 0;
  const model = new CarModel(ctx, data).dressAsCar(hexRGB(PAINTS[paint][1]));
  const driver = new Driver(world, data.layout);
  const camera = new Camera();
  const rig = new CameraRig(['chase', 'low', 'hood', 'roadside'], {
    ground: (x, z) => world.heightAt(x, z),
    roadsideSpot: (s) => {
      const side = Math.floor(s / 150) % 2 ? 1 : -1;
      const p = road.lanePoint(s, side * (ROAD_HALF + 6));
      return { s, eye: [p[0], Math.max(world.heightAt(p[0], p[2]), WATER_LEVEL) + 1.6, p[2]] };
    },
  });

  let timeIndex = 0;
  const light = defaultLight();
  const applyTime = () => {
    const t = TIMES[timeIndex];
    Object.assign(light, { uSunDir: t.sun, uSunColor: t.uSunColor, uSkyColor: t.uSkyColor, uHorizonColor: t.uHorizonColor, uGroundColor: t.uGroundColor, uFogColor: t.uHorizonColor, uFogDensity: t.fog, uExposure: t.exposure });
  };
  applyTime();

  // ---- HUD ----
  const speedEl = h('b', {}, '0');
  hud.append(h('div', { class: 'speedo', 'aria-live': 'off' }, speedEl, h('small', {}, 'km/h')));
  const controls = new DriveControls(hud);
  const cruise = h('div', {}, h('div', { class: 'pedals right' },
    h('button', { class: 'pad', type: 'button', 'aria-label': 'Slower', onclick: () => setCruise(-10) }, '−'),
    h('button', { class: 'pad', type: 'button', 'aria-label': 'Faster', onclick: () => setCruise(10) }, '+')));
  hud.append(cruise);
  const setCruise = (d) => {
    driver.cruise = Math.max(20, Math.min(160, Math.round(driver.cruise * 3.6 + d))) / 3.6;
    shell.toast(`Cruise ${Math.round(driver.cruise * 3.6)} km/h`);
  };
  const modeBtn = shell.button('🕹', () => {
    const m = driver.toggleMode();
    modeBtn.setAttribute('aria-pressed', m === 'manual');
    controls.visible = m === 'manual';
    cruise.hidden = m === 'manual';
    shell.toast(m === 'manual' ? 'You drive' : 'Auto-drive');
  }, { 'aria-label': 'Drive yourself', 'aria-pressed': 'false' });
  shell.button('🎥', () => shell.toast(`Camera: ${rig.next()}`), { 'aria-label': 'Change camera' });
  shell.button('☀', () => {
    timeIndex = (timeIndex + 1) % TIMES.length;
    applyTime();
    shell.toast(TIMES[timeIndex].name);
  }, { 'aria-label': 'Time of day' });
  shell.button('🎨', () => {
    paint = (paint + 1) % PAINTS.length;
    model.setPaint(hexRGB(PAINTS[paint][1]));
    shell.toast(PAINTS[paint][0]);
  }, { 'aria-label': 'Paint colour' });

  // ---- build the world around the start before showing it (time-sliced) ----
  driver.update(0, controls);
  terrain.update(driver.position[0], driver.position[2]);
  roadMesh.update(driver.s);
  await jobs.drain(12, (f) => shell.setProgress(0.6 + f * 0.4, `Building the world… ${Math.round(f * 100)}%`));
  shell.setProgress(1);

  let time = 0;
  let lastTerrainUpdate = 0;
  let lastSpeed = '';
  const frame = (dt) => {
    time += dt;
    driver.update(dt, controls);
    const p = driver.position;
    if (time - lastTerrainUpdate > 0.25) {
      lastTerrainUpdate = time;
      terrain.update(p[0] + driver.fwd[0] * 60, p[2] + driver.fwd[2] * 60);
    }
    roadMesh.update(driver.s);
    jobs.run(4);
    forest.sync(terrain, dt);

    poseMatrix(model.world, p, driver.left, driver.up, driver.fwd);
    bodyMatrix(model.body, driver.pitch, driver.roll);
    model.setWheels(driver.distance / data.layout.wheelRadius, driver.steer);
    rig.update(dt, model.world, { speed: driver.v, s: driver.s }, camera, ctx.aspect);
    light.uEye = camera.eye;

    gl.viewport(0, 0, ctx.width, ctx.height);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    sky.draw(camera, light, time);
    terrain.draw(camera, light);
    roadMesh.draw(camera, light, time);
    forest.draw(camera, light, time);
    shadow.draw(camera, model.world, 0.75);
    model.draw(camera, light, { range: 'exterior' });
    water.draw(camera, light, time);

    const sp = String(Math.round(driver.speedKmh));
    if (sp !== lastSpeed) speedEl.textContent = lastSpeed = sp;
  };
  const running = loop(ctx, frame);

  return {
    driver,
    terrain,
    forest,
    camera,
    get speed() {
      return driver.speedKmh;
    },
    get distance() {
      return driver.distance;
    },
    get position() {
      return driver.position.slice();
    },
    unmount() {
      running.stop();
      jobs.clear();
      controls.dispose();
      terrain.dispose();
      forest.dispose();
      roadMesh.dispose();
      water.dispose();
      sky.dispose();
      shadow.dispose();
      model.dispose();
    },
  };
}
