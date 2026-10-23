// Streaming parser for the subset of the LS-DYNA keyword format needed to rebuild part geometry.
//
// Parsed:   *NODE, *ELEMENT_SHELL[_opts], *ELEMENT_SOLID[_opts], *ELEMENT_TSHELL, *ELEMENT_BEAM (counted only),
//           *PART[_opts], *SECTION_SHELL, *SECTION_SOLID, *MAT_* (id, density, modulus), *INCLUDE, *INCLUDE_PATH,
//           *KEYWORD (long / i10 flags), *END.
//           Connections between parts (for the puzzle's attachment points): *SET_NODE_LIST, *CONSTRAINED_SPOTWELD,
//           *CONSTRAINED_NODAL_RIGID_BODY, *CONSTRAINED_EXTRA_NODES_SET, *CONSTRAINED_JOINT_*, beam end nodes.
// Skipped:  everything else (contacts, loads, curves, other sets ...).
//
// Card formats: fixed width (normal, i10 "%", long "+") and comma-separated free format.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { Growable } from './growable.mjs';

const SKIP = { line() {} };

export class KeywordModel {
  constructor() {
    this.nodeIds = new Growable(Int32Array, 1 << 16);
    this.nodeXYZ = new Growable(Float64Array, 3 << 16);
    this.parts = new Map(); // pid -> { pid, name, secid, mid, keyword }
    this.sections = new Map(); // secid -> { secid, kind, elform, thickness, title }
    this.materials = new Map(); // mid -> { mid, type, title, density, modulus }
    this.elements = new Map(); // pid -> { shell: Growable(4/elem), solid: Growable(8/elem), beams, shellIds, solidIds }
    this.nodeSets = new Map(); // sid -> node ids
    this.links = []; // { kind: 'weld' | 'bolt' | 'joint' | 'beam', nodes?: ids, nsid? } — nodes tied together
    this.extraNodes = []; // { pid, nsid } — node sets fastened to a (rigid) part
    this.files = [];
    this.warnings = [];
    this.keywordCounts = new Map();
  }

  elemsOf(pid) {
    let e = this.elements.get(pid);
    if (!e) {
      e = { shell: new Growable(Int32Array, 64), solid: new Growable(Int32Array, 64), beams: 0 };
      this.elements.set(pid, e);
    }
    return e;
  }

  warn(msg) {
    if (this.warnings.length < 200) this.warnings.push(msg);
  }
}

// ---------- field helpers ----------

export function splitFields(line, widths) {
  if (line.includes(',')) return line.split(',').map((s) => s.trim());
  const out = [];
  let pos = 0;
  for (const w of widths) {
    out.push(line.slice(pos, pos + w).trim());
    pos += w;
  }
  return out;
}

export function toInt(s) {
  if (!s) return 0;
  const v = parseInt(s, 10);
  return Number.isFinite(v) ? v : 0;
}

export function toFloat(s) {
  if (!s) return 0;
  const v = parseFloat(s.replace(/[dD]/, 'e'));
  return Number.isFinite(v) ? v : NaN;
}

const repeat = (w, n) => Array(n).fill(w);

// ---------- keyword handlers ----------

function nodeHandler(model, fmt) {
  const widths = fmt === 'long' ? [20, 20, 20, 20] : fmt === 'i10' ? [10, 16, 16, 16] : [8, 16, 16, 16];
  return {
    line(l) {
      const f = splitFields(l, widths);
      const id = toInt(f[0]);
      if (!id) return;
      model.nodeIds.push(id);
      model.nodeXYZ.pushMany(toFloat(f[1]) || 0, toFloat(f[2]) || 0, toFloat(f[3]) || 0);
    },
  };
}

function intWidth(fmt) {
  return fmt === 'long' ? 20 : fmt === 'i10' ? 10 : 8;
}

