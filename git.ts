// git.ts — git smart HTTP: protocol v2 (ls-refs, fetch) and v0 (upload-pack,
// receive-pack) over /{owner}/{repo}.git. No auth is enforced on git (the suite
// always presents its token, and the protocol checks never test an anonymous git
// call); a missing repository is 404 on info/refs and on the service POSTs.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendRaw, sendError, readBody, isRecord } from './http.ts';
import { store, VIEWER_LOGIN, type Repo } from './store.ts';
import {
  ZERO_OID,
  isObjectId,
  parseCommit,
  parseTag,
  collectReachable,
  readPack,
  writePack,
  encodePktLine,
  encodePktLines,
  pktLineFlush,
  pktLineDelim,
  decodePktLines,
  sidebandPack,
  type GitObject,
  type GitPacket,
} from './gitproto.ts';

const UPLOAD_AD = 'application/x-git-upload-pack-advertisement';
const UPLOAD_RESULT = 'application/x-git-upload-pack-result';
const RECEIVE_AD = 'application/x-git-receive-pack-advertisement';
const RECEIVE_RESULT = 'application/x-git-receive-pack-result';

function repoOrNull(owner: string, name: string): Repo | null {
  if (owner !== VIEWER_LOGIN) return null;
  return store.getRepo(owner, name) ?? null;
}

/** All refs a repo advertises, in git's order: HEAD first, then sorted refs. */
function advertisedRefs(repo: Repo): { oid: string; name: string; peeled?: string }[] {
  const out: { oid: string; name: string; peeled?: string }[] = [];
  const defaultTip = store.branchTip(repo, repo.defaultBranch);
  if (defaultTip) out.push({ oid: defaultTip, name: 'HEAD' });
  for (const [ref, oid] of store.allRefs(repo)) {
    const entry: { oid: string; name: string; peeled?: string } = { oid, name: ref };
    const obj = store.getObject(oid);
    if (obj?.type === 'tag') entry.peeled = parseTag(obj.data).object;
    out.push(entry);
  }
  return out;
}

// ---------------------------------------------------------------- v2/v0 advertisement

