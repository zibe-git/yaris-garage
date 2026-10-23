// Puzzle rules, free of Three.js so they run in node tests:
// which parts are playable, the build order, the scrambled layout, rotations, snapping and scoring.
// Model space is the FE model's: mm, +x forward, +y left, +z up. Vectors are [x, y, z] arrays.

// dots: which attachment points are shown for the held part ('all' partners, only 'placed' ones, or none);
// bands: lines from each peg on the part to its hole; ready: mark ready / blocked parts in the tray
export const DIFFICULTY = {
  easy: { label: 'Easy', blurb: 'All attachment points, outline, free hints', snap: 1.5, ghost: true, glow: true, rotate: false, hintCost: 0, dots: 'all', bands: true, ready: true },
  normal: { label: 'Normal', blurb: 'Pegs match the holes they fit, hints cost points', snap: 1, ghost: false, glow: true, rotate: false, hintCost: 1, dots: 'placed', bands: true, ready: false },
  hard: { label: 'Hard', blurb: 'Parts arrive turned, no guides, tight snap', snap: 0.8, ghost: false, glow: false, rotate: true, hintCost: 2, dots: false, bands: false, ready: false },
};

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);

/** Small seeded PRNG so a level can be replayed with the same layout. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(list, rng) {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Geometry summary of a manifest part. weight ≈ visible area (solids have no shell area: use their bbox). */
export function partInfo(p) {
  const size = p.bboxMax.map((v, i) => v - p.bboxMin[i]);
  const boxArea = size[0] * size[1] + size[1] * size[2] + size[0] * size[2];
  return { pid: p.pid, min: p.bboxMin, max: p.bboxMax, size, centroid: p.centroid, extent: len(size), weight: p.areaMM2 > 0 ? p.areaMM2 : boxArea };
}

function boxOf(infos) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const p of infos) for (let i = 0; i < 3; i++) {
    min[i] = Math.min(min[i], p.min[i]);
    max[i] = Math.max(max[i], p.max[i]);
  }
  return { min, max, size: sub(max, min), center: min.map((v, i) => (v + max[i]) / 2) };
}

// gap between two boxes (0 when they touch or overlap)
function boxGap(a, b) {
  let d = 0;
  for (let i = 0; i < 3; i++) d += Math.max(0, a.min[i] - b.max[i], b.min[i] - a.max[i]) ** 2;
  return Math.sqrt(d);
}

/**
 * Plan a level from its manifest parts. car = { min, max } is the whole model's bounding box.
 * - axis: the direction the assembly is built along — thin and pointing away from the car centre
 *   (a door builds outwards along +y, the hood upwards, the front bumper forwards)
 * - anchor: the innermost large part; it starts in place and everything is built onto it
 * - playable: the largest remaining parts (up to maxParts in total); smaller ones are "auto" and pop in with their host
 * - prereqs: which parts must be in place first (see buildOrder)
 */
