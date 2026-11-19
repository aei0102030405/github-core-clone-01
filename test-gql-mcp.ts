// GraphQL + MCP smoke test.
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
const isRec = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
async function gql(query: string, variables: Record<string, unknown> = {}, token = TOKEN) {
  const r = await fetch(`${base}/api/graphql`, {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } : { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  return { status: r.status, json: await r.json() as unknown };
}
async function rest(method: string, path: string, body?: unknown) {
  const r = await fetch(base + path, { method, headers: H, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: await r.json() as unknown };
}

// Setup: a repo with a commit, issues, a PR.
await rest('POST', '/api/v3/user/repos', { name: 'gql-repo', private: false });
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
await rest('PUT', '/api/v3/repos/adaiversen/gql-repo/contents/src/app.ts', { message: 'base', content: b64('base\n') });
await rest('POST', '/api/v3/repos/adaiversen/gql-repo/git/refs', { ref: 'refs/heads/feature', sha: (await rest('GET', '/api/v3/repos/adaiversen/gql-repo/branches')).json ? '' : '' }).catch(() => undefined);
// Get the base tip properly:
const branches = (await rest('GET', '/api/v3/repos/adaiversen/gql-repo/branches')).json as { name: string; commit: { sha: string } }[];
const baseSha = branches.find((b) => b.name === 'main')!.commit.sha;
await rest('POST', '/api/v3/repos/adaiversen/gql-repo/git/refs', { ref: 'refs/heads/feature', sha: baseSha });
await rest('PUT', '/api/v3/repos/adaiversen/gql-repo/contents/src/app.ts', { message: 'feature', content: b64('feature\n'), branch: 'feature' });
const i1 = (await rest('POST', '/api/v3/repos/adaiversen/gql-repo/issues', { title: 'open one', body: 'b1' })).json as { number: number };
const i2 = (await rest('POST', '/api/v3/repos/adaiversen/gql-repo/issues', { title: 'open two', body: 'b2' })).json as { number: number };
const i3 = (await rest('POST', '/api/v3/repos/adaiversen/gql-repo/issues', { title: 'to close', body: 'b3' })).json as { number: number };
await rest('PATCH', `/api/v3/repos/adaiversen/gql-repo/issues/${i3.number}`, { state: 'closed' });
const pr = (await rest('POST', '/api/v3/repos/adaiversen/gql-repo/pulls', { title: 'the pr', body: 'pb', head: 'feature', base: 'main' })).json as { number: number };

// 1. viewer login
{
  const r = await gql('query ViewerLogin { viewer { login } }');
  check('viewer login', r.status === 200 && isRec(r.json) && isRec(r.json.data) && isRec(r.json.data.viewer) && r.json.data.viewer.login === 'adaiversen', JSON.stringify(r.json));
}
// 2. repository fields
let repoId = '';
{
  const r = await gql(
    'query RepositoryFields($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { id databaseId name owner { login } defaultBranchRef { name } viewerPermission hasIssuesEnabled } }',
    { owner: 'adaiversen', name: 'gql-repo' },
  );
  const node = isRec(r.json) && isRec(r.json.data) ? (r.json.data.repository as Record<string, unknown>) : null;
  check('repo fields 200', r.status === 200 && node !== null, JSON.stringify(r.json));
  if (node) {
    repoId = String(node.id);
    check('repo id non-empty string', typeof node.id === 'string' && node.id !== '' && node.id !== String(node.databaseId));
    check('repo databaseId positive int', typeof node.databaseId === 'number' && node.databaseId > 0);
    check('repo name', node.name === 'gql-repo');
    check('repo owner login', isRec(node.owner) && node.owner.login === 'adaiversen');
    check('repo defaultBranchRef', isRec(node.defaultBranchRef) && node.defaultBranchRef.name === 'main');
    check('repo viewerPermission', ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'].includes(String(node.viewerPermission)));
    check('repo hasIssuesEnabled', node.hasIssuesEnabled === true);
  }
}
// 3. introspection Issue
{
  const r = await gql('query Issue_fields { Issue: __type(name: "Issue") { fields(includeDeprecated: true) { name } } }');
  const fields = isRec(r.json) && isRec(r.json.data) && isRec(r.json.data.Issue) && Array.isArray(r.json.data.Issue.fields)
    ? (r.json.data.Issue.fields as { name: string }[]).map((f) => f.name) : [];
  check('Issue introspection has id/number/title/state/body', ['id', 'number', 'title', 'state', 'body'].every((f) => fields.includes(f)), fields.join(','));
}
// 4. introspection PullRequest + Repository + SearchType
{
  const r = await gql('query PullRequestAndRepositoryFields { PullRequest: __type(name: "PullRequest") { fields(includeDeprecated: true) { name } } Repository: __type(name: "Repository") { fields(includeDeprecated: true) { name } } }');
  const prFields = isRec(r.json) && isRec(r.json.data) && isRec(r.json.data.PullRequest) && Array.isArray(r.json.data.PullRequest.fields)
    ? (r.json.data.PullRequest.fields as { name: string }[]).map((f) => f.name) : [];
  const repoFields = isRec(r.json) && isRec(r.json.data) && isRec(r.json.data.Repository) && Array.isArray(r.json.data.Repository.fields)
    ? (r.json.data.Repository.fields as { name: string }[]).map((f) => f.name) : [];
  check('PR introspection', ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files'].every((f) => prFields.includes(f)), prFields.join(','));
  check('Repo introspection', ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'].every((f) => repoFields.includes(f)), repoFields.join(','));
  const s = await gql('query SearchType_enumValues { SearchType: __type(name: "SearchType") { enumValues(includeDeprecated: true) { name } } }');
  const vals = isRec(s.json) && isRec(s.json.data) && isRec(s.json.data.SearchType) && Array.isArray(s.json.data.SearchType.enumValues)
    ? (s.json.data.SearchType.enumValues as { name: string }[]).map((f) => f.name) : [];
  check('SearchType has ISSUE', vals.includes('ISSUE'), vals.join(','));
}
// 5. open issues DESC
{
  const r = await gql(
    'query OpenIssues($owner: String!, $name: String!, $first: Int!) { repository(owner: $owner, name: $name) { issues(first: $first, states: [OPEN], orderBy: {field: CREATED_AT, direction: DESC}) { nodes { number title state id } } } }',
    { owner: 'adaiversen', name: 'gql-repo', first: 10 },
  );
  const nodes = isRec(r.json) && isRec(r.json.data) && isRec(r.json.data.repository) && isRec(r.json.data.repository.issues)
    ? (r.json.data.repository.issues.nodes as { number: number; state: string }[]) : [];
  check('open issues 2, DESC', nodes.length === 2 && nodes[0]!.number > nodes[1]!.number && nodes.every((n) => n.state === 'OPEN'), JSON.stringify(nodes));
  check('open issues exclude closed', !nodes.some((n) => n.number === i3.number));
}
// 6. issue by number
{
  const r = await gql(
    'query IssueByNumber($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { issue(number: $number) { number title state id body } } }',
    { owner: 'adaiversen', name: 'gql-repo', number: i1.number },
  );
  const issue = isRec(r.json) && isRec(r.json.data) && isRec(r.json.data.repository) ? (r.json.data.repository.issue as Record<string, unknown>) : null;
  check('issue by number', issue !== null && issue.number === i1.number && issue.title === 'open one' && issue.state === 'OPEN' && issue.body === 'b1', JSON.stringify(issue));
}
// 7. createIssue mutation + REST parity
let createdIssueId = '';
{
  const r = await gql(
    'mutation IssueCreate($input: CreateIssueInput!) { createIssue(input: $input) { issue { number id } } }',
    { input: { repositoryId: repoId, title: 'gql created', body: 'gb' } },
  );
  const issue = isRec(r.json) && isRec(r.json.data) && isRec(r.json.data.createIssue) ? (r.json.data.createIssue.issue as Record<string, unknown>) : null;
  check('createIssue', issue !== null && typeof issue.number === 'number' && typeof issue.id === 'string' && issue.id !== '', JSON.stringify(r.json));
  if (issue) {
    createdIssueId = String(issue.id);
    const restIssue = (await rest('GET', `/api/v3/repos/adaiversen/gql-repo/issues/${issue.number}`)).json as Record<string, unknown>;
    check('createIssue REST parity', restIssue.title === 'gql created' && restIssue.state === 'open');
  }
}
// 8. closeIssue
{
  const r = await gql(
    'mutation IssueClose($input: CloseIssueInput!) { closeIssue(input: $input) { issue { number id state } } }',
    { input: { issueId: createdIssueId } },
  );
  const issue = isRec(r.json) && isRec(r.json.data) && isRec(r.json.data.closeIssue) ? (r.json.data.closeIssue.issue as Record<string, unknown>) : null;
  check('closeIssue CLOSED', issue !== null && issue.state === 'CLOSED', JSON.stringify(r.json));
}
// 9. pullRequests list
{
  const r = await gql(
    'query PullRequests($owner: String!, $name: String!, $first: Int!) { repository(owner: $owner, name: $name) { pullRequests(first: $first) { nodes { number headRefName baseRefName mergeable state } } } }',
    { owner: 'adaiversen', name: 'gql-repo', first: 5 },
  );
  const nodes = isRec(r.json) && isRec(r.json.data) && isRec(r.json.data.repository) && isRec(r.json.data.repository.pullRequests)
    ? (r.json.data.repository.pullRequests.nodes as Record<string, unknown>[]) : [];
  const node = nodes.find((n) => n.number === pr.number);
  check('pullRequests lists PR', node !== undefined && node.headRefName === 'feature' && node.baseRefName === 'main' && node.state === 'OPEN' && typeof node.mergeable === 'string', JSON.stringify(nodes));
}
// 10. pullRequest files
{
  const r = await gql(
    'query PullRequestFiles($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { number files(first: 10) { nodes { path } } } } }',
    { owner: 'adaiversen', name: 'gql-repo', number: pr.number },
  );
  const node = isRec(r.json) && isRec(r.json.data) && isRec(r.json.data.repository) ? (r.json.data.repository.pullRequest as Record<string, unknown>) : null;
  const paths = node && isRec(node.files) && Array.isArray(node.files.nodes) ? (node.files.nodes as { path: string }[]).map((n) => n.path) : [];
  check('PR files include src/app.ts', paths.includes('src/app.ts'), paths.join(','));
}
// 11. createPullRequest + mergePullRequest
{
  await rest('POST', '/api/v3/repos/adaiversen/gql-repo/git/refs', { ref: 'refs/heads/feature2', sha: baseSha });
  await rest('PUT', '/api/v3/repos/adaiversen/gql-repo/contents/other.txt', { message: 'f2', content: b64('o\n'), branch: 'feature2' });
  const r = await gql(
    'mutation PullRequestCreate($input: CreatePullRequestInput!) { createPullRequest(input: $input) { pullRequest { number id state headRefName baseRefName } } }',
    { input: { repositoryId: repoId, baseRefName: 'main', headRefName: 'feature2', title: 'gql pr' } },
  );
  const created = isRec(r.json) && isRec(r.json.data) && isRec(r.json.data.createPullRequest) ? (r.json.data.createPullRequest.pullRequest as Record<string, unknown>) : null;
  check('createPullRequest', created !== null && created.state === 'OPEN' && created.headRefName === 'feature2', JSON.stringify(r.json));
  if (created) {
    const m = await gql(
      'mutation MergePullRequest($input: MergePullRequestInput!) { mergePullRequest(input: $input) { pullRequest { number merged state } } }',
      { input: { pullRequestId: created.id, mergeMethod: 'SQUASH' } },
    );
    const merged = isRec(m.json) && isRec(m.json.data) && isRec(m.json.data.mergePullRequest) ? (m.json.data.mergePullRequest.pullRequest as Record<string, unknown>) : null;
    check('mergePullRequest merged', merged !== null && merged.merged === true, JSON.stringify(m.json));
    const restPr = (await rest('GET', `/api/v3/repos/adaiversen/gql-repo/pulls/${created.number}`)).json as Record<string, unknown>;
    check('mergePullRequest REST merged', restPr.merged === true && restPr.state === 'closed');
  }
}
// 12. addComment
{
  const r = await gql(
    'mutation AddComment($input: AddCommentInput!) { addComment(input: $input) { commentEdge { node { id body } } } }',
    { input: { subjectId: createdIssueId, body: 'gql comment' } },
  );
  const node = isRec(r.json) && isRec(r.json.data) && isRec(r.json.data.addComment) && isRec(r.json.data.addComment.commentEdge)
    ? (r.json.data.addComment.commentEdge.node as Record<string, unknown>) : null;
  check('addComment', node !== null && node.body === 'gql comment' && typeof node.id === 'string', JSON.stringify(r.json));
}
// 13. invalid field -> 200 with errors naming it
{
  const r = await gql('query ViewerInvalidField { viewer { login noSuchFieldOnViewer } }');
  check('invalid field 200 + errors', r.status === 200 && isRec(r.json) && Array.isArray(r.json.errors) && (r.json.errors as { message: string }[]).some((e) => e.message.includes('noSuchFieldOnViewer')), JSON.stringify(r.json));
}
// 14. unauthenticated -> 401
{
  const r = await gql('query ViewerLogin { viewer { login } }', {}, '');
  check('graphql unauth 401', r.status === 401, `got ${r.status}`);
}
// 15. node(id)
{
  const r = await gql('query NodeRepository($id: ID!) { node(id: $id) { id ... on Repository { name nameWithOwner } } }', { id: repoId });
  const node = isRec(r.json) && isRec(r.json.data) ? (r.json.data.node as Record<string, unknown>) : null;
  check('node repo', node !== null && node.id === repoId && node.name === 'gql-repo' && node.nameWithOwner === 'adaiversen/gql-repo', JSON.stringify(node));
}
// 16. unknown repository -> null, no errors
{
  const r = await gql(
    'query RepositoryFields($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { id } }',
    { owner: 'adaiversen', name: 'gql-repo-missing' },
  );
  check('unknown repo null no errors', r.status === 200 && isRec(r.json) && isRec(r.json.data) && r.json.data.repository === null && !Array.isArray(r.json.errors), JSON.stringify(r.json));
}
// 17. batched operations
{
  const r = await fetch(`${base}/api/graphql`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify([
      { query: 'query ViewerLogin { viewer { login } }', variables: {} },
      { query: 'query Issue_fields { Issue: __type(name: "Issue") { fields(includeDeprecated: true) { name } } }', variables: {} },
    ]),
  });
  const body = await r.json() as unknown[];
  check('batched 2 in order', r.status === 200 && Array.isArray(body) && body.length === 2
    && isRec(body[0]) && isRec(body[0].data) && isRec(body[0].data.viewer) && body[0].data.viewer.login === 'adaiversen'
    && isRec(body[1]) && isRec(body[1].data) && isRec(body[1].data.Issue), JSON.stringify(body).slice(0, 200));
}
// 18. global id stability + opacity
{
  const q = 'query RepositoryFields($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { id databaseId } }';
  const a = await gql(q, { owner: 'adaiversen', name: 'gql-repo' });
  const b = await gql(q, { owner: 'adaiversen', name: 'gql-repo' });
  const idA = isRec(a.json) && isRec(a.json.data) && isRec(a.json.data.repository) ? String(a.json.data.repository.id) : '';
  const idB = isRec(b.json) && isRec(b.json.data) && isRec(b.json.data.repository) ? String(b.json.data.repository.id) : '';
  const dbId = isRec(a.json) && isRec(a.json.data) && isRec(a.json.data.repository) ? String(a.json.data.repository.databaseId) : '';
  check('global id stable + opaque', idA !== '' && idA === idB && idA !== dbId, `${idA} vs ${dbId}`);
}
// 19. issues pagination (cursor)
{
  await rest('POST', '/api/v3/user/repos', { name: 'gql-pages' });
  for (let i = 1; i <= 7; i += 1) await rest('POST', '/api/v3/repos/adaiversen/gql-pages/issues', { title: `page ${i}`, body: 'b' });
  const q = 'query IssuesPage($owner: String!, $name: String!, $first: Int!, $after: String) { repository(owner: $owner, name: $name) { issues(first: $first, after: $after) { nodes { number } pageInfo { hasNextPage endCursor } } } }';
  const p1 = await gql(q, { owner: 'adaiversen', name: 'gql-pages', first: 5, after: null });
  const c1 = isRec(p1.json) && isRec(p1.json.data) && isRec(p1.json.data.repository) ? (p1.json.data.repository.issues as { nodes: { number: number }[]; pageInfo: { hasNextPage: boolean; endCursor: string } }) : null;
  check('page1 5 + hasNext', c1 !== null && c1.nodes.length === 5 && c1.pageInfo.hasNextPage === true && typeof c1.pageInfo.endCursor === 'string' && c1.pageInfo.endCursor !== '', JSON.stringify(c1));
  if (c1) {
    const p2 = await gql(q, { owner: 'adaiversen', name: 'gql-pages', first: 5, after: c1.pageInfo.endCursor });
    const c2 = isRec(p2.json) && isRec(p2.json.data) && isRec(p2.json.data.repository) ? (p2.json.data.repository.issues as { nodes: { number: number }[]; pageInfo: { hasNextPage: boolean } }) : null;
    const seen = new Set([...c1.nodes, ...(c2?.nodes ?? [])].map((n) => n.number));
    check('page2 2 + no next + all 7', c2 !== null && c2.nodes.length === 2 && c2.pageInfo.hasNextPage === false && seen.size === 7, JSON.stringify(c2));
  }
}

console.log(`\nGRAPHQL: ${pass} pass, ${fail} fail`);

// ---------------- MCP ----------------
let mpass = 0;
let mfail = 0;
function mcheck(name: string, cond: boolean, extra = '') {
  if (cond) { mpass += 1; console.log(`PASS ${name}`); }
  else { mfail += 1; console.log(`FAIL ${name} ${extra}`); }
}
let rpcId = 1;
async function mcp(method: string, params: Record<string, unknown> = {}, token = TOKEN, rawBody?: string) {
  const body = rawBody ?? JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method, params: { ...params, _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', protocolVersion: '2026-07-28' } } });
  const r = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: token
      ? { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'Mcp-Method': method }
      : { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'Mcp-Method': method },
    body,
  });
  const text = await r.text();
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, text };
}
// discover
{
  const r = await mcp('server/discover', {});
  const result = isRec(r.json) && isRec(r.json.result) ? r.json.result : null;
  check('mcp discover', r.status === 200 && result !== null && Array.isArray(result.supportedVersions) && (result.supportedVersions as string[]).includes('2026-07-28'), JSON.stringify(r.json).slice(0, 300));
}
// initialize (legacy)
{
  const r = await mcp('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  const result = isRec(r.json) && isRec(r.json.result) ? r.json.result : null;
  check('mcp initialize', r.status === 200 && result !== null && typeof result.protocolVersion === 'string' && isRec(result.serverInfo) && typeof result.serverInfo.name === 'string', JSON.stringify(r.json).slice(0, 300));
}
// tools/list
let tools: { name: string; description: string; inputSchema: { type: string; required: string[] } }[] = [];
{
  const r = await mcp('tools/list', {});
  const result = isRec(r.json) && isRec(r.json.result) ? r.json.result : null;
  tools = result && Array.isArray(result.tools) ? result.tools as typeof tools : [];
  check('mcp tools/list >=6', tools.length >= 6, `got ${tools.length}`);
  const names = tools.map((t) => t.name);
  check('mcp six tools present', ['create_repo', 'get_repo', 'create_issue', 'list_issues', 'create_pull_request', 'merge_pull_request'].every((n) => names.includes(n)), names.join(','));
  check('mcp tool schemas', tools.every((t) => typeof t.description === 'string' && t.description !== '' && isRec(t.inputSchema) && t.inputSchema.type === 'object'));
  const r2 = await mcp('tools/list', {});
  const tools1 = isRec(r.json) && isRec(r.json.result) ? r.json.result.tools : null;
  const tools2 = isRec(r2.json) && isRec(r2.json.result) ? r2.json.result.tools : null;
  check('mcp tools/list idempotent', JSON.stringify(tools1) === JSON.stringify(tools2), 'tools differ');
}
// tools/call create_repo
{
  const r = await mcp('tools/call', { name: 'create_repo', arguments: { name: 'mcp-repo', description: 'd', private: true } });
  const result = isRec(r.json) && isRec(r.json.result) ? r.json.result : null;
  check('mcp create_repo', r.status === 200 && result !== null && result.isError !== true && isRec(result.structuredContent) && result.structuredContent.name === 'mcp-repo', JSON.stringify(r.json).slice(0, 300));
}
// tools/call create_issue + REST parity
{
  const r = await mcp('tools/call', { name: 'create_issue', arguments: { owner: 'adaiversen', repo: 'mcp-repo', title: 'mcp issue', body: 'mb' } });
  const result = isRec(r.json) && isRec(r.json.result) ? r.json.result : null;
  check('mcp create_issue', result !== null && result.isError !== true, JSON.stringify(r.json).slice(0, 300));
  const listed = (await rest('GET', '/api/v3/repos/adaiversen/mcp-repo/issues?state=all&per_page=100')).json as { title: string; number: number }[];
  check('mcp create_issue REST parity', Array.isArray(listed) && listed.some((i) => i.title === 'mcp issue'));
}
// tools/call list_issues
{
  const r = await mcp('tools/call', { name: 'list_issues', arguments: { owner: 'adaiversen', repo: 'mcp-repo', state: 'open' } });
  const result = isRec(r.json) && isRec(r.json.result) ? r.json.result : null;
  const text = JSON.stringify(result);
  check('mcp list_issues finds issue', result !== null && result.isError !== true && text.includes('mcp issue'), text.slice(0, 300));
}
// tools/call create_pull_request + merge
{
  await rest('PUT', '/api/v3/repos/adaiversen/mcp-repo/contents/base.txt', { message: 'base', content: b64('base\n') });
  const tip = ((await rest('GET', '/api/v3/repos/adaiversen/mcp-repo/branches')).json as { name: string; commit: { sha: string } }[]).find((b) => b.name === 'main')!.commit.sha;
  await rest('POST', '/api/v3/repos/adaiversen/mcp-repo/git/refs', { ref: 'refs/heads/mcp-head', sha: tip });
  await rest('PUT', '/api/v3/repos/adaiversen/mcp-repo/contents/head.txt', { message: 'head', content: b64('h\n'), branch: 'mcp-head' });
  const r = await mcp('tools/call', { name: 'create_pull_request', arguments: { owner: 'adaiversen', repo: 'mcp-repo', title: 'mcp pr', head: 'mcp-head', base: 'main' } });
  const result = isRec(r.json) && isRec(r.json.result) ? r.json.result : null;
  const num = result && isRec(result.structuredContent) ? Number(result.structuredContent.number) : NaN;
  check('mcp create_pull_request', result !== null && result.isError !== true && Number.isFinite(num), JSON.stringify(r.json).slice(0, 300));
  if (Number.isFinite(num)) {
    const m = await mcp('tools/call', { name: 'merge_pull_request', arguments: { owner: 'adaiversen', repo: 'mcp-repo', pull_number: num } });
    const mres = isRec(m.json) && isRec(m.json.result) ? m.json.result : null;
    check('mcp merge_pull_request', mres !== null && mres.isError !== true, JSON.stringify(m.json).slice(0, 300));
    const prRest = (await rest('GET', `/api/v3/repos/adaiversen/mcp-repo/pulls/${num}`)).json as Record<string, unknown>;
    check('mcp merge REST merged', prRest.merged === true);
  }
}
// unknown tool
{
  const r = await mcp('tools/call', { name: 'mcp_no_such_tool_x', arguments: {} });
  const err = isRec(r.json) && isRec(r.json.error) ? r.json.error : null;
  check('mcp unknown tool -32602/-32601', err !== null && (err.code === -32602 || err.code === -32601) && r.status !== 500, JSON.stringify(r.json));
}
// parse error
{
  const r = await mcp('tools/list', {}, TOKEN, '{"jsonrpc": "2.0", "id": 424242, "method": "tools/list"');
  const err = isRec(r.json) && isRec(r.json.error) ? r.json.error : null;
  check('mcp parse error 400 -32700', r.status === 400 && err !== null && err.code === -32700, `status=${r.status} ${r.text.slice(0, 200)}`);
}
// missing arguments
{
  const r = await mcp('tools/call', { name: 'create_issue', arguments: {} });
  const err = isRec(r.json) && isRec(r.json.error) ? r.json.error : null;
  const result = isRec(r.json) && isRec(r.json.result) ? r.json.result : null;
  check('mcp missing args -32602 or isError', (err !== null && err.code === -32602) || (result !== null && result.isError === true), JSON.stringify(r.json).slice(0, 200));
}
// concurrent calls keep ids
{
  const idA = 'concurrent-left-x';
  const idB = 'concurrent-right-x';
  const mk = (id: string, repo: string) => fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', 'Mcp-Method': 'tools/call' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'get_repo', arguments: { owner: 'adaiversen', repo }, _meta: {} } }),
  }).then(async (r) => ({ status: r.status, json: await r.json() as unknown }));
  const [a, b] = await Promise.all([mk(idA, 'mcp-repo'), mk(idB, 'gql-repo')]);
  const aId = isRec(a.json) ? a.json.id : null;
  const bId = isRec(b.json) ? b.json.id : null;
  check('mcp concurrent ids', aId === idA && bId === idB, `${String(aId)} / ${String(bId)}`);
  check('mcp concurrent own objects', JSON.stringify(a.json).includes('mcp-repo') && JSON.stringify(b.json).includes('gql-repo'));
}
// auth required
{
  const r = await mcp('tools/call', { name: 'create_issue', arguments: { owner: 'no-auth', repo: 'x', title: 't' } }, '');
  check('mcp auth 401', r.status === 401, `got ${r.status}`);
}

console.log(`\nMCP: ${mpass} pass, ${mfail} fail`);
console.log(`\nTOTAL: ${pass + mpass} pass, ${fail + mfail} fail`);
server.close();
process.exit(fail + mfail ? 1 : 0);