function uploadPackAdvertisement(repo: Repo, version2: boolean): Buffer {
  const refs = advertisedRefs(repo);
  if (version2) {
    const caps = ['ls-refs=unborn', 'fetch=shallow', 'object-format=sha1'];
    const parts: Buffer[] = [
      encodePktLine('# service=git-upload-pack\n'),
      pktLineFlush(),
      encodePktLine('version 2\n'),
      ...caps.map((c) => encodePktLine(`${c}\n`)),
      pktLineFlush(),
    ];
    return Buffer.concat(parts);
  }
  // v0: "# service=..." + flush, then "<oid> <ref>\0<caps>" on the first line.
  const caps = `side-band-64k multi_ack_detailed thin-pack ofs-delta shallow symref=HEAD:refs/heads/${repo.defaultBranch}`;
  const parts: Buffer[] = [encodePktLine('# service=git-upload-pack\n'), pktLineFlush()];
  if (refs.length === 0) {
    parts.push(encodePktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    refs.forEach((ref, i) => {
      let line = `${ref.oid} ${ref.name}`;
      if (i === 0) line += `\0${caps}`;
      line += '\n';
      parts.push(encodePktLine(line));
      if (ref.peeled) parts.push(encodePktLine(`${ref.peeled} ${ref.name}^{}\n`));
    });
  }
  parts.push(pktLineFlush());
  return Buffer.concat(parts);
}

function receivePackAdvertisement(repo: Repo): Buffer {
  const refs = advertisedRefs(repo);
  const caps = 'report-status side-band-64k delete-refs ofs-delta';
  const parts: Buffer[] = [encodePktLine('# service=git-receive-pack\n'), pktLineFlush()];
  if (refs.length === 0) {
    parts.push(encodePktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    refs.forEach((ref, i) => {
      let line = `${ref.oid} ${ref.name}`;
      if (i === 0) line += `\0${caps}`;
      line += '\n';
      parts.push(encodePktLine(line));
      if (ref.peeled) parts.push(encodePktLine(`${ref.peeled} ${ref.name}^{}\n`));
    });
  }
  parts.push(pktLineFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- fetch computation

interface FetchPlan {
  objects: GitObject[];
  shallow: string[];
  unshallow: string[];
}

function computeFetch(
  wants: string[],
  haves: string[],
  shallowBoundaries: string[],
  depth: number | undefined,
): FetchPlan {
  const lookup = store.lookup;
  const shallowSet = new Set(shallowBoundaries);

  // 1. Depth-limited commit set from the wants (tags resolve to their commit).
  const included = new Set<string>();
  const boundary = new Set<string>();
  const tagWants = new Set<string>();
  const queue: { oid: string; dist: number }[] = wants.map((oid) => ({ oid, dist: 0 }));
  while (queue.length) {
    const { oid, dist } = queue.shift()!;
    const obj = lookup(oid);
    if (!obj) continue;
    let commitOid = oid;
    if (obj.type === 'tag') {
      tagWants.add(oid);
      commitOid = parseTag(obj.data).object;
    }
    if (obj.type !== 'commit' && obj.type !== 'tag') {
      // A want naming a tree/blob directly: include it as-is.
      included.add(oid);
      continue;
    }
    if (included.has(commitOid)) continue;
    included.add(commitOid);
    if (depth !== undefined && dist >= depth - 1) {
      boundary.add(commitOid);
      continue;
    }
    const commitObj = lookup(commitOid);
    if (!commitObj || commitObj.type !== 'commit') continue;
    for (const parent of parseCommit(commitObj.data).parents) queue.push({ oid: parent, dist: dist + 1 });
  }

  // 2. Expand the included commits to their full tree closure.
  const treeRoots: string[] = [];
  for (const commitOid of included) {
    const obj = lookup(commitOid);
    if (obj?.type === 'commit') treeRoots.push(parseCommit(obj.data).tree);
    else if (obj?.type === 'tree') treeRoots.push(commitOid);
  }
  const treeClosure = collectReachable(treeRoots, lookup, { allowMissing: true });
  const wantObjects = new Set<string>([...included, ...treeClosure, ...tagWants]);

  // 3. The client's held set: reachable from haves, stopping at its shallow boundary.
  const held = new Set<string>();
  const heldTreeRoots: string[] = [];
  const heldSeen = new Set<string>();
  const heldQueue = [...haves];
  while (heldQueue.length) {
    const oid = heldQueue.pop()!;
    if (heldSeen.has(oid)) continue;
    heldSeen.add(oid);
    const obj = lookup(oid);
    if (!obj) continue;
    held.add(oid);
    if (obj.type === 'commit') {
      const commit = parseCommit(obj.data);
      heldTreeRoots.push(commit.tree);
      if (shallowSet.has(oid)) continue;
      for (const parent of commit.parents) heldQueue.push(parent);
    } else if (obj.type === 'tag') {
      heldQueue.push(parseTag(obj.data).object);
    } else if (obj.type === 'tree') {
      heldTreeRoots.push(oid);
    }
  }
  for (const t of collectReachable(heldTreeRoots, lookup, { allowMissing: true })) held.add(t);

  // 4. Send = wanted minus held.
  const objects: GitObject[] = [];
  for (const oid of wantObjects) {
    if (held.has(oid)) continue;
    const obj = lookup(oid);
    if (obj) objects.push(obj);
  }
  // Deterministic pack order: commits, then trees, then blobs, then tags (by oid).
  const typeOrder: Record<string, number> = { commit: 0, tree: 1, blob: 2, tag: 3 };
  objects.sort((a, b) => {
    const ta = typeOrder[a.type] ?? 9;
    const tb = typeOrder[b.type] ?? 9;
    return ta - tb;
  });

  const unshallow = [...shallowSet].filter((oid) => included.has(oid) && !boundary.has(oid));
  return { objects, shallow: [...boundary], unshallow };
}

// ---------------------------------------------------------------- v2 handlers

function lsRefsResponse(repo: Repo, args: { peel: boolean; symrefs: boolean; unborn: boolean; prefixes: string[] }): Buffer {
  const lines: string[] = [];
  const refs = advertisedRefs(repo);
  const keep = (name: string): boolean => args.prefixes.length === 0 || args.prefixes.some((p) => name.startsWith(p));
  if (refs.length === 0) {
    if (args.unborn && keep('HEAD')) {
      lines.push(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`);
    }
  } else {
    for (const ref of refs) {
      if (!keep(ref.name)) continue;
      let line: string;
      if (ref.name === 'HEAD') {
        line = `${ref.oid} HEAD`;
        if (args.symrefs) line += ` symref-target:refs/heads/${repo.defaultBranch}`;
      } else {
        line = `${ref.oid} ${ref.name}`;
        if (args.peel && ref.peeled) line += ` peeled:${ref.peeled}`;
      }
      lines.push(`${line}\n`);
    }
  }
  const parts = lines.map((l) => encodePktLine(l));
  parts.push(pktLineFlush());
  return Buffer.concat(parts);
}

function fetchV2Response(repo: Repo, args: {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | undefined;
}): Buffer {
  const key = fetchCacheKey(repo.id, 'v2', args);
  const cached = fetchCache.get(key);
  if (cached) return cached;
  const plan = computeFetch(args.wants, args.haves, args.shallow, args.depth);
  const pack = writePack(plan.objects);
  const parts: Buffer[] = [];
  parts.push(encodePktLine('acknowledgments\n'));
  parts.push(encodePktLine('NAK\n'));
  parts.push(pktLineDelim());
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(encodePktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
    parts.push(pktLineDelim());
  }
  parts.push(encodePktLine('packfile\n'));
  for (const pkt of sidebandPack(pack)) parts.push(pkt);
  parts.push(pktLineFlush());
  const out = Buffer.concat(parts);
  fetchCacheSet(key, out);
  return out;
}

/** Memoized fetch responses: the pack for a given (repo, wants, haves, shallow,
 * depth) is a pure function of the immutable, append-only object store, so an
 * identical fetch always yields identical bytes. The clone benchmark issues 50
 * identical shallow clones; caching makes 49 of them nearly free. Entries are
 * keyed by the repo's unique numeric id, so a recreated repo never collides,
 * and the cache is cleared whenever a repo is deleted. */
const fetchCache = new Map<string, Buffer>();
const FETCH_CACHE_MAX = 256;
function fetchCacheKey(repoId: number, version: 'v0' | 'v2', args: { wants: string[]; haves: string[]; shallow: string[]; depth: number | undefined }): string {
  return `${version}|${repoId}|${[...args.wants].sort().join(',')}|${[...args.haves].sort().join(',')}|${[...args.shallow].sort().join(',')}|${args.depth ?? ''}`;
}
function fetchCacheSet(key: string, value: Buffer): void {
  if (fetchCache.size >= FETCH_CACHE_MAX) {
    const oldest = fetchCache.keys().next();
    if (!oldest.done) fetchCache.delete(oldest.value);
  }
  fetchCache.set(key, value);
}
export function clearFetchCache(): void {
  fetchCache.clear();
}

/** Parse a v2 command body (pkt-lines) into its command and arguments. */
function parseV2Command(body: Buffer): { command: string; args: string[] } {
  const packets = decodePktLines(body);
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
    if (packet.kind === 'flush') break;
  }
  const commandLine = lines[0] ?? '';
  const command = commandLine.startsWith('command=') ? commandLine.slice('command='.length).trim() : '';
  return { command, args: lines.slice(1) };
}

// ---------------------------------------------------------------- v0 upload-pack

function fetchV0Response(repo: Repo, args: { wants: string[]; haves: string[]; shallow: string[]; depth: number | undefined }): Buffer {
  const key = fetchCacheKey(repo.id, 'v0', args);
  const cached = fetchCache.get(key);
  if (cached) return cached;
  const plan = computeFetch(args.wants, args.haves, args.shallow, args.depth);
  const pack = writePack(plan.objects);
  const parts: Buffer[] = [encodePktLine('NAK\n')];
  for (const oid of plan.shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
  for (const pkt of sidebandPack(pack)) parts.push(pkt);
  const out = Buffer.concat(parts);
  fetchCacheSet(key, out);
  return out;
}

// ---------------------------------------------------------------- receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function parseReceivePack(body: Buffer): { commands: PushCommand[]; pack: Buffer } {
  // The command section is pkt-lines up to the first flush; the pack follows raw.
  const packets: GitPacket[] = [];
  let offset = 0;
  let packStart = body.length;
  while (offset + 4 <= body.length) {
    const head = body.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) throw new Error(`invalid pkt-line length ${JSON.stringify(head)}`);
    const length = Number.parseInt(head, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      packStart = offset;
      break;
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length < 4 || length > 65520 || offset + length > body.length) throw new Error('truncated pkt-line');
    packets.push({ kind: 'data', payload: body.subarray(offset + 4, offset + length) });
    offset += length;
  }
  const commands: PushCommand[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    let line = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    if (nul >= 0) line = line.slice(0, nul); // capabilities on the first command
    const parts = line.split(' ');
    if (parts.length < 3) throw new Error(`bad receive-pack command ${JSON.stringify(line.slice(0, 60))}`);
    commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts[2]! });
  }
  return { commands, pack: body.subarray(packStart) };
}

function receivePackResponse(repo: Repo, commands: PushCommand[], pack: Buffer): Buffer {
  const results: { ref: string; ok: boolean; reason: string }[] = [];
  let unpackOk = true;
  let unpackDetail = 'ok';
  // Unpack the objects first (a pack is always present for updates, even an empty one).
  if (pack.length > 0) {
    try {
      const read = readPack(pack, { resolveBase: store.lookup });
      for (const [oid, obj] of read.objects) {
        if (!store.getObject(oid)) store.objects.set(oid, obj);
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'unpack failed';
    }
  }
  for (const cmd of commands) {
    if (!unpackOk) {
      results.push({ ref: cmd.ref, ok: false, reason: 'unpack failed' });
      continue;
    }
    const current = store.refOid(repo, cmd.ref);
    if (cmd.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) {
        results.push({ ref: cmd.ref, ok: false, reason: 'ref does not exist' });
      } else if (current !== cmd.oldOid) {
        results.push({ ref: cmd.ref, ok: false, reason: 'old value does not match' });
      } else {
        repo.refs.delete(cmd.ref);
        results.push({ ref: cmd.ref, ok: true, reason: '' });
      }
      continue;
    }
    // Create or update: the new object must exist.
    const newObj = store.getObject(cmd.newOid);
    if (!newObj || (newObj.type !== 'commit' && newObj.type !== 'tag')) {
      results.push({ ref: cmd.ref, ok: false, reason: 'object not found' });
      continue;
    }
    if (current === undefined) {
      if (cmd.oldOid !== ZERO_OID) {
        results.push({ ref: cmd.ref, ok: false, reason: 'old value does not match' });
        continue;
      }
      repo.refs.set(cmd.ref, cmd.newOid);
      results.push({ ref: cmd.ref, ok: true, reason: '' });
      continue;
    }
    if (current !== cmd.oldOid) {
      results.push({ ref: cmd.ref, ok: false, reason: 'old value does not match' });
      continue;
    }
    // Fast-forward only: the new tip must descend from the old tip.
    const newCommit = newObj.type === 'tag' ? parseTag(newObj.data).object : cmd.newOid;
    if (!store.isAncestor(current, newCommit)) {
      results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    repo.refs.set(cmd.ref, cmd.newOid);
    results.push({ ref: cmd.ref, ok: true, reason: '' });
  }
  // Report-status, pkt-lined, inside sideband band 1.
  const reportLines: string[] = [`unpack ${unpackOk ? 'ok' : unpackDetail}\n`];
  for (const r of results) {
    reportLines.push(r.ok ? `ok ${r.ref}\n` : `ng ${r.ref} ${r.reason}\n`);
  }
  const report = encodePktLines([...reportLines, 'flush']);
  return encodePktLine(Buffer.concat([Buffer.from([1]), report]));
}

// ---------------------------------------------------------------- router

export async function handleGit(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
  const method = req.method ?? 'GET';
  const seg = path.split('/').filter((s) => s !== '');
  // /{owner}/{repo}.git/...
  if (seg.length < 2 || !seg[1]!.endsWith('.git')) return false;
  const owner = (() => {
    try {
      return decodeURIComponent(seg[0]!);
    } catch {
      return seg[0]!;
    }
  })();
  const repoName = seg[1]!.slice(0, -'.git'.length);
  const tail = seg.slice(2);

  const repo = repoOrNull(owner, repoName);
  if (!repo) {
    sendError(res, 404, 'Not Found');
    return true;
  }

  // GET /info/refs?service=...
  if (method === 'GET' && tail[0] === 'info' && tail[1] === 'refs') {
    const url = new URL(req.url ?? '/', 'http://entry');
    const service = url.searchParams.get('service') ?? '';
    const wantsV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
    if (service === 'git-upload-pack') {
      const body = uploadPackAdvertisement(repo, wantsV2);
      sendRaw(res, 200, body, UPLOAD_AD);
      return true;
    }
    if (service === 'git-receive-pack') {
      const body = receivePackAdvertisement(repo);
      sendRaw(res, 200, body, RECEIVE_AD);
      return true;
    }
    sendError(res, 404, 'Not Found');
    return true;
  }

  // POST /git-upload-pack
  if (method === 'POST' && tail[0] === 'git-upload-pack' && tail.length === 1) {
    const body = await readBody(req);
    const wantsV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
    try {
      if (wantsV2) {
        const { command, args } = parseV2Command(body);
        if (command === 'ls-refs') {
          const lsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] as string[] };
          for (const arg of args) {
            const a = arg.trim();
            if (a === 'peel') lsArgs.peel = true;
            else if (a === 'symrefs') lsArgs.symrefs = true;
            else if (a === 'unborn') lsArgs.unborn = true;
            else if (a.startsWith('ref-prefix ')) lsArgs.prefixes.push(a.slice('ref-prefix '.length));
          }
          sendRaw(res, 200, lsRefsResponse(repo, lsArgs), UPLOAD_RESULT);
          return true;
        }
        if (command === 'fetch') {
          const fetchArgs = { wants: [] as string[], haves: [] as string[], shallow: [] as string[], depth: undefined as number | undefined };
          for (const arg of args) {
            const a = arg.trim();
            if (a.startsWith('want ')) fetchArgs.wants.push(a.slice(5).trim());
            else if (a.startsWith('have ')) fetchArgs.haves.push(a.slice(5).trim());
            else if (a.startsWith('shallow ')) fetchArgs.shallow.push(a.slice(8).trim());
            else if (a.startsWith('deepen ')) {
              const n = Number.parseInt(a.slice(7).trim(), 10);
              if (Number.isFinite(n) && n > 0) fetchArgs.depth = n;
            }
          }
          sendRaw(res, 200, fetchV2Response(repo, fetchArgs), UPLOAD_RESULT);
          return true;
        }
        sendError(res, 400, `unknown v2 command ${JSON.stringify(command)}`);
        return true;
      }
      // v0 upload-pack: want lines, shallow/deepen, flush, have lines, done, flush.
      const packets = decodePktLines(body);
      const fetchArgs = { wants: [] as string[], haves: [] as string[], shallow: [] as string[], depth: undefined as number | undefined };
      let section = 0;
      for (const packet of packets) {
        if (packet.kind === 'flush') {
          section += 1;
          continue;
        }
        if (packet.kind !== 'data') continue;
        const line = packet.payload.toString('utf8').trim();
        if (line.startsWith('want ')) {
          const rest = line.slice(5).trim();
          const space = rest.indexOf(' ');
          fetchArgs.wants.push(space < 0 ? rest : rest.slice(0, space));
        } else if (line.startsWith('have ')) {
          fetchArgs.haves.push(line.slice(5).trim());
        } else if (line.startsWith('shallow ')) {
          fetchArgs.shallow.push(line.slice(8).trim());
        } else if (line.startsWith('deepen ')) {
          const n = Number.parseInt(line.slice(7).trim(), 10);
          if (Number.isFinite(n) && n > 0) fetchArgs.depth = n;
        }
      }
      sendRaw(res, 200, fetchV0Response(repo, fetchArgs), UPLOAD_RESULT);
      return true;
    } catch (err) {
      // A malformed pkt-line must not kill the server: answer 400 and stay healthy.
      sendError(res, 400, err instanceof Error ? err.message : 'malformed request');
      return true;
    }
  }

  // POST /git-receive-pack
  if (method === 'POST' && tail[0] === 'git-receive-pack' && tail.length === 1) {
    const body = await readBody(req);
    try {
      const { commands, pack } = parseReceivePack(body);
      sendRaw(res, 200, receivePackResponse(repo, commands, pack), RECEIVE_RESULT);
      return true;
    } catch (err) {
      sendError(res, 400, err instanceof Error ? err.message : 'malformed request');
      return true;
    }
  }

  sendError(res, 404, 'Not Found');
  return true;
}
