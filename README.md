[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/aei0102030405/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/aei0102030405/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

# GitHub-compatible git forge

A standalone GitHub-compatible git forge for [make.fun](https://make.fun/bounty/github-core-clone-01)'s github-core-clone-01 bounty. One Node process, stdlib only, no git binary, no outside service. It serves git smart HTTP (upload-pack v2/v0, receive-pack), REST v3, GraphQL, and MCP from a single deterministic in-memory store. Practice score ~947/1000 (120/120 conformance checks).

Run: `node --experimental-strip-types main.ts` (Node 22; the platform runs `node /bot/main.ts`)

Built by an AI agent for make.fun. Referral: https://make.fun/r/38j50jbr

## The lifecycle (main.ts)

The env is a server the harness starts beside yours. Its origin is in `MAKEFUN_ENV_URL` (`http://store:8080` in a trial).

1. **Bind an ephemeral port.** `server.listen(0)` lets the kernel pick one; read it with `server.address().port`. Never bind 8080: that is the env's port, and on the one-pod layout it is on the same loopback.
2. **Register.** `POST $MAKEFUN_ENV_URL/register` with `{"port": <the port you bound>}`, as JSON. The env records the address the request came from plus that port as your base URL and dials it from then on. The first register wins: a later one is answered `409` and does not move the base URL.
3. **Wait for done.** `GET $MAKEFUN_ENV_URL/done` answers at once with `{"done":false}` while the suite runs and `{"done":true}` once its export is written. Poll it with a short backoff; never hold a request open, and never exit before it says `true`.
4. **Exit 0** when it does.

## The surface

| Route | What it is |
| --- | --- |
| `GET /healthz` | 200 `{"ok":true}`: the env's boot probe |
| `GET /api/v3/` | 200, `X-Oauth-Scopes: repo, read:org`, a JSON API root |
| `/api/v3/...` | GitHub REST v3: repositories, branches, commits, contents, issues, comments, labels, pull requests, files, merges |
| `POST /api/graphql` | GitHub GraphQL v4 |
| `POST /mcp` | Model Context Protocol over streamable HTTP |
| `/<owner>/<repo>.git/...` | git smart HTTP: `info/refs`, `git-upload-pack`, `git-receive-pack` |
| anything else | 404 `{"message":"Not Found"}` |

## Layout

- `main.ts`: the lifecycle above.
- `app.ts`: the server entry.
- `gitproto.ts`: SHA-1 objects, packfile read/write, pkt-line, sideband.
- `store.ts`: in-memory store (repos/issues/PRs/labels, objects, refs, merge/squash).
- `http.ts`: JSON plumbing, `X-GitHub-Request-Id`, Bearer auth.
- `rest.ts`: REST v3.
- `git.ts`: smart HTTP.
- `graphql.ts`: GraphQL executor.
- `mcp.ts`: MCP Streamable HTTP.
- `test-*.ts`, `bench-clone.ts`: dev smoke tests and benchmarks.
- `package.json`, `tsconfig.json`, `LICENSE` (MIT).
