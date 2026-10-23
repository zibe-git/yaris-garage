// Launcher router: the home page is static HTML; an app's code (and the shared shell) loads only when it opens,
// so the first visit costs a few kilobytes. #explode / #drive / #rally / #puzzle open an app, back returns home.
const APPS = {
  explode: () => import('./apps/explode.js'),
  drive: () => import('./apps/drive.js'),
  rally: () => import('./apps/rally.js'),
  puzzle: () => import('./apps/puzzle.js'),
};

const home = document.getElementById('home');
const appEl = document.getElementById('app');
let current = null;
let seq = 0;

async function route() {
  const name = location.hash.slice(1).split('?')[0];
  const id = ++seq;
  if (current) {
    const c = current;
    current = null;
    try {
      c.unmount();
    } catch (e) {
      console.error(e);
    }
  }
  if (!APPS[name]) {
    appEl.hidden = true;
    appEl.replaceChildren();
    home.hidden = false;
    document.title = 'Yaris Garage';
    return;
  }
  home.hidden = true;
  appEl.hidden = false;
  try {
    const [{ openShell }, app] = await Promise.all([import('./shell.js'), APPS[name]()]);
    if (id !== seq) return;
    const opened = await openShell(appEl, name, app);
    if (id === seq) current = opened;
    else opened.unmount(); // another app was opened while this one loaded
  } catch (e) {
    console.error(e);
    if (id === seq) {
      const msg = document.createElement('div');
      msg.id = 'boot';
      msg.textContent = `Could not start: ${e.message}`;
      appEl.replaceChildren(msg);
    }
  }
}

// Warm the app's code as soon as a finger lands on its card.
const warmed = new Set();
home.addEventListener('pointerdown', (e) => {
  const a = e.target.closest('[data-app]');
  if (a && !warmed.has(a.dataset.app)) {
    warmed.add(a.dataset.app);
    APPS[a.dataset.app]().catch(() => {});
    import('./shell.js').catch(() => {});
  }
}, { passive: true });

window.addEventListener('hashchange', route);
if (location.hash) route();
