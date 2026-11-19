// graphql.ts — a minimal GraphQL v4 executor for the documents gh and
// github-mcp-server send (checks-graphql.ts's GRAPHQL_DOCUMENTS). It parses the
// query subset those documents use (operations, aliases, arguments, variables,
// inline fragments, __type introspection) and resolves against the same store
// as REST. Unknown fields are a 200 with an `errors` array naming the field.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson, readBody, parseJsonBody, isRecord, isAuthenticated } from './http.ts';
import { store, VIEWER_LOGIN, VIEWER_ID, globalId, parseGlobalId, type Repo, type Issue, type Pull } from './store.ts';

// ---------------------------------------------------------------- schema (for validation + introspection)

const SCHEMA_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node'],
  Viewer: ['login'],
  User: ['login', 'id'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'],
  Issue: ['id', 'number', 'title', 'body', 'state', 'createdAt', 'author', 'labels', 'comments'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'headRefName', 'baseRefName', 'mergeable', 'merged', 'files'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestFileConnection: ['nodes', 'pageInfo'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  Ref: ['name', 'target'],
  PullRequestFile: ['path', 'additions', 'deletions', 'changeType'],
  IssueComment: ['id', 'body'],
  CommentEdge: ['node', 'cursor'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'clientMutationId'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
};

const SEARCH_TYPE_VALUES = ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'MILESTONE'];

// ---------------------------------------------------------------- parser

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: { name: string; value: ValueNode }[] };

interface FieldNode {
  alias: string | null;
  name: string;
  args: { name: string; value: ValueNode }[];
  selection: SelectionNode[];
}

type SelectionNode =
  | { kind: 'field'; field: FieldNode }
  | { kind: 'inlineFragment'; typeCondition: string | null; selection: SelectionNode[] };

interface OperationNode {
  operation: 'query' | 'mutation';
  name: string | null;
  selection: SelectionNode[];
}

function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i]!;
    if (/\s/.test(ch) || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if ('{}():![]=@$&|'.includes(ch) || ch === '.') {
      if (ch === '.' && input.slice(i, i + 3) === '...') {
        tokens.push('...');
        i += 3;
        continue;
      }
      tokens.push(ch);
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < input.length) {
          const esc = input[j + 1]!;
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          out += input[j];
          j += 1;
        }
      }
      tokens.push(JSON.stringify(out));
      i = j + 1;
      continue;
    }
    if (/[A-Za-z0-9_+-]/.test(ch)) {
      let j = i;
      while (j < input.length && /[A-Za-z0-9_.\-+]/.test(input[j]!)) j += 1;
      tokens.push(input.slice(i, j));
      i = j;
      continue;
    }
    i += 1;
  }
  return tokens;
}

class Parser {
  private tokens: string[];
  private pos = 0;

  constructor(input: string) {
    this.tokens = tokenize(input);
  }

  private peek(): string | undefined {
    return this.tokens[this.pos];
  }

  private next(): string {
    return this.tokens[this.pos++] ?? '';
  }

  private expect(tok: string): void {
    const got = this.next();
    if (got !== tok) throw new Error(`expected ${tok}, got ${got}`);
  }

  parseOperation(): OperationNode {
    let operation: 'query' | 'mutation' = 'query';
    let name: string | null = null;
    const first = this.peek();
    if (first === 'query' || first === 'mutation') {
      operation = this.next() as 'query' | 'mutation';
      const maybeName = this.peek();
      if (maybeName && maybeName !== '(' && maybeName !== '{') name = this.next();
    }
    // Variable definitions: ( $x: Type!, ... )
    if (this.peek() === '(') {
      let depth = 0;
      while (this.pos < this.tokens.length) {
        const t = this.next();
        if (t === '(') depth += 1;
        if (t === ')') {
          depth -= 1;
          if (depth === 0) break;
        }
      }
    }
    const selection = this.parseSelectionSet();
    return { operation, name, selection };
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expect('{');
    const out: SelectionNode[] = [];
    while (this.peek() !== '}' && this.pos < this.tokens.length) {
      out.push(this.parseSelection());
    }
    this.expect('}');
    return out;
  }

