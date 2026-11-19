// Extracts RPC method names (+ stream flag) from upstream contracts source. Usage: node list-methods.mjs <upstream-root> > fixtures/methods.json
import fs from 'node:fs';
import path from 'node:path';
const root = process.argv[2];
const dir = path.join(root, 'packages/contracts/src');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
const maps = {};   // key -> wire name
const methods = {};
for (const f of files) {
  const src = fs.readFileSync(path.join(dir, f), 'utf8');
  for (const m of src.matchAll(/export const (\w*WS_METHODS|\w*_METHODS)\s*=\s*\{([\s\S]*?)\}\s*as const/g)) {
    for (const e of m[2].matchAll(/(\w+):\s*"([^"]+)"/g)) maps[`${m[1]}.${e[1]}`] = { wire: e[2], file: f };
  }
}
for (const f of files) {
  const src = fs.readFileSync(path.join(dir, f), 'utf8');
  const parts = src.split(/Rpc\.make\(/).slice(1);
  for (const p of parts) {
    const head = p.slice(0, 80).match(/^\s*(\w+)\.(\w+)/);
    const body = p.split(/\n(?:export )?const /)[0];
    const stream = /stream:\s*true/.test(body);
    const key = head ? `${head[1]}.${head[2]}` : null;
    const wire = key && maps[key]?.wire;
    if (wire) methods[wire] = { stream, file: f };
    else if (!head) { const s = p.match(/^\s*"([^"]+)"/); if (s) methods[s[1]] = { stream, file: f }; }
  }
}
const out = Object.entries(methods).sort(([a], [b]) => a.localeCompare(b)).map(([name, v]) => ({ name, stream: v.stream, file: v.file }));
const unused = Object.values(maps).filter((m) => !methods[m.wire]).map((m) => m.wire);
console.log(JSON.stringify({ count: out.length, streams: out.filter((x) => x.stream).length, methods: out, mapEntriesWithoutRpcMake: unused }, null, 1));
