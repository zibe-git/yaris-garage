// Bake the converted CCSA/GMU Yaris FE model (data/model, from tools/model/convert-k.mjs) into one
// GPU-ready file shared by all four mobile apps:
//   - every part simplified with meshoptimizer (absolute error in mm, borders locked so panels stay closed)
//   - one interleaved vertex buffer, 12 bytes / vertex: position u16×3 (quantised over the model bbox, model mm),
//     part index u16, normal i8×4 (smooth, area-weighted; the shader flips it towards the viewer)
//   - one Uint32 index buffer; every part's triangles are contiguous, parts ordered
//       [opaque exterior | glass | hidden inside]  so Drive / Rally draw one range and Explode / Puzzle all of it
//   - per-part metadata in model space (mm, +x forward, +y left, +z up) so the puzzle rules run unchanged,
//     plus the render material used by Drive / Rally and the wheel a part spins with
// Output: <out>/car.json + <out>/car.bin (+ car.bin.gz for hosts that don't compress binary files).  The app needs no processing at load: the buffers go straight to the GPU.
// Usage: node tools/bake.mjs data/model public/model [--ratio 0.12] [--error 3]   (npm run model does all three steps)
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { MeshoptSimplifier } from 'meshoptimizer';

const [src = 'data/model', out = 'public/model'] = process.argv.slice(2).filter((a) => !a.startsWith('--') && !/^[\d.]+$/.test(a));
const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? Number(process.argv[i + 1]) : def;
};
const RATIO = arg('ratio', 0.12);
const ERROR_MM = arg('error', 3);

if (!fs.existsSync(`${src}/parts.json`)) {
  console.error(`${src}/parts.json not found — run: npm run model`);
  process.exit(1);
}
const manifest = JSON.parse(fs.readFileSync(`${src}/parts.json`, 'utf8'));
const binBuf = fs.readFileSync(`${src}/geometry.bin`);
const bin = binBuf.buffer.slice(binBuf.byteOffset, binBuf.byteOffset + binBuf.byteLength);
await MeshoptSimplifier.ready;

const norm = (name) => (name || '').toLowerCase().replace(/^\s*\d+[_\-\s]*/, '').replace(/[^a-z0-9]+/g, '');

// Render material for Drive / Rally, or null when the part can't be seen from outside (same rules as drive/tools/bake-car.mjs).
export const MATERIALS = ['paint', 'glass', 'interior', 'chassis', 'trim', 'tire', 'rim', 'brake', 'headlight', 'taillight'];
function materialOf(p) {
  const n = norm(p.name);
  if (/tread/.test(n)) return 'tire';
  if (/tire|drum/.test(n)) {
    if (/rim/.test(n)) return 'rim';
    if (/disk|drum|hub/.test(n)) return 'brake';
    return 'tire';
  }
  switch (p.group) {
    case 'body':
    case 'closures':
      if (/trim/.test(n)) return 'interior';
      if (/firewalltray|firewallupper|firewallfront/.test(n)) return 'trim';
      return 'paint';
    case 'bumpers':
      return /bumperplastic|^bumper$/.test(n) ? 'paint' : 'chassis';
    case 'glazing':
      return /top|midlayer/.test(n) ? null : 'glass';
    case 'electrical':
      if (/headl/.test(n)) return 'headlight';
      if (/taill/.test(n)) return 'taillight';
      return null;
    case 'interior':
      return /airbag|curtab|seatbelt/.test(n) ? null : 'interior';
    case 'steering':
      return /colmwheel|airbagcover/.test(n) ? 'interior' : null;
    case 'suspension':
    case 'subframe':
    case 'exhaust':
      return 'chassis';
    default:
      return null;
  }
}

