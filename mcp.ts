// mcp.ts — Model Context Protocol, Streamable HTTP at /mcp (JSON-RPC 2.0).
// Modern era first: `server/discover` (2026-07-28) answers identity, capabilities
// and supportedVersions; the legacy `initialize` handshake is answered too, so a
// pre-discover client still connects. Plain JSON answers (the client also reads
// SSE, but JSON is enough). Auth: no bearer token -> 401; a non-JSON body -> 400
// with JSON-RPC -32700.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson, readBody, isRecord, isAuthenticated, nextRequestId } from './http.ts';
import { store, VIEWER_LOGIN, type Repo } from './store.ts';
import { repoJson, issueJson, pullJson } from './rest.ts';

const SERVER_NAME = 'github-core-clone-forge';
const SERVER_VERSION = '1.0.0';
const PROTOCOL_VERSION = '2026-07-28';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required: string[] };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository (defaults to the authenticated user).' },
        name: { type: 'string', description: 'The name of the repository.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        title: { type: 'string', description: 'The title of the issue.' },
        body: { type: 'string', description: 'The body of the issue.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        state: { type: 'string', description: 'Filter by state: open, closed, or all.', enum: ['open', 'closed', 'all'] },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        title: { type: 'string', description: 'The title of the pull request.' },
        body: { type: 'string', description: 'The body of the pull request.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash commit onto its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function toolResult(data: unknown): Record<string, unknown> {
  const text = JSON.stringify(data);
  return { content: [{ type: 'text', text }], structuredContent: data, isError: false };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], structuredContent: { error: message }, isError: true };
}

function findRepo(owner: string, repo: string): Repo | null {
  if (owner !== VIEWER_LOGIN) return null;
  return store.getRepo(owner, repo) ?? null;
}

function callTool(name: string, args: Record<string, unknown>): Record<string, unknown> {
  switch (name) {
    case 'create_repo': {
      const repoName = typeof args.name === 'string' ? args.name : '';
      if (!repoName) return toolError('create_repo requires a name');
      if (store.getRepo(VIEWER_LOGIN, repoName)) {
        return toolError(`Repository ${VIEWER_LOGIN}/${repoName} already exists`);
      }
      const repo = store.createRepo(VIEWER_LOGIN, repoName, {
        description: typeof args.description === 'string' ? args.description : '',
        private: args.private === true,
      });
      return toolResult(repoJson(repo));
    }
    case 'get_repo': {
      const owner = typeof args.owner === 'string' ? args.owner : '';
      const repoName = typeof args.repo === 'string' ? args.repo : '';
      const repo = findRepo(owner, repoName);
      if (!repo) return toolError(`Repository ${owner}/${repoName} not found`);
      return toolResult(repoJson(repo));
    }
    case 'create_issue': {
      const owner = typeof args.owner === 'string' ? args.owner : '';
      const repoName = typeof args.repo === 'string' ? args.repo : '';
      const repo = findRepo(owner, repoName);
      if (!repo) return toolError(`Repository ${owner}/${repoName} not found`);
      const title = typeof args.title === 'string' ? args.title : '';
      if (!title) return toolError('create_issue requires a title');
      const issue = {
        id: store.nextIssueId++,
        number: repo.nextIssueNumber++,
        title,
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open' as const,
        labels: [] as { name: string; color: string }[],
        comments: [] as { id: number; body: string; createdSeq: number }[],
        createdSeq: store.nextSeq++,
      };
      repo.issues.push(issue);
      return toolResult(issueJson(repo, issue));
    }
    case 'list_issues': {
      const owner = typeof args.owner === 'string' ? args.owner : '';
      const repoName = typeof args.repo === 'string' ? args.repo : '';
      const repo = findRepo(owner, repoName);
      if (!repo) return toolError(`Repository ${owner}/${repoName} not found`);
      const state = typeof args.state === 'string' ? args.state.toLowerCase() : 'open';
      const list = repo.issues.filter((i) => state === 'all' || i.state === state);
      return toolResult({ issues: list.map((i) => issueJson(repo, i)) });
    }
    case 'create_pull_request': {
      const owner = typeof args.owner === 'string' ? args.owner : '';
      const repoName = typeof args.repo === 'string' ? args.repo : '';
      const repo = findRepo(owner, repoName);
      if (!repo) return toolError(`Repository ${owner}/${repoName} not found`);
      const title = typeof args.title === 'string' ? args.title : '';
      const head = typeof args.head === 'string' ? args.head : '';
      const base = typeof args.base === 'string' ? args.base : '';
      if (!title || !head || !base) return toolError('create_pull_request requires title, head and base');
      const headSha = store.branchTip(repo, head);
      const baseSha = store.branchTip(repo, base);
      if (!headSha || !baseSha) return toolError('Head or base branch does not exist');
      const files = store.diffFiles(baseSha, headSha);
      const conflicts = store.mergeConflicts(baseSha, headSha, baseSha);
      const pull = {
        id: store.nextPullId++,
        number: repo.nextPullNumber++,
        title,
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open' as const,
        head,
        base,
        headSha,
        baseSha,
        merged: false,
        mergedAt: null as string | null,
        mergeCommitSha: null as string | null,
        mergeable: !conflicts,
        createdSeq: store.nextSeq++,
        files,
      };
      repo.pulls.push(pull);
      return toolResult(pullJson(repo, pull));
    }
    case 'merge_pull_request': {
      const owner = typeof args.owner === 'string' ? args.owner : '';
      const repoName = typeof args.repo === 'string' ? args.repo : '';
      const repo = findRepo(owner, repoName);
      if (!repo) return toolError(`Repository ${owner}/${repoName} not found`);
      const number = typeof args.pull_number === 'number' ? args.pull_number : Number(args.pull_number);
      const pull = repo.pulls.find((p) => p.number === number);
      if (!pull) return toolError(`Pull request #${number} not found`);
      if (pull.merged && pull.mergeCommitSha) {
        return toolResult({ merged: true, sha: pull.mergeCommitSha, number: pull.number });
      }
      if (pull.state === 'closed') return toolError(`Pull request #${number} is closed`);
      const mergeOid = store.squashMerge(repo, pull);
      if (!mergeOid) return toolError('Merge conflict');
      pull.merged = true;
      pull.mergedAt = '2025-01-01T00:00:00Z';
      pull.mergeCommitSha = mergeOid;
      pull.state = 'closed';
      return toolResult({ merged: true, sha: mergeOid, number: pull.number });
    }
    default:
      return toolError(`Unknown tool: ${name}`);
  }
}