export function planLevel(parts, car, { maxParts = 18, minExtent = 140 } = {}) {
  const all = parts.map(partInfo);
  if (all.length < 2) throw new Error('a level needs at least two parts');
  const box = boxOf(all);
  const extent = len(box.size);
  // how far out of the car the assembly sits on each axis, divided by how thick it is there
  const off = [0, 1, 2].map((i) => (box.center[i] - (car.min[i] + car.max[i]) / 2) / ((car.max[i] - car.min[i]) / 2 || 1));
  const score = off.map((o, i) => (Math.abs(o) + 0.05) / Math.max(box.size[i] / extent, 1e-3));
  const k = score.indexOf(Math.max(...score));
  let sign = off[k] < -0.05 ? -1 : 1;

  const maxW = Math.max(...all.map((p) => p.weight));
  const depth = (p) => sign * p.centroid[k];
  const anchor = all.filter((p) => p.weight >= 0.1 * maxW).reduce((a, b) => (depth(b) < depth(a) ? b : a));

  const rest = all.filter((p) => p !== anchor).sort((a, b) => b.weight - a.weight);
  const want = Math.min(Math.max(1, maxParts - 1), rest.length);
  let playable = rest.filter((p) => p.extent >= minExtent).slice(0, want);
  if (playable.length < Math.min(2, rest.length)) {
    playable = rest.slice().sort((a, b) => b.extent - a.extent).slice(0, Math.min(2, rest.length));
  }
  const auto = rest.filter((p) => !playable.includes(p));
  const hosts = [anchor, ...playable];
  const autoHost = new Map(auto.map((p) => [p.pid, hosts.reduce((a, b) => (boxGap(b, p) < boxGap(a, p) ? b : a)).pid]));
  // if most of the work lies on the inner side of the anchor, build (and look) from that side instead
  const growth = playable.reduce((s, p) => s + Math.sign(p.centroid[k] - anchor.centroid[k]) * p.weight, 0);
  if (sign * growth < 0) sign = -sign;
  const axis = [0, 0, 0];
  axis[k] = sign;

  return {
    axisIndex: k,
    sign,
    axis,
    center: box.center,
    size: box.size,
    min: box.min,
    max: box.max,
    extent,
    anchor: anchor.pid,
    playable: playable.map((p) => p.pid),
    auto: autoHost,
    prereqs: buildOrder(hosts, anchor, k, sign),
    parts: new Map(all.map((p) => [p.pid, p])),
  };
}

/**
 * Build order: parts are stacked in layers along the axis, starting at the anchor. A part needs every part that
 * sits between it and the anchor and covers enough of its footprint (seen along the axis) — you cannot fit the
 * outer skin before the impact beam under it. Returns pid → direct prerequisites (transitively reduced).
 */
export function buildOrder(parts, anchor, k, sign, { overlap = 0.2, gap = 4 } = {}) {
  const [i, j] = [0, 1, 2].filter((a) => a !== k);
  const rel = (p) => sign * (p.centroid[k] - anchor.centroid[k]);
  const footprint = (p) => Math.max(p.size[i], 1) * Math.max(p.size[j], 1);
  const direct = new Map();
  for (const q of parts) {
    if (q === anchor) continue;
    const rq = rel(q);
    const pre = [];
    for (const p of parts) {
      if (p === q || p === anchor) continue;
      const rp = rel(p);
      if (Math.sign(rp) !== Math.sign(rq) || Math.abs(rp) >= Math.abs(rq) - gap) continue;
      const ox = Math.min(p.max[i], q.max[i]) - Math.max(p.min[i], q.min[i]);
      const oy = Math.min(p.max[j], q.max[j]) - Math.max(p.min[j], q.min[j]);
      if (ox <= 0 || oy <= 0 || ox * oy < overlap * Math.min(footprint(p), footprint(q))) continue;
      pre.push(p.pid);
    }
    direct.set(q.pid, pre);
  }
  // drop prerequisites that are already implied through another one
  const memo = new Map();
  const closure = (pid) => {
    if (memo.has(pid)) return memo.get(pid);
    const out = new Set();
    for (const p of direct.get(pid) || []) {
      out.add(p);
      for (const x of closure(p)) out.add(x);
    }
    memo.set(pid, out);
    return out;
  };
  const reduced = new Map();
  for (const [pid, pre] of direct) reduced.set(pid, pre.filter((p) => !pre.some((r) => r !== p && closure(r).has(p))));
  return reduced;
}

/**
 * Attachment points of a part that the player can see: up to `perPartner` points for each connected part, the
 * visible ones first (placed parts, then the rest of the car), at most `max` in total and `minSpacing` mm apart
 * so they do not pile up on screen, numbered 1…n.
 * partnerState(pid) → 'placed' | 'context' | 'loose' | null (hidden).
 */