  private parseSelection(): SelectionNode {
    if (this.peek() === '...') {
      this.next();
      let typeCondition: string | null = null;
      if (this.peek() === 'on') {
        this.next();
        typeCondition = this.next();
      }
      const selection = this.parseSelectionSet();
      return { kind: 'inlineFragment', typeCondition, selection };
    }
    let alias: string | null = null;
    let name = this.next();
    if (this.peek() === ':') {
      this.next();
      alias = name;
      name = this.next();
    }
    const args: { name: string; value: ValueNode }[] = [];
    if (this.peek() === '(') {
      this.next();
      while (this.peek() !== ')' && this.pos < this.tokens.length) {
        const argName = this.next();
        this.expect(':');
        args.push({ name: argName, value: this.parseValue() });
      }
      this.expect(')');
    }
    let selection: SelectionNode[] = [];
    if (this.peek() === '{') selection = this.parseSelectionSet();
    return { kind: 'field', field: { alias, name, args, selection } };
  }

  private parseValue(): ValueNode {
    const tok = this.next();
    if (tok === '$') return { kind: 'variable', name: this.next() };
    if (tok === '[') {
      const values: ValueNode[] = [];
      while (this.peek() !== ']' && this.pos < this.tokens.length) values.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', values };
    }
    if (tok === '{') {
      const fields: { name: string; value: ValueNode }[] = [];
      while (this.peek() !== '}' && this.pos < this.tokens.length) {
        const name = this.next();
        this.expect(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (tok === 'true') return { kind: 'boolean', value: true };
    if (tok === 'false') return { kind: 'boolean', value: false };
    if (tok === 'null') return { kind: 'null' };
    if (tok.startsWith('"')) return { kind: 'string', value: JSON.parse(tok) as string };
    if (/^-?\d+$/.test(tok)) return { kind: 'int', value: Number.parseInt(tok, 10) };
    if (/^-?\d*\.\d+$/.test(tok)) return { kind: 'float', value: Number.parseFloat(tok) };
    return { kind: 'enum', value: tok };
  }
}

function evalValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((v) => evalValue(v, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const f of node.fields) out[f.name] = evalValue(f.value, variables);
      return out;
    }
  }
}

function argsOf(field: FieldNode, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const a of field.args) out[a.name] = evalValue(a.value, variables);
  return out;
}

// ---------------------------------------------------------------- execution

interface Ctx {
  variables: Record<string, unknown>;
  errors: { message: string }[];
}

type Obj = { __type: string; value: unknown };

function resolveField(obj: Obj, field: FieldNode, ctx: Ctx): unknown {
  const type = obj.__type;
  const known = SCHEMA_FIELDS[type] ?? [];
  if (!known.includes(field.name) && field.name !== '__type') {
    ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${type}".` });
    return undefined;
  }
  const args = argsOf(field, ctx.variables);
  return resolveKnown(obj, field, args, ctx);
}