function partMesh(p) {
  const g = p.geometry;
  const q = new Uint16Array(bin, g.posOffset, g.posCount);
  const Idx = g.idxBits === 32 ? Uint32Array : Uint16Array;
  const idx = new Uint32Array(new Idx(bin, g.idxOffset, g.idxCount));
  const pos = new Float32Array(g.posCount);
  for (let i = 0; i < g.posCount; i += 3)
    for (let k = 0; k < 3; k++) pos[i + k] = p.bboxMin[k] + (q[i + k] / 65535) * (p.bboxMax[k] - p.bboxMin[k]);
  return { pos, idx };
}

function simplify({ pos, idx }) {
  if (idx.length <= 240) return compact(pos, idx);
  const target = Math.max(3, Math.floor((idx.length * RATIO) / 3) * 3);
  const [simple] = MeshoptSimplifier.simplify(idx, pos, 3, target, ERROR_MM, ['LockBorder', 'ErrorAbsolute']);
  return compact(pos, simple);
}

function compact(pos, idx) {
  const remap = new Int32Array(pos.length / 3).fill(-1);
  const outPos = [];
  const outIdx = new Uint32Array(idx.length);
  let n = 0;
  for (let i = 0; i < idx.length; i++) {
    const v = idx[i];
    if (remap[v] < 0) {
      remap[v] = n++;
      outPos.push(pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]);
    }
    outIdx[i] = remap[v];
  }
  return { pos: new Float32Array(outPos), idx: outIdx };
}

function normals(pos, idx) {
  const nrm = new Float32Array(pos.length);
  for (let i = 0; i < idx.length; i += 3) {
    const a = idx[i] * 3;
    const b = idx[i + 1] * 3;
    const c = idx[i + 2] * 3;
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const v of [a, b, c]) {
      nrm[v] += nx;
      nrm[v + 1] += ny;
      nrm[v + 2] += nz;
    }
  }
  return nrm;
}

// ---- wheels: centres from the tread bboxes; the car frame origin is on the ground between the axles ----
const wheelKey = (p) => (p.centroid[0] > -2000 ? 'F' : 'R') + (p.centroid[1] > 0 ? 'L' : 'R');
const WHEELS = ['FL', 'FR', 'RL', 'RR'];
const isWheel = (p) => /tire|tread|drum/.test(norm(p.name));
const wheelBox = {};
for (const p of manifest.parts.filter((p) => /tread/.test(norm(p.name)))) wheelBox[wheelKey(p)] = { min: p.bboxMin, max: p.bboxMax };
const wheelCentre = {};
for (const [k, b] of Object.entries(wheelBox)) wheelCentre[k] = b.min.map((v, i) => (v + b.max[i]) / 2);
const radiusMM = Object.values(wheelBox).reduce((s, b) => s + (b.max[2] - b.min[2]) / 2, 0) / 4;
const frontX = (wheelCentre.FL[0] + wheelCentre.FR[0]) / 2;
const rearX = (wheelCentre.RL[0] + wheelCentre.RR[0]) / 2;
const groundZ = Math.min(...Object.values(wheelBox).map((b) => b.min[2]));
const origin = [(frontX + rearX) / 2, 0, groundZ];

// ---- simplify + order ----
let trisIn = 0;
const parts = manifest.parts
  .filter((p) => p.geometry && p.triangles > 0)
  .map((p) => {
    const m = partMesh(p);
    trisIn += m.idx.length / 3;
    const s = simplify(m);
    const material = materialOf(p);
    const tier = material === null ? 2 : material === 'glass' ? 1 : 0;
    return { p, s, material, tier, wheel: isWheel(p) ? WHEELS.indexOf(wheelKey(p)) : -1 };
  })
  .sort((a, b) => a.tier - b.tier || a.p.pid - b.p.pid);

