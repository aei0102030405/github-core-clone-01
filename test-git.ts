// Git smoke test using the kit's own GitClient (the protocol spec).
import { createApp } from './app.ts';
import {
  GitClient,
  buildCommit,
  buildTree,
  buildTag,
  hashObject,
  parseCommit,
  parseTree,
  parseTag,
  collectReachable,
  ZERO_OID,
} from '../kit/github-core-clone-01-kit/program/env/src/git-client.ts';

const server = createApp();
await new Promise<void>((resolve) => server.listen(0, resolve));
const port = (server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}`;
const TOKEN = 'test-token-123';
process.env.MAKEFUN_SHOP_TOKEN = TOKEN;

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) { pass += 1; console.log(`PASS ${name}`); }
  else { fail += 1; console.log(`FAIL ${name} ${extra}`); }
}

const client = new GitClient({ baseUrl: base, token: TOKEN });
const owner = 'adaiversen';

// Local object store (mirrors the harness's LocalRepo).
const local = new Map<string, { type: 'blob' | 'tree' | 'commit' | 'tag'; data: Buffer }>();
function put(type: 'blob' | 'tree' | 'commit' | 'tag', data: Buffer): string {
  const oid = hashObject(type, data);
  local.set(oid, { type, data });
  return oid;
}
function commit(files: { path: string; data: Buffer }[], message: string, parents: string[], ts: number): string {
  // Build nested trees from flat files.
  const byDir = new Map<string, { mode: string; name: string; oid: string }[]>();
  for (const f of files) {
    const slash = f.path.lastIndexOf('/');
    const dir = slash < 0 ? '' : f.path.slice(0, slash);
    const name = slash < 0 ? f.path : f.path.slice(slash + 1);
    const blobOid = put('blob', f.data);
    const list = byDir.get(dir) ?? [];
    list.push({ mode: '100644', name, oid: blobOid });
    byDir.set(dir, list);
  }
  const buildDir = (dir: string): string => {
    const entries = [...(byDir.get(dir) ?? [])];
    for (const d of byDir.keys()) {
      if (d === dir) continue;
      if (dir === '' && !d.includes('/')) entries.push({ mode: '40000', name: d, oid: buildDir(d) });
      else if (d.startsWith(`${dir}/`) && !d.slice(dir.length + 1).includes('/')) entries.push({ mode: '40000', name: d.slice(dir.length + 1), oid: buildDir(d) });
    }
    return put('tree', buildTree(entries));
  };
  const tree = buildDir('');
  return put('commit', buildCommit({ tree, parents, message, timestamp: ts }));
}
function reachable(tips: string[]): { type: 'blob' | 'tree' | 'commit' | 'tag'; data: Buffer }[] {
  const ids = collectReachable(tips, (oid) => local.get(oid));
  return [...ids].map((oid) => local.get(oid)!);
}
async function createRepo(name: string) {
  const r = await fetch(`${base}/api/v3/user/repos`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, private: true }),
  });
  if (r.status !== 201) throw new Error(`create repo ${name}: ${r.status} ${await r.text()}`);
}

// 1. advertisement on missing repo -> 404
{
  const missing = await client.infoRefs(owner, 'no-such-repo', 'git-upload-pack');
  check('missing repo info/refs 404', missing.status === 404, `got ${missing.status}`);
}

// 2. create repo, push initial commit
await createRepo('git-smoke');
const tip1 = commit([{ path: 'README.md', data: Buffer.from('# hello\n') }], 'initial commit\n', [], 1700000000);
const pushed1 = await client.push(owner, 'git-smoke', [{ oldOid: ZERO_OID, newOid: tip1, ref: 'refs/heads/main' }], { objects: reachable([tip1]) });
check('push unpack ok', pushed1.report?.unpackOk === true, JSON.stringify(pushed1.report));
check('push ok ref', pushed1.report?.refs[0]?.ok === true, JSON.stringify(pushed1.report?.refs));
check('push sideband', pushed1.sideband === true);

// 3. ls-refs
{
  const listed = await client.lsRefs(owner, 'git-smoke');
  check('ls-refs finds main', listed.refs.some((r) => r.name === 'refs/heads/main' && r.oid === tip1), JSON.stringify(listed.refs));
  check('ls-refs HEAD symref', listed.headSymref === 'refs/heads/main', String(listed.headSymref));
  check('ls-refs protocol v2', listed.protocol === 2);
  const filtered = await client.lsRefs(owner, 'git-smoke', { prefixes: ['refs/tags/'] });
  check('ls-refs prefix filter empty', filtered.refs.length === 0, JSON.stringify(filtered.refs));
}

// 4. clone round-trip
{
  const clone = await client.clone(owner, 'git-smoke');
  check('clone has tip', clone.objects.has(tip1));
  check('clone tip bytes exact', clone.objects.get(tip1)?.data.equals(local.get(tip1)!.data) === true);
  const c = parseCommit(clone.objects.get(tip1)!.data);
  check('clone commit message', c.message === 'initial commit\n', JSON.stringify(c.message));
  check('clone commit author ts', c.author.includes('1700000000 +0000'), c.author);
  const tree = clone.objects.get(c.tree);
  check('clone tree present', tree !== undefined);
  if (tree) {
    const entries = parseTree(tree.data);
    check('clone tree entry', entries.length === 1 && entries[0]!.name === 'README.md' && entries[0]!.mode === '100644');
  }
}

// 5. second commit + incremental fetch
const tip2 = commit([{ path: 'README.md', data: Buffer.from('# hello\n') }, { path: 'src/app.ts', data: Buffer.from('export {};\n') }], 'second commit\n', [tip1], 1700000100);
{
  const pushed = await client.push(owner, 'git-smoke', [{ oldOid: tip1, newOid: tip2, ref: 'refs/heads/main' }], { objects: reachable([tip2]) });
  check('push update ok', pushed.report?.refs[0]?.ok === true, JSON.stringify(pushed.report?.refs));
  const clone = await client.clone(owner, 'git-smoke');
  check('clone sees tip2', clone.objects.has(tip2));
  // Incremental fetch: have tip1, want tip2.
  const first = await client.clone(owner, 'git-smoke');
  const fetched = await client.fetch(owner, 'git-smoke', { wants: [tip2], haves: [tip1], haveObjects: first.objects });
  check('incremental has tip2', fetched.objects.has(tip2));
  check('incremental no tip1', !fetched.objects.has(tip1), `got ${fetched.objects.size} objects`);
  // Fetch nothing new.
  const none = await client.fetch(owner, 'git-smoke', { wants: [tip2], haves: [tip2], haveObjects: first.objects });
  check('fetch nothing new', none.objects.size === 0, `got ${none.objects.size}`);
}

// 6. shallow clone depth 1 + deepen
const tip3 = commit([{ path: 'README.md', data: Buffer.from('# hello v3\n') }], 'third commit\n', [tip2], 1700000200);
{
  await client.push(owner, 'git-smoke', [{ oldOid: tip2, newOid: tip3, ref: 'refs/heads/main' }], { objects: reachable([tip3]) });
  const shallow = await client.clone(owner, 'git-smoke', { depth: 1 });
  check('shallow has tip3', shallow.objects.has(tip3));
  check('shallow no tip2', !shallow.objects.has(tip2));
  check('shallow-info names tip3', shallow.shallow.includes(tip3), JSON.stringify(shallow.shallow));
  const deepened = await client.fetch(owner, 'git-smoke', { wants: [tip3], haves: [tip3], shallow: shallow.shallow, depth: 2, haveObjects: shallow.objects });
  check('deepen has tip2', deepened.objects.has(tip2));
  check('deepen no tip1', !deepened.objects.has(tip1));
  check('deepen boundary moved', deepened.shallow.includes(tip2) || deepened.unshallow.includes(tip3), `shallow=${deepened.shallow} unshallow=${deepened.unshallow}`);
}

// 7. non-fast-forward refused with exact reason
{
  const sibling = commit([{ path: 'README.md', data: Buffer.from('# sibling\n') }], 'sibling\n', [tip2], 1700000300);
  const refused = await client.push(owner, 'git-smoke', [{ oldOid: tip3, newOid: sibling, ref: 'refs/heads/main' }], { objects: reachable([sibling]) });
  check('non-FF unpack ok', refused.report?.unpackOk === true);
  const rep = refused.report?.refs[0];
  check('non-FF refused', rep?.ok === false);
  check('non-FF reason exact', rep?.reason === 'non-fast-forward', JSON.stringify(rep?.reason));
  const listed = await client.lsRefs(owner, 'git-smoke');
  check('non-FF main unchanged', listed.refs.find((r) => r.name === 'refs/heads/main')?.oid === tip3);
}

// 8. mixed push: one ok, one ng
{
  const forward = commit([{ path: 'x.txt', data: Buffer.from('x\n') }], 'forward\n', [tip3], 1700000400);
  const sibling = commit([{ path: 'y.txt', data: Buffer.from('y\n') }], 'sibling2\n', [tip2], 1700000500);
  // Setup: create the side branch at tip3 first (as the real check does).
  const setup = await client.push(owner, 'git-smoke', [{ oldOid: ZERO_OID, newOid: tip3, ref: 'refs/heads/side' }], { objects: [] });
  check('mixed setup side branch', setup.report?.refs[0]?.ok === true, JSON.stringify(setup.report?.refs));
  const mixed = await client.push(owner, 'git-smoke', [
    { oldOid: tip3, newOid: forward, ref: 'refs/heads/main' },
    { oldOid: tip3, newOid: sibling, ref: 'refs/heads/side' },
  ], { objects: [...new Set([...reachable([forward]).map((o) => o), ...reachable([sibling])])] });
  check('mixed unpack ok', mixed.report?.unpackOk === true);
  check('mixed 2 refs', mixed.report?.refs.length === 2, JSON.stringify(mixed.report?.refs));
  const main = mixed.report?.refs.find((r) => r.ref === 'refs/heads/main');
  const side = mixed.report?.refs.find((r) => r.ref === 'refs/heads/side');
  check('mixed main ok', main?.ok === true);
  check('mixed side ng non-FF', side?.ok === false && side?.reason === 'non-fast-forward', JSON.stringify(side));
}

// 9. annotated tag round-trip + peel
{
  const tag = put('tag', buildTag({ object: tip3, type: 'commit', tag: 'v1', message: 'release v1\n', timestamp: 1700000600 }));
  const pushed = await client.push(owner, 'git-smoke', [{ oldOid: ZERO_OID, newOid: tag, ref: 'refs/tags/v1' }], { objects: reachable([tag]) });
  check('tag push ok', pushed.report?.refs[0]?.ok === true, JSON.stringify(pushed.report?.refs));
  const clone = await client.clone(owner, 'git-smoke');
  check('clone has tag', clone.objects.has(tag));
  check('clone tag bytes exact', clone.objects.get(tag)?.data.equals(local.get(tag)!.data) === true);
  const parsed = parseTag(clone.objects.get(tag)!.data);
  check('tag headers', parsed.object === tip3 && parsed.type === 'commit' && parsed.tag === 'v1');
  const listed = await client.lsRefs(owner, 'git-smoke', { peel: true });
  const ref = listed.refs.find((r) => r.name === 'refs/tags/v1');
  check('tag advertised', ref?.oid === tag);
  check('tag peels', ref?.peeled === tip3, JSON.stringify(ref?.peeled));
}

// 10. delete branch + delete tag
{
  const created = await client.push(owner, 'git-smoke', [{ oldOid: ZERO_OID, newOid: tip3, ref: 'refs/heads/temp' }], { objects: [] });
  check('create temp branch', created.report?.refs[0]?.ok === true);
  const deleted = await client.push(owner, 'git-smoke', [{ oldOid: tip3, newOid: ZERO_OID, ref: 'refs/heads/temp' }], {});
  check('delete branch ok', deleted.report?.refs[0]?.ok === true, JSON.stringify(deleted.report?.refs));
  const listed = await client.lsRefs(owner, 'git-smoke');
  check('branch gone', !listed.refs.some((r) => r.name === 'refs/heads/temp'));
}

// 11. empty repo clone
{
  await createRepo('git-empty');
  const clone = await client.clone(owner, 'git-empty');
  check('empty clone 0 objects', clone.objects.size === 0, `got ${clone.objects.size}`);
}

// 12. v0 fallback (gitProtocol 0)
{
  const v0 = new GitClient({ baseUrl: base, token: TOKEN, gitProtocol: 0 });
  const clone = await v0.clone(owner, 'git-smoke');
  check('v0 clone protocol 0', clone.protocol === 0, String(clone.protocol));
  check('v0 clone has tip', clone.objects.has(tip3));
}

// 13. malformed POST does not kill the server
{
  const bad = await client.postRaw(owner, 'git-smoke', 'git-upload-pack', Buffer.from('zzzznot-a-pkt-line', 'ascii'));
  check('malformed POST answered', bad.status === 400, `got ${bad.status}`);
  const healthy = await client.infoRefs(owner, 'git-smoke', 'git-upload-pack');
  check('server healthy after malformed', healthy.status === 200, `got ${healthy.status}`);
  const clone = await client.clone(owner, 'git-smoke');
  check('clone intact after malformed', clone.objects.has(tip3));
}

console.log(`\nGIT: ${pass} pass, ${fail} fail`);
server.close();
process.exit(fail ? 1 : 0);