function resolveKnown(obj: Obj, field: FieldNode, args: Record<string, unknown>, ctx: Ctx): unknown {
  switch (obj.__type) {
    case 'Query': {
      if (field.name === 'viewer') return { __type: 'Viewer', value: null };
      if (field.name === 'repository') {
        const owner = String(args.owner ?? '');
        const name = String(args.name ?? '');
        if (owner !== VIEWER_LOGIN) return null;
        const repo = store.getRepo(owner, name);
        return repo ? { __type: 'Repository', value: repo } : null;
      }
      if (field.name === 'node') {
        const id = String(args.id ?? '');
        const parsed = parseGlobalId(id);
        if (!parsed) return null;
        if (parsed.kind === 'Repository') {
          const dbId = Number(parsed.parts[0]);
          for (const repo of store.repos.values()) {
            if (repo.id === dbId) return { __type: 'Repository', value: repo };
          }
          return null;
        }
        if (parsed.kind === 'Issue') {
          const dbId = Number(parsed.parts[0]);
          const number = Number(parsed.parts[1]);
          for (const repo of store.repos.values()) {
            if (repo.id !== dbId) continue;
            const issue = repo.issues.find((i) => i.number === number);
            if (issue) return { __type: 'Issue', value: { repo, issue } };
          }
          return null;
        }
        if (parsed.kind === 'PullRequest') {
          const dbId = Number(parsed.parts[0]);
          const number = Number(parsed.parts[1]);
          for (const repo of store.repos.values()) {
            if (repo.id !== dbId) continue;
            const pull = repo.pulls.find((p) => p.number === number);
            if (pull) return { __type: 'PullRequest', value: { repo, pull } };
          }
          return null;
        }
        return null;
      }
      return null;
    }
    case 'Viewer':
    case 'User': {
      if (field.name === 'login') return VIEWER_LOGIN;
      if (field.name === 'id') return VIEWER_ID;
      return null;
    }
    case 'Repository': {
      const repo = obj.value as Repo;
      switch (field.name) {
        case 'id':
          return globalId('Repository', repo.id);
        case 'databaseId':
          return repo.id;
        case 'name':
          return repo.name;
        case 'nameWithOwner':
          return `${repo.owner}/${repo.name}`;
        case 'owner':
          return { __type: 'User', value: repo.owner };
        case 'defaultBranchRef': {
          const tip = store.branchTip(repo, repo.defaultBranch);
          return tip ? { __type: 'Ref', value: repo.defaultBranch } : null;
        }
        case 'viewerPermission':
          return 'ADMIN';
        case 'hasIssuesEnabled':
          return true;
        case 'issue': {
          const number = Number(args.number);
          const issue = repo.issues.find((i) => i.number === number);
          return issue ? { __type: 'Issue', value: { repo, issue } } : null;
        }
        case 'issues': {
          const first = typeof args.first === 'number' ? args.first : undefined;
          const after = typeof args.after === 'string' ? args.after : null;
          const states = Array.isArray(args.states) ? (args.states as string[]) : null;
          const orderBy = isRecord(args.orderBy) ? args.orderBy : null;
          let list = [...repo.issues];
          if (states) {
            const wanted = new Set(states.map((s) => String(s).toUpperCase()));
            list = list.filter((i) => wanted.has(i.state.toUpperCase()));
          }
          if (orderBy && String(orderBy.field ?? '').toUpperCase() === 'CREATED_AT') {
            const dir = String(orderBy.direction ?? 'ASC').toUpperCase();
            list.sort((a, b) => (dir === 'DESC' ? b.createdSeq - a.createdSeq : a.createdSeq - b.createdSeq));
          } else {
            list.sort((a, b) => a.createdSeq - b.createdSeq);
          }
          let startIndex = 0;
          if (after) {
            const parsed = parseGlobalId(after);
            if (parsed?.kind === 'Cursor') {
              const num = Number(parsed.parts[0]);
              const idx = list.findIndex((i) => i.number === num);
              if (idx >= 0) startIndex = idx + 1;
            }
          }
          const page = first !== undefined ? list.slice(startIndex, startIndex + first) : list.slice(startIndex);
          const hasNextPage = first !== undefined && startIndex + first < list.length;
          const endCursor = page.length ? globalId('Cursor', page[page.length - 1]!.number) : null;
          return {
            __type: 'IssueConnection',
            value: { nodes: page.map((issue) => ({ __type: 'Issue', value: { repo, issue } })), hasNextPage, endCursor },
          };
        }
        case 'pullRequests': {
          const first = typeof args.first === 'number' ? args.first : undefined;
          let list = [...repo.pulls].filter((p) => p.state === 'open');
          list.sort((a, b) => b.createdSeq - a.createdSeq);
          if (first !== undefined) list = list.slice(0, first);
          return {
            __type: 'PullRequestConnection',
            value: { nodes: list.map((pull) => ({ __type: 'PullRequest', value: { repo, pull } })) },
          };
        }
        case 'pullRequest': {
          const number = Number(args.number);
          const pull = repo.pulls.find((p) => p.number === number);
          return pull ? { __type: 'PullRequest', value: { repo, pull } } : null;
        }
        default:
          return null;
      }
    }
    case 'Issue': {
      const { repo, issue } = obj.value as { repo: Repo; issue: Issue };
      switch (field.name) {
        case 'id':
          return globalId('Issue', repo.id, issue.number);
        case 'number':
          return issue.number;
        case 'title':
          return issue.title;
        case 'body':
          return issue.body;
        case 'state':
          return issue.state.toUpperCase();
        default:
          return null;
      }
    }
    case 'PullRequest': {
      const { repo, pull } = obj.value as { repo: Repo; pull: Pull };
      switch (field.name) {
        case 'id':
          return globalId('PullRequest', repo.id, pull.number);
        case 'number':
          return pull.number;
        case 'title':
          return pull.title;
        case 'body':
          return pull.body;
        case 'state':
          return pull.merged ? 'MERGED' : pull.state.toUpperCase();
        case 'headRefName':
          return pull.head;
        case 'baseRefName':
          return pull.base;
        case 'mergeable':
          return pull.mergeable ? 'MERGEABLE' : 'CONFLICTING';
        case 'merged':
          return pull.merged;
        case 'files': {
          const first = typeof args.first === 'number' ? args.first : undefined;
          let nodes = pull.files.map((f) => ({ __type: 'PullRequestFile', value: f.filename }));
          if (first !== undefined) nodes = nodes.slice(0, first);
          return { __type: 'PullRequestFileConnection', value: { nodes } };
        }
        default:
          return null;
      }
    }
    case 'IssueConnection': {
      const v = obj.value as { nodes: Obj[]; hasNextPage: boolean; endCursor: string | null };
      if (field.name === 'nodes') return v.nodes;
      if (field.name === 'pageInfo') return { __type: 'PageInfo', value: v };
      if (field.name === 'totalCount') return v.nodes.length;
      return null;
    }
    case 'PullRequestConnection': {
      const v = obj.value as { nodes: Obj[] };
      if (field.name === 'nodes') return v.nodes;
      if (field.name === 'pageInfo') return { __type: 'PageInfo', value: { hasNextPage: false, endCursor: null } };
      if (field.name === 'totalCount') return v.nodes.length;
      return null;
    }
    case 'PullRequestFileConnection': {
      const v = obj.value as { nodes: Obj[] };
      if (field.name === 'nodes') return v.nodes;
      if (field.name === 'pageInfo') return { __type: 'PageInfo', value: { hasNextPage: false, endCursor: null } };
      return null;
    }
    case 'PageInfo': {
      const v = obj.value as { hasNextPage: boolean; endCursor: string | null };
      if (field.name === 'hasNextPage') return v.hasNextPage;
      if (field.name === 'hasPreviousPage') return false;
      if (field.name === 'endCursor') return v.endCursor;
      if (field.name === 'startCursor') return null;
      return null;
    }
    case 'Ref': {
      if (field.name === 'name') return obj.value as string;
      return null;
    }
    case 'PullRequestFile': {
      if (field.name === 'path') return obj.value as string;
      return null;
    }
    case 'IssueComment': {
      const v = obj.value as { id: number; body: string };
      if (field.name === 'id') return globalId('Comment', v.id);
      if (field.name === 'body') return v.body;
      return null;
    }
    case 'CommentEdge': {
      const v = obj.value as { id: number; body: string };
      if (field.name === 'node') return { __type: 'IssueComment', value: v };
      if (field.name === 'cursor') return globalId('Cursor', v.id);
      return null;
    }
    default:
      return null;
  }
}