export function attachmentPoints(pid, connections, partnerState, { include = ['placed', 'context'], perPartner = 3, max = 9, minSpacing = 0 } = {}) {
  const rank = { placed: 0, context: 1, loose: 2 };
  const found = [];
  for (const c of connections) {
    if (c.a !== pid && c.b !== pid) continue;
    const partner = c.a === pid ? c.b : c.a;
    const state = partnerState(partner);
    if (!state || !include.includes(state)) continue;
    found.push({ partner, state, kind: c.kind, n: c.n, points: c.points.slice(0, perPartner) });
  }
  // visible partners first, then the most strongly attached
  found.sort((x, y) => rank[x.state] - rank[y.state] || y.n - x.n || x.partner - y.partner);
  const out = [];
  const far = (p) => out.every((o) => Math.hypot(o.point[0] - p[0], o.point[1] - p[1], o.point[2] - p[2]) >= minSpacing);
  for (const f of found) {
    for (const point of f.points) if (out.length < max && far(point)) out.push({ ...f, point, label: out.length + 1, points: undefined });
  }
  return out;
}

/** Parts whose prerequisites are all placed. */
export function readyParts(plan, placed) {
  return plan.playable.filter((pid) => !placed.has(pid) && (plan.prereqs.get(pid) || []).every((p) => placed.has(p)));
}

/**
 * Scrambled start: playable parts float on a ring around the assembly, pushed out along the build axis, each
 * given an arc proportional to its size so big panels do not pile up. Returns pid → { offset, rot }.
 */
export function scramble(plan, rng, { rotate = false, groundZ = -Infinity } = {}) {
  const k = plan.axisIndex;
  const [u, v] = [0, 1, 2].filter((a) => a !== k); // v is z whenever z lies in the ring plane
  const S = plan.extent;
  const pieces = shuffle(plan.playable.map((pid) => plan.parts.get(pid)), rng);
  const total = pieces.reduce((s, p) => s + p.extent, 0) || 1;
  const r0 = Math.max(0.5 * Math.max(plan.size[u], plan.size[v]) + 0.12 * S, (total * 0.75) / (2 * Math.PI));
  const out = new Map();
  let cum = 0;
  for (const p of pieces) {
    const theta = (2 * Math.PI * (cum + p.extent / 2)) / total + (rng() - 0.5) * 0.15;
    cum += p.extent;
    const r = r0 + 0.35 * p.extent + rng() * 0.1 * S;
    const target = plan.center.slice();
    target[u] += Math.cos(theta) * r;
    target[v] += Math.sin(theta) * r;
    target[k] += plan.sign * (0.5 * plan.size[k] + (0.25 + 0.15 * rng()) * S);
    const offset = sub(target, p.centroid);
    const rot = rotate ? 1 + Math.floor(rng() * (ROTATIONS.length - 1)) : 0;
    // keep it above the floor
    const below = rot ? p.extent / 2 : p.centroid[2] - p.min[2];
    const lift = groundZ + 10 - (p.centroid[2] + offset[2] - below);
    if (lift > 0) offset[2] += lift;
    out.set(p.pid, { offset, rot });
  }
  return out;
}

// ----- rotations -----

/** The 24 rotations of a cube as row-major 3×3 integer matrices; index 0 is the identity. */
export const ROTATIONS = (() => {
  const out = [];
  for (const perm of [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]]) {
    for (let s = 0; s < 8; s++) {
      const m = new Array(9).fill(0);
      for (let r = 0; r < 3; r++) m[r * 3 + perm[r]] = s & (1 << r) ? -1 : 1;
      const det = m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
      if (det === 1) out.push(m);
    }
  }
  return out;
})();

export const rotIndex = (m) => ROTATIONS.findIndex((r) => r.every((x, i) => x === m[i]));

/** Index of ROTATIONS[a] · ROTATIONS[b] (apply b first). */
export function mulRot(a, b) {
  const A = ROTATIONS[a];
  const B = ROTATIONS[b];
  const m = new Array(9).fill(0);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) for (let x = 0; x < 3; x++) m[r * 3 + c] += A[r * 3 + x] * B[x * 3 + c];
  return rotIndex(m);
}