function shellHandler(model, fmt, opts) {
  if (opts.includes('COMPOSITE')) {
    model.warn('*ELEMENT_SHELL_COMPOSITE not supported, skipped');
    return SKIP;
  }
  const widths = repeat(intWidth(fmt), 10);
  let extra = 0;
  if (opts.some((o) => ['THICKNESS', 'BETA', 'MCID'].includes(o))) extra++;
  if (opts.includes('OFFSET')) extra++;
  if (opts.includes('DOF')) extra++;
  let skip = 0;
  return {
    line(l) {
      if (skip > 0) {
        skip--;
        return;
      }
      const f = splitFields(l, widths);
      const pid = toInt(f[1]);
      const n1 = toInt(f[2]);
      const n2 = toInt(f[3]);
      const n3 = toInt(f[4]);
      const n4 = toInt(f[5]) || n3;
      if (pid && n1 && n2 && n3) model.elemsOf(pid).shell.pushMany(n1, n2, n3, n4);
      skip = extra;
    },
  };
}

function solidHandler(model, fmt, opts) {
  const w = intWidth(fmt);
  const widths = repeat(w, 10);
  let extra = 0;
  if (opts.includes('ORTHO')) extra += 2;
  if (opts.includes('DOF')) extra++;
  if (opts.includes('BETA')) extra++;
  let skip = 0;
  let pendingPid = 0;
  const push = (pid, nodes) => {
    if (!pid || !nodes[0]) return;
    // fill unused trailing node slots by repeating the last node (degenerate hexa convention)
    for (let i = 1; i < 8; i++) if (!nodes[i]) nodes[i] = nodes[i - 1];
    model.elemsOf(pid).solid.pushMany(...nodes.slice(0, 8));
  };
  return {
    line(l) {
      if (skip > 0) {
        skip--;
        return;
      }
      const f = splitFields(l, widths);
      if (pendingPid) {
        // second card of the two-card format: n1..n10
        push(pendingPid, f.slice(0, 8).map(toInt));
        pendingPid = 0;
        skip = extra;
        return;
      }
      const pid = toInt(f[1]);
      const nodes = f.slice(2, 10).map(toInt);
      if (nodes.every((n) => !n)) {
        pendingPid = pid; // node card follows
        return;
      }
      push(pid, nodes);
      skip = extra;
    },
  };
}

function beamHandler(model, fmt, opts) {
  // Beams (spot welds, bars) are counted per part but not rendered; their end nodes become links.
  let extra = 0;
  for (const o of ['THICKNESS', 'SCALAR', 'SCALR', 'SECTION', 'PID', 'OFFSET', 'ORIENTATION']) if (opts.includes(o)) extra++;
  const widths = repeat(intWidth(fmt), 4);
  let skip = 0;
  return {
    line(l) {
      if (skip > 0) {
        skip--;
        return;
      }
      const f = splitFields(l, widths);
      const pid = toInt(f[1]);
      if (pid) model.elemsOf(pid).beams++;
      const n1 = toInt(f[2]);
      const n2 = toInt(f[3]);
      if (n1 && n2) model.links.push({ kind: 'beam', nodes: [n1, n2] });
      skip = extra;
    },
  };
}

function partHandler(model, fmt, opts, keyword) {
  const widths = repeat(fmt === 'long' ? 20 : 10, 8);
  const composite = opts.includes('COMPOSITE');
  let state = 'title';
  let title = '';
  let skip = 0;
  let inertiaPending = false;
  return {
    line(l) {
      if (skip > 0) {
        skip--;
        if (skip === 0 && inertiaPending) inertiaPending = false;
        return;
      }
      if (state === 'title') {
        title = l.trim();
        state = 'id';
        return;
      }
      if (state === 'done') return; // PART_COMPOSITE: remaining integration cards
      const f = splitFields(l, widths);
      const pid = toInt(f[0]);
      if (pid) {
        model.parts.set(pid, { pid, name: title, secid: toInt(f[1]), mid: toInt(f[2]), keyword });
      }
      if (composite) {
        state = 'done';
        return;
      }
      state = 'title';
      if (opts.includes('INERTIA')) skip += 3; // (+1 local CS card when IRCS=1, rare; not handled)
      if (opts.includes('CONTACT')) skip += 1;
      if (opts.includes('PRINT')) skip += 1;
      if (opts.includes('ATTACHMENT') || opts.includes('ATTACHMENT_NODES')) skip += 1;
    },
  };
}