function executeSelection(obj: Obj, selection: SelectionNode[], ctx: Ctx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selection) {
    if (sel.kind === 'inlineFragment') {
      if (sel.typeCondition && sel.typeCondition !== obj.__type) continue;
      Object.assign(out, executeSelection(obj, sel.selection, ctx));
      continue;
    }
    const field = sel.field;
    if (field.name === '__type') {
      const args = argsOf(field, ctx.variables);
      const typeName = String(args.name ?? '');
      const fields = SCHEMA_FIELDS[typeName];
      const enumValues = typeName === 'SearchType' ? SEARCH_TYPE_VALUES : null;
      out[field.alias ?? field.name] = {
        name: typeName,
        fields: fields ? fields.map((name) => ({ name })) : null,
        enumValues: enumValues ? enumValues.map((name) => ({ name })) : null,
      };
      continue;
    }
    const value = resolveField(obj, field, ctx);
    const key = field.alias ?? field.name;
    if (value === undefined) {
      out[key] = null;
      continue;
    }
    if (value === null) {
      out[key] = null;
      continue;
    }
    if (isRecord(value) && '__type' in value) {
      out[key] = field.selection.length ? executeSelection(value as Obj, field.selection, ctx) : {};
      continue;
    }
    if (Array.isArray(value)) {
      out[key] = value.map((entry) => {
        if (isRecord(entry) && '__type' in entry) {
          return field.selection.length ? executeSelection(entry as Obj, field.selection, ctx) : {};
        }
        return entry;
      });
      continue;
    }
    out[key] = value;
  }
  return out;
}