/** Index of a +90° (dir 1) or −90° (dir −1) turn about model axis 0/1/2. */
export function quarterTurn(axis, dir) {
  const [i, j] = [0, 1, 2].filter((a) => a !== axis);
  const m = new Array(9).fill(0);
  m[axis * 3 + axis] = 1;
  // right-handed: i → j for a positive turn
  m[j * 3 + i] = dir;
  m[i * 3 + j] = -dir;
  return rotIndex(m);
}

export const applyRot = (rot, v) => {
  const m = ROTATIONS[rot];
  return [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];
};

/**
 * Does the part look the same turned by `rot` about its centre? (A wheel turned 90° about its axle does.)
 * points: flat [x, y, z, …] model coordinates; a sample of them is rotated and must land on the cloud.
 */
export function isEquivalentRotation(points, center, rot, tol, samples = 48) {
  if (rot === 0) return true;
  const m = ROTATIONS[rot];
  const n = Math.floor(points.length / 3);
  const tol2 = tol * tol;
  const step = Math.max(1, Math.floor(n / samples));
  for (let s = 0; s < n; s += step) {
    const px = points[s * 3] - center[0];
    const py = points[s * 3 + 1] - center[1];
    const pz = points[s * 3 + 2] - center[2];
    const qx = m[0] * px + m[1] * py + m[2] * pz + center[0];
    const qy = m[3] * px + m[4] * py + m[5] * pz + center[1];
    const qz = m[6] * px + m[7] * py + m[8] * pz + center[2];
    let hit = false;
    for (let t = 0; t < n && !hit; t++) {
      const dx = points[t * 3] - qx;
      const dy = points[t * 3 + 1] - qy;
      const dz = points[t * 3 + 2] - qz;
      hit = dx * dx + dy * dy + dz * dz <= tol2;
    }
    if (!hit) return false;
  }
  return true;
}

/**
 * Shortest sequence of turns from `rot` back to the identity. moves: name → rotation index (each a quarter turn
 * about some model axis, as the current camera maps the yaw/pitch/roll keys).
 */
export function rotationSteps(rot, moves) {
  if (rot === 0) return [];
  const prev = new Map([[rot, null]]);
  const queue = [rot];
  while (queue.length) {
    const cur = queue.shift();
    for (const [name, turn] of Object.entries(moves)) {
      const next = mulRot(turn, cur);
      if (prev.has(next)) continue;
      prev.set(next, [cur, name]);
      if (next === 0) {
        const path = [];
        for (let at = 0; prev.get(at); at = prev.get(at)[0]) path.unshift(prev.get(at)[1]);
        return path;
      }
      queue.push(next);
    }
  }
  return null;
}

// ----- snapping & scoring -----

/** Screen-space snap radius: a part snaps when its centre is dragged this close to where it belongs. */
export const snapRadiusPx = (extentPx, difficulty = 'normal') => Math.min(160, Math.max(24, 0.2 * extentPx)) * DIFFICULTY[difficulty].snap;

export function scoreLevel({ mistakes, hints, difficulty = 'normal' }) {
  const penalty = mistakes + hints * DIFFICULTY[difficulty].hintCost;
  return penalty === 0 ? 3 : penalty <= 3 ? 2 : 1;
}

