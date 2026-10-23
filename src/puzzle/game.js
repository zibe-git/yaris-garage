// Puzzle scene on the shared CarModel: scatters a level's parts around the ghosted car and lets the player drag them
// back with a finger. A part snaps when its centre is dragged close (on screen) to where it belongs, its
// prerequisites are in place and it is the right way round. Rules live in shared/logic.js (model mm, +x fwd,
// +y left, +z up); everything here is part-table writes (offset, rotation, colour, alpha) plus a little camera work.
import { DIFFICULTY, ROTATIONS, planLevel, scramble, readyParts, attachmentPoints, quarterTurn, mulRot, isEquivalentRotation, rotationSteps, snapRadiusPx, scoreLevel, prettyName, mulberry32 } from '../shared/logic.js';
import { mat4, vec3, quat, hexRGB } from '../gl/math.js';

const GOOD = hexRGB('#3ddc84');
const BAD = hexRGB('#ff3b3b');
const PULSE = hexRGB('#ffd23f');
const GHOST = [0.5, 0.56, 0.66];
const SOLID = [0.1, 0.11, 0.13];
const CONTEXT_MODES = ['ghost', 'solid', 'off'];

// HSL (0..1) → linear RGB
function hsl(h, s, l) {
  const f = (n) => {
    const k = (n + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    return (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))) ** 2.2;
  };
  return [f(0), f(8), f(4)];
}

const rotQuat = (rot) => quat.fromMat3(ROTATIONS[rot]);

export class PuzzleGame extends EventTarget {
  /** model: CarModel, orbit: Orbit on the same canvas, data: { layout, bin } from loadCarData */
  constructor(model, orbit, data) {
    super();
    this.model = model;
    this.orbit = orbit;
    this.layout = data.layout;
    this.bin = data.bin;
    this.canvas = model.ctx.canvas;
    this.context = 'ghost';
    this.pieces = new Map(); // pid → piece
    this.state = 'idle'; // idle | intro | playing | done
    this.time = 0;
    this.dragging = null;
    this.fit = null;
    this.bursts = [];
    this.car = { min: this.layout.bboxMin, max: this.layout.bboxMax };
    this._move = (e) => this.#move(e);
    this._up = (e) => this.#up(e, e.type === 'pointercancel');
    // on window: a drag can also start from a tray chip
    window.addEventListener('pointermove', this._move, { passive: false });
    window.addEventListener('pointerup', this._up);
    window.addEventListener('pointercancel', this._up);
  }

  dispose() {
    window.removeEventListener('pointermove', this._move);
    window.removeEventListener('pointerup', this._up);
    window.removeEventListener('pointercancel', this._up);
  }

  // ----- coordinates: model mm ↔ world metres (car frame, uWorld is identity here) -----

