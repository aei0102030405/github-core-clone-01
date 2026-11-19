// store.ts — the forge's in-memory store. One Store per process; every surface (REST,
// GraphQL, MCP, git smart HTTP) reads and writes the same objects, so a change through
// one surface is visible through the others at once.
//
// Determinism: ids come from counters, never from a clock or Math.random; the only
// timestamp is the fixed FORGE_TIMESTAMP in gitproto.ts.

import {
  ZERO_OID,
  isObjectId,
  hashObject,
  buildTree,
  buildCommit,
  parseTree,
  parseCommit,
  parseTag,
  collectReachable,
  type GitObject,
  type GitObjectType,
  type TreeEntry,
} from './gitproto.ts';

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const DEFAULT_BRANCH = 'main';
export const FIXED_ISO = '2025-01-01T00:00:00Z';

export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  refs: Map<string, string>; // ref name -> commit oid (or tag oid)
  labels: Map<string, { name: string; color: string; description: string }>;
  issues: Issue[];
  pulls: Pull[];
  nextIssueNumber: number;
  nextPullNumber: number;
  nextCommentId: number;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: { name: string; color: string }[];
  comments: Comment[];
  createdSeq: number;
}

export interface Comment {
  id: number;
  body: string;
  createdSeq: number;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  head: string; // branch name
  base: string; // branch name
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  mergeable: boolean;
  createdSeq: number;
  /** Files changed by the PR, computed from head vs base trees. */
  files: { filename: string; status: 'added' | 'modified' | 'removed'; additions: number; deletions: number; changes: number }[];
}

export function globalId(kind: string, ...parts: (string | number)[]): string {
  return Buffer.from([kind, ...parts.map(String)].join(':'), 'utf8').toString('base64');
}

export function parseGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const pieces = text.split(':');
    const kind = pieces[0];
    if (!kind || pieces.length < 2) return null;
    return { kind, parts: pieces.slice(1) };
  } catch {
    return null;
  }
}

export class Store {
  repos = new Map<string, Repo>(); // key: `${owner}/${name}`
  objects = new Map<string, GitObject>(); // oid -> object
  nextRepoId = 1;
  nextIssueId = 1;
  nextPullId = 1;
  nextSeq = 1;

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  createRepo(owner: string, name: string, opts: { description?: string; private?: boolean; defaultBranch?: string }): Repo {
    const repo: Repo = {
      id: this.nextRepoId++,
      name,
      owner,
      description: opts.description ?? '',
      private: opts.private ?? false,
      defaultBranch: opts.defaultBranch ?? DEFAULT_BRANCH,
      refs: new Map(),
      labels: new Map(),
      issues: [],
      pulls: [],
      nextIssueNumber: 1,
      nextPullNumber: 1,
      nextCommentId: 1,
    };
    this.repos.set(this.repoKey(owner, name), repo);
    return repo;
  }

