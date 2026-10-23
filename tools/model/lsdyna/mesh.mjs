// Turn parsed keyword data into per-part triangle meshes ready for the browser.
//   shells → triangles (quad split in two)
//   solids → boundary faces only (faces shared by two elements of the same part are interior and dropped)
import { Growable } from './growable.mjs';

// Outward faces of an LS-DYNA hexahedron (nodes 1-4 one face, 5-8 the opposite face).
const HEX_FACES = [
  [0, 3, 2, 1],
  [4, 5, 6, 7],
  [0, 1, 5, 4],
  [1, 2, 6, 5],
  [2, 3, 7, 6],
  [3, 0, 4, 7],
];
const TET_FACES = [
  [0, 2, 1],
  [0, 1, 3],
  [1, 2, 3],
  [2, 0, 3],
];

/** Remove consecutive duplicates (cyclically) from a face loop. */
function cleanLoop(ids) {
  const out = [];
  for (const v of ids) if (out[out.length - 1] !== v) out.push(v);
  while (out.length > 1 && out[0] === out[out.length - 1]) out.pop();
  return out;
}

/** Infer the unit system from material densities (steel ≈ 7.85 g/cm³). */
export function detectUnits(materials) {
  const ds = [...materials.values()].map((m) => m.density).filter((d) => Number.isFinite(d) && d > 0).sort((a, b) => a - b);
  if (!ds.length) return { length: 'mm', mass: 'unknown', toMM: 1, densityToKgPerMM3: null, guess: true };
  const median = ds[Math.floor(ds.length / 2)];
  const exp = Math.log10(median);
  if (exp < -7) return { length: 'mm', mass: 't', time: 's', toMM: 1, densityToKgPerMM3: 1e3, medianDensity: median };
  if (exp < -3) return { length: 'mm', mass: 'kg', time: 'ms', toMM: 1, densityToKgPerMM3: 1, medianDensity: median };
  return { length: 'm', mass: 'kg', time: 's', toMM: 1000, densityToKgPerMM3: 1e-9, medianDensity: median };
}

