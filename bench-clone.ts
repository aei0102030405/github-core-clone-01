// Micro-benchmark: 50 concurrent shallow clones of a 200-commit repo.
import { createApp } from './app.ts';
import {
  GitClient,
  buildCommit,
  buildTree,
  hashObject,
  collectReachable,
  ZERO_OID,
} from '../kit/github-core-clone-01-kit/program/env/src/git-client.ts';

const server = createApp();
await new Promise<void>((resolve) => server.listen(0, resolve));
const port = (server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}`;
const TOKEN = 'test-token-123';
process.env.MAKEFUN_SHOP_TOKEN = TOKEN;
const client = new GitClient({ baseUrl: base, token: TOKEN });
const owner = 'adaiversen';

const local = new Map<string, { type: 'blob' | 'tree' | 'commit' | 'tag'; data: Buffer }>();
function put(type: 'blob' | 'tree' | 'commit' | 'tag', data: Buffer): string {
  const oid = hashObject(type, data);
  local.set(oid, { type, data });
  return oid;
}

// Build a 200-commit history, each commit changing one 1 KiB file.
let tip = '';
let parent = '';
const blobs: Buffer[] = [];
for (let i = 0; i < 200; i += 1) {
  const data = Buffer.alloc(1024, 0x41 + (i % 26));
  data.write(`commit ${i} `.repeat(10), 0, 'ascii');
  const blob = put('blob', data);
  const tree = put('tree', buildTree([{ mode: '100644', name: 'bench.txt', oid: blob }]));
  tip = put('commit', buildCommit({ tree, parents: parent ? [parent] : [], message: `commit ${i}\n`, timestamp: 1700000000 + i }));
  parent = tip;
  blobs.push(data);
}
await fetch(`${base}/api/v3/user/repos`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: 'bench-clone', private: true }),
});
const objects = [...collectReachable([tip], (oid) => local.get(oid))].map((oid) => local.get(oid)!);
console.log(`history: ${objects.length} objects, pack would carry ${objects.length}`);
const pushed = await client.push(owner, 'bench-clone', [{ oldOid: ZERO_OID, newOid: tip, ref: 'refs/heads/main' }], { objects });
console.log('push ok:', pushed.report?.refs[0]?.ok);

// Warm-up + timed rounds of 50 concurrent shallow clones.
async function round(n: number): Promise<number> {
  const t0 = performance.now();
  await Promise.all(Array.from({ length: n }, () => client.clone(owner, 'bench-clone', { depth: 1 })));
  return performance.now() - t0;
}
await round(5);
for (let i = 0; i < 3; i += 1) {
  const ms = await round(50);
  console.log(`50 concurrent depth-1 clones: ${ms.toFixed(1)} ms`);
}
// Also time a single clone (sequential) for comparison.
{
  const t0 = performance.now();
  for (let i = 0; i < 20; i += 1) await client.clone(owner, 'bench-clone', { depth: 1 });
  console.log(`20 sequential depth-1 clones: ${(performance.now() - t0).toFixed(1)} ms (${((performance.now() - t0) / 20).toFixed(2)} ms each)`);
}
server.close();
process.exit(0);
