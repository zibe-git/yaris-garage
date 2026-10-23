// Puzzle: rebuild the car part by part. Pick a level, then drag each floating part back onto the ghosted car with one
// finger — inner layers first. Numbered pegs on the held part match the holes where it is really welded or bolted.
// Deep link: #puzzle?level=door&d=hard&seed=7
import '../puzzle/puzzle.css';
import { h } from '../shell.js';
import { CarModel, loadCarData, defaultLight } from '../gl/model.js';
import { Orbit } from '../gl/orbit.js';
import { loop } from '../gl/gl.js';
import { PuzzleGame, MOVE_LABEL } from '../puzzle/game.js';
import { Guides } from '../puzzle/guides.js';
import { campaign, freePlay, findLevel } from '../shared/levels.js';
import { DIFFICULTY, formatTime, planLevel } from '../shared/logic.js';
import { sound } from '../shared/sound.js';

export const title = 'Puzzle';

// best results per level and difficulty, kept in this browser only
const STORE_KEY = 'yaris-mobile-puzzle-v1';
const store = {
  data: null,
  load() {
    try {
      this.data = JSON.parse(localStorage.getItem(STORE_KEY)) || {};
    } catch {
      this.data = {};
    }
    return this;
  },
  best(id, d) {
    return this.data.levels?.[id]?.[d] || null;
  },
  record(id, d, { stars, timeMs }) {
    const prev = this.best(id, d);
    const better = !prev || stars > prev.stars || (stars === prev.stars && timeMs < prev.timeMs);
    if (better) {
      this.data.levels ??= {};
      this.data.levels[id] ??= {};
      this.data.levels[id][d] = { stars, timeMs };
      this.save();
    }
    return better;
  },
  save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(this.data));
    } catch {
      /* private mode: progress just is not kept */
    }
  },
};

const CONTEXT_LABEL = { ghost: 'Car: ghost', solid: 'Car: solid', off: 'Car: hidden' };

