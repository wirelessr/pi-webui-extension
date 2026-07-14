/**
 * pi WebUI hub — single browser entry point that reverse-proxies each
 * per-session bridge and serves one SPA (in-page session switching, so the
 * page/SSE survive switching and notifications can fire for any session).
 *
 * Routes:
 *   GET  /api/sessions        aggregated live session list
 *   ANY  /s/<sessionId>/...   reverse-proxy to that session's bridge (SSE-safe)
 *   GET  /  and static        hub shell + shared components assets
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSessionList, parseProxyPath, pickSession } from "./hub-helpers.js";

const require = createRequire(import.meta.url);
const HUB_DIR = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(HUB_DIR, "..", "public");
const COMPONENTS_DIR = join(dirname(require.resolve("@wirelessr/pi-webui-components/package.json")), "src");

const PORT = Number.parseInt(process.env.PI_HUB_PORT || "8730", 10);
const HOST = process.env.PI_HUB_HOST || "0.0.0.0";
// Match the extension's default discovery dir so the hub sees real sessions.
const BRIDGE_DIR =
  process.env.PI_BRIDGE_DIR || join(homedir(), ".pi", "agent", "extensions", "pi-webui-extension", "data");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function listSessions() {
  let files = [];
  try {
    files = readdirSync(BRIDGE_DIR).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const discoveries = [];
  for (const f of files) {
    try {
      discoveries.push(JSON.parse(readFileSync(join(BRIDGE_DIR, f), "utf-8")));
    } catch {
      // skip unreadable
    }
  }
  return buildSessionList(discoveries, isPidAlive);
}

// ── Static serving (hub shell first, then shared components) ──

async function serveStatic(reqPath, res) {
  const rel = normalize(reqPath === "/" ? "/index.html" : reqPath).replace(/^(\.\.[/\\])+/, "").replace(/^\//, "");
  for (const base of [PUBLIC_DIR, COMPONENTS_DIR]) {
    const filePath = join(base, rel);
    if (!filePath.startsWith(base)) continue; // traversal guard
    if (existsSync(filePath)) {
      try {
        const data = await readFile(filePath);
        res.writeHead(200, { "Content-Type": MIME[extname(filePath).toLowerCase()] || "application/octet-stream", "Cache-Control": "no-cache" });
        res.end(data);
        return;
      } catch {
        break;
      }
    }
  }
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
}

// ── Reverse proxy to a session's bridge ──

function proxy(session, rest, req, res) {
  const proxyReq = httpRequest(
    { host: "localhost", port: session.port, path: rest, method: req.method, headers: { ...req.headers, host: `localhost:${session.port}` } },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
      proxyRes.pipe(res);
    },
  );
  proxyReq.on("error", () => {
    if (!res.headersSent) res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: `Session ${session.sessionId} unreachable on :${session.port}` }));
  });
  // Tear down the upstream request if the browser goes away (SSE cleanup).
  res.on("close", () => proxyReq.destroy());
  req.pipe(proxyReq);
}

const server = createServer(async (req, res) => {
  const url = req.url || "/";

  if (url === "/api/sessions") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ sessions: listSessions() }));
    return;
  }

  const proxied = parseProxyPath(url);
  if (proxied) {
    const session = pickSession(listSessions(), proxied.sessionId);
    if (!session) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `Unknown session ${proxied.sessionId}` }));
      return;
    }
    proxy(session, proxied.rest, req, res);
    return;
  }

  if (req.method === "GET" || req.method === "HEAD") {
    await serveStatic(url.split("?")[0], res);
    return;
  }
  res.writeHead(405, { "Content-Type": "text/plain" });
  res.end("Method not allowed");
});

server.listen(PORT, HOST, () => {
  console.log(`[hub] listening on http://${HOST}:${PORT} (discovery: ${BRIDGE_DIR})`);
});
