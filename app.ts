// app.ts — the forge's HTTP server: one process, Node stdlib only. It routes
// every request to the surface that owns it and answers a JSON 404 for the rest.
//
//   GET  /healthz                  the env's boot probe: 200 {"ok":true}
//   /{owner}/{repo}.git/...        git smart HTTP (protocol v2 + v0)
//   /api/v3/...                    GitHub REST v3
//   POST /api/graphql             GraphQL v4
//   POST /mcp                     MCP Streamable HTTP (JSON-RPC 2.0)

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { sendJson, sendError, pathOf } from './http.ts';
import { handleRest } from './rest.ts';
import { handleGit } from './git.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const path = pathOf(req);
        const method = req.method ?? 'GET';

        // The env's boot check calls this twice: 200 {"ok":true}.
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        // MCP (Streamable HTTP).
        if (path === '/mcp') {
          await handleMcp(req, res);
          return;
        }

        // GraphQL v4.
        if (path === '/api/graphql') {
          await handleGraphQL(req, res);
          return;
        }

        // Git smart HTTP: /{owner}/{repo}.git/...
        const seg = path.split('/').filter((s) => s !== '');
        if (seg.length >= 2 && seg[1]!.endsWith('.git')) {
          await handleGit(req, res, path);
          return;
        }

        // REST v3 under /api/v3.
        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          await handleRest(req, res, path);
          return;
        }

        // Everything else, every method: GitHub's 404 body.
        sendError(res, 404, 'Not Found');
      } catch (err) {
        // A handler must never take the process down: answer 500 JSON and stay up.
        try {
          sendError(res, 500, err instanceof Error ? err.message : 'Internal Server Error');
        } catch {
          // The response is already gone; nothing left to do.
        }
      }
    })();
  });
}