export async function mount(shell) {
  const { ctx, gl, canvas, hud, root } = shell;
  store.load();
  shell.setProgress(0, 'Loading the car…');
  const data = await loadCarData((f) => shell.setProgress(f * 0.95, `Loading the car… ${Math.round(f * 100)}%`));
  const model = new CarModel(ctx, data);
  shell.setProgress(1);
  const manifest = data.layout; // has groups + parts with group / assembly, like parts.json
  const light = defaultLight();
  light.uSkyColor = [0.42, 0.45, 0.5];
  light.uHorizonColor = [0.55, 0.57, 0.6];
  light.uGroundColor = [0.22, 0.21, 0.2];
  light.uSunColor = [1.9, 1.85, 1.75];

  let game = null;
  const orbit = new Orbit(canvas, {
    target: [0, 0.75, 0], yaw: 0.8, pitch: 0.3, distance: 9, minDistance: 0.4, maxDistance: 24,
    grab: (e) => {
      sound.unlock();
      return game.grab(e);
    },
  });
  game = new PuzzleGame(model, orbit, data);
  game.light = light;
  game.stop();
  orbit.autoRotate = 0.15;
  orbit.idle = 10;
  orbit.frame({ distance: Math.min(16, orbit.fitDistance(2.5, ctx.aspect)) });

  const levels = campaign(manifest);
  const groupLabel = Object.fromEntries(manifest.groups.map((g) => [g.id, g.label]));
  let difficulty = DIFFICULTY[store.data.difficulty] ? store.data.difficulty : 'normal';
  let current = null;
  const titleEl = root.querySelector('.bar h1');

  // ---- overlay ----
  const guidesCanvas = h('canvas', { class: 'pz-guides', 'aria-hidden': 'true' });
  const guides = new Guides(game, guidesCanvas);
  const statPlaced = h('b');
  const statTime = h('span');
  const statMistakes = h('span');
  const stats = h('div', { class: 'pz-stats', hidden: true, 'aria-live': 'off' }, statPlaced, statTime, statMistakes);
  const fitEl = h('div', { class: 'pz-fit', hidden: true });
  const rotateRow = h('div', { class: 'pz-rotate', hidden: true, role: 'toolbar', 'aria-label': 'Turn the held part' },
    Object.entries(MOVE_LABEL).map(([move, label]) => h('button', { class: 'icon-btn', type: 'button', 'data-move': move, onclick: () => game.rotateHeld(move) }, label)));
  const contextChip = h('button', { class: 'chip', type: 'button', onclick: () => (contextChip.textContent = CONTEXT_LABEL[game.cycleContext()]) }, CONTEXT_LABEL.ghost);
  const tray = h('div', { class: 'chips', role: 'toolbar', 'aria-label': 'Loose parts' });
  const dock = h('div', { class: 'dock', hidden: true }, rotateRow, tray);

  const diffEl = h('div', { class: 'pz-diff', role: 'radiogroup', 'aria-label': 'Difficulty' },
    Object.entries(DIFFICULTY).map(([id, d]) => h('button', { type: 'button', role: 'radio', 'data-difficulty': id, onclick: () => {
      difficulty = id;
      store.data.difficulty = id;
      store.save();
      renderMenu();
    } }, h('b', {}, d.label), h('small', {}, d.blurb))));
  const resumeBtn = h('button', { class: 'btn primary', type: 'button', onclick: () => showMenu(false) }, 'Resume');
  const restartBtn = h('button', { class: 'btn', type: 'button', onclick: () => current && play(current) }, 'Restart level');
  const menuTop = h('div', { class: 'pz-menu-top' }, resumeBtn, restartBtn);
  const campaignEl = h('div', { class: 'levels' });
  const freeEl = h('div');
  const menu = h('section', { class: 'menu', 'aria-label': 'Levels' },
    menuTop, h('h2', {}, 'Difficulty'), diffEl, h('h2', {}, 'Campaign'), campaignEl, h('h2', {}, 'Free build'), freeEl);

  const resStars = h('div', { class: 'pz-stars', role: 'img' });
  const resTitle = h('span');
  const resBest = h('span', { class: 'pz-best', hidden: true }, 'New best');
  const resDl = h('dl');
  const nextBtn = h('button', { class: 'btn primary', type: 'button', onclick: () => {
    const i = levels.findIndex((l) => l.id === current?.id);
    if (levels[i + 1]) play(levels[i + 1]);
  } }, 'Next level');
  const result = h('section', { class: 'sheet pz-result', hidden: true, 'aria-live': 'polite' },
    h('h2', {}, resTitle, resBest), resStars, resDl,
    h('div', { class: 'row' }, nextBtn,
      h('button', { class: 'btn', type: 'button', onclick: () => current && play(current) }, 'Replay'),
      h('button', { class: 'btn', type: 'button', onclick: () => {
        result.hidden = true;
        showMenu(true);
      } }, 'Levels')));
  hud.append(guidesCanvas, stats, fitEl, dock, result, menu);

  const hintBtn = shell.button('💡', () => game.hint(), { 'aria-label': 'Hint' });
  shell.button('☰', () => showMenu(menu.hidden), { 'aria-label': 'Levels' });
  const soundBtn = shell.button(sound.muted ? '🔇' : '🔊', () => {
    sound.setMuted(!sound.muted);
    soundBtn.textContent = sound.muted ? '🔇' : '🔊';
    soundBtn.setAttribute('aria-label', sound.muted ? 'Sound off' : 'Sound on');
  }, { 'aria-label': sound.muted ? 'Sound off' : 'Sound on' });

  // ---- menu ----
  const counts = new Map();
  const playCount = (level) => {
    if (!counts.has(level.id)) {
      const metas = level.pids.map((pid) => manifest.parts[model.byPid.get(pid)]);
      counts.set(level.id, planLevel(metas, game.car, { maxParts: level.maxParts }).playable.length);
    }
    return counts.get(level.id);
  };
  const levelButton = (level, index, exact) => {
    const best = store.best(level.id, difficulty);
    const parts = exact ? `${playCount(level)} parts` : `≤ ${Math.min(level.pids.length, level.maxParts) - 1} parts`;
    return h('button', { class: `level${best ? ' done' : ''}`, type: 'button', 'data-level': level.id, onclick: () => play(level) },
      h('b', {}, index != null ? `${index + 1}. ${level.title}` : level.title),
      h('span', {}, level.blurb),
      h('span', { class: 'meta' },
        h('span', { class: `stars${best ? ' got' : ''}` }, best ? '★'.repeat(best.stars) + '☆'.repeat(3 - best.stars) : '☆☆☆'),
        h('span', {}, best ? formatTime(best.timeMs) : parts)));
  };
  let freeBuilt = false;
  function renderMenu() {
    for (const b of diffEl.children) b.setAttribute('aria-checked', String(b.dataset.difficulty === difficulty));
    campaignEl.replaceChildren(...levels.map((l, i) => levelButton(l, i, true)));
    freeBuilt = false;
    renderFree();
  }
  function renderFree() {
    if (freeBuilt) return;
    freeBuilt = true;
    freeEl.replaceChildren(...freePlay(manifest).map((g) => h('section', {},
      h('h3', {}, h('i', { style: { background: g.color } }), g.label),
      h('div', { class: 'levels' }, g.levels.map((l) => levelButton(l, null, false))))));
  }
  function showMenu(open) {
    menu.hidden = !open;
    menuTop.hidden = !(current && game.state === 'playing');
    if (open) {
      renderMenu();
      menu.scrollTop = 0;
      if (game.state === 'idle') orbit.autoRotate = 0.15;
    }
  }

  // ---- playing ----
  function play(level, opts = {}) {
    current = level;
    showMenu(false);
    result.hidden = true;
    game.start(level, { difficulty, ...opts });
    history.replaceState(null, '', `#puzzle?level=${encodeURIComponent(level.id)}&d=${difficulty}&seed=${game.seed}`);
  }

  const renderStats = () => {
    const p = game.progress();
    statPlaced.textContent = `${p.placed}/${p.total}`;
    statTime.textContent = formatTime(p.elapsedMs);
    statMistakes.textContent = `✕ ${p.mistakes}`;
    statMistakes.className = p.mistakes ? 'bad' : '';
  };

  let trayKey = '';
  function renderTray() {
    const loose = game.state === 'playing' ? game.loosePids() : [];
    const ready = new Set(game.rules?.ready ? game.readyPids() : []);
    const key = `${loose.join()}|${[...ready].join()}|${game.held}`;
    if (key === trayKey) return;
    trayKey = key;
    tray.replaceChildren(contextChip, ...loose
      .map((pid) => game.pieces.get(pid))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((pc) => {
        const cls = ['chip', pc.pid === game.held ? 'held' : '', game.rules.ready ? (ready.has(pc.pid) ? 'ready' : 'blocked') : ''].filter(Boolean).join(' ');
        const rgb = pc.color.map((c) => Math.round(c ** (1 / 2.2) * 255)).join(',');
        // tap: find it (pulse + guides); swipe up: pull it out of the tray under the finger
        let start = null;
        let pulled = false;
        return h('button', { class: cls, type: 'button', 'data-pid': pc.pid,
          onpointerdown: (e) => {
            start = { x: e.clientX, y: e.clientY };
            pulled = false;
          },
          onpointermove: (e) => {
            if (!start || pulled) return;
            const dx = e.clientX - start.x, dy = e.clientY - start.y;
            if (dy < -12 && -dy > Math.abs(dx)) {
              pulled = game.beginDrag(pc.pid, e);
              if (pulled) e.currentTarget.releasePointerCapture?.(e.pointerId);
              start = null;
            } else if (Math.abs(dx) > 12) start = null;
          },
          onclick: () => {
            if (pulled) return;
            game.spot(pc.pid);
            game.hold(pc.pid);
          } }, h('i', { style: { background: `rgb(${rgb})` } }), pc.name);
      }));
  }

  game.addEventListener('level', ({ detail }) => {
    titleEl.textContent = `${detail.level.title} · ${DIFFICULTY[game.difficulty].label}`;
    stats.hidden = false;
    dock.hidden = false;
    hintBtn.disabled = false;
    rotateRow.hidden = true;
    contextChip.textContent = CONTEXT_LABEL[game.context];
    trayKey = '';
    renderTray();
    renderStats();
  });
  game.addEventListener('progress', () => {
    renderStats();
    renderTray();
  });
  game.addEventListener('held', ({ detail }) => {
    rotateRow.hidden = !(game.rules?.rotate && detail.pid != null && game.state === 'playing');
    renderTray();
  });
  game.addEventListener('placed', () => {
    sound.snap();
    rotateRow.hidden = !(game.rules?.rotate && game.held != null);
  });
  game.addEventListener('rejected', () => sound.reject());
  game.addEventListener('fit', ({ detail }) => {
    const f = detail.fit;
    fitEl.hidden = !f;
    if (!f) return;
    fitEl.textContent = f.text;
    fitEl.className = `pz-fit ${f.status}`;
    if (f.status === 'ok') sound.tick();
  });
  game.addEventListener('toast', ({ detail }) => shell.toast(detail.text, detail.kind === 'hint' ? 4000 : 2600));
  let resultTimer = 0;
  game.addEventListener('complete', ({ detail }) => {
    renderStats();
    sound.win();
    dock.hidden = true;
    rotateRow.hidden = true;
    hintBtn.disabled = true;
    const better = store.record(detail.level.id, detail.difficulty, detail);
    clearTimeout(resultTimer);
    resultTimer = setTimeout(() => {
      resStars.replaceChildren(...[1, 2, 3].map((i) => h('span', { class: i <= detail.stars ? 'on' : '' }, '★')));
      resStars.setAttribute('aria-label', `${detail.stars} of 3 stars`);
      resTitle.textContent = `${detail.level.title} rebuilt`;
      resDl.replaceChildren(...[['Time', formatTime(detail.timeMs)], ['Mistakes', detail.mistakes], ['Hints', detail.hints], ['Difficulty', DIFFICULTY[detail.difficulty].label]]
        .flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, String(v))]));
      resBest.hidden = !better;
      const i = levels.findIndex((l) => l.id === detail.level.id);
      nextBtn.hidden = i < 0 || i === levels.length - 1;
      result.hidden = false;
    }, 1400);
  });

  // ---- frame ----
  let statT = 0;
  let aspect = ctx.aspect;
  const frame = (dt) => {
    if (Math.abs(ctx.aspect - aspect) > 0.05) {
      aspect = ctx.aspect;
      game.reframe();
    }
    game.update(dt);
    orbit.update(dt, ctx.aspect);
    gl.viewport(0, 0, ctx.width, ctx.height);
    gl.clearColor(0.085, 0.095, 0.11, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    light.uEye = orbit.eye;
    model.draw(orbit, light);
    guides.draw();
    const d = game.dragging;
    if (d && !fitEl.hidden) fitEl.style.transform = `translate(${Math.round(d.pt.x - fitEl.offsetWidth / 2)}px, ${Math.round(d.pt.y - 70)}px)`;
    if (game.state === 'playing' && (statT -= dt) <= 0) {
      statT = 0.25;
      statTime.textContent = formatTime(game.elapsed());
    }
  };
  const running = loop(ctx, frame);
  const idle = window.requestIdleCallback || ((f) => setTimeout(f, 200));
  idle(() => sound.prepare());

  // ---- start: deep link, else the menu ----
  const params = shell.params;
  if (DIFFICULTY[params.get('d')]) difficulty = params.get('d');
  const linked = params.get('level') && findLevel(manifest, params.get('level'));
  if (linked) play(linked, params.has('seed') ? { seed: Number(params.get('seed')) } : {});
  else showMenu(true);

  return {
    game,
    model,
    orbit,
    levels,
    groupLabel,
    play: (id, opts) => play(findLevel(manifest, id), opts),
    get level() {
      return current;
    },
    get placed() {
      return game.progress().placed;
    },
    /** Put the next ready part in (turned upright first); returns its pid or null. */
    solveNext() {
      if (game.state !== 'playing') return null;
      const pid = game.readyPids()[0];
      if (pid == null) return null;
      const pc = game.pieces.get(pid);
      pc.rot = 0;
      pc.qTarget = [0, 0, 0, 1];
      game.tryPlace(pid);
      return pid;
    },
    /** Client px to drag a loose part from, and where to drop it so its centre lands home. */
    dragPlan(pid) {
      const from = game.grabPointOf(pid);
      if (!from) return null;
      const cur = game.screenOf(pid);
      const home = game.screenOf(pid, { home: true });
      return { from, to: { x: from.x + home.x - cur.x, y: from.y + home.y - cur.y } };
    },
    unmount() {
      clearTimeout(resultTimer);
      running.stop();
      orbit.dispose();
      game.dispose();
      model.dispose();
    },
  };
}
