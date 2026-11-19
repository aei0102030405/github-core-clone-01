// rest.ts — GitHub REST v3. All replies are application/json with a non-empty
// X-GitHub-Request-Id; errors are {message: string}. Auth: Bearer token required
// (no token -> 401); a repo under another owner is 404, never 403.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  sendJson,
  sendError,
  readBody,
  parseJsonBody,
  isRecord,
  isAuthenticated,
  queryOf,
  segments,
  nextRequestId,
} from './http.ts';
import {
  store,
  VIEWER_LOGIN,
  VIEWER_ID,
  VIEWER_EMAIL,
  FIXED_ISO,
  type Repo,
  type Issue,
  type Pull,
} from './store.ts';
import { isObjectId, parseCommit } from './gitproto.ts';
import { clearFetchCache } from './git.ts';

const BASE = '/api/v3';

// ---------------------------------------------------------------- shapes

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: repo.owner === VIEWER_LOGIN ? VIEWER_ID : 2000 + repo.id, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    pushed_at: FIXED_ISO,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    url: `${BASE}/repos/${repo.owner}/${repo.name}`,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    open_issues_count: repo.issues.filter((i) => i.state === 'open').length,
  };
}

function labelJson(label: { name: string; color: string; description: string }): Record<string, unknown> {
  return { id: 0, name: label.name, color: label.color, description: label.description, default: false };
}

export function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: `I_${repo.id}_${issue.number}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((l) => ({ name: l.name, color: l.color })),
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    closed_at: issue.state === 'closed' ? FIXED_ISO : null,
    comments: issue.comments.length,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `${BASE}/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function commentJson(repo: Repo, issue: Issue, comment: { id: number; body: string }): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: `C_${repo.id}_${issue.number}_${comment.id}`,
    body: comment.body,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
    url: `${BASE}/repos/${repo.owner}/${repo.name}/issues/comments/${comment.id}`,
  };
}

export function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: `PR_${repo.id}_${pull.number}`,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: { ref: pull.head, sha: pull.headSha, label: `${repo.owner}:${pull.head}` },
    base: { ref: pull.base, sha: pull.baseSha, label: `${repo.owner}:${pull.base}` },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: pull.mergeable,
    mergeable_state: pull.mergeable ? 'clean' : 'dirty',
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    closed_at: pull.state === 'closed' ? FIXED_ISO : null,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `${BASE}/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

// ---------------------------------------------------------------- pagination

interface Page {
  page: number;
  perPage: number;
}

function pageOf(query: URLSearchParams): Page {
  const page = Math.max(1, Number.parseInt(query.get('page') ?? '1', 10) || 1);
  const perPageRaw = Number.parseInt(query.get('per_page') ?? '30', 10);
  const perPage = Number.isFinite(perPageRaw) ? Math.min(100, Math.max(1, perPageRaw)) : 30;
  return { page, perPage };
}

function paginate<T>(items: readonly T[], page: Page): { slice: T[]; total: number; lastPage: number } {
  const total = items.length;
  const lastPage = Math.max(1, Math.ceil(total / page.perPage));
  const start = (page.page - 1) * page.perPage;
  return { slice: items.slice(start, start + page.perPage), total, lastPage };
}

/** GitHub's Link header for a paginated collection. Absolute URLs: the suite's
 * sameOrigin check does `new URL(next)` with no base, so a relative URL fails
 * as "left the entry's origin". */
function linkHeader(req: IncomingMessage, page: Page, lastPage: number): string {
  const host = req.headers.host ?? 'localhost';
  const path = req.url?.split('?')[0] ?? '';
  const base = `http://${host}${path}`;
  const query = queryOf(req);
  const mk = (p: number, rel: string): string => {
    query.set('page', String(p));
    return `<${base}?${query.toString()}>; rel="${rel}"`;
  };
  const parts: string[] = [];
  if (page.page < lastPage) parts.push(mk(page.page + 1, 'next'), mk(lastPage, 'last'));
  if (page.page > 1) parts.push(mk(1, 'first'), mk(page.page - 1, 'prev'));
  return parts.join(', ');
}

