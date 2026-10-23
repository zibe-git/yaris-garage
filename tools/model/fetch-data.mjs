// Download the CCSA 2010 Toyota Yaris FE model, verify its SHA-384 and extract it to data/extracted/.
// Usage: node tools/fetch-data.mjs [detailed|coarse]
import fs from 'node:fs';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const MODELS = {
  detailed: {
    file: '2010-toyota-yaris-detailed-v2j.zip',
    sha384: 'f68913788cbe520709323f76214054f16bdbeeb2b7ddd6dad3f4defccb15a2b6e9df62d50146d17809e4155a786082c7',
  },
  coarse: {
    file: '2010-toyota-yaris-coarse-v1l.zip',
    sha384: '4f2b837ba0c85c2ef123a75201ac341c5de6763fb2768b818d41ec4c027af921aabea83f0069bfa8b457a56c44c34ed0',
  },
};

const variant = process.argv[2] || 'detailed';
const m = MODELS[variant];
if (!m) {
  console.error(`unknown variant ${variant}; use detailed or coarse`);
  process.exit(1);
}
const url = `https://media.ccsa.gmu.edu/model/${m.file}`;
const zip = path.join('data/raw', m.file);
fs.mkdirSync('data/raw', { recursive: true });

if (!fs.existsSync(zip)) {
  console.log(`downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  fs.writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
}

const digest = crypto.createHash('sha384').update(fs.readFileSync(zip)).digest('hex');
if (digest !== m.sha384) {
  console.error(`SHA-384 mismatch for ${zip}\n  expected ${m.sha384}\n  got      ${digest}`);
  process.exit(1);
}
console.log(`checksum OK (${(fs.statSync(zip).size / 1e6).toFixed(1)} MB)`);

const out = path.join('data/extracted', variant);
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
execFileSync('unzip', ['-q', '-o', zip, '-d', out], { stdio: 'inherit' });
const files = [];
const walk = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else files.push(`${(fs.statSync(p).size / 1e6).toFixed(1).padStart(7)} MB  ${path.relative(out, p)}`);
  }
};
walk(out);
console.log(`extracted to ${out}:\n${files.join('\n')}`);
console.log(`\nnext: node tools/convert-k.mjs ${out} public/model`);
