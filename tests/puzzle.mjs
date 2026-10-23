// Puzzle e2e on a phone-sized page: menu, a real finger drag that snaps a part in, a blocked part rejected, solving a
// level to the result sheet, hard mode turning, and no long tasks while dragging.
// Usage: node tests/puzzle.mjs [baseUrl] [--gpu]   (dev server: npm run dev → http://localhost:5182)
import { chromium } from 'playwright';
import fs from 'node:fs';

const base = process.argv.slice(2).find((a) => !a.startsWith('--')) || 'http://localhost:5182/';
const gpu = process.argv.includes('--gpu');
const out = 'tests/output';
fs.mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ args: gpu ? ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(String(e)));
await page.addInitScript(() => {
  window.__long = [];
  new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__long.push({ t: e.startTime, d: Math.round(e.duration) }))).observe({ type: 'longtask', buffered: true });
});
const cdp = await page.context().newCDPSession(page);

let failed = 0;
async function step(name, fn) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}: ${e.message}`);
    await page.screenshot({ path: `${out}/FAIL-pz-${name.replace(/\W+/g, '_')}.png` });
  }
}
const assert = (c, msg) => {
  if (!c) throw new Error(msg);
};
// a fresh page per level, so state never leaks from the previous one
const open = async (hash) => {
  await page.goto('about:blank');
  await page.goto(`${base}#${hash}`);
  await page.waitForFunction(() => window.app?.game, null, { timeout: 60000 });
};
const playing = () => page.waitForFunction(() => window.app.game.state === 'playing', null, { timeout: 20000 });
const settle = () => page.waitForTimeout(900); // camera framing eases in

async function touchDrag(from, to, steps = 12) {
  const pt = (p) => [{ x: p.x, y: p.y, id: 1 }];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pt(from) });
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pt({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t }) });
    await page.waitForTimeout(16);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

await step('menu lists the campaign and free build', async () => {
  await open('puzzle');
  await page.waitForSelector('.menu .level');
  const n = await page.$$eval('.menu .level', (b) => b.length);
  assert(n > 20, `only ${n} level buttons`);
  assert(await page.$eval('.pz-menu-top', (e) => e.hidden), 'resume row shown without a level');
  await page.screenshot({ path: `${out}/pz1-menu.png` });
});

await step('tapping a level starts it', async () => {
  await page.click('.menu .level[data-level="bumper"]');
  await playing();
  assert(await page.$eval('.menu', (e) => e.hidden), 'menu still open');
});

await step('a finger drag snaps a ready part in', async () => {
  await open('puzzle?level=bumper&d=easy&seed=7');
  await playing();
  await settle();
  const plan = await page.evaluate(() => {
    const g = window.app.game;
    for (const pid of g.readyPids()) {
      const p = window.app.dragPlan(pid);
      if (p) return { pid, ...p };
    }
    return null;
  });
  assert(plan, 'no grabbable ready part');
  await page.waitForTimeout(300); // let long tasks from computing the plan be reported first
  const t0 = await page.evaluate(() => performance.now());
  await touchDrag(plan.from, plan.to);
  await page.waitForTimeout(300);
  const s = await page.evaluate(([pid, t0]) => ({ placed: window.app.game.pieces.get(pid).placed, mistakes: window.app.game.mistakes, long: window.__long.filter((e) => e.t >= t0).map((e) => e.d) }), [plan.pid, t0]);
  await page.screenshot({ path: `${out}/pz2-after-drag.png` });
  assert(s.placed, `part ${plan.pid} not placed (mistakes ${s.mistakes})`);
  assert(s.mistakes === 0, `mistakes ${s.mistakes}`);
  console.log(`     long tasks during the drag: ${s.long.length ? s.long.join(', ') + ' ms' : 'none'}`);
  assert(!s.long.some((d) => d > 100), `long task during the drag: ${s.long.join(', ')} ms`);
});

await step('mid-drag shows pegs, holes and the fit label', async () => {
  const plan = await page.evaluate(() => {
    const g = window.app.game;
    for (const pid of g.readyPids()) {
      const p = window.app.dragPlan(pid);
      if (p) return { pid, ...p };
    }
    return null;
  });
  assert(plan, 'no grabbable part');
  const pt = (p) => [{ x: p.x, y: p.y, id: 1 }];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pt(plan.from) });
  for (let i = 1; i <= 10; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pt({ x: plan.from.x + (plan.to.x - plan.from.x) * i / 10, y: plan.from.y + (plan.to.y - plan.from.y) * i / 10 }) });
    await page.waitForTimeout(16);
  }
  await page.waitForTimeout(120);
  const fit = await page.$eval('.pz-fit', (e) => (e.hidden ? null : e.textContent));
  await page.screenshot({ path: `${out}/pz3-dragging.png` });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  assert(fit === 'Release to fit', `fit label: ${fit}`);
});