const vCount = parts.reduce((n, x) => n + x.s.pos.length / 3, 0);
const iCount = parts.reduce((n, x) => n + x.s.idx.length, 0);
const bmin = manifest.bboxMin;
const bsize = manifest.bboxMax.map((v, i) => v - bmin[i]);
const vbuf = new ArrayBuffer(vCount * 12);
const u16 = new Uint16Array(vbuf);
const i8 = new Int8Array(vbuf);
const ibuf = new Uint32Array(iCount);
const r1 = (v) => Math.round(v * 10) / 10;
const meta = [];
let vo = 0;
let io = 0;
const ranges = { opaque: [0, 0], glass: [0, 0], hidden: [0, 0] };
const tierName = ['opaque', 'glass', 'hidden'];
for (const [k, x] of parts.entries()) {
  const { pos, idx } = x.s;
  const nrm = normals(pos, idx);
  const nv = pos.length / 3;
  for (let v = 0; v < nv; v++) {
    const o = (vo + v) * 6; // u16 slots
    for (let c = 0; c < 3; c++) u16[o + c] = Math.round(((pos[v * 3 + c] - bmin[c]) / bsize[c]) * 65535);
    u16[o + 3] = k;
    const l = Math.hypot(nrm[v * 3], nrm[v * 3 + 1], nrm[v * 3 + 2]) || 1;
    for (let c = 0; c < 3; c++) i8[(vo + v) * 12 + 8 + c] = Math.round((nrm[v * 3 + c] / l) * 127);
  }
  for (let i = 0; i < idx.length; i++) ibuf[io + i] = idx[i] + vo;
  const p = x.p;
  meta.push({
    pid: p.pid,
    name: p.name,
    group: p.group,
    assembly: p.assembly || null,
    centroid: p.centroid.map(r1),
    bboxMin: p.bboxMin.map(r1),
    bboxMax: p.bboxMax.map(r1),
    areaMM2: p.areaMM2,
    volumeMM3: p.volumeMM3,
    thicknessMM: p.thicknessMM,
    massKg: p.massKg,
    kind: p.section?.kind || null,
    materialType: p.material?.type || null,
    render: x.material,
    wheel: x.wheel,
    first: io,
    count: idx.length,
  });
  const r = ranges[tierName[x.tier]];
  if (!r[1]) r[0] = io;
  r[1] = io + idx.length - r[0];
  vo += nv;
  io += idx.length;
}

const layout = {
  version: 1,
  source: manifest.source,
  credit: '2010 Toyota Yaris finite element model © Center for Collision Safety and Analysis (CCSA), George Mason University, developed under sponsorship of FHWA / NHTSA',
  generated: new Date().toISOString(),
  axes: 'model mm, +x forward, +y left, +z up',
  bboxMin: bmin,
  bboxMax: manifest.bboxMax,
  origin, // model point that becomes the car frame origin (ground, between the axles)
  wheels: WHEELS.map((k) => wheelCentre[k].map(r1)),
  wheelRadius: Math.round(radiusMM) / 1000,
  wheelbase: Math.round(frontX - rearX) / 1000,
  track: Math.round(wheelCentre.FL[1] - wheelCentre.FR[1]) / 1000,
  vertices: vCount,
  triangles: iCount / 3,
  vertexBytes: vbuf.byteLength,
  indexBytes: ibuf.byteLength,
  ranges,
  groups: manifest.groups,
  parts: meta,
  connections: manifest.connections,
};
fs.mkdirSync(out, { recursive: true });
const carBin = Buffer.concat([Buffer.from(vbuf), Buffer.from(ibuf.buffer)]);
fs.writeFileSync(path.join(out, 'car.bin'), carBin);
const gz = zlib.gzipSync(carBin, { level: 9 });
fs.writeFileSync(path.join(out, 'car.bin.gz'), gz);
fs.writeFileSync(path.join(out, 'car.json'), JSON.stringify(layout));
console.log(`${parts.length} parts: ${trisIn} → ${iCount / 3} triangles, ${vCount} vertices (ratio ${RATIO}, error ${ERROR_MM} mm)`);
console.log(`car.bin ${(carBin.length / 1e6).toFixed(1)} MB (${(gz.length / 1e6).toFixed(1)} MB gzipped), car.json ${(fs.statSync(path.join(out, 'car.json')).size / 1e3).toFixed(0)} kB`);
console.log('ranges (first index, count):', ranges);