  toWorld(p) {
    const o = this.layout.origin;
    return [(p[1] - o[1]) / 1000, (p[2] - o[2]) / 1000, (p[0] - o[0]) / 1000];
  }
  toModel(w) {
    const o = this.layout.origin;
    return [w[2] * 1000 + o[0], w[0] * 1000 + o[1], w[1] * 1000 + o[2]];
  }
  /** World point → canvas CSS px. */
  project(w) {
    const c = mat4.project(this.orbit.viewProj, w);
    const r = this.canvas.getBoundingClientRect();
    return { x: ((c[0] / c[3] + 1) / 2) * r.width, y: ((1 - c[1] / c[3]) / 2) * r.height, visible: c[3] > 0 };
  }
  #ray(x, y) {
    const r = this.canvas.getBoundingClientRect();
    const nx = (x / r.width) * 2 - 1;
    const ny = 1 - (y / r.height) * 2;
    const inv = mat4.invert(mat4.create(), this.orbit.viewProj);
    const un = (z) => {
      const c = mat4.project(inv, [nx, ny, z]);
      return [c[0] / c[3], c[1] / c[3], c[2] / c[3]];
    };
    const a = un(-1);
    return { o: a, d: vec3.norm(vec3.sub(un(1), a)) };
  }
  #rayPlane(x, y, plane) {
    const { o, d } = this.#ray(x, y);
    const den = vec3.dot(plane.n, d);
    if (Math.abs(den) < 1e-6) return null;
    const t = vec3.dot(plane.n, vec3.sub(plane.p, o)) / den;
    return t > 0 ? vec3.add(o, vec3.scale(d, t)) : null;
  }
  #forward() {
    return vec3.norm(vec3.sub(this.orbit.target, this.orbit.eye));
  }

  // ----- level lifecycle -----

  /** level = { id, title, pids, maxParts } from shared/levels.js */
  start(level, { difficulty = 'normal', seed = (Math.random() * 2 ** 31) | 0 } = {}) {
    this.stop();
    const m = this.model;
    const metas = level.pids.map((pid) => this.layout.parts[m.byPid.get(pid)]);
    const plan = planLevel(metas, this.car, { maxParts: level.maxParts });
    Object.assign(this, { level, plan, seed, difficulty, rules: DIFFICULTY[difficulty], mistakes: 0, hints: 0, startedAt: null, finishedAt: null, hintPid: null, spotPid: null, spotLeft: 0, held: null, dragging: null, fit: null, result: null });
    this.scatter = scramble(plan, mulberry32(seed), { rotate: this.rules.rotate, groundZ: this.layout.bboxMin[2] });
    const inLevel = new Set(level.pids);
    this.connections = this.layout.connections.filter((c) => inLevel.has(c.a) || inLevel.has(c.b));
    let hue = (seed % 997) / 997;
    for (const pid of level.pids) {
      const i = m.byPid.get(pid);
      const meta = this.layout.parts[i];
      const role = pid === plan.anchor ? 'anchor' : plan.playable.includes(pid) ? 'play' : 'auto';
      const base = m.groupColor.get(meta.group) || [0.6, 0.6, 0.6];
      this.pieces.set(pid, {
        pid,
        i,
        meta,
        role,
        name: prettyName(meta.name) || `Part ${pid}`,
        centroid: meta.centroid,
        extent: plan.parts.get(pid).extent,
        offset: [0, 0, 0],
        target: [0, 0, 0],
        rot: 0,
        q: [0, 0, 0, 1],
        qTarget: [0, 0, 0, 1],
        placed: true, // shown assembled during the intro
        visible: true,
        flash: 0,
        flashDelay: 0,
        flashColor: GOOD,
        shake: null,
        waypoint: null,
        base,
        color: role === 'play' ? hsl(hue, 0.62, 0.56) : base,
        prereqs: plan.prereqs.get(pid) || [],
        host: plan.auto.get(pid),
      });
      if (role === 'play') hue = (hue + 0.618034) % 1;
    }
    this.#applyContext();
    for (const pc of this.pieces.values()) {
      m.setPivot(pc.i, pc.centroid);
      m.setColor(pc.i, pc.base, 0);
    }
    this.axis = plan.axis;
    this.orbit.autoRotate = 0;
    this.#frame(this.#box(false), true);
    this.state = 'intro';
    this.introLeft = 1.0;
    this.#emit('level', { level });
    this.#emit('progress');
  }

  /** The whole car back as a ghost-free, assembled model (menu backdrop). */
  stop() {
    const m = this.model;
    m.reset();
    for (let i = 0; i < m.n; i++) m.setColor(i, [0.42, 0.45, 0.5], 0);
    this.pieces.clear();
    this.level = null;
    this.plan = null;
    this.dragging = null;
    this.bursts = [];
    this.state = 'idle';
    this.orbit.enabled = true;
  }

  #scatter() {
    for (const pc of this.pieces.values()) {
      if (pc.role === 'play') {
        const s = this.scatter.get(pc.pid);
        pc.placed = false;
        pc.target = s.offset.slice();
        pc.rot = s.rot;
        pc.qTarget = rotQuat(s.rot);
      } else if (pc.role === 'auto' && pc.host !== this.plan.anchor) {
        pc.placed = false;
        pc.visible = false;
      }
    }
    this.state = 'playing';
    this.#frame(this.#box(true));
    this.#emit('progress');
  }

  #complete() {
    this.state = 'done';
    this.finishedAt = performance.now();
    const result = { level: this.level, difficulty: this.difficulty, timeMs: this.elapsed(), mistakes: this.mistakes, hints: this.hints };
    result.stars = scoreLevel(result);
    this.hintPid = null;
    this.held = null;
    // a green wave from the anchor outwards
    const anchor = this.pieces.get(this.plan.anchor).centroid;
    for (const pc of this.pieces.values()) {
      pc.flash = 1.4;
      pc.flashColor = GOOD;
      pc.flashDelay = (vec3.len(vec3.sub(pc.centroid, anchor)) / this.plan.extent) * 0.8;
    }
    this.#frame(this.#box(false));
    this.orbit.autoRotate = 0.25;
    this.orbit.idle = 10;
    this.result = result;
    this.#emit('progress');
    this.#emit('complete', result);
  }

  // ----- queries (UI and tests) -----

  get placedSet() {
    return new Set([...this.pieces.values()].filter((p) => p.placed).map((p) => p.pid));
  }
  loosePids() {
    return [...this.pieces.values()].filter((p) => p.role === 'play' && !p.placed).map((p) => p.pid);
  }
  readyPids() {
    return this.plan && this.state === 'playing' ? readyParts(this.plan, this.placedSet) : [];
  }
  /** How a part another one attaches to can be seen: 'placed', 'loose', 'context' (rest of the car) or null. */
  partnerState(pid) {
    const pc = this.pieces.get(pid);
    if (pc) return !pc.visible ? null : pc.placed ? 'placed' : pc.role === 'play' ? 'loose' : null;
    return this.context === 'off' || !this.model.byPid.has(pid) ? null : 'context';
  }
  blockersOf(pid) {
    return (this.pieces.get(pid)?.prereqs || []).filter((p) => !this.pieces.get(p).placed);
  }
  progress() {
    const play = [...this.pieces.values()].filter((p) => p.role === 'play');
    return { placed: play.filter((p) => p.placed && this.state !== 'intro').length, total: play.length, mistakes: this.mistakes, hints: this.hints, elapsedMs: this.elapsed() };
  }
  elapsed() {
    if (!this.startedAt) return 0;
    return (this.finishedAt || performance.now()) - this.startedAt;
  }

  /** Model point on a part as it lies now (rotated about its centre, then offset). */
  onPiece(pc, p) {
    return vec3.add(vec3.add(pc.centroid, quat.rotate(pc.q, vec3.sub(p, pc.centroid))), pc.offset);
  }
  /** Canvas CSS px of a part's centre, where it is now or (home: true) where it belongs. */
  screenOf(pid, { home = false } = {}) {
    const pc = this.pieces.get(pid);
    if (!pc) return null;
    return this.project(this.toWorld(home ? pc.centroid : vec3.add(pc.centroid, pc.offset)));
  }

  /** A canvas point that picks this loose part (its centre may be a hole), or null. Used by tests. */
  grabPointOf(pid) {
    const pc = this.pieces.get(pid);
    if (!pc) return null;
    const pts = this.#points(pc);
    const n = pts.length / 3;
    const r = this.canvas.getBoundingClientRect();
    for (let t = 0; t < 40; t++) {
      const k = Math.floor(((t * 0.618034) % 1) * n);
      const p = vec3.lerp([pts[k * 3], pts[k * 3 + 1], pts[k * 3 + 2]], pc.centroid, 0.15);
      const s = this.project(this.toWorld(this.onPiece(pc, p)));
      if (s.x < 4 || s.y < 4 || s.x > r.width - 4 || s.y > r.height - 4 || !s.visible) continue;
      if (this.pickLoose(s.x + r.left, s.y + r.top) === pid) return { x: s.x + r.left, y: s.y + r.top };
    }
    return null;
  }

  // ----- actions -----

  /** Drop a part at its home position as if dragged there; returns { ok, reason, blockers }. */
  tryPlace(pid) {
    const pc = this.pieces.get(pid);
    if (!pc || pc.role !== 'play' || pc.placed || this.state !== 'playing') return { ok: false, reason: 'not-loose' };
    if (!this.startedAt) this.startedAt = performance.now();
    pc.offset = [0, 0, 0];
    return this.#attempt(pc);
  }

  hint() {
    if (this.state !== 'playing') return null;
    // in hard mode a held part that is turned the wrong way gets turning instructions first
    const held = this.pieces.get(this.held);
    if (this.rules.rotate && held && !held.placed && held.rot !== 0 && !this.#rotationOk(held)) {
      const steps = this.rotationSteps(held.pid);
      if (steps?.length) {
        this.hints++;
        this.#toast(`Turn the ${held.name}: ${steps.map((s) => MOVE_LABEL[s]).join(' then ')}`, 'hint');
        this.#emit('progress');
        return held.pid;
      }
    }
    const ready = this.readyPids();
    if (!ready.length) return null;
    // the ready part that unlocks the most others, then the biggest
    const unlocks = (pid) => this.loosePids().filter((q) => this.pieces.get(q).prereqs.includes(pid)).length;
    const pid = ready.sort((a, b) => unlocks(b) - unlocks(a) || this.pieces.get(b).extent - this.pieces.get(a).extent)[0];
    if (this.hintPid !== pid) this.hints++;
    this.hintPid = pid;
    const pc = this.pieces.get(pid);
    this.hold(pid);
    this.#toast(`Try the ${pc.name} — the ring shows where it goes.`, 'hint');
    this.#emit('progress');
    return pid;
  }

  /** Briefly pulse a part so it can be found (tray chip). */
  spot(pid) {
    if (!this.pieces.has(pid)) return;
    this.spotPid = pid;
    this.spotLeft = 1.6;
  }

  cycleContext() {
    this.context = CONTEXT_MODES[(CONTEXT_MODES.indexOf(this.context) + 1) % CONTEXT_MODES.length];
    this.#applyContext();
    this.#emit('held', { pid: this.held });
    return this.context;
  }

  /** Quarter-turn the held part about the model axis closest to the screen's up (yaw), right (pitch) or view (roll) axis. */
  rotateHeld(move) {
    const pc = this.pieces.get(this.held);
    if (!pc || pc.placed || !this.rules?.rotate || this.state !== 'playing') return false;
    const turn = this.#moveTable()[move];
    if (turn == null) return false;
    pc.rot = mulRot(turn, pc.rot);
    pc.qTarget = rotQuat(pc.rot);
    this.#emit('held', { pid: pc.pid });
    return true;
  }

  /** Fewest yaw/pitch/roll presses that turn a part back upright, for the current camera. */
  rotationSteps(pid) {
    const pc = this.pieces.get(pid);
    return pc ? rotationSteps(pc.rot, this.#moveTable()) : null;
  }

  hold(pid) {
    const pc = this.pieces.get(pid);
    if (!pc || pc.role !== 'play' || pc.placed) return;
    this.held = pid;
    this.#emit('held', { pid });
  }

  /** Pegs on the held part and holes where they go: [{ label, partner, peg (model), hole (model) }]. */
  guidePoints() {
    const pc = this.pieces.get(this.held);
    if (!pc || pc.placed || !this.rules?.dots || this.state !== 'playing') return [];
    if (pc.guide?.key !== this.placedSet.size + this.context) {
      const include = this.rules.dots === 'all' ? ['placed', 'context', 'loose'] : ['placed', 'context'];
      let pts = attachmentPoints(pc.pid, this.connections, (pid) => this.partnerState(pid), { include, max: 6, minSpacing: Math.max(40, pc.extent * 0.22) });
      if (!pts.length) pts = [{ partner: null, state: 'home', point: pc.centroid, label: 1 }];
      const partners = [...new Set(pts.map((p) => p.partner))];
      pc.guide = { key: this.placedSet.size + this.context, pts: pts.map((p) => ({ label: p.label, color: partners.indexOf(p.partner), point: p.point })) };
    }
    return pc.guide.pts.map((p) => ({ ...p, peg: this.onPiece(pc, p.point), hole: p.point }));
  }

  // ----- rules -----

  #attempt(pc) {
    const blockers = this.blockersOf(pc.pid);
    if (blockers.length) {
      this.#reject(pc, `Not yet — the ${this.#names(blockers)} must go in first.`, 'order');
      return { ok: false, reason: 'order', blockers };
    }
    if (!this.#rotationOk(pc)) {
      this.#reject(pc, 'Right spot, wrong way round — turn it first.', 'rotation');
      return { ok: false, reason: 'rotation' };
    }
    this.#place(pc);
    return { ok: true };
  }

  // turned so that it looks the same as upright (always true when not turned)
  #rotationOk(pc) {
    if (pc.rot === 0) return true;
    if (pc.rotOk?.rot !== pc.rot) {
      const tol = Math.max(4, pc.extent * 0.03);
      pc.rotOk = { rot: pc.rot, ok: isEquivalentRotation(this.#points(pc), pc.centroid, pc.rot, tol) };
    }
    return pc.rotOk.ok;
  }

  #names(pids) {
    return pids.slice(0, 2).map((p) => this.pieces.get(p).name).join(' and the ');
  }

  #reject(pc, text, reason) {
    this.mistakes++;
    pc.flash = 1;
    pc.flashColor = BAD;
    // shake sideways on screen, then fly back to where it was lying
    const right = vec3.norm(vec3.cross(this.#forward(), [0, 1, 0]));
    const dirModel = [right[2], right[0], right[1]];
    pc.shake = { t: 0.45, base: pc.offset.slice(), dir: dirModel, amp: Math.min(pc.extent * 0.06, this.plan.extent * 0.02) };
    pc.target = this.scatter.get(pc.pid).offset.slice();
    this.#toast(text, 'bad');
    this.#emit('rejected', { pid: pc.pid, reason });
    this.#emit('progress');
  }

  #place(pc) {
    pc.placed = true;
    // come in from just outside along the build axis, then slide home
    pc.waypoint = vec3.scale(this.axis, this.plan.extent * 0.03 + pc.extent * 0.15);
    pc.target = pc.waypoint.slice();
    pc.shake = null;
    pc.rot = 0;
    pc.qTarget = [0, 0, 0, 1];
    pc.flash = 1;
    pc.flashColor = GOOD;
    // weld points light up, and the parts it is fastened to answer with a flash
    const fastened = attachmentPoints(pc.pid, this.connections, (pid) => this.partnerState(pid), { perPartner: 6, max: 24 });
    for (const a of fastened) this.bursts.push({ point: a.point, t: 0, delay: 0.25 + Math.random() * 0.15 });
    for (const a of fastened) {
      const other = this.pieces.get(a.partner);
      if (!other || other.flash > 0) continue;
      other.flash = 0.7;
      other.flashColor = GOOD;
      other.flashDelay = 0.15;
    }
    // small parts fastened to it pop in
    for (const a of this.pieces.values()) {
      if (a.role !== 'auto' || a.host !== pc.pid || a.visible) continue;
      a.visible = true;
      a.placed = true;
      a.offset = vec3.scale(this.axis, this.plan.extent * 0.08);
      a.target = [0, 0, 0];
      a.flash = 1;
      a.flashColor = GOOD;
    }
    if (this.hintPid === pc.pid) this.hintPid = null;
    if (this.held === pc.pid) this.held = null;
    this.#emit('placed', { pid: pc.pid });
    this.#emit('progress');
    if (this.loosePids().length === 0) this.#complete();
  }

  // ----- pointer: Orbit calls grab() first; we keep the drag while it lasts -----

  /** Index-free pick among loose parts only: everything else drops below the pick threshold for one render. */
  pickLoose(x, y) {
    const m = this.model;
    const saved = [];
    for (let i = 0; i < m.n; i++) {
      const a = m.alpha(i);
      const pc = this.pieces.get(m.parts[i].pid);
      if (a >= 0.5 && !(pc && pc.role === 'play' && !pc.placed)) {
        saved.push(i, a);
        m.setAlpha(i, 0.3);
      }
    }
    const i = m.pick(this.orbit, this.light, x, y);
    for (let k = 0; k < saved.length; k += 2) m.setAlpha(saved[k], saved[k + 1]);
    return i >= 0 ? m.parts[i].pid : null;
  }

  /** Orbit's grab hook: true when the pointer starts dragging a loose part (or a drag is already on). */
  grab(e) {
    if (this.dragging) return true;
    if (this.state !== 'playing' || e.button > 0) return false;
    const pc = this.pieces.get(this.pickLoose(e.clientX, e.clientY));
    if (!pc || pc.placed || pc.role !== 'play') return false;
    const r = this.canvas.getBoundingClientRect();
    const pt = { x: e.clientX - r.left, y: e.clientY - r.top };
    const centre = this.toWorld(vec3.add(pc.centroid, pc.offset));
    const plane = { n: this.#forward(), p: centre };
    const hit = this.#rayPlane(pt.x, pt.y, plane);
    if (!hit) return false;
    this.canvas.setPointerCapture?.(e.pointerId);
    pc.shake = null;
    this.dragging = { piece: pc, plane, grab: vec3.sub(hit, centre), heat: 0, pointerId: e.pointerId, from: pt, moved: false, inRange: false, pt };
    if (!this.startedAt) this.startedAt = performance.now();
    this.hold(pc.pid);
    return true;
  }

  /** Start dragging a loose part from outside the 3D view (tray chip): its centre jumps under the finger. */
  beginDrag(pid, e) {
    const pc = this.pieces.get(pid);
    if (this.dragging || !pc || pc.placed || pc.role !== 'play' || this.state !== 'playing') return false;
    const centre = this.toWorld(vec3.add(pc.centroid, pc.offset));
    pc.shake = null;
    const r = this.canvas.getBoundingClientRect();
    const pt = { x: e.clientX - r.left, y: e.clientY - r.top };
    this.dragging = { piece: pc, plane: { n: this.#forward(), p: centre }, grab: [0, 0, 0], heat: 0, pointerId: e.pointerId, from: { x: -1e4, y: -1e4 }, moved: true, inRange: false, pt };
    if (!this.startedAt) this.startedAt = performance.now();
    this.hold(pid);
    this.#move(e);
    return true;
  }

  #move(e) {
    const d = this.dragging;
    if (!d || e.pointerId !== d.pointerId) return;
    e.preventDefault();
    const r = this.canvas.getBoundingClientRect();
    const pt = { x: e.clientX - r.left, y: e.clientY - r.top };
    if (Math.hypot(pt.x - d.from.x, pt.y - d.from.y) > 6) d.moved = true;
    d.pt = pt;
    const hit = this.#rayPlane(pt.x, pt.y, d.plane);
    if (!hit) return;
    const pc = d.piece;
    pc.offset = vec3.sub(this.toModel(vec3.sub(hit, d.grab)), pc.centroid);
    pc.target = pc.offset.slice();
    const s = this.#snapInfo(pc);
    d.heat = Math.min(1, Math.max(0, 1 - (s.dist - s.radius) / (s.radius * 6)));
    d.inRange = s.dist <= s.radius && s.visible;
    this.#updateFit(pc, d.inRange && d.moved);
  }

  // before release: say whether it would fit
  #updateFit(pc, inRange) {
    let fit = null;
    if (inRange) {
      const blockers = this.blockersOf(pc.pid);
      if (blockers.length) fit = { status: 'blocked', text: `Needs the ${this.#names(blockers)} first` };
      else if (!this.#rotationOk(pc)) fit = { status: 'turn', text: 'Turn it first' };
      else fit = { status: 'ok', text: 'Release to fit' };
    }
    if (fit?.status === this.fit?.status) return;
    this.fit = fit;
    this.#emit('fit', { fit });
  }

  #up(e, cancelled) {
    const d = this.dragging;
    if (!d || e.pointerId !== d.pointerId) return;
    this.dragging = null;
    if (this.canvas.hasPointerCapture?.(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
    this.#updateFit(d.piece, false);
    if (!cancelled && d.inRange && d.moved) this.#attempt(d.piece);
  }

  // how far (on screen) a part's centre is from home, and the snap radius there
  #snapInfo(pc) {
    const homeW = this.toWorld(pc.centroid);
    const home = this.project(homeW);
    const cur = this.project(this.toWorld(vec3.add(pc.centroid, pc.offset)));
    const depth = vec3.len(vec3.sub(this.orbit.eye, homeW));
    const pxPerMM = this.canvas.clientHeight / (2 * Math.tan(this.orbit.fov / 2) * depth * 1000);
    return { dist: Math.hypot(home.x - cur.x, home.y - cur.y), radius: snapRadiusPx(pc.extent * pxPerMM, this.difficulty), visible: home.visible, home };
  }

  /** Screen ring for the held / hinted part's home: { x, y, r } or null. */
  homeRing() {
    const pid = this.hintPid ?? (this.rules?.ghost && this.dragging ? this.dragging.piece.pid : null);
    const pc = this.pieces.get(pid);
    if (!pc || pc.placed || this.state !== 'playing') return null;
    const s = this.#snapInfo(pc);
    return { x: s.home.x, y: s.home.y, r: s.radius, ok: this.fit?.status === 'ok' && this.dragging?.piece === pc };
  }

  // ----- rotation helpers -----

  // move name → rotation index for the current camera (world axes mapped to the nearest model axis)
  #moveTable() {
    const f = this.#forward();
    const right = vec3.norm(vec3.cross(f, [0, 1, 0]));
    const up = vec3.cross(right, f);
    const axes = { yaw: up, pitch: right, roll: vec3.scale(f, -1) };
    const out = {};
    for (const [name, w] of Object.entries(axes)) {
      const m = [w[2], w[0], w[1]]; // world → model direction
      const abs = m.map(Math.abs);
      const ax = abs.indexOf(Math.max(...abs));
      const s = Math.sign(m[ax]);
      out[`${name}+`] = quarterTurn(ax, s);
      out[`${name}-`] = quarterTurn(ax, -s);
    }
    return out;
  }

  // model-space vertex sample of a part (≤ 3000 points) from the baked buffers, for symmetry checks and grab points
  #points(pc) {
    if (pc.points) return pc.points;
    const L = this.layout;
    const meta = pc.meta;
    const idx = new Uint32Array(this.bin, L.vertexBytes + meta.first * 4, meta.count);
    let lo = Infinity, hi = -1;
    for (let k = 0; k < idx.length; k++) {
      if (idx[k] < lo) lo = idx[k];
      if (idx[k] > hi) hi = idx[k];
    }
    const u16 = new Uint16Array(this.bin, 0, L.vertexBytes / 2);
    const size = L.bboxMax.map((v, k) => v - L.bboxMin[k]);
    const stride = Math.max(1, Math.ceil((hi - lo + 1) / 3000));
    const out = [];
    for (let v = lo; v <= hi; v += stride) for (let c = 0; c < 3; c++) out.push(L.bboxMin[c] + (u16[v * 6 + c] / 65535) * size[c]);
    pc.points = new Float32Array(out);
    return pc.points;
  }

  // ----- view -----

  #applyContext() {
    const m = this.model;
    for (let i = 0; i < m.n; i++) {
      const pid = m.parts[i].pid;
      if (this.pieces.has(pid)) continue;
      m.setAlpha(i, this.context === 'off' ? 0 : this.context === 'ghost' ? 0.07 : 1);
      m.setColor(i, this.context === 'ghost' ? GHOST : SOLID, 0);
    }
  }

  /** Model-space box of the level: assembled, or (scattered) including where the loose parts float. */
  #box(scattered) {
    const min = this.plan.min.slice();
    const max = this.plan.max.slice();
    if (scattered) {
      for (const pc of this.pieces.values()) {
        if (pc.role !== 'play') continue;
        const c = vec3.add(pc.centroid, pc.target);
        for (let k = 0; k < 3; k++) {
          min[k] = Math.min(min[k], c[k] - pc.extent / 2);
          max[k] = Math.max(max[k], c[k] + pc.extent / 2);
        }
      }
    }
    return { min, max };
  }

  /** Frame the level again (the view changed shape: rotation, split screen). */
  reframe() {
    if (this.plan) this.#frame(this.#box(this.state === 'playing'), false, false);
  }

  // look at a model-space box from outside the build axis, a little above and in front
  #frame(box, immediate = false, turn = true) {
    const c = this.toWorld(box.min.map((v, k) => (v + box.max[k]) / 2));
    const radius = vec3.len(vec3.sub(box.max, box.min)) / 2000;
    const a = this.axis;
    const dm = Math.abs(a[2]) > 0.5 ? vec3.add(a, [0.6, 0.35, 0]) : vec3.add(a, [Math.abs(a[0]) > 0.5 ? 0 : 0.35, Math.abs(a[0]) > 0.5 ? 0.35 : 0, 0.5]);
    const dir = vec3.norm([dm[1], dm[2], dm[0]]);
    const o = this.orbit;
    let yaw = Math.atan2(dir[0], dir[2]);
    yaw += Math.round((o.goal.yaw - yaw) / (2 * Math.PI)) * 2 * Math.PI; // no full spins
    const pitch = Math.asin(Math.max(-0.95, Math.min(0.95, dir[1])));
    // the bounding sphere overestimates a box; leave a little room for the bar and the dock
    const distance = o.fitDistance(radius * 0.85, this.model.ctx.aspect);
    o.minDistance = Math.min(o.minDistance, distance * 0.3);
    o.maxDistance = Math.max(o.maxDistance, distance * 2.5);
    o.frame(turn ? { target: c, distance, yaw, pitch } : { target: c, distance });
    if (immediate) {
      o.yaw = yaw;
      o.pitch = pitch;
      o.distance = distance;
      o.target = c.slice();
    }
  }

  // ----- frame update -----

  update(dt) {
    this.time += dt;
    for (const b of this.bursts) b.t += dt;
    this.bursts = this.bursts.filter((b) => b.t < b.delay + 0.7);
    if (!this.level) return;
    if (this.state === 'intro') {
      this.introLeft -= dt;
      if (this.introLeft <= 0) this.#scatter();
    }
    if (this.spotLeft > 0) {
      this.spotLeft -= dt;
      if (this.spotLeft <= 0) this.spotPid = null;
    }
    const m = this.model;
    const k = 1 - Math.exp(-dt * 9);
    for (const pc of this.pieces.values()) {
      if (pc.shake) {
        pc.shake.t -= dt;
        const sh = pc.shake;
        pc.offset = vec3.add(sh.base, vec3.scale(sh.dir, Math.sin(sh.t * 55) * sh.amp * Math.max(0, sh.t / 0.45)));
        if (sh.t <= 0) pc.shake = null;
      } else if (pc !== this.dragging?.piece) {
        const d = vec3.sub(pc.target, pc.offset);
        if (vec3.dot(d, d) > 0.01) {
          // the last slide home is slower, so the fit reads
          pc.offset = vec3.add(pc.offset, vec3.scale(d, pc.placed && !pc.waypoint ? 1 - Math.exp(-dt * 6) : k));
        } else pc.offset = pc.target.slice();
        if (pc.waypoint && vec3.len(vec3.sub(pc.offset, pc.waypoint)) < this.plan.extent * 0.01) {
          pc.waypoint = null;
          pc.target = [0, 0, 0];
        }
      }
      pc.q = quat.slerp(pc.q, pc.qTarget, k);
      m.setOffset(pc.i, pc.offset[0], pc.offset[1], pc.offset[2], pc.visible ? 1 : 0);
      m.setRotation(pc.i, pc.q);
      this.#shade(pc, dt);
    }
  }

  // colour + highlight feedback
  #shade(pc, dt) {
    const m = this.model;
    let color = pc.placed || pc.role !== 'play' ? pc.base : pc.color;
    let hi = 0;
    if (pc.flashDelay > 0) pc.flashDelay -= dt;
    else if (pc.flash > 0) {
      pc.flash = Math.max(0, pc.flash - dt * 1.6);
      color = vec3.lerp(color, pc.flashColor, Math.min(1, pc.flash) * 0.85);
    }
    const d = this.dragging;
    if (d?.piece === pc) hi = this.rules.glow ? 0.15 + 0.5 * d.heat : 0.15;
    else if (pc.pid === this.hintPid || pc.pid === this.spotPid) color = vec3.lerp(color, PULSE, 0.25 + 0.45 * (0.5 + 0.5 * Math.sin(this.time * 7)));
    else if (pc.pid === this.held && !pc.placed) hi = 0.12;
    m.setColor(pc.i, color, hi);
  }

  #toast(text, kind = 'info') {
    this.#emit('toast', { text, kind });
  }

  #emit(type, detail = {}) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}

export const MOVE_LABEL = { 'yaw+': '⟲ turn', 'yaw-': '⟳ turn', 'pitch+': '⤒ tip', 'pitch-': '⤓ tip', 'roll+': '↺ roll', 'roll-': '↻ roll' };