export function buildMeshes(model, { units = detectUnits(model.materials) } = {}) {
  const nodeCount = model.nodeIds.length;
  const ids = model.nodeIds.view();
  const xyz = model.nodeXYZ.view();
  const s = units.toMM;
  const index = new Map();
  for (let i = 0; i < nodeCount; i++) index.set(ids[i], i);

  const P = (i) => [xyz[3 * i] * s, xyz[3 * i + 1] * s, xyz[3 * i + 2] * s];
  const local = new Int32Array(nodeCount).fill(-1);
  const out = [];
  let missingNodes = 0;

  for (const [pid, elems] of model.elements) {
    const nShell = elems.shell.length / 4;
    const nSolid = elems.solid.length / 8;
    if (!nShell && !nSolid) continue;

    const tris = new Growable(Int32Array, 1024);
    let area = 0;
    let solidVolume = 0;

    // --- shells
    const sh = elems.shell.view();
    for (let e = 0; e < nShell; e++) {
      const a = index.get(sh[4 * e]);
      const b = index.get(sh[4 * e + 1]);
      const c = index.get(sh[4 * e + 2]);
      const d = index.get(sh[4 * e + 3]);
      if (a === undefined || b === undefined || c === undefined || d === undefined) {
        missingNodes++;
        continue;
      }
      tris.pushMany(a, b, c);
      area += triArea(P(a), P(b), P(c));
      if (d !== c) {
        tris.pushMany(a, c, d);
        area += triArea(P(a), P(c), P(d));
      }
    }

    // --- solids: count faces, keep those seen once
    if (nSolid) {
      const faces = new Map();
      const so = elems.solid.view();
      const n = new Array(8);
      for (let e = 0; e < nSolid; e++) {
        let ok = true;
        for (let k = 0; k < 8; k++) {
          n[k] = index.get(so[8 * e + k]);
          if (n[k] === undefined) ok = false;
        }
        if (!ok) {
          missingNodes++;
          continue;
        }
        const unique = [...new Set(n)];
        const loops =
          unique.length === 4 && n[3] === n[4] ? TET_FACES.map((f) => f.map((k) => unique[k])) : HEX_FACES.map((f) => cleanLoop(f.map((k) => n[k])));
        for (const loop of loops) {
          if (loop.length < 3) continue;
          const key = [...loop].sort((x, y) => x - y).join(',');
          const hit = faces.get(key);
          if (hit) hit.count++;
          else faces.set(key, { count: 1, loop });
        }
      }
      for (const { count, loop } of faces.values()) {
        if (count !== 1) continue;
        for (let k = 1; k < loop.length - 1; k++) {
          tris.pushMany(loop[0], loop[k], loop[k + 1]);
          solidVolume += signedVolume(P(loop[0]), P(loop[k]), P(loop[k + 1]));
        }
      }
    }

    const t = tris.view();
    if (!t.length) continue;

    // --- compact vertices, bbox, area-weighted centroid
    const touched = [];
    for (let k = 0; k < t.length; k++) {
      const g = t[k];
      if (local[g] === -1) {
        local[g] = touched.length;
        touched.push(g);
      }
    }
    const nv = touched.length;
    const pos = new Float64Array(nv * 3);
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let v = 0; v < nv; v++) {
      const p = P(touched[v]);
      for (let k = 0; k < 3; k++) {
        pos[3 * v + k] = p[k];
        if (p[k] < min[k]) min[k] = p[k];
        if (p[k] > max[k]) max[k] = p[k];
      }
    }
    const indices = nv > 65535 ? new Uint32Array(t.length) : new Uint16Array(t.length);
    const centroid = [0, 0, 0];
    let wsum = 0;
    for (let k = 0; k < t.length; k += 3) {
      const ia = local[t[k]];
      const ib = local[t[k + 1]];
      const ic = local[t[k + 2]];
      indices[k] = ia;
      indices[k + 1] = ib;
      indices[k + 2] = ic;
      const a = [pos[3 * ia], pos[3 * ia + 1], pos[3 * ia + 2]];
      const b = [pos[3 * ib], pos[3 * ib + 1], pos[3 * ib + 2]];
      const c = [pos[3 * ic], pos[3 * ic + 1], pos[3 * ic + 2]];
      const w = triArea(a, b, c) || 1e-12;
      for (let j = 0; j < 3; j++) centroid[j] += (w * (a[j] + b[j] + c[j])) / 3;
      wsum += w;
    }
    for (let j = 0; j < 3; j++) centroid[j] /= wsum;
    for (const g of touched) local[g] = -1;

    // --- quantize positions to Uint16 inside the part bbox
    const quant = new Uint16Array(nv * 3);
    for (let v = 0; v < nv; v++) {
      for (let k = 0; k < 3; k++) {
        const range = max[k] - min[k];
        quant[3 * v + k] = range > 0 ? Math.round(((pos[3 * v + k] - min[k]) / range) * 65535) : 0;
      }
    }

    const part = model.parts.get(pid) || { pid, name: `PART ${pid}`, secid: 0, mid: 0 };
    const section = model.sections.get(part.secid);
    const material = model.materials.get(part.mid);
    let massKg = null;
    if (material && Number.isFinite(material.density) && units.densityToKgPerMM3) {
      const rho = material.density * units.densityToKgPerMM3; // kg / mm³
      if (nShell && section?.thickness) massKg = area * section.thickness * s * rho;
      else if (nSolid) massKg = Math.abs(solidVolume) * rho;
    }

    out.push({
      meta: {
        pid,
        name: part.name,
        elements: { shell: nShell, solid: nSolid, beam: elems.beams },
        vertices: nv,
        triangles: t.length / 3,
        bboxMin: min.map(round3),
        bboxMax: max.map(round3),
        centroid: centroid.map(round3),
        areaMM2: Math.round(area),
        volumeMM3: nSolid ? Math.round(Math.abs(solidVolume)) : null,
        thicknessMM: section?.thickness != null ? round3(section.thickness * s) : null,
        section: section ? { id: section.secid, kind: section.kind, elform: section.elform, title: section.title || '' } : null,
        material: material ? { id: material.mid, type: material.type, title: material.title || '' } : null,
        massKg: massKg != null ? Number(massKg.toPrecision(4)) : null,
      },
      quant,
      indices,
    });
  }

  // parts that exist only as beams / discrete elements are listed without geometry
  const geometryless = [];
  for (const [pid, part] of model.parts) {
    if (out.some((o) => o.meta.pid === pid)) continue;
    const e = model.elements.get(pid);
    geometryless.push({ pid, name: part.name, beams: e?.beams || 0 });
  }

  out.sort((a, b) => a.meta.pid - b.meta.pid);
  return { parts: out, geometryless, units, missingNodes, nodeCount };
}

function triArea(a, b, c) {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  const x = uy * vz - uz * vy, y = uz * vx - ux * vz, z = ux * vy - uy * vx;
  return 0.5 * Math.sqrt(x * x + y * y + z * z);
}

function signedVolume(a, b, c) {
  return (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
}

const round3 = (v) => Math.round(v * 1000) / 1000;