// ---------------------------------------------------------------- helpers

function repoOr404(res: ServerResponse, owner: string, name: string): Repo | null {
  if (owner !== VIEWER_LOGIN) {
    sendError(res, 404, 'Not Found');
    return null;
  }
  const repo = store.getRepo(owner, name);
  if (!repo) {
    sendError(res, 404, 'Not Found');
    return null;
  }
  return repo;
}

function branchCommits(repo: Repo, branch: string): { sha: string; message: string; author: string; committer: string; tree: string; parents: string[] }[] {
  const tip = store.branchTip(repo, branch);
  if (!tip) return [];
  const out: { sha: string; message: string; author: string; committer: string; tree: string; parents: string[] }[] = [];
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = store.getObject(oid);
    if (!obj || obj.type !== 'commit') continue;
    const commit = parseCommit(obj.data);
    out.push({ sha: oid, message: commit.message, author: commit.author, committer: commit.committer, tree: commit.tree, parents: commit.parents });
    for (const parent of commit.parents) queue.push(parent);
  }
  return out;
}

function personOf(line: string): { name: string; email: string; date: string } {
  // "Name <email> 1700000000 +0000"
  const m = /^(.*?) <(.*?)> (\d+) ([+-]\d{4})$/.exec(line);
  if (!m) return { name: line, email: '', date: FIXED_ISO };
  const ts = Number(m[3]) * 1000;
  return { name: m[1] ?? '', email: m[2] ?? '', date: new Date(ts).toISOString() };
}

// ---------------------------------------------------------------- the router

