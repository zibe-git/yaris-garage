// Dev screenshots on the real GPU at phone size: node tools/shot.mjs <url> <out.png> [js to run first] [--landscape]
// e.g. node tools/shot.mjs 'http://localhost:4175/#explode' /tmp/x.png "app.setSolo('wheels'); app.setExplode(1)"
import { chromium } from 'playwright';

const [url, out = 'shot.png', script] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const landscape = process.argv.includes('--landscape');
const browser = await chromium.launch({ args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: landscape ? { width: 844, height: 390 } : { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
page.on('console', (m) => ['error', 'warning'].includes(m.type()) && console.log(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`));
await page.goto(url);
await page.waitForFunction(() => window.app, null, { timeout: 60000 });
await page.waitForTimeout(1500);
if (script) console.log('→', await page.evaluate(`(async () => { ${script} })()`));
await page.waitForTimeout(2500);
await page.screenshot({ path: out });
await browser.close();
console.log(out);