function sectionShellHandler(model, fmt, opts) {
  const widths = repeat(fmt === 'long' ? 20 : 10, 8);
  const hasTitle = opts.includes('TITLE');
  let state = hasTitle ? 'title' : 'card1';
  let cur = null;
  let title = '';
  let skip = 0;
  return {
    line(l) {
      if (skip > 0) {
        skip--;
        if (skip === 0) state = hasTitle ? 'title' : 'card1';
        return;
      }
      if (state === 'title') {
        title = l.trim();
        state = 'card1';
        return;
      }
      const f = splitFields(l, widths);
      if (state === 'card1') {
        cur = { secid: toInt(f[0]), kind: 'shell', elform: toInt(f[1]), nip: toInt(f[3]), icomp: toInt(f[6]), title };
        state = 'card2';
        return;
      }
      // card2: t1..t4
      const t = [f[0], f[1], f[2], f[3]].map(toFloat).filter((v) => Number.isFinite(v) && v > 0);
      if (l.includes('&')) model.warn(`*SECTION_SHELL ${cur.secid}: parameter reference in thickness`);
      cur.thickness = t.length ? t.reduce((a, b) => a + b, 0) / t.length : null;
      model.sections.set(cur.secid, cur);
      if (cur.icomp === 1 && cur.nip > 0) {
        skip = Math.ceil(cur.nip / 8);
      } else {
        state = hasTitle ? 'title' : 'card1';
      }
    },
  };
}

function sectionSolidHandler(model, fmt, opts) {
  const widths = repeat(fmt === 'long' ? 20 : 10, 3);
  const hasTitle = opts.includes('TITLE');
  let state = hasTitle ? 'title' : 'card1';
  let title = '';
  return {
    line(l) {
      if (state === 'title') {
        title = l.trim();
        state = 'card1';
        return;
      }
      const f = splitFields(l, widths);
      const secid = toInt(f[0]);
      if (secid) model.sections.set(secid, { secid, kind: 'solid', elform: toInt(f[1]), thickness: null, title });
      state = hasTitle ? 'title' : 'card1';
    },
  };
}

function materialHandler(model, fmt, name) {
  const hasTitle = name.endsWith('_TITLE');
  const type = hasTitle ? name.slice(0, -'_TITLE'.length) : name;
  const widths = repeat(fmt === 'long' ? 20 : 10, 3);
  let state = hasTitle ? 'title' : 'card1';
  let title = '';
  return {
    line(l) {
      if (state === 'title') {
        title = l.trim();
        state = 'card1';
        return;
      }
      if (state !== 'card1') return;
      const f = splitFields(l, widths);
      const mid = toInt(f[0]);
      if (mid) model.materials.set(mid, { mid, type, title, density: toFloat(f[1]), modulus: toFloat(f[2]) });
      state = 'done';
    },
  };
}

// set and constraint cards use 10-character fields (20 in long format), unlike element cards
const cardWidth = (fmt) => (fmt === 'long' ? 20 : 10);

function setNodeListHandler(model, fmt, opts) {
  const w = cardWidth(fmt);
  let state = opts.includes('TITLE') ? 'title' : 'card1';
  let nodes = null;
  return {
    line(l) {
      if (state === 'title') {
        state = 'card1';
        return;
      }
      const f = splitFields(l, repeat(w, 8));
      if (state === 'card1') {
        nodes = [];
        model.nodeSets.set(toInt(f[0]), nodes);
        state = 'nodes';
        return;
      }
      for (const v of f) if (toInt(v)) nodes.push(toInt(v));
    },
  };
}

// one card per entry: pick fields by position
function cardHandler(fmt, fields, fn, { idCard = false } = {}) {
  const w = cardWidth(fmt);
  let expectId = idCard;
  return {
    line(l) {
      if (expectId) {
        expectId = false;
        return;
      }
      const f = splitFields(l, repeat(w, 8)).map(toInt);
      fn(fields.map((i) => f[i]));
      expectId = idCard;
    },
  };
}