export async function handleRest(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
  const method = req.method ?? 'GET';
  const seg = segments(path);
  // seg[0] is 'api', seg[1] is 'v3' for every REST route.
  if (seg[0] !== 'api' || seg[1] !== 'v3') return false;

  // The API root and meta need no token (the starter answered them bare).
  if (method === 'GET' && (path === '/api/v3' || path === '/api/v3/')) {
    sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
    return true;
  }
  if (method === 'GET' && path === '/api/v3/meta') {
    sendJson(res, 200, { verifiable_password_authentication: true, installed_version: '1.0.0' });
    return true;
  }

  // Every other REST route requires the bearer token.
  if (!isAuthenticated(req)) {
    sendError(res, 401, 'Requires authentication');
    return true;
  }

  const query = queryOf(req);
  const rest = seg.slice(2); // after api/v3

  // ---- /user ------------------------------------------------------------
  if (rest[0] === 'user' && rest.length === 1) {
    if (method === 'GET') {
      sendJson(res, 200, {
        login: VIEWER_LOGIN, id: VIEWER_ID, node_id: `U_${VIEWER_ID}`, name: 'ada iversen',
        email: VIEWER_EMAIL, type: 'User', html_url: `https://github.com/${VIEWER_LOGIN}`,
        url: `${BASE}/users/${VIEWER_LOGIN}`, created_at: FIXED_ISO, updated_at: FIXED_ISO,
      });
      return true;
    }
    sendError(res, 404, 'Not Found');
    return true;
  }

  // ---- /user/repos ------------------------------------------------------
  if (rest[0] === 'user' && rest[1] === 'repos' && rest.length === 2) {
    if (method === 'GET') {
      const page = pageOf(query);
      const all = store.listRepos(VIEWER_LOGIN);
      const { slice, lastPage } = paginate(all, page);
      const link = linkHeader(req, page, lastPage);
      sendJson(res, 200, slice.map(repoJson), link ? { link } : {});
      return true;
    }
    if (method === 'POST') {
      const body = await readBody(req);
      const parsed = parseJsonBody(body);
      if (!parsed.ok) {
        sendError(res, 400, 'Problems parsing JSON');
        return true;
      }
      const value = isRecord(parsed.value) ? parsed.value : {};
      const name = typeof value.name === 'string' ? value.name : '';
      if (!name) {
        sendError(res, 422, 'Validation Failed: name is required');
        return true;
      }
      if (store.getRepo(VIEWER_LOGIN, name)) {
        sendError(res, 422, 'Repository creation failed. name already exists on this account');
        return true;
      }
      const repo = store.createRepo(VIEWER_LOGIN, name, {
        description: typeof value.description === 'string' ? value.description : '',
        private: value.private === true,
      });
      sendJson(res, 201, repoJson(repo));
      return true;
    }
    sendError(res, 404, 'Not Found');
    return true;
  }

  // ---- /repos/{owner}/{name}/... ---------------------------------------
  if (rest[0] === 'repos' && rest.length >= 3) {
    const owner = rest[1]!;
    const name = rest[2]!;
    const tail = rest.slice(3);

    // GET /repos/{o}/{r} and PATCH / DELETE
    if (tail.length === 0) {
      if (method === 'GET') {
        const repo = repoOr404(res, owner, name);
        if (!repo) return true;
        sendJson(res, 200, repoJson(repo));
        return true;
      }
      if (method === 'PATCH') {
        const repo = repoOr404(res, owner, name);
        if (!repo) return true;
        const body = await readBody(req);
        const parsed = parseJsonBody(body);
        if (!parsed.ok) {
          sendError(res, 400, 'Problems parsing JSON');
          return true;
        }
        const value = isRecord(parsed.value) ? parsed.value : {};
        if (typeof value.description === 'string') repo.description = value.description;
        if (typeof value.private === 'boolean') repo.private = value.private;
        sendJson(res, 200, repoJson(repo));
        return true;
      }
      if (method === 'DELETE') {
        const repo = repoOr404(res, owner, name);
        if (!repo) return true;
        store.deleteRepo(owner, name);
        clearFetchCache();
        res.writeHead(204, { 'x-github-request-id': nextRequestId() });
        res.end();
        return true;
      }
      sendError(res, 404, 'Not Found');
      return true;
    }

    const repo = repoOr404(res, owner, name);
    if (!repo) return true;

    // ---- branches -------------------------------------------------------
    if (tail[0] === 'branches') {
      if (method === 'GET' && tail.length === 1) {
        const out: Record<string, unknown>[] = [];
        for (const [ref, oid] of store.allRefs(repo)) {
          if (!ref.startsWith('refs/heads/')) continue;
          out.push({ name: ref.slice('refs/heads/'.length), commit: { sha: oid } });
        }
        sendJson(res, 200, out);
        return true;
      }
      if (method === 'GET' && tail.length === 2) {
        const branch = tail[1]!;
        const tip = store.branchTip(repo, branch);
        if (!tip) {
          sendError(res, 404, 'Branch not found');
          return true;
        }
        sendJson(res, 200, { name: branch, commit: { sha: tip } });
        return true;
      }
      sendError(res, 404, 'Not Found');
      return true;
    }

    // ---- commits --------------------------------------------------------
    if (tail[0] === 'commits' && tail.length === 1 && method === 'GET') {
      const branch = query.get('sha') ?? repo.defaultBranch;
      const list = branchCommits(repo, branch);
      sendJson(
        res,
        200,
        list.map((c) => ({
          sha: c.sha,
          commit: {
            message: c.message,
            author: personOf(c.author),
            committer: personOf(c.committer),
            tree: { sha: c.tree },
          },
          parents: c.parents.map((p) => ({ sha: p })),
        })),
      );
      return true;
    }

    // ---- git/refs -------------------------------------------------------
    if (tail[0] === 'git' && tail[1] === 'refs') {
      if (method === 'GET' && tail.length === 2) {
        const out: Record<string, unknown>[] = [];
        for (const [ref, oid] of store.allRefs(repo)) {
          const obj = store.getObject(oid);
          out.push({ ref, object: { sha: oid, type: obj?.type ?? 'commit' } });
        }
        sendJson(res, 200, out);
        return true;
      }
      if (method === 'GET' && tail.length >= 3) {
        const ref = `refs/${tail.slice(2).join('/')}`;
        const oid = store.refOid(repo, ref);
        if (!oid) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        const obj = store.getObject(oid);
        sendJson(res, 200, { ref, object: { sha: oid, type: obj?.type ?? 'commit' } });
        return true;
      }
      if (method === 'POST' && tail.length === 2) {
        const body = await readBody(req);
        const parsed = parseJsonBody(body);
        if (!parsed.ok) {
          sendError(res, 400, 'Problems parsing JSON');
          return true;
        }
        const value = isRecord(parsed.value) ? parsed.value : {};
        const ref = typeof value.ref === 'string' ? value.ref : '';
        const sha = typeof value.sha === 'string' ? value.sha : '';
        if (!ref.startsWith('refs/') || !isObjectId(sha)) {
          sendError(res, 422, 'Validation Failed: ref and sha are required');
          return true;
        }
        if (store.refOid(repo, ref)) {
          sendError(res, 422, 'Reference already exists');
          return true;
        }
        if (!store.getObject(sha)) {
          sendError(res, 422, 'Object does not exist');
          return true;
        }
        repo.refs.set(ref, sha);
        sendJson(res, 201, { ref, object: { sha, type: store.getObject(sha)?.type ?? 'commit' } });
        return true;
      }
      sendError(res, 404, 'Not Found');
      return true;
    }

    // ---- contents -------------------------------------------------------
    if (tail[0] === 'contents') {
      const filePath = tail.slice(1).join('/');
      if (method === 'GET') {
        const branch = query.get('ref') ?? repo.defaultBranch;
        const tip = store.branchTip(repo, branch);
        if (!tip) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        const files = store.commitFiles(tip);
        const direct = files.get(filePath);
        if (direct) {
          const obj = store.getObject(direct.oid);
          const content = obj ? obj.data.toString('base64') : '';
          sendJson(res, 200, {
            type: 'file', encoding: 'base64', size: obj?.data.length ?? 0,
            name: filePath.split('/').pop() ?? filePath, path: filePath,
            content, sha: direct.oid,
          });
          return true;
        }
        // Directory listing: direct children of filePath.
        const prefix = filePath === '' ? '' : `${filePath}/`;
        const children = new Map<string, { type: string; path: string; sha: string; size: number }>();
        for (const [p, f] of files) {
          if (prefix !== '' && !p.startsWith(prefix)) continue;
          const rest = prefix === '' ? p : p.slice(prefix.length);
          const slash = rest.indexOf('/');
          if (slash < 0) {
            const obj = store.getObject(f.oid);
            children.set(rest, { type: 'file', path: p, sha: f.oid, size: obj?.data.length ?? 0 });
          } else {
            const dir = rest.slice(0, slash);
            if (!children.has(dir)) {
              // The subtree oid for the directory.
              const dirFiles = new Map<string, { oid: string; mode: string }>();
              for (const [p2, f2] of files) {
                if (p2.startsWith(`${prefix}${dir}/`)) dirFiles.set(p2.slice(prefix.length + dir.length + 1), f2);
              }
              const dirOid = dirFiles.size ? store.buildTreeFromFiles(dirFiles) : '';
              children.set(dir, { type: 'dir', path: `${prefix}${dir}`, sha: dirOid, size: 0 });
            }
          }
        }
        if (children.size === 0) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        sendJson(
          res,
          200,
          [...children.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([name, c]) => ({
            type: c.type, name, path: c.path, sha: c.sha, size: c.size,
          })),
        );
        return true;
      }
      if (method === 'PUT') {
        const body = await readBody(req);
        const parsed = parseJsonBody(body);
        if (!parsed.ok) {
          sendError(res, 400, 'Problems parsing JSON');
          return true;
        }
        const value = isRecord(parsed.value) ? parsed.value : {};
        const message = typeof value.message === 'string' ? value.message : 'Update file';
        const contentB64 = typeof value.content === 'string' ? value.content : '';
        const branch = typeof value.branch === 'string' && value.branch !== '' ? value.branch : repo.defaultBranch;
        const givenSha = typeof value.sha === 'string' ? value.sha : undefined;
        let contentBuf: Buffer;
        try {
          contentBuf = Buffer.from(contentB64, 'base64');
        } catch {
          sendError(res, 422, 'Validation Failed: content is not valid base64');
          return true;
        }
        const blobOid = store.putObject('blob', contentBuf);
        const branchExists = store.branchTip(repo, branch) !== undefined;
        const parent = branchExists ? store.branchTip(repo, branch)! : store.branchTip(repo, repo.defaultBranch);
        const files = parent ? store.commitFiles(parent) : new Map<string, { oid: string; mode: string }>();
        const existing = files.get(filePath);
        if (givenSha !== undefined) {
          if (!existing || existing.oid !== givenSha) {
            sendError(res, 409, 'Conflict: sha does not match the current file');
            return true;
          }
        }
        const isUpdate = existing !== undefined;
        files.set(filePath, { oid: blobOid, mode: '100644' });
        const commitOid = store.createCommit(files, parent ? [parent] : [], message);
        repo.refs.set(`refs/heads/${branch}`, commitOid);
        sendJson(res, isUpdate ? 200 : 201, {
          content: {
            name: filePath.split('/').pop() ?? filePath, path: filePath, sha: blobOid,
            size: contentBuf.length, encoding: 'base64', content: contentB64,
          },
          commit: { sha: commitOid, message },
        });
        return true;
      }
      if (method === 'DELETE') {
        const body = await readBody(req);
        const parsed = parseJsonBody(body);
        if (!parsed.ok) {
          sendError(res, 400, 'Problems parsing JSON');
          return true;
        }
        const value = isRecord(parsed.value) ? parsed.value : {};
        const message = typeof value.message === 'string' ? value.message : 'Delete file';
        const givenSha = typeof value.sha === 'string' ? value.sha : undefined;
        const branch = typeof value.branch === 'string' && value.branch !== '' ? value.branch : repo.defaultBranch;
        const tip = store.branchTip(repo, branch);
        if (!tip) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        const files = store.commitFiles(tip);
        const existing = files.get(filePath);
        if (!existing) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        if (givenSha !== undefined && existing.oid !== givenSha) {
          sendError(res, 409, 'Conflict: sha does not match the current file');
          return true;
        }
        files.delete(filePath);
        const commitOid = store.createCommit(files, [tip], message);
        repo.refs.set(`refs/heads/${branch}`, commitOid);
        sendJson(res, 200, { commit: { sha: commitOid, message } });
        return true;
      }
      sendError(res, 404, 'Not Found');
      return true;
    }

    // ---- labels ---------------------------------------------------------
    if (tail[0] === 'labels') {
      if (method === 'GET' && tail.length === 1) {
        sendJson(res, 200, [...repo.labels.values()].map(labelJson));
        return true;
      }
      if (method === 'POST' && tail.length === 1) {
        const body = await readBody(req);
        const parsed = parseJsonBody(body);
        if (!parsed.ok) {
          sendError(res, 400, 'Problems parsing JSON');
          return true;
        }
        const value = isRecord(parsed.value) ? parsed.value : {};
        const name = typeof value.name === 'string' ? value.name : '';
        const color = typeof value.color === 'string' ? value.color.replace(/^#/, '') : '000000';
        if (!name) {
          sendError(res, 422, 'Validation Failed: name is required');
          return true;
        }
        const label = { name, color, description: typeof value.description === 'string' ? value.description : '' };
        repo.labels.set(name, label);
        sendJson(res, 201, labelJson(label));
        return true;
      }
      sendError(res, 404, 'Not Found');
      return true;
    }

    // ---- issues ---------------------------------------------------------
    if (tail[0] === 'issues') {
      // /issues/{n}/comments
      if (tail.length === 3 && tail[2] === 'comments') {
        const number = Number(tail[1]);
        const issue = repo.issues.find((i) => i.number === number);
        if (!issue) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        if (method === 'GET') {
          sendJson(res, 200, issue.comments.map((c) => commentJson(repo, issue, c)));
          return true;
        }
        if (method === 'POST') {
          const body = await readBody(req);
          const parsed = parseJsonBody(body);
          if (!parsed.ok) {
            sendError(res, 400, 'Problems parsing JSON');
            return true;
          }
          const value = isRecord(parsed.value) ? parsed.value : {};
          const text = typeof value.body === 'string' ? value.body : '';
          const comment = { id: repo.nextCommentId++, body: text, createdSeq: store.nextSeq++ };
          issue.comments.push(comment);
          sendJson(res, 201, commentJson(repo, issue, comment));
          return true;
        }
        sendError(res, 404, 'Not Found');
        return true;
      }
      // /issues/{n}
      if (tail.length === 2) {
        const number = Number(tail[1]);
        const issue = repo.issues.find((i) => i.number === number);
        if (!issue) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        if (method === 'GET') {
          sendJson(res, 200, issueJson(repo, issue));
          return true;
        }
        if (method === 'PATCH') {
          const body = await readBody(req);
          const parsed = parseJsonBody(body);
          if (!parsed.ok) {
            sendError(res, 400, 'Problems parsing JSON');
            return true;
          }
          const value = isRecord(parsed.value) ? parsed.value : {};
          if (value.state === 'closed' || value.state === 'open') issue.state = value.state;
          if (typeof value.title === 'string') issue.title = value.title;
          if (typeof value.body === 'string') issue.body = value.body;
          sendJson(res, 200, issueJson(repo, issue));
          return true;
        }
        sendError(res, 404, 'Not Found');
        return true;
      }
      // /issues
      if (tail.length === 1) {
        if (method === 'GET') {
          const state = (query.get('state') ?? 'open').toLowerCase();
          const direction = (query.get('direction') ?? 'desc').toLowerCase();
          let list = repo.issues.filter((i) => state === 'all' || i.state === state);
          list = [...list].sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
          const page = pageOf(query);
          const { slice, lastPage } = paginate(list, page);
          const link = linkHeader(req, page, lastPage);
          sendJson(res, 200, slice.map((i) => issueJson(repo, i)), link ? { link } : {});
          return true;
        }
        if (method === 'POST') {
          const body = await readBody(req);
          const parsed = parseJsonBody(body);
          if (!parsed.ok) {
            sendError(res, 400, 'Problems parsing JSON');
            return true;
          }
          const value = isRecord(parsed.value) ? parsed.value : {};
          const title = typeof value.title === 'string' ? value.title : '';
          const bodyText = typeof value.body === 'string' ? value.body : '';
          const labelNames: string[] = Array.isArray(value.labels)
            ? value.labels.map((l: unknown) => (typeof l === 'string' ? l : isRecord(l) && typeof l.name === 'string' ? l.name : '')).filter(Boolean)
            : [];
          for (const labelName of labelNames) {
            if (!repo.labels.has(labelName)) {
              sendError(res, 422, `Validation Failed: label "${labelName}" does not exist`);
              return true;
            }
          }
          const issue: Issue = {
            id: store.nextIssueId++,
            number: repo.nextIssueNumber++,
            title,
            body: bodyText,
            state: 'open',
            labels: labelNames.map((n) => {
              const l = repo.labels.get(n)!;
              return { name: l.name, color: l.color };
            }),
            comments: [],
            createdSeq: store.nextSeq++,
          };
          repo.issues.push(issue);
          sendJson(res, 201, issueJson(repo, issue));
          return true;
        }
        sendError(res, 404, 'Not Found');
        return true;
      }
      sendError(res, 404, 'Not Found');
      return true;
    }

    // ---- pulls ----------------------------------------------------------
    if (tail[0] === 'pulls') {
      // /pulls/{n}/files
      if (tail.length === 3 && tail[2] === 'files' && method === 'GET') {
        const number = Number(tail[1]);
        const pull = repo.pulls.find((p) => p.number === number);
        if (!pull) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        sendJson(res, 200, pull.files);
        return true;
      }
      // /pulls/{n}/merge
      if (tail.length === 3 && tail[2] === 'merge' && method === 'PUT') {
        const number = Number(tail[1]);
        const pull = repo.pulls.find((p) => p.number === number);
        if (!pull) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        if (pull.merged && pull.mergeCommitSha) {
          sendJson(res, 200, { merged: true, sha: pull.mergeCommitSha, message: `Pull request #${number} merged` });
          return true;
        }
        if (pull.state === 'closed') {
          sendError(res, 405, 'Pull request is closed');
          return true;
        }
        const baseTip = store.branchTip(repo, pull.base);
        const headTip = store.branchTip(repo, pull.head);
        if (!baseTip || !headTip) {
          sendError(res, 405, 'Base or head branch is missing');
          return true;
        }
        const mergeOid = store.squashMerge(repo, pull);
        if (!mergeOid) {
          sendError(res, 405, 'Merge conflict');
          return true;
        }
        pull.merged = true;
        pull.mergedAt = FIXED_ISO;
        pull.mergeCommitSha = mergeOid;
        pull.state = 'closed';
        sendJson(res, 200, { merged: true, sha: mergeOid, message: `Pull request #${number} successfully merged` });
        return true;
      }
      // /pulls/{n}
      if (tail.length === 2 && method === 'GET') {
        const number = Number(tail[1]);
        const pull = repo.pulls.find((p) => p.number === number);
        if (!pull) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        sendJson(res, 200, pullJson(repo, pull));
        return true;
      }
      // /pulls
      if (tail.length === 1) {
        if (method === 'GET') {
          const state = (query.get('state') ?? 'open').toLowerCase();
          const list = repo.pulls.filter((p) => state === 'all' || p.state === state);
          const page = pageOf(query);
          const { slice, lastPage } = paginate(list, page);
          const link = linkHeader(req, page, lastPage);
          sendJson(res, 200, slice.map((p) => pullJson(repo, p)), link ? { link } : {});
          return true;
        }
        if (method === 'POST') {
          const body = await readBody(req);
          const parsed = parseJsonBody(body);
          if (!parsed.ok) {
            sendError(res, 400, 'Problems parsing JSON');
            return true;
          }
          const value = isRecord(parsed.value) ? parsed.value : {};
          const title = typeof value.title === 'string' ? value.title : '';
          const bodyText = typeof value.body === 'string' ? value.body : '';
          const head = typeof value.head === 'string' ? value.head : '';
          const base = typeof value.base === 'string' ? value.base : repo.defaultBranch;
          const headSha = store.branchTip(repo, head);
          const baseSha = store.branchTip(repo, base);
          if (!headSha || !baseSha) {
            sendError(res, 422, 'Validation Failed: head or base branch does not exist');
            return true;
          }
          const existing = repo.pulls.find((p) => p.head === head && p.base === base && p.state === 'open');
          if (existing) {
            sendError(res, 422, 'Validation Failed: a pull request already exists for this head and base');
            return true;
          }
          const files = store.diffFiles(baseSha, headSha);
          const conflicts = store.mergeConflicts(baseSha, headSha, baseSha);
          const pull: Pull = {
            id: store.nextPullId++,
            number: repo.nextPullNumber++,
            title,
            body: bodyText,
            state: 'open',
            head,
            base,
            headSha,
            baseSha,
            merged: false,
            mergedAt: null,
            mergeCommitSha: null,
            mergeable: !conflicts,
            createdSeq: store.nextSeq++,
            files,
          };
          repo.pulls.push(pull);
          sendJson(res, 201, pullJson(repo, pull));
          return true;
        }
        sendError(res, 404, 'Not Found');
        return true;
      }
      sendError(res, 404, 'Not Found');
      return true;
    }

    sendError(res, 404, 'Not Found');
    return true;
  }

  // Unknown /api/v3 route: JSON 404.
  sendError(res, 404, 'Not Found');
  return true;
}
