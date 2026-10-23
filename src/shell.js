// App shell shared by the four apps: full-screen canvas + WebGL2 context, top bar with back button, an overlay layer
// for the app's controls, a loading bar and toasts. An app module exports { title, mount(shell) → { unmount } }.
import './ui.css';
import { createGL } from './gl/gl.js';

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

export async function openShell(container, name, app) {
  const canvas = h('canvas', { class: 'view', 'aria-label': `${app.title} 3D view`, role: 'img' });
  const actions = h('div', { class: 'bar-actions' });
  const bar = h('header', { class: 'bar' },
    h('a', { class: 'icon-btn back', href: '#', 'aria-label': 'Back to all apps' }, '‹'),
    h('h1', {}, app.title),
    actions);
  const hud = h('div', { class: 'hud' });
  const label = h('span', {}, 'Loading…');
  const fill = h('i');
  const loading = h('div', { class: 'loading', role: 'status' }, h('div', { class: 'progress' }, fill), label);
  const toastEl = h('div', { class: 'toast', role: 'status', 'aria-live': 'polite' });
  const root = h('div', { class: `shell app-${name}` }, canvas, hud, bar, loading, toastEl);
  container.replaceChildren(root);
  document.title = `${app.title} · Yaris Garage`;

  const ctx = createGL(canvas);
  let toastTimer = 0;
  const shell = {
    root,
    canvas,
    ctx,
    gl: ctx.gl,
    hud,
    actions,
    params: new URLSearchParams(location.hash.split('?')[1] || ''),
    setProgress(f, text) {
      loading.hidden = f >= 1;
      fill.style.transform = `scaleX(${Math.max(0, Math.min(1, f))})`;
      if (text) label.textContent = text;
    },
    toast(text, ms = 1600) {
      toastEl.textContent = text;
      toastEl.classList.add('on');
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => toastEl.classList.remove('on'), ms);
    },
    button(text, onclick, attrs = {}) {
      const b = h('button', { class: 'icon-btn', type: 'button', onclick, ...attrs }, text);
      actions.append(b);
      return b;
    },
  };
  let instance;
  try {
    instance = await app.mount(shell);
  } catch (e) {
    clearTimeout(toastTimer);
    ctx.destroy();
    root.remove();
    throw e;
  }
  window.app = instance; // tests / debugging
  return {
    unmount() {
      clearTimeout(toastTimer);
      instance?.unmount?.();
      ctx.destroy();
      root.remove(); // only our own DOM: a newer app may already be in the container
      if (window.app === instance) delete window.app;
    },
  };
}
