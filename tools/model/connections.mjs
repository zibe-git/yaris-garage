// Where parts are fastened to each other, from the keyword model's welds, bolts (nodal rigid bodies), joints,
// beam elements and nodes shared by two parts. Used by the puzzle as "this dot on that dot" attachment points.
//
// A link's nodes may be free (spot weld beams float between two sheets): those are attributed to the part owning
// the nearest node within `snap` mm.

const KIND_RANK = { weld: 5, bolt: 4, joint: 3, beam: 2, shared: 1 };

/**
 * @returns {{ pairs: Array<{ a:number, b:number, kind:string, n:number, points:number[][] }>, stats: object }}
 * a < b are part ids; points are up to maxPoints well-spread attachment points (mm, model space).
 */
export function findConnections(model, { toMM = 1, maxPoints = 6, snap = 8, maxBoltExtent = 150, spacing = 25 } = {}) {
  const ids = model.nodeIds.view();
  const xyz = model.nodeXYZ.view();
  const n = ids.length;
  const index = new Map();
  for (let i = 0; i < n; i++) index.set(ids[i], i);
  const P = (i) => [xyz[3 * i] * toMM, xyz[3 * i + 1] * toMM, xyz[3 * i + 2] * toMM];

  // node → owning part(s)
  const owner = new Int32Array(n);
  const more = new Map(); // node index -> Set of further pids
  const own = (id, pid) => {
    const i = index.get(id);
    if (i === undefined) return;
    if (!owner[i]) owner[i] = pid;
    else if (owner[i] !== pid) {
      if (!more.has(i)) more.set(i, new Set());
      more.get(i).add(pid);
    }
  };
  for (const [pid, e] of model.elements) {
    for (const id of e.shell.view()) own(id, pid);
    for (const id of e.solid.view()) own(id, pid);
  }
  for (const { pid, nsid } of model.extraNodes) for (const id of model.nodeSets.get(nsid) || []) own(id, pid);
  const ownersOf = (i) => (owner[i] ? [owner[i], ...(more.get(i) || [])] : []);

  // spatial hash of owned nodes, for free link nodes
  const cell = (v) => Math.floor(v / snap);
  const key = (x, y, z) => `${x},${y},${z}`;
  let grid = null;
  const nearestOwned = (p) => {
    if (!grid) {
      grid = new Map();
      for (let i = 0; i < n; i++) {
        if (!owner[i]) continue;
        const q = P(i);
        const k = key(cell(q[0]), cell(q[1]), cell(q[2]));
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k).push(i);
      }
    }
    const [cx, cy, cz] = p.map(cell);
    let best = -1;
    let bestD = snap * snap;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      for (const i of grid.get(key(cx + dx, cy + dy, cz + dz)) || []) {
        const q = P(i);
        const d = (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2 + (q[2] - p[2]) ** 2;
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
    }
    return best;
  };
  const partsAt = (i) => {
    if (owner[i]) return ownersOf(i);
    const j = nearestOwned(P(i));
    return j >= 0 ? ownersOf(j) : [];
  };

  const pairs = new Map();
  const add = (kind, pids, point) => {
    const u = [...new Set(pids)].sort((x, y) => x - y);
    for (let s = 0; s < u.length; s++) for (let t = s + 1; t < u.length; t++) {
      const k = `${u[s]}-${u[t]}`;
      let pr = pairs.get(k);
      if (!pr) pairs.set(k, (pr = { a: u[s], b: u[t], kind, pts: [] }));
      if (KIND_RANK[kind] > KIND_RANK[pr.kind]) pr.kind = kind;
      pr.pts.push(point);
    }
  };

  const stats = { links: 0, used: 0, skippedLarge: 0, shared: 0 };
  for (const link of model.links) {
    stats.links++;
    const nodes = (link.nodes || model.nodeSets.get(link.nsid) || []).map((id) => index.get(id)).filter((i) => i !== undefined);
    if (nodes.length < 2) continue;
    const pts = nodes.map(P);
    const lo = [0, 1, 2].map((k) => Math.min(...pts.map((p) => p[k])));
    const hi = [0, 1, 2].map((k) => Math.max(...pts.map((p) => p[k])));
    if (Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) > maxBoltExtent) {
      stats.skippedLarge++;
      continue;
    }
    const pids = nodes.flatMap(partsAt);
    if (new Set(pids).size < 2) continue;
    stats.used++;
    add(link.kind, pids, [0, 1, 2].map((k) => pts.reduce((s, p) => s + p[k], 0) / pts.length));
  }
  // conformal joins: a node that belongs to two parts
  for (const [i, extra] of more) {
    stats.shared++;
    add('shared', [owner[i], ...extra], P(i));
  }

  const out = [];
  for (const pr of pairs.values()) out.push({ a: pr.a, b: pr.b, kind: pr.kind, n: pr.pts.length, points: spread(pr.pts, maxPoints, spacing) });
  out.sort((x, y) => x.a - y.a || x.b - y.b);
  return { pairs: out, stats: { ...stats, pairs: out.length } };
}

// Farthest-point sample: up to k points, starting nearest the centre, at least `spacing` mm apart.
export function spread(points, k, spacing) {
  if (!points.length) return [];
  const c = [0, 1, 2].map((i) => points.reduce((s, p) => s + p[i], 0) / points.length);
  const d2 = (p, q) => (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2;
  const picked = [points.reduce((a, b) => (d2(b, c) < d2(a, c) ? b : a))];
  const dist = points.map((p) => d2(p, picked[0]));
  while (picked.length < k) {
    let best = -1;
    for (let i = 0; i < points.length; i++) if (best < 0 || dist[i] > dist[best]) best = i;
    if (best < 0 || dist[best] < spacing * spacing) break;
    const p = points[best];
    picked.push(p);
    for (let i = 0; i < points.length; i++) dist[i] = Math.min(dist[i], d2(points[i], p));
  }
  return picked.map((p) => p.map((v) => Math.round(v * 10) / 10));
}