function constraintHandler(model, fmt, name) {
  if (name === 'CONSTRAINED_SPOTWELD') {
    return cardHandler(fmt, [0, 1], ([a, b]) => a && b && model.links.push({ kind: 'weld', nodes: [a, b] }));
  }
  if (name === 'CONSTRAINED_NODAL_RIGID_BODY') {
    return cardHandler(fmt, [2], ([nsid]) => nsid && model.links.push({ kind: 'bolt', nsid }));
  }
  if (name === 'CONSTRAINED_EXTRA_NODES_SET') {
    return cardHandler(fmt, [0, 1], ([pid, nsid]) => pid && nsid && model.extraNodes.push({ pid, nsid }));
  }
  // revolute / spherical / translational / cylindrical joints: n1..n6 pairs of coincident nodes
  if (/^CONSTRAINED_JOINT_(REVOLUTE|SPHERICAL|TRANSLATIONAL|CYLINDRICAL|UNIVERSAL|PLANAR)(_ID)?$/.test(name)) {
    return cardHandler(fmt, [0, 1, 2, 3, 4, 5], (n) => {
      const nodes = n.filter(Boolean);
      if (nodes.length >= 2) model.links.push({ kind: 'joint', nodes });
    }, { idCard: name.endsWith('_ID') });
  }
  return SKIP;
}

function includeHandler(queue, opts, model) {
  const isPath = opts.includes('PATH');
  const transform = opts.includes('TRANSFORM');
  let first = true;
  let pending = '';
  return {
    line(l) {
      if (transform && !first) return; // transformation cards
      let s = l.trim();
      if (!s) return;
      // long file names may be continued with a trailing " +"
      if (s.endsWith(' +')) {
        pending += s.slice(0, -2);
        return;
      }
      s = pending + s;
      pending = '';
      if (transform) {
        model.warn(`*INCLUDE_TRANSFORM ${s}: transformation ignored`);
        first = false;
      }
      queue.push({ name: s, isPath });
    },
  };
}

// ---------- driver ----------

function parseKeywordLine(line) {
  const raw = line.trim();
  const tokens = raw.slice(1).split(/\s+/);
  const name = tokens[0].toUpperCase();
  let fmt = 'normal';
  if (tokens.includes('+')) fmt = 'long';
  else if (tokens.includes('%')) fmt = 'i10';
  else if (name.endsWith('+')) fmt = 'long';
  else if (name.endsWith('%')) fmt = 'i10';
  return { name: name.replace(/[+%]$/, ''), fmt, rest: tokens.slice(1).join(' ') };
}

function handlerFor(model, kw, fmt, includeQueue) {
  const { name } = kw;
  const opts = name.split('_').slice(1);
  if (name === 'NODE') return nodeHandler(model, fmt);
  if (name.startsWith('ELEMENT_SHELL')) return shellHandler(model, fmt, opts.slice(1));
  if (name.startsWith('ELEMENT_SOLID') || name.startsWith('ELEMENT_TSHELL')) return solidHandler(model, fmt, opts.slice(1));
  if (name.startsWith('ELEMENT_BEAM')) return beamHandler(model, fmt, opts.slice(1));
  if (name === 'PART' || name.startsWith('PART_')) {
    if (['PART_MOVE', 'PART_DUPLICATE', 'PART_MODES', 'PART_SENSOR', 'PART_ADAPTIVE_FAILURE', 'PART_STACKED_ELEMENTS'].some((p) => name.startsWith(p))) {
      return SKIP;
    }
    return partHandler(model, fmt, opts, name);
  }
  if (name.startsWith('SECTION_SHELL')) return sectionShellHandler(model, fmt, opts.slice(1));
  if (name.startsWith('SECTION_SOLID')) return sectionSolidHandler(model, fmt, opts.slice(1));
  if (name.startsWith('MAT_') && !/^MAT_(ADD|THERMAL|NONLOCAL)/.test(name)) return materialHandler(model, fmt, name);
  if (name.startsWith('INCLUDE')) return includeHandler(includeQueue, opts, model);
  if (name.startsWith('SET_NODE_LIST')) return setNodeListHandler(model, fmt, opts.slice(2));
  if (name.startsWith('CONSTRAINED_')) return constraintHandler(model, fmt, name);
  return SKIP;
}