export function formatTime(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// ----- names -----
// CCSA part names are run-together lower case ("673_doorfrontimpactbarbrktR"). Split them with a word list.

const ABBR = {
  brkt: 'bracket', bkt: 'bracket', brkts: 'brackets', brckt: 'bracket', suprt: 'support', supprt: 'support', sprt: 'support', sup: 'support',
  cnt: 'connector', frt: 'front', fnt: 'front', font: 'front', fron: 'front', dr: 'door', innr: 'inner', axel: 'axle', xmember: 'cross-member',
  wh: 'wheel', apillar: 'A-pillar', bpillar: 'B-pillar', cpillar: 'C-pillar', aarm: 'A-arm', misc: 'misc.', lighgt: 'light', enine: 'engine',
  mouint: 'mount', plagte: 'plate', stip: 'strip', subrame: 'subframe', intern: 'internal', innne: 'inner', bladerim: 'blade rim',
};
const WORDS = new Set([
  ...Object.keys(ABBR),
  ...`door front rear inner outer impact bar bracket support upper lower hinge foam trim frame lock solid spacing tire disk disc hub shock spring
  base rod end hood lift right left bumper plastic center centre fender wheel well seat floor rail panel pillar roof member cross tunnel firewall
  cowl tray engine mount tube block main rubber window windshield housing top bottom side subframe sub internal struct structure long rocker
  extension trunk tail light lights taillight radiator fan blade blades rim cover drum suspension axle arm steel back plate connector cap post
  section fill belt head rest headrest dash dashboard console airbag steering column rack shield large small alternator starter drive oil pan
  transmission upright guide middle beam bracket brackets cushion back recliner track slider adjuster pad pads glass regulator motor handle
  latch strap mat carpet instrument cluster glove box knee bolster duct vent air filter intake manifold exhaust muffler pipe catalytic fuel tank
  battery horn lamp head gear shift lever pedal booster master cylinder caliper knuckle control link stabilizer anti roll spindle bearing joint
  boot tie inner sill crowbar hook tow grille emblem mirror wiper module bag curtain plate plates connectors whwell crush can lid skin hem
  reinforcement reinf extn ext bottom top main tube tubes outer short wide narrow thin thick rr fr lh rh lwr upr ctr assy assembly box`.split(/\s+/),
]);

function segment(word) {
  // dynamic programming: fewest known words, unknown letters cost more than a word
  const n = word.length;
  const best = new Array(n + 1).fill(Infinity);
  const back = new Array(n + 1);
  best[0] = 0;
  for (let i = 0; i < n; i++) {
    if (best[i] === Infinity) continue;
    for (let j = i + 2; j <= Math.min(n, i + 14); j++) {
      if (WORDS.has(word.slice(i, j)) && best[i] + 1 < best[j]) {
        best[j] = best[i] + 1;
        back[j] = [i, true];
      }
    }
    if (best[i] + 3 < best[i + 1]) {
      best[i + 1] = best[i] + 3;
      back[i + 1] = [i, false];
    }
  }
  const tokens = [];
  for (let at = n; at > 0; ) {
    const [from, known] = back[at];
    const t = word.slice(from, at);
    if (!known && tokens.length && !tokens[0].known) tokens[0].text = t + tokens[0].text;
    else tokens.unshift({ text: t, known });
    at = from;
  }
  return tokens.map((t) => (t.known ? ABBR[t.text] || t.text : t.text));
}

/** "673_doorfrontimpactbarbrktR" → "Door front impact bar bracket (R)". */
export function prettyName(raw) {
  let s = String(raw || '').replace(/^\s*\d+[_\-\s]+/, '').trim();
  if (!s) return '';
  let side = '';
  const m = s.match(/^(.*?[a-z0-9])_?(L|R|Left|Right|LEFT|RIGHT)(\d*)$/) || s.match(/^(.*brkt)(l|r)(\d*)$/);
  if (m) {
    side = m[2][0].toUpperCase();
    s = m[1] + m[3];
  }
  const words = [];
  for (const chunk of s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) {
    for (const piece of chunk.split(/(\d+)/).filter(Boolean)) words.push(...(/^\d+$/.test(piece) ? [piece] : segment(piece)));
  }
  let out = words.join(' ').replace(/\s+/g, ' ').trim();
  out = out.charAt(0).toUpperCase() + out.slice(1);
  return side ? `${out} (${side})` : out;
}
