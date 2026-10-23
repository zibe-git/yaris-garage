// Explode: the whole FE model, every one of its 926 parts. Drag to turn, pinch to zoom, slide to explode; a group chip
// shows that group alone (the rest ghosted) and the slider then spreads just that group; tap a part to read about it,
// double-tap to pull it out.
import { h } from '../shell.js';
import { CarModel, loadCarData, defaultLight } from '../gl/model.js';
import { Orbit } from '../gl/orbit.js';
import { loop } from '../gl/gl.js';
import { vec3, hexRGB } from '../gl/math.js';
import { prettyName } from '../shared/logic.js';

export const title = 'Explode';

const COLOR_MODES = ['Group', 'Thickness', 'Mass'];

// thickness / mass → blue … orange ramp
function ramp(t) {
  const stops = [[0.15, 0.35, 0.75], [0.2, 0.7, 0.7], [0.85, 0.8, 0.3], [0.95, 0.45, 0.15]];
  const x = Math.min(0.999, Math.max(0, t)) * (stops.length - 1);
  const i = Math.floor(x);
  return vec3.lerp(stops[i], stops[i + 1], x - i);
}

export async function mount(shell) {
  const { ctx, gl, canvas, hud } = shell;
  shell.setProgress(0, 'Loading the car…');
  const data = await loadCarData((f) => shell.setProgress(f * 0.95, `Loading the car… ${Math.round(f * 100)}%`));
  const model = new CarModel(ctx, data);
  shell.setProgress(1);
  const { parts, groups } = data.layout;
  const light = defaultLight();
  light.uSkyColor = [0.42, 0.45, 0.5];
  light.uHorizonColor = [0.55, 0.57, 0.6];
  light.uGroundColor = [0.22, 0.21, 0.2];
  light.uSunColor = [1.9, 1.85, 1.75];

  // ---- explode state (model mm) ----
  const center = data.layout.bboxMin.map((v, i) => (v + data.layout.bboxMax[i]) / 2);
  const size = vec3.len(vec3.sub(data.layout.bboxMax, data.layout.bboxMin));
  const weight = (p) => Math.max(p.areaMM2 || 0, 1);
  const groupCentre = new Map();
  for (const g of groups) {
    const ps = parts.filter((p) => p.group === g.id);
    if (!ps.length) continue;
    let c = [0, 0, 0], w = 0;
    for (const p of ps) {
      c = vec3.add(c, vec3.scale(p.centroid, weight(p)));
      w += weight(p);
    }
    groupCentre.set(g.id, vec3.scale(c, 1 / w));
  }
  const dirFrom = (pt, c, min) => {
    const d = vec3.sub(pt, c);
    return vec3.len(d) < min ? [0, 0, 1] : vec3.norm(d);
  };
  const st = parts.map((p) => {
    const extent = vec3.len(vec3.sub(p.bboxMax, p.bboxMin));
    return { dir: dirFrom(p.centroid, center, size * 0.03), distance: size * 0.12 + extent * 0.35, extent, pull: 0, pullTarget: 0 };
  });
  const explode = { value: 0, target: 0 };
  let solo = null; // group id shown alone
  let selected = -1;
  let colorMode = 0;

  function applyColors() {
    const thick = parts.map((p) => p.thicknessMM || 0).filter((t) => t > 0).sort((a, b) => a - b);
    const tMax = thick[Math.floor(thick.length * 0.97)] || 3;
    const masses = parts.map((p) => Math.log10(1 + (p.massKg || 0)));
    const mMax = Math.max(...masses);
    parts.forEach((p, i) => {
      const c = colorMode === 0 ? model.groupColor.get(p.group) || [0.6, 0.6, 0.6]
        : colorMode === 1 ? (p.thicknessMM ? ramp(p.thicknessMM / tMax) : [0.35, 0.35, 0.38])
        : ramp(masses[i] / mMax);
      model.setColor(i, c);
    });
  }

  function applyVisibility() {
    parts.forEach((p, i) => model.setAlpha(i, !solo || p.group === solo ? 1 : 0.06));
  }

  function select(i) {
    if (selected >= 0) model.setHighlight(selected, 0);
    selected = i;
    if (i >= 0) model.setHighlight(i, 0.55);
    renderSheet();
  }

  // ---- UI ----
  const slider = h('input', { class: 'range', type: 'range', min: 0, max: 1, step: 0.001, value: 0, 'aria-label': 'Explode' });
  // zoom out as things spread so the exploded set stays on screen
  let baseDistance = 8;
  const fitExplode = () => orbit.frame({ distance: baseDistance * (1 + (solo ? 0.6 : 0.4) * explode.target) });
  // the bar and the dock cover the top and bottom: centre the car in the space between them
  const free = () => {
    const H = canvas.clientHeight || 1;
    const top = 56;
    const bottom = dock.offsetHeight;
    orbit.shiftY = (bottom - top) / H;
    return Math.max(0.3, (H - top - bottom) / H);
  };
  slider.addEventListener('input', () => {
    explode.target = Number(slider.value);
    fitExplode();
  });
  const chipFor = new Map();
  const allChip = h('button', { class: 'chip solo', type: 'button', onclick: () => setSolo(null) }, 'All parts');
  const chips = h('div', { class: 'chips', role: 'toolbar', 'aria-label': 'Groups' }, allChip,
    groups.filter((g) => groupCentre.has(g.id)).map((g) => {
      const b = h('button', { class: 'chip', type: 'button', onclick: () => setSolo(solo === g.id ? null : g.id) }, h('i', { style: { background: g.color } }), g.label);
      chipFor.set(g.id, b);
      return b;
    }));
  const dock = h('div', { class: 'dock' }, chips, h('div', { class: 'row' }, h('span', { class: 'label' }, 'Explode'), slider));
  const sheetTitle = h('h2');
  const sheetSub = h('p', { class: 'sub' });
  const sheetDl = h('dl');
  const pullBtn = h('button', { class: 'btn', type: 'button', onclick: () => togglePull(selected) }, 'Pull out');
  const soloBtn = h('button', { class: 'btn', type: 'button', onclick: () => setSolo(solo === parts[selected].group ? null : parts[selected].group) }, 'Show group');
  const sheet = h('section', { class: 'sheet', hidden: true, 'aria-live': 'polite' },
    sheetTitle, sheetSub, sheetDl,
    h('div', { class: 'row' }, pullBtn, soloBtn, h('button', { class: 'btn', type: 'button', style: { marginLeft: 'auto' }, onclick: () => select(-1) }, 'Close')));
  hud.append(dock, sheet);

  const modeBtn = shell.button(`🎨 ${COLOR_MODES[0]}`, () => {
    colorMode = (colorMode + 1) % COLOR_MODES.length;
    modeBtn.textContent = `🎨 ${COLOR_MODES[colorMode]}`;
    applyColors();
    if (selected >= 0) model.setHighlight(selected, 0.55);
  }, { 'aria-label': 'Colour by' });
  shell.button('⟲', () => {
    setSolo(null);
    select(-1);
    explode.target = 0;
    slider.value = 0;
    st.forEach((s) => (s.pullTarget = 0));
    baseDistance = homeDistance();
    orbit.frame({ target: [0, 0.75, 0], distance: baseDistance, yaw: 0.8, pitch: 0.3 });
  }, { 'aria-label': 'Reset view' });

  function setSolo(id) {
    solo = id;
    allChip.classList.toggle('solo', !id);
    for (const [gid, b] of chipFor) b.classList.toggle('solo', gid === id);
    applyVisibility();
    explode.target = Number(slider.value);
    if (id) {
      const c = model.toWorld(groupCentre.get(id));
      const ps = parts.filter((p) => p.group === id);
      const ext = Math.max(...ps.map((p) => vec3.len(vec3.sub(p.bboxMax, p.centroid)) + vec3.len(vec3.sub(p.centroid, groupCentre.get(id)))));
      baseDistance = Math.max(1.2, orbit.fitDistance((ext / 1000) * 0.9, ctx.aspect, free()));
      orbit.frame({ target: c });
      chipFor.get(id)?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
    } else {
      baseDistance = homeDistance();
      orbit.frame({ target: [0, 0.75, 0] });
    }
    fitExplode();
    if (selected >= 0 && solo && parts[selected].group !== solo) select(-1);
    renderSheet();
  }

  function togglePull(i) {
    if (i < 0) return;
    st[i].pullTarget = st[i].pullTarget > 0.5 ? 0 : 1;
    renderSheet();
  }

  function renderSheet() {
    sheet.hidden = selected < 0;
    if (selected < 0) return;
    const p = parts[selected];
    const g = groups.find((x) => x.id === p.group);
    sheetTitle.textContent = prettyName(p.name);
    sheetSub.textContent = [g?.label, p.assembly].filter(Boolean).join(' · ');
    const conn = data.layout.connections.filter((c) => c.a === p.pid || c.b === p.pid);
    const rows = [
      ['Mass', p.massKg ? `${p.massKg >= 1 ? p.massKg.toFixed(2) : (p.massKg * 1000).toFixed(0) + ' g'}${p.massKg >= 1 ? ' kg' : ''}` : '—'],
      [p.kind === 'solid' ? 'Volume' : 'Sheet', p.thicknessMM ? `${p.thicknessMM.toFixed(2)} mm` : p.volumeMM3 ? `${(p.volumeMM3 / 1000).toFixed(0)} cm³` : '—'],
      ['Material', (p.materialType || '—').replace(/^MAT_/, '').replace(/_/g, ' ').toLowerCase()],
      ['Joined to', conn.length ? `${conn.length} part${conn.length > 1 ? 's' : ''} (${[...new Set(conn.map((c) => c.kind))].join(', ')})` : '—'],
      ['Part id', String(p.pid)],
    ];
    sheetDl.replaceChildren(...rows.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]));
    pullBtn.textContent = st[selected].pullTarget > 0.5 ? 'Put back' : 'Pull out';
    soloBtn.textContent = solo === p.group ? 'Show all' : 'Show group';
  }

  // ---- camera + input ----
  // whole car in view (with room to explode) whatever the screen shape
  const homeDistance = () => Math.min(16, orbit.fitDistance(2.4, ctx.aspect, free()));
  const orbit = new Orbit(canvas, {
    target: [0, 0.75, 0], yaw: 0.8, pitch: 0.3, distance: 8, minDistance: 0.6, maxDistance: 22,
    onTap: (x, y) => model.pickAsync(orbit, light, x, y).then(select),
    onDoubleTap: (x, y) => model.pickAsync(orbit, light, x, y).then((i) => {
      if (i >= 0) {
        select(i);
        togglePull(i);
      }
    }),
  });
  orbit.autoRotate = 0.12;
  baseDistance = homeDistance();
  orbit.frame({ distance: baseDistance });
  orbit.distance = orbit.goal.distance;

  applyColors();
  applyVisibility();

  // ---- frame ----
  const k = (dt) => 1 - Math.exp(-dt * 7);
  let needOffsets = true;
  const frame = (dt) => {
    let moving = false;
    const step = (s, key = 'value', tgt = 'target') => {
      const d = s[tgt] - s[key];
      if (Math.abs(d) < 1e-4) s[key] = s[tgt];
      else {
        s[key] += d * k(dt);
        moving = true;
      }
    };
    step(explode);
    for (const s of st) step(s, 'pull', 'pullTarget');
    if (moving || needOffsets) {
      needOffsets = false;
      const e = explode.value;
      parts.forEach((p, i) => {
        let o = [0, 0, 0];
        const gc = groupCentre.get(p.group);
        if (e && gc) {
          if (!solo) o = vec3.add(vec3.scale(vec3.sub(gc, center), e * 1.2), vec3.scale(vec3.sub(p.centroid, gc), e * 0.6));
          else if (p.group === solo) {
            const d = vec3.sub(p.centroid, gc);
            const l = vec3.len(d);
            o = vec3.add(vec3.scale(d, e * 0.9), l > 1e-6 ? vec3.scale(d, (e * st[i].extent * 0.3) / l) : vec3.scale(st[i].dir, e * st[i].extent * 0.3));
          }
        }
        if (st[i].pull) o = vec3.add(o, vec3.scale(st[i].dir, st[i].pull * st[i].distance));
        model.setOffset(i, o[0], o[1], o[2]);
      });
    }
    orbit.update(dt, ctx.aspect);
    gl.viewport(0, 0, ctx.width, ctx.height);
    gl.clearColor(0.085, 0.095, 0.11, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    light.uEye = orbit.eye;
    model.draw(orbit, light);
  };
  const running = loop(ctx, frame);
  // re-frame after rotating the phone
  let lastAspect = ctx.aspect;
  const onResize = () => {
    if (Math.abs(ctx.aspect - lastAspect) < 0.05) return;
    lastAspect = ctx.aspect;
    setSolo(solo);
  };
  const ro = new ResizeObserver(() => requestAnimationFrame(onResize));
  ro.observe(canvas);

  return {
    model,
    orbit,
    setExplode(v) {
      slider.value = v;
      explode.target = v;
      fitExplode();
    },
    setSolo,
    select,
    unmount() {
      ro.disconnect();
      running.stop();
      orbit.dispose();
      model.dispose();
    },
  };
}