// ---------------------------------------------------------------- mutations

function doMutation(op: OperationNode, ctx: Ctx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of op.selection) {
    if (sel.kind !== 'field') continue;
    const field = sel.field;
    const args = argsOf(field, ctx.variables);
    const input = isRecord(args.input) ? args.input : {};
    const key = field.alias ?? field.name;
    if (field.name === 'createIssue') {
      const repoId = String(input.repositoryId ?? '');
      const parsed = parseGlobalId(repoId);
      let repo: Repo | undefined;
      if (parsed?.kind === 'Repository') {
        const dbId = Number(parsed.parts[0]);
        for (const r of store.repos.values()) if (r.id === dbId) repo = r;
      }
      if (!repo) {
        ctx.errors.push({ message: 'Could not resolve to a Repository with the id provided.' });
        out[key] = null;
        continue;
      }
      const title = typeof input.title === 'string' ? input.title : '';
      const body = typeof input.body === 'string' ? input.body : '';
      const issue: Issue = {
        id: store.nextIssueId++,
        number: repo.nextIssueNumber++,
        title,
        body,
        state: 'open',
        labels: [],
        comments: [],
        createdSeq: store.nextSeq++,
      };
      repo.issues.push(issue);
      const obj: Obj = { __type: 'CreateIssuePayload', value: { repo, issue } };
      out[key] = executePayload(obj, field.selection, ctx);
      continue;
    }
    if (field.name === 'closeIssue') {
      const issueId = String(input.issueId ?? '');
      const parsed = parseGlobalId(issueId);
      let found: { repo: Repo; issue: Issue } | null = null;
      if (parsed?.kind === 'Issue') {
        const dbId = Number(parsed.parts[0]);
        const number = Number(parsed.parts[1]);
        for (const repo of store.repos.values()) {
          if (repo.id !== dbId) continue;
          const issue = repo.issues.find((i) => i.number === number);
          if (issue) found = { repo, issue };
        }
      }
      if (!found) {
        ctx.errors.push({ message: 'Could not resolve to an Issue with the id provided.' });
        out[key] = null;
        continue;
      }
      found.issue.state = 'closed';
      const obj: Obj = { __type: 'CloseIssuePayload', value: found };
      out[key] = executePayload(obj, field.selection, ctx);
      continue;
    }
    if (field.name === 'createPullRequest') {
      const repoId = String(input.repositoryId ?? '');
      const parsed = parseGlobalId(repoId);
      let repo: Repo | undefined;
      if (parsed?.kind === 'Repository') {
        const dbId = Number(parsed.parts[0]);
        for (const r of store.repos.values()) if (r.id === dbId) repo = r;
      }
      const head = typeof input.headRefName === 'string' ? input.headRefName : '';
      const base = typeof input.baseRefName === 'string' ? input.baseRefName : '';
      const title = typeof input.title === 'string' ? input.title : '';
      const body = typeof input.body === 'string' ? input.body : '';
      if (!repo) {
        ctx.errors.push({ message: 'Could not resolve to a Repository with the id provided.' });
        out[key] = null;
        continue;
      }
      const headSha = store.branchTip(repo, head);
      const baseSha = store.branchTip(repo, base);
      if (!headSha || !baseSha) {
        ctx.errors.push({ message: 'Head or base branch does not exist.' });
        out[key] = null;
        continue;
      }
      const files = store.diffFiles(baseSha, headSha);
      const conflicts = store.mergeConflicts(baseSha, headSha, baseSha);
      const pull: Pull = {
        id: store.nextPullId++,
        number: repo.nextPullNumber++,
        title,
        body,
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
      const obj: Obj = { __type: 'CreatePullRequestPayload', value: { repo, pull } };
      out[key] = executePayload(obj, field.selection, ctx);
      continue;
    }
    if (field.name === 'mergePullRequest') {
      const prId = String(input.pullRequestId ?? '');
      const parsed = parseGlobalId(prId);
      let found: { repo: Repo; pull: Pull } | null = null;
      if (parsed?.kind === 'PullRequest') {
        const dbId = Number(parsed.parts[0]);
        const number = Number(parsed.parts[1]);
        for (const repo of store.repos.values()) {
          if (repo.id !== dbId) continue;
          const pull = repo.pulls.find((p) => p.number === number);
          if (pull) found = { repo, pull };
        }
      }
      if (!found) {
        ctx.errors.push({ message: 'Could not resolve to a PullRequest with the id provided.' });
        out[key] = null;
        continue;
      }
      const { repo, pull } = found;
      if (!pull.merged) {
        const mergeOid = store.squashMerge(repo, pull);
        if (mergeOid) {
          pull.merged = true;
          pull.mergedAt = '2025-01-01T00:00:00Z';
          pull.mergeCommitSha = mergeOid;
          pull.state = 'closed';
        }
      }
      const obj: Obj = { __type: 'MergePullRequestPayload', value: found };
      out[key] = executePayload(obj, field.selection, ctx);
      continue;
    }
    if (field.name === 'addComment') {
      const subjectId = String(input.subjectId ?? '');
      const parsed = parseGlobalId(subjectId);
      let found: { repo: Repo; issue: Issue } | null = null;
      if (parsed?.kind === 'Issue') {
        const dbId = Number(parsed.parts[0]);
        const number = Number(parsed.parts[1]);
        for (const repo of store.repos.values()) {
          if (repo.id !== dbId) continue;
          const issue = repo.issues.find((i) => i.number === number);
          if (issue) found = { repo, issue };
        }
      }
      if (!found) {
        ctx.errors.push({ message: 'Could not resolve to an Issue with the id provided.' });
        out[key] = null;
        continue;
      }
      const body = typeof input.body === 'string' ? input.body : '';
      const comment = { id: found.repo.nextCommentId++, body, createdSeq: store.nextSeq++ };
      found.issue.comments.push(comment);
      const obj: Obj = { __type: 'AddCommentPayload', value: comment };
      out[key] = executePayload(obj, field.selection, ctx);
      continue;
    }
    ctx.errors.push({ message: `Cannot query field "${field.name}" on type "Mutation".` });
    out[key] = null;
  }
  return out;
}

