// Convert an LS-DYNA keyword model into browser-ready files.
// Usage: node tools/convert-k.mjs <file.k | directory> <outDir>
//   <outDir>/parts.json    metadata + byte ranges + connections (where parts are welded / bolted together)
//   <outDir>/geometry.bin  per part: Uint16 quantized positions (padded to 4 bytes) then Uint16/Uint32 indices
import fs from 'node:fs';
import path from 'node:path';
import { parseKeyword } from './lsdyna/parser.mjs';
import { buildMeshes } from './lsdyna/mesh.mjs';
import { findConnections } from './connections.mjs';
import { classify, groupList, assemblyOf } from './groups.mjs';

export async function convert(input, outDir, { quiet = false } = {}) {
  const log = quiet ? () => {} : console.log;
  const t0 = performance.now();
  const model = await parseKeyword(input);
  log(`parsed ${model.files.length} file(s), ${model.nodeIds.length} nodes, ${model.parts.size} parts in ${((performance.now() - t0) / 1000).toFixed(1)} s`);

  const built = buildMeshes(model);
  log(`built ${built.parts.length} meshes (${built.geometryless.length} parts without surface geometry), units: ${built.units.length}/${built.units.mass}`);
  if (built.missingNodes) log(`warning: ${built.missingNodes} elements reference missing nodes`);
  const connections = findConnections(model, { toMM: built.units.toMM });
  log(`found ${connections.pairs.length} connected part pairs from ${connections.stats.used} welds / bolts / joints / beams`);

  fs.mkdirSync(outDir, { recursive: true });
  const chunks = [];
  let offset = 0;
  const add = (typed) => {
    const buf = Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength);
    const start = offset;
    chunks.push(buf);
    offset += buf.byteLength;
    const pad = (4 - (offset % 4)) % 4;
    if (pad) {
      chunks.push(Buffer.alloc(pad));
      offset += pad;
    }
    return start;
  };

  const parts = built.parts.map(({ meta, quant, indices }) => {
    const posOffset = add(quant);
    const idxOffset = add(indices);
    const group = classify(meta.name);
    return {
      ...meta,
      group,
      assembly: assemblyOf(meta.name, group, meta.centroid),
      geometry: { posOffset, posCount: quant.length, idxOffset, idxCount: indices.length, idxBits: indices.BYTES_PER_ELEMENT * 8 },
    };
  });

  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const p of parts) for (let k = 0; k < 3; k++) {
    min[k] = Math.min(min[k], p.bboxMin[k]);
    max[k] = Math.max(max[k], p.bboxMax[k]);
  }

  const manifest = {
    version: 1,
    source: path.basename(path.resolve(input)),
    generated: new Date().toISOString(),
    units: built.units,
    bboxMin: min,
    bboxMax: max,
    stats: {
      files: model.files.map((f) => path.relative(path.resolve(input, fs.statSync(input).isDirectory() ? '.' : '..'), f)),
      nodes: built.nodeCount,
      partsDefined: model.parts.size,
      partsWithGeometry: parts.length,
      triangles: parts.reduce((a, p) => a + p.triangles, 0),
      shells: parts.reduce((a, p) => a + p.elements.shell, 0),
      solids: parts.reduce((a, p) => a + p.elements.solid, 0),
      beams: [...model.elements.values()].reduce((a, e) => a + e.beams, 0),
      bytes: offset,
      keywords: Object.fromEntries([...model.keywordCounts].sort((a, b) => b[1] - a[1])),
    },
    warnings: model.warnings,
    groups: groupList(),
    geometryless: built.geometryless,
    parts,
    connections: connections.pairs,
  };

  fs.writeFileSync(path.join(outDir, 'geometry.bin'), Buffer.concat(chunks));
  fs.writeFileSync(path.join(outDir, 'parts.json'), JSON.stringify(manifest));
  log(`wrote ${path.join(outDir, 'parts.json')} and geometry.bin (${(offset / 1e6).toFixed(1)} MB) in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  if (model.warnings.length) log(`${model.warnings.length} warning(s):\n  ` + model.warnings.slice(0, 20).join('\n  '));
  return manifest;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [input, outDir] = process.argv.slice(2);
  if (!input || !outDir) {
    console.error('usage: node tools/convert-k.mjs <file.k | directory> <outDir>');
    process.exit(1);
  }
  await convert(input, outDir);
}
