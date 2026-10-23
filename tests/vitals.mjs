// Web vitals check on the production build: Lighthouse (mobile preset: Moto G Power, slow 4G, 4× CPU throttle) on the
// launcher must score 100 in performance, accessibility, best practices and SEO. Then, in a real browser, each app is
// opened from its card and used for a few seconds while recording layout shifts, long tasks and the slowest
// interaction (INP proxy from the Event Timing API).
// Usage: npm run vitals   (builds first)   ·   node tests/vitals.mjs [--skip-apps] [--apps=explode,drive] [--swiftshader]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import lighthouse from 'lighthouse';
import * as chromeLauncher from 'chrome-launcher';
import { chromium } from 'playwright';

const PORT = 4175;
const BASE = `http://localhost:${PORT}/`;
const OUT = new URL('./output/', import.meta.url);
fs.mkdirSync(OUT, { recursive: true });

const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'pipe' });
await new Promise((resolve, reject) => {
  server.stdout.on('data', (d) => /Local/.test(d) && resolve());
  server.on('exit', (c) => reject(new Error(`preview exited ${c}`)));
  setTimeout(() => reject(new Error('preview did not start')), 20000);
});

let failed = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? `  ${detail}` : ''}`);
  if (!ok) failed++;
};

try {
  // ---- Lighthouse on the launcher ----
  const chrome = await chromeLauncher.launch({ chromePath: chromium.executablePath(), chromeFlags: ['--headless=new', '--no-sandbox'] });
  try {
    const { lhr } = await lighthouse(BASE, { port: chrome.port, output: 'json', logLevel: 'error' });
    fs.writeFileSync(new URL('lighthouse.json', OUT), JSON.stringify(lhr));
    for (const [id, cat] of Object.entries(lhr.categories)) check(cat.score === 1, `Lighthouse ${id}`, String(Math.round(cat.score * 100)));
    const a = lhr.audits;
    for (const id of ['first-contentful-paint', 'largest-contentful-paint', 'total-blocking-time', 'cumulative-layout-shift', 'speed-index'])
      console.log(`    ${id.padEnd(26)} ${a[id].displayValue}  (score ${a[id].score})`);
    for (const cat of Object.values(lhr.categories))
      for (const ref of cat.auditRefs) {
        const r = a[ref.id];
        if (ref.weight > 0 && r.score !== null && r.score < 1) console.log(`    ! ${cat.id}/${ref.id}: ${r.title} (${r.score})`);
      }
  } finally {
    await chrome.kill();
  }

  // ---- field-style vitals while using each app ----
  if (!process.argv.includes('--skip-apps')) {
    // real GPU (Metal on macOS) so frame times mean something; SwiftShader elsewhere (CI) or with --swiftshader.
    // The CPU is throttled 4× like Lighthouse's mobile preset.
    const gpu = process.argv.includes('--swiftshader') || process.platform !== 'darwin' ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : ['--use-angle=metal', '--enable-gpu'];
    const browser = await chromium.launch({ args: [...gpu, '--ignore-gpu-blocklist'] });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    const errors = [];
    page.on('console', (m) => ['error', 'warning'].includes(m.type()) && errors.push(m.text()));
    page.on('pageerror', (e) => errors.push(e.message));
    await page.addInitScript(() => {
      const v = (window.__vitals = { cls: 0, longTasks: [], events: [] });
      new PerformanceObserver((l) => l.getEntries().forEach((e) => !e.hadRecentInput && (v.cls += e.value))).observe({ type: 'layout-shift', buffered: true });
      new PerformanceObserver((l) => l.getEntries().forEach((e) => v.longTasks.push(Math.round(e.duration)))).observe({ type: 'longtask', buffered: true });
      new PerformanceObserver((l) => l.getEntries().forEach((e) => e.interactionId && v.events.push({ name: e.name, d: e.duration }))).observe({ type: 'event', durationThreshold: 16, buffered: true });
    });
    const only = process.argv.find((a) => a.startsWith('--apps='))?.slice(7).split(',');
    for (const name of only || ['explode', 'drive', 'rally', 'puzzle']) {
      await page.goto(BASE);
      await page.tap(`[data-app="${name}"]`);
      const started = await page.waitForFunction(() => window.app && document.querySelector('.loading')?.hidden !== false, null, { timeout: 60000 }).then(() => true, () => false);
      check(started, `${name}: opens`);
      await page.waitForTimeout(1500);
      await page.evaluate(() => {
        window.__vitals.longTasks = [];
        window.__vitals.events = [];
      });
      // a few taps and drags on the canvas and the app's buttons
      const box = await page.locator('canvas.view').boundingBox();
      for (let i = 0; i < 3; i++) {
        await page.touchscreen.tap(box.width * (0.3 + i * 0.2), box.height * 0.5);
        await page.waitForTimeout(250);
      }
      const buttons = page.locator('.bar-actions button');
      for (let i = 0; i < Math.min(2, await buttons.count()); i++) {
        await buttons.nth(i).tap();
        await page.waitForTimeout(300);
      }
      await page.waitForTimeout(1500);
      await page.screenshot({ path: new URL(`vitals-${name}.png`, OUT).pathname });
      const v = await page.evaluate(() => window.__vitals);
      const inp = Math.max(0, ...v.events.map((e) => e.d));
      // SwiftShader draws every frame on the CPU, so there the next-paint time says nothing about a phone's GPU
      if (gpu[0].includes('metal')) check(inp <= 200, `${name}: slowest interaction`, `${Math.round(inp)} ms`);
      else console.log(`    slowest interaction (software GL, not checked): ${Math.round(inp)} ms`);
      check(v.cls < 0.1, `${name}: layout shift`, v.cls.toFixed(3));
      console.log(`    slowest events: ${v.events.sort((a, b) => b.d - a.d).slice(0, 3).map((e) => `${e.name} ${Math.round(e.d)}`).join(', ') || 'none'}`);
      console.log(`    long tasks while in use: ${v.longTasks.length ? v.longTasks.join(', ') + ' ms' : 'none'}`);
    }
    check(!errors.length, 'no console errors or warnings', errors.slice(0, 3).join(' | '));
    await browser.close();
  }
} finally {
  server.kill();
}
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