// The payload resolvers (createIssue.issue, closeIssue.issue, ...).
function resolvePayload(obj: Obj, field: FieldNode, args: Record<string, unknown>, ctx: Ctx): unknown {
  const v = obj.value as { repo: Repo; issue?: Issue; pull?: Pull };
  if (field.name === 'issue' && v.issue) {
    return { __type: 'Issue', value: { repo: v.repo, issue: v.issue } };
  }
  if (field.name === 'pullRequest' && v.pull) {
    return { __type: 'PullRequest', value: { repo: v.repo, pull: v.pull } };
  }
  return null;
}

// Patch resolveKnown's default for payload types by wrapping executeSelection's
// field resolution: payload objects are handled here.
const PAYLOAD_TYPES = new Set(['CreateIssuePayload', 'CloseIssuePayload', 'CreatePullRequestPayload', 'MergePullRequestPayload', 'AddCommentPayload']);

function executePayload(obj: Obj, selection: SelectionNode[], ctx: Ctx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selection) {
    if (sel.kind === 'inlineFragment') {
      if (sel.typeCondition && sel.typeCondition !== obj.__type) continue;
      Object.assign(out, executePayload(obj, sel.selection, ctx));
      continue;
    }
    const field = sel.field;
    const key = field.alias ?? field.name;
    if (field.name === 'commentEdge') {
      const comment = obj.value as { id: number; body: string };
      const edge: Obj = { __type: 'CommentEdge', value: comment };
      out[key] = field.selection.length ? executeSelection(edge, field.selection, ctx) : {};
      continue;
    }
    const known: Record<string, string[]> = {
      CreateIssuePayload: ['issue'],
      CloseIssuePayload: ['issue'],
      CreatePullRequestPayload: ['pullRequest'],
      MergePullRequestPayload: ['pullRequest'],
      AddCommentPayload: ['commentEdge'],
    };
    if (!(known[obj.__type] ?? []).includes(field.name)) {
      ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${obj.__type}".` });
      out[key] = null;
      continue;
    }
    const value = resolvePayload(obj, field, argsOf(field, ctx.variables), ctx);
    if (value === null || value === undefined) {
      out[key] = null;
      continue;
    }
    if (isRecord(value) && '__type' in value) {
      out[key] = field.selection.length ? executeSelection(value as Obj, field.selection, ctx) : {};
      continue;
    }
    out[key] = value;
  }
  return out;
}