interface RpcError {
  code: number;
  message: string;
  data?: unknown;
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcError(id: unknown, error: RpcError): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error };
}

function requiredMissing(tool: ToolDef, args: Record<string, unknown>): string[] {
  return tool.inputSchema.required.filter((name) => args[name] === undefined || args[name] === null || args[name] === '');
}

export async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (req.method === 'DELETE') {
    // A legacy session goodbye: nothing held, answer 204.
    res.writeHead(204, { 'x-github-request-id': nextRequestId() });
    res.end();
    return true;
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { message: 'Method not allowed' });
    return true;
  }
  const raw = await readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8')) as unknown;
  } catch {
    // A body that is not JSON: HTTP 400 with JSON-RPC -32700.
    res.writeHead(400, { 'content-type': 'application/json; charset=utf-8', 'x-github-request-id': nextRequestId() });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
    return true;
  }
  if (!isRecord(parsed) || typeof parsed.method !== 'string') {
    res.writeHead(400, { 'content-type': 'application/json; charset=utf-8', 'x-github-request-id': nextRequestId() });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } }));
    return true;
  }
  const id = 'id' in parsed ? parsed.id : null;
  const method = parsed.method;
  const params = isRecord(parsed.params) ? parsed.params : {};

  // Notifications (no id) need no answer.
  if (id === undefined || id === null) {
    if (method.startsWith('notifications/')) {
      res.writeHead(202, { 'x-github-request-id': nextRequestId() });
      res.end();
      return true;
    }
    // A request without an id is not a request: answer 202 and move on.
    res.writeHead(202, { 'x-github-request-id': nextRequestId() });
    res.end();
    return true;
  }

  // Auth is decided before any tool exists: no bearer token -> 401.
  if (!isAuthenticated(req)) {
    res.writeHead(401, { 'content-type': 'application/json; charset=utf-8', 'x-github-request-id': nextRequestId() });
    res.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32001, message: 'Unauthorized' } }));
    return true;
  }

  if (method === 'server/discover') {
    const result = {
      resultType: 'discover',
      supportedVersions: SUPPORTED_VERSIONS,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      _meta: {
        'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION },
        'io.modelcontextprotocol/protocolVersion': PROTOCOL_VERSION,
      },
    };
    sendJson(res, 200, rpcResult(id, result));
    return true;
  }

  if (method === 'initialize') {
    const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_VERSION;
    const chosen = SUPPORTED_VERSIONS.includes(offered) ? offered : PROTOCOL_VERSION;
    sendJson(res, 200, rpcResult(id, {
      protocolVersion: chosen,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    }));
    return true;
  }

  if (method === 'ping') {
    sendJson(res, 200, rpcResult(id, {}));
    return true;
  }

  if (method === 'tools/list') {
    // Byte-identical across calls: the same constant, serialized the same way.
    sendJson(res, 200, rpcResult(id, { tools: TOOLS }));
    return true;
  }

  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = isRecord(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) {
      sendJson(res, 200, rpcError(id, { code: -32602, message: `Unknown tool: ${name}` }));
      return true;
    }
    const missing = requiredMissing(tool, args);
    if (missing.length > 0) {
      sendJson(res, 200, rpcError(id, { code: -32602, message: `Missing required argument(s): ${missing.join(', ')}` }));
      return true;
    }
    const result = callTool(name, args);
    sendJson(res, 200, rpcResult(id, result));
    return true;
  }

  // Unknown method.
  sendJson(res, 200, rpcError(id, { code: -32601, message: `Method not found: ${method}` }));
  return true;
}