await step('swiping a tray chip up pulls its part out and it can be dropped home', async () => {
  const plan = await page.evaluate(() => {
    const g = window.app.game;
    for (const pid of g.readyPids()) {
      const chip = document.querySelector(`.chip[data-pid="${pid}"]`);
      chip.scrollIntoView({ inline: 'center' });
      const r = chip.getBoundingClientRect();
      if (r.right > innerWidth || r.left < 0) continue;
      const home = g.screenOf(pid, { home: true });
      const c = g.canvas.getBoundingClientRect();
      return { pid, from: { x: r.left + r.width / 2, y: r.top + r.height / 2 }, to: { x: home.x + c.left, y: home.y + c.top } };
    }
    return null;
  });
  assert(plan, 'no ready part with a visible chip');
  await page.waitForTimeout(200);
  await touchDrag(plan.from, plan.to, 16);
  await page.waitForTimeout(300);
  const placed = await page.evaluate((pid) => window.app.game.pieces.get(pid).placed, plan.pid);
  assert(placed, `part ${plan.pid} not placed from the tray`);
});

await step('a part dropped before the one under it is rejected', async () => {
  await open('puzzle?level=door&d=normal&seed=3');
  await playing();
  await settle();
  const r = await page.evaluate(() => {
    const g = window.app.game;
    const blocked = g.loosePids().find((p) => !g.readyPids().includes(p));
    if (!blocked) return { none: true };
    return { ...g.tryPlace(blocked), mistakes: g.mistakes };
  });
  assert(!r.none, 'no blocked part in the door level');
  assert(!r.ok && r.reason === 'order' && r.mistakes === 1, JSON.stringify(r));
});

await step('solving the level shows the result sheet', async () => {
  await page.evaluate(async () => {
    for (let i = 0; i < 60 && window.app.game.state === 'playing'; i++) {
      window.app.solveNext();
      await new Promise((r) => setTimeout(r, 30));
    }
  });
  await page.waitForFunction(() => !document.querySelector('.pz-result').hidden, null, { timeout: 8000 });
  await page.waitForTimeout(400);
  const t = await page.$eval('.pz-result h2', (e) => e.textContent);
  assert(/rebuilt/.test(t), t);
  await page.screenshot({ path: `${out}/pz4-complete.png` });
});

await step('hard mode: parts arrive turned, the rotate pad turns the held one', async () => {
  await open('puzzle?level=hood&d=hard&seed=11');
  await playing();
  await settle();
  const pid = await page.evaluate(() => {
    const g = window.app.game;
    const pid = g.loosePids().find((p) => g.pieces.get(p).rot !== 0);
    if (pid != null) g.hold(pid);
    return pid;
  });
  assert(pid != null, 'no turned part');
  assert(await page.$eval('.pz-rotate', (e) => !e.hidden), 'rotate pad hidden');
  const before = await page.evaluate((p) => window.app.game.pieces.get(p).rot, pid);
  await page.click('.pz-rotate [data-move="yaw+"]');
  const after = await page.evaluate((p) => window.app.game.pieces.get(p).rot, pid);
  assert(before !== after, 'rotation did not change');
  const steps = await page.evaluate((p) => window.app.game.rotationSteps(p), pid);
  for (const m of steps) await page.click(`.pz-rotate [data-move="${m}"]`);
  const final = await page.evaluate((p) => window.app.game.pieces.get(p).rot, pid);
  assert(final === 0, `still turned: ${final}`);
  await page.screenshot({ path: `${out}/pz5-hard.png` });
});

await step('landscape layout', async () => {
  await page.setViewportSize({ width: 844, height: 390 });
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${out}/pz6-landscape.png` });
});

await step('leaving and reopening the app', async () => {
  await page.evaluate(() => (location.hash = ''));
  await page.waitForFunction(() => !document.getElementById('home').hidden);
  assert(!(await page.evaluate(() => window.app?.game)), 'app instance left behind'); // window.app is then the #app element
  await page.evaluate(() => (location.hash = 'puzzle'));
  await page.waitForFunction(() => window.app?.game && document.querySelector('.menu .level'), null, { timeout: 20000 });
});

await step('no console errors', async () => assert(!errors.length, errors.join('\n')));

await browser.close();
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