// ---------------------------------------------------------------- entry

export function executeGraphQL(query: string, variables: Record<string, unknown>): { data: Record<string, unknown> | null; errors: { message: string }[] } {
  const ctx: Ctx = { variables, errors: [] };
  let op: OperationNode;
  try {
    op = new Parser(query).parseOperation();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'Syntax Error' }] };
  }
  if (op.operation === 'mutation') {
    const data = doMutation(op, ctx);
    return { data, errors: ctx.errors };
  }
  // A query's top-level fields resolve against the Query root, except payload
  // selections which go through executePayload via executeSelection's dispatch.
  const root: Obj = { __type: 'Query', value: null };
  const data = executeSelectionWithPayloads(root, op.selection, ctx);
  return { data, errors: ctx.errors };
}

function executeSelectionWithPayloads(obj: Obj, selection: SelectionNode[], ctx: Ctx): Record<string, unknown> {
  if (PAYLOAD_TYPES.has(obj.__type)) return executePayload(obj, selection, ctx);
  // executeSelection already dispatches payload values through resolveField;
  // but payload objects arrive as values, so intercept them here.
  const out: Record<string, unknown> = {};
  for (const sel of selection) {
    if (sel.kind === 'inlineFragment') {
      if (sel.typeCondition && sel.typeCondition !== obj.__type) continue;
      Object.assign(out, executeSelectionWithPayloads(obj, sel.selection, ctx));
      continue;
    }
    const field = sel.field;
    if (field.name === '__type') {
      const args = argsOf(field, ctx.variables);
      const typeName = String(args.name ?? '');
      const fields = SCHEMA_FIELDS[typeName];
      const enumValues = typeName === 'SearchType' ? SEARCH_TYPE_VALUES : null;
      out[field.alias ?? field.name] = {
        name: typeName,
        fields: fields ? fields.map((name) => ({ name })) : null,
        enumValues: enumValues ? enumValues.map((name) => ({ name })) : null,
      };
      continue;
    }
    const value = resolveField(obj, field, ctx);
    const key = field.alias ?? field.name;
    if (value === undefined || value === null) {
      out[key] = null;
      continue;
    }
    if (isRecord(value) && '__type' in value) {
      const child = value as Obj;
      out[key] = field.selection.length
        ? PAYLOAD_TYPES.has(child.__type)
          ? executePayload(child, field.selection, ctx)
          : executeSelectionWithPayloads(child, field.selection, ctx)
        : {};
      continue;
    }
    if (Array.isArray(value)) {
      out[key] = value.map((entry) => {
        if (isRecord(entry) && '__type' in entry) {
          const child = entry as Obj;
          return field.selection.length
            ? PAYLOAD_TYPES.has(child.__type)
              ? executePayload(child, field.selection, ctx)
              : executeSelectionWithPayloads(child, field.selection, ctx)
            : {};
        }
        return entry;
      });
      continue;
    }
    out[key] = value;
  }
  return out;
}

export async function handleGraphQL(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (req.method !== 'POST') {
    sendJson(res, 405, { data: null, errors: [{ message: 'Method not allowed' }] });
    return true;
  }
  if (!isAuthenticated(req)) {
    res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ message: 'Requires authentication' }));
    return true;
  }
  const body = await readBody(req);
  const parsed = parseJsonBody(body);
  if (!parsed.ok) {
    sendJson(res, 400, { data: null, errors: [{ message: 'Problems parsing JSON' }] });
    return true;
  }
  const runOne = (entry: unknown): Record<string, unknown> => {
    if (!isRecord(entry) || typeof entry.query !== 'string') {
      return { data: null, errors: [{ message: 'A query document is required.' }] };
    }
    const variables = isRecord(entry.variables) ? (entry.variables as Record<string, unknown>) : {};
    const { data, errors } = executeGraphQL(entry.query, variables);
    const out: Record<string, unknown> = { data };
    if (errors.length) out.errors = errors;
    return out;
  };
  if (Array.isArray(parsed.value)) {
    sendJson(res, 200, parsed.value.map(runOne));
    return true;
  }
  sendJson(res, 200, runOne(parsed.value));
  return true;
}
