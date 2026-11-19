// Smoke test for the forge: REST + contents + issues + pulls.
import { createApp } from './app.ts';

const server = createApp();
await new Promise<void>((resolve) => server.listen(0, resolve));
const port = (server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}`;
const TOKEN = 'test-token-123';
process.env.MAKEFUN_SHOP_TOKEN = TOKEN;
const H = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) { pass += 1; console.log(`PASS ${name}`); }
  else { fail += 1; console.log(`FAIL ${name} ${extra}`); }
}
async function req(method: string, path: string, body?: unknown, headers: Record<string, string> = H) {
  const r = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, headers: r.headers, json, text };
}
const isRec = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

// 1. create repo
let r = await req('POST', '/api/v3/user/repos', { name: 'smoke-repo', private: true, description: 'smoke' });
check('create repo 201', r.status === 201, `got ${r.status} ${r.text}`);
const repo = isRec(r.json) ? r.json : {};
check('repo name', repo.name === 'smoke-repo');
check('repo default_branch', repo.default_branch === 'main');
check('request-id header', (r.headers.get('x-github-request-id') ?? '') !== '');

// 2. duplicate -> 422
r = await req('POST', '/api/v3/user/repos', { name: 'smoke-repo' });
check('duplicate repo 422', r.status === 422, `got ${r.status}`);

// 3. create file via contents (unborn repo)
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
r = await req('PUT', '/api/v3/repos/adaiversen/smoke-repo/contents/docs/readme.md', { message: 'seed', content: b64('hello world\n') });
check('contents PUT 201', r.status === 201, `got ${r.status} ${r.text}`);
const putBody = isRec(r.json) ? r.json : {};
const commitSha = isRec(putBody.commit) ? String(putBody.commit.sha) : '';
const contentSha = isRec(putBody.content) ? String(putBody.content.sha) : '';
check('commit sha 40-hex', /^[0-9a-f]{40}$/.test(commitSha), commitSha);
check('content sha 40-hex', /^[0-9a-f]{40}$/.test(contentSha), contentSha);

// 4. GET the file
r = await req('GET', '/api/v3/repos/adaiversen/smoke-repo/contents/docs/readme.md');
check('contents GET 200', r.status === 200, `got ${r.status}`);
check('contents base64', isRec(r.json) && r.json.content === b64('hello world\n'));
check('contents type file', isRec(r.json) && r.json.type === 'file');

// 5. GET the directory
r = await req('GET', '/api/v3/repos/adaiversen/smoke-repo/contents/docs');
check('contents dir 200 array', r.status === 200 && Array.isArray(r.json) && r.json.length === 1, `got ${r.status} ${r.text}`);

// 6. update with correct sha -> 200
r = await req('PUT', '/api/v3/repos/adaiversen/smoke-repo/contents/docs/readme.md', { message: 'v2', content: b64('hello v2\n'), sha: contentSha });
check('contents update 200', r.status === 200, `got ${r.status} ${r.text}`);

// 7. stale sha -> 409
r = await req('PUT', '/api/v3/repos/adaiversen/smoke-repo/contents/docs/readme.md', { message: 'v3', content: b64('x'), sha: contentSha });
check('contents stale sha 409', r.status === 409, `got ${r.status}`);

// 8. branches + commits
r = await req('GET', '/api/v3/repos/adaiversen/smoke-repo/branches');
check('branches lists main', r.status === 200 && Array.isArray(r.json) && r.json.some((b: unknown) => isRec(b) && b.name === 'main'));
r = await req('GET', '/api/v3/repos/adaiversen/smoke-repo/commits');
check('commits lists 2', r.status === 200 && Array.isArray(r.json) && r.json.length === 2, `got ${r.status} ${JSON.stringify(r.json)?.slice(0, 200)}`);
check('commit message', Array.isArray(r.json) && isRec(r.json[0]) && isRec(r.json[0].commit) && (r.json[0].commit as Record<string, unknown>).message === 'v2');

// 9. create branch via git/refs
const tip = Array.isArray((await req('GET', '/api/v3/repos/adaiversen/smoke-repo/commits')).json)
  ? String(((((await req('GET', '/api/v3/repos/adaiversen/smoke-repo/commits')).json) as unknown[])[0] as Record<string, unknown>).sha)
  : '';
r = await req('POST', '/api/v3/repos/adaiversen/smoke-repo/git/refs', { ref: 'refs/heads/feature', sha: tip });
check('create branch 201', r.status === 201, `got ${r.status} ${r.text}`);
r = await req('GET', '/api/v3/repos/adaiversen/smoke-repo/branches');
check('branches lists feature', Array.isArray(r.json) && r.json.some((b: unknown) => isRec(b) && b.name === 'feature'));

// 10. commit on feature via contents with branch
r = await req('PUT', '/api/v3/repos/adaiversen/smoke-repo/contents/feature.txt', { message: 'feature work', content: b64('feature\n'), branch: 'feature' });
check('contents on feature 201', r.status === 201, `got ${r.status} ${r.text}`);

// 11. labels
r = await req('POST', '/api/v3/repos/adaiversen/smoke-repo/labels', { name: 'bug', color: 'd73a4a' });
check('label 201', r.status === 201 && isRec(r.json) && r.json.name === 'bug', `got ${r.status} ${r.text}`);

// 12. issues
r = await req('POST', '/api/v3/repos/adaiversen/smoke-repo/issues', { title: 'first issue', body: 'body here', labels: ['bug'] });
check('issue 201', r.status === 201 && isRec(r.json) && r.json.number === 1 && r.json.state === 'open', `got ${r.status} ${r.text}`);
r = await req('POST', '/api/v3/repos/adaiversen/smoke-repo/issues', { title: 'second issue', body: 'b2' });
check('issue 2 number 2', r.status === 201 && isRec(r.json) && r.json.number === 2);
r = await req('POST', '/api/v3/repos/adaiversen/smoke-repo/issues', { title: 'bad', labels: ['nope'] });
check('issue bad label 422', r.status === 422, `got ${r.status}`);
r = await req('GET', '/api/v3/repos/adaiversen/smoke-repo/issues?state=open&sort=created&direction=asc');
check('issues asc', r.status === 200 && Array.isArray(r.json) && (r.json[0] as Record<string, unknown>).number === 1);
r = await req('GET', '/api/v3/repos/adaiversen/smoke-repo/issues?state=open&sort=created&direction=desc');
check('issues desc', r.status === 200 && Array.isArray(r.json) && (r.json[0] as Record<string, unknown>).number === 2);
r = await req('PATCH', '/api/v3/repos/adaiversen/smoke-repo/issues/2', { state: 'closed' });
check('issue close 200', r.status === 200 && isRec(r.json) && r.json.state === 'closed');
r = await req('GET', '/api/v3/repos/adaiversen/smoke-repo/issues?state=open');
check('issues open excludes closed', r.status === 200 && Array.isArray(r.json) && r.json.length === 1);
r = await req('POST', '/api/v3/repos/adaiversen/smoke-repo/issues/1/comments', { body: 'a comment' });
check('comment 201', r.status === 201 && isRec(r.json) && typeof r.json.id === 'number', `got ${r.status} ${r.text}`);
r = await req('GET', '/api/v3/repos/adaiversen/smoke-repo/issues/1/comments');
check('comments list', r.status === 200 && Array.isArray(r.json) && r.json.length === 1 && (r.json[0] as Record<string, unknown>).body === 'a comment');

// 13. pulls
r = await req('POST', '/api/v3/repos/adaiversen/smoke-repo/pulls', { title: 'my pr', body: 'pr body', head: 'feature', base: 'main' });
check('pr 201', r.status === 201 && isRec(r.json) && r.json.number === 1 && r.json.state === 'open', `got ${r.status} ${r.text}`);
const pr = isRec(r.json) ? r.json : {};
check('pr head sha', typeof pr.head === 'object' && isRec(pr.head) && /^[0-9a-f]{40}$/.test(String(pr.head.sha)));
r = await req('GET', '/api/v3/repos/adaiversen/smoke-repo/pulls/1/files');
check('pr files has feature.txt', r.status === 200 && Array.isArray(r.json) && r.json.some((f: unknown) => isRec(f) && f.filename === 'feature.txt' && f.status === 'added'), `got ${r.status} ${r.text}`);
r = await req('PUT', '/api/v3/repos/adaiversen/smoke-repo/pulls/1/merge', { merge_method: 'squash' });
check('pr merge 200', r.status === 200 && isRec(r.json) && r.json.merged === true && /^[0-9a-f]{40}$/.test(String(r.json.sha)), `got ${r.status} ${r.text}`);
const mergeSha = isRec(r.json) ? String(r.json.sha) : '';
r = await req('GET', '/api/v3/repos/adaiversen/smoke-repo/pulls/1');
check('pr closed + merged', r.status === 200 && isRec(r.json) && r.json.state === 'closed' && r.json.merged === true && r.json.merge_commit_sha === mergeSha && typeof r.json.merged_at === 'string');
r = await req('GET', '/api/v3/repos/adaiversen/smoke-repo/contents/feature.txt');
check('merge content on default', r.status === 200 && isRec(r.json) && r.json.content === b64('feature\n'));
r = await req('GET', '/api/v3/repos/adaiversen/smoke-repo/commits');
check('merge commit on default', r.status === 200 && Array.isArray(r.json) && (r.json[0] as Record<string, unknown>).sha === mergeSha);
r = await req('PUT', '/api/v3/repos/adaiversen/smoke-repo/pulls/99/merge', { merge_method: 'squash' });
check('merge unknown 404', r.status === 404, `got ${r.status}`);
r = await req('GET', '/api/v3/repos/adaiversen/smoke-repo/pulls?state=all');
check('pulls all lists merged', r.status === 200 && Array.isArray(r.json) && r.json.length === 1);
r = await req('GET', '/api/v3/repos/adaiversen/smoke-repo/pulls');
check('pulls default open empty', r.status === 200 && Array.isArray(r.json) && r.json.length === 0);

// 14. pagination of /user/repos
for (let i = 0; i < 12; i += 1) {
  await req('POST', '/api/v3/user/repos', { name: `page-repo-${i}` });
}
r = await req('GET', '/api/v3/user/repos?per_page=10&page=1');
const link = r.headers.get('link') ?? '';
check('repos page1 has next link', r.status === 200 && Array.isArray(r.json) && r.json.length === 10 && link.includes('rel="next"'), `link=${link}`);
r = await req('GET', '/api/v3/user/repos?per_page=10&page=2');
check('repos page2 has 3', r.status === 200 && Array.isArray(r.json) && r.json.length === 3, `got ${Array.isArray(r.json) ? r.json.length : r.status}`);

// 15. foreign owner 404, missing repo 404, unknown route 404, malformed 400
r = await req('GET', '/api/v3/repos/olgabauer/smoke-repo');
check('foreign owner 404', r.status === 404, `got ${r.status}`);
r = await req('GET', '/api/v3/repos/adaiversen/no-such-repo');
check('missing repo 404', r.status === 404, `got ${r.status}`);
r = await req('GET', '/api/v3/nope');
check('unknown route 404 json', r.status === 404 && isRec(r.json) && typeof r.json.message === 'string');
const bad = await fetch(base + '/api/v3/user/repos', { method: 'POST', headers: H, body: '{not json' });
check('malformed body 400', bad.status === 400, `got ${bad.status}`);
const ct = await fetch(base + '/api/v3/user/repos', { headers: H });
check('content-type json', (ct.headers.get('content-type') ?? '').includes('application/json'));

// 16. delete
r = await req('DELETE', '/api/v3/repos/adaiversen/page-repo-0');
check('delete 204', r.status === 204, `got ${r.status}`);
r = await req('GET', '/api/v3/repos/adaiversen/page-repo-0');
check('deleted repo 404', r.status === 404, `got ${r.status}`);

console.log(`\nREST: ${pass} pass, ${fail} fail`);
server.close();
process.exit(fail ? 1 : 0);