  listRepos(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === owner) out.push(repo);
    return out;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }

  // ------------------------------------------------------------ git objects

  putObject(type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  getObject(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  lookup = (oid: string): GitObject | undefined => this.objects.get(oid);

  refOid(repo: Repo, ref: string): string | undefined {
    return repo.refs.get(ref);
  }

  /** The commit oid a branch points at, or undefined. */
  branchTip(repo: Repo, branch: string): string | undefined {
    return repo.refs.get(`refs/heads/${branch}`);
  }

  /** All refs, sorted by name, as [name, oid] pairs. */
  allRefs(repo: Repo): [string, string][] {
    return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  }

  // ------------------------------------------------------------ trees

  /** The flat file map of a tree (path -> {oid, mode}), recursing into subtrees. */
  flattenTree(treeOid: string, prefix = ''): Map<string, { oid: string; mode: string }> {
    const out = new Map<string, { oid: string; mode: string }>();
    const walk = (oid: string, pre: string): void => {
      const obj = this.objects.get(oid);
      if (!obj || obj.type !== 'tree') return;
      for (const entry of parseTree(obj.data)) {
        const path = pre ? `${pre}/${entry.name}` : entry.name;
        if (entry.mode === '40000') walk(entry.oid, path);
        else out.set(path, { oid: entry.oid, mode: entry.mode });
      }
    };
    walk(treeOid, prefix);
    return out;
  }

  /** Build (and store) a tree from a flat file map. Returns the root tree oid. */
  buildTreeFromFiles(files: Map<string, { oid: string; mode: string }>): string {
    // Group by directory.
    const byDir = new Map<string, TreeEntry[]>();
    for (const [path, file] of files) {
      const slash = path.lastIndexOf('/');
      const dir = slash < 0 ? '' : path.slice(0, slash);
      const name = slash < 0 ? path : path.slice(slash + 1);
      const list = byDir.get(dir) ?? [];
      list.push({ mode: file.mode, name, oid: file.oid });
      byDir.set(dir, list);
    }
    const buildDir = (dir: string): string => {
      const entries: TreeEntry[] = [...(byDir.get(dir) ?? [])];
      // Subdirectories of this dir.
      const subdirs = new Set<string>();
      for (const d of byDir.keys()) {
        if (d === dir) continue;
        if (dir === '' && !d.includes('/')) subdirs.add(d);
        else if (d.startsWith(`${dir}/`) && !d.slice(dir.length + 1).includes('/')) subdirs.add(d.slice(dir.length + 1));
      }
      for (const sub of subdirs) {
        const subPath = dir === '' ? sub : `${dir}/${sub}`;
        entries.push({ mode: '40000', name: sub, oid: buildDir(subPath) });
      }
      const data = buildTree(entries);
      return this.putObject('tree', data);
    };
    return buildDir('');
  }

  /** The commit's tree as a flat file map. */
  commitFiles(commitOid: string): Map<string, { oid: string; mode: string }> {
    const obj = this.objects.get(commitOid);
    if (!obj || obj.type !== 'commit') return new Map();
    return this.flattenTree(parseCommit(obj.data).tree);
  }

  /** Create a commit on top of `parents` with the given file map and message. */
  createCommit(files: Map<string, { oid: string; mode: string }>, parents: string[], message: string): string {
    const treeOid = this.buildTreeFromFiles(files);
    const data = buildCommit({ tree: treeOid, parents, message });
    return this.putObject('commit', data);
  }

  /** Is `ancestor` an ancestor of (or equal to) `oid`? Walks parents only. */
  isAncestor(ancestor: string, oid: string): boolean {
    if (ancestor === oid) return true;
    const seen = new Set<string>();
    const queue = [oid];
    while (queue.length) {
      const cur = queue.pop()!;
      if (seen.has(cur)) continue;
      seen.add(cur);
      const obj = this.objects.get(cur);
      if (!obj || obj.type !== 'commit') continue;
      for (const parent of parseCommit(obj.data).parents) {
        if (parent === ancestor) return true;
        queue.push(parent);
      }
    }
    return false;
  }

  /** The files changed between two trees (base -> head), by path. */
  diffFiles(baseCommit: string, headCommit: string): Pull['files'] {
    const base = this.commitFiles(baseCommit);
    const head = this.commitFiles(headCommit);
    const out: Pull['files'] = [];
    const paths = new Set([...base.keys(), ...head.keys()]);
    for (const path of [...paths].sort()) {
      const b = base.get(path);
      const h = head.get(path);
      if (b && !h) {
        out.push({ filename: path, status: 'removed', additions: 0, deletions: 1, changes: 1 });
      } else if (!b && h) {
        out.push({ filename: path, status: 'added', additions: 1, deletions: 0, changes: 1 });
      } else if (b && h && b.oid !== h.oid) {
        out.push({ filename: path, status: 'modified', additions: 1, deletions: 1, changes: 2 });
      }
    }
    return out;
  }

  /** Whether merging head into base would conflict (same file changed differently on both sides). */
  mergeConflicts(baseCommit: string, headCommit: string, baseTipCommit: string): boolean {
    // Merge base = baseCommit (the base branch tip at PR creation). Compare the file maps:
    // a file conflicts if head changed it relative to merge-base AND baseTip changed it
    // relative to merge-base, to different contents.
    const mergeBase = this.commitFiles(baseCommit);
    const head = this.commitFiles(headCommit);
    const tip = this.commitFiles(baseTipCommit);
    const paths = new Set([...mergeBase.keys(), ...head.keys(), ...tip.keys()]);
    for (const path of paths) {
      const m = mergeBase.get(path)?.oid;
      const h = head.get(path)?.oid;
      const t = tip.get(path)?.oid;
      const headChanged = h !== m;
      const tipChanged = t !== m;
      if (headChanged && tipChanged && h !== t) return true;
    }
    return false;
  }

  /** Squash-merge a PR onto its base branch. Returns the merge commit oid, or null on conflict. */
  squashMerge(repo: Repo, pull: Pull): string | null {
    const baseTip = this.branchTip(repo, pull.base);
    const headTip = this.branchTip(repo, pull.head);
    if (!baseTip || !headTip) return null;
    if (this.mergeConflicts(pull.baseSha, headTip, baseTip)) return null;
    // The merged tree: base tip's files, overlaid with the head's files (head wins).
    const merged = this.commitFiles(baseTip);
    for (const [path, file] of this.commitFiles(headTip)) merged.set(path, file);
    const message = `Merge pull request #${pull.number} from ${pull.head}\n\n${pull.title}`;
    const mergeOid = this.createCommit(merged, [baseTip], message);
    repo.refs.set(`refs/heads/${pull.base}`, mergeOid);
    return mergeOid;
  }

  /** The peeled commit oid a ref points at (tags peel to their commit). */
  peelRef(repo: Repo, ref: string): string | undefined {
    const oid = repo.refs.get(ref);
    if (!oid) return undefined;
    const obj = this.objects.get(oid);
    if (obj?.type === 'tag') {
      const tag = parseTag(obj.data);
      return tag.object;
    }
    return oid;
  }

  /** All objects reachable from a set of tips (for fetch/clone). */
  reachable(tips: Iterable<string>): Set<string> {
    return collectReachable(tips, this.lookup, { allowMissing: true });
  }
}

export const store = new Store();