function resolveFile(name, baseDir, searchDirs) {
  const candidates = path.isAbsolute(name) ? [name] : [baseDir, ...searchDirs].map((d) => path.join(d, name));
  for (const c of candidates) if (fs.existsSync(c)) return c;
  // case-insensitive fallback (models authored on Windows)
  for (const c of candidates) {
    const dir = path.dirname(c);
    if (!fs.existsSync(dir)) continue;
    const hit = fs.readdirSync(dir).find((f) => f.toLowerCase() === path.basename(c).toLowerCase());
    if (hit) return path.join(dir, hit);
  }
  return null;
}

async function parseOne(model, file, searchDirs, seen) {
  const includeQueue = [];
  model.files.push(file);
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'latin1' }), crlfDelay: Infinity });
  let handler = SKIP;
  let fmt = 'normal';
  let globalFmt = 'normal';
  for await (const line of rl) {
    const c = line.charCodeAt(0);
    if (c === 36 /* $ */) continue;
    if (c === 42 /* * */) {
      const kw = parseKeywordLine(line);
      model.keywordCounts.set(kw.name, (model.keywordCounts.get(kw.name) || 0) + 1);
      if (kw.name === 'END') break;
      if (kw.name === 'KEYWORD') {
        if (/long\s*=\s*[ys]/i.test(kw.rest)) globalFmt = 'long';
        if (/i10\s*=\s*y/i.test(kw.rest)) globalFmt = 'i10';
        handler = SKIP;
        continue;
      }
      fmt = kw.fmt !== 'normal' ? kw.fmt : globalFmt;
      handler = handlerFor(model, kw, fmt, includeQueue);
      continue;
    }
    if (line.trim() === '') continue;
    handler.line(line);
  }
  rl.close();

  const baseDir = path.dirname(file);
  for (const inc of includeQueue) {
    if (inc.isPath) {
      searchDirs.push(path.isAbsolute(inc.name) ? inc.name : path.join(baseDir, inc.name));
      continue;
    }
    const resolved = resolveFile(inc.name, baseDir, searchDirs);
    if (!resolved) {
      model.warn(`include not found: ${inc.name} (from ${path.basename(file)})`);
      continue;
    }
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    await parseOne(model, resolved, searchDirs, seen);
  }
}

const KEYWORD_EXT = /\.(k|key|dyn|inc|kw)$/i;

/** Pick root keyword files in a directory: those not referenced by another file's *INCLUDE. */
export function findRootFiles(dir) {
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (KEYWORD_EXT.test(e.name)) files.push(p);
    }
  };
  walk(dir);
  const included = new Set();
  for (const f of files) {
    const text = fs.readFileSync(f, 'latin1');
    const re = /^\*INCLUDE[^\n]*\n((?:(?:\$[^\n]*|[^*\n][^\n]*)\n)+)/gim;
    let m;
    while ((m = re.exec(text))) {
      for (const l of m[1].split('\n')) {
        const s = l.trim();
        if (s && !s.startsWith('$')) included.add(path.basename(s).toLowerCase());
      }
    }
  }
  return files.filter((f) => !included.has(path.basename(f).toLowerCase()));
}

/** Parse a keyword file (following includes) or every root file of a directory. */
export async function parseKeyword(input) {
  const model = new KeywordModel();
  const roots = fs.statSync(input).isDirectory() ? findRootFiles(input) : [input];
  if (!roots.length) throw new Error(`no keyword files found in ${input}`);
  const seen = new Set(roots.map((r) => path.resolve(r)));
  for (const r of roots) await parseOne(model, path.resolve(r), [path.dirname(path.resolve(r))], seen);
  return model;
}
