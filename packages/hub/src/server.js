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

import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { buildForkSessionCommand, buildOpenSessionCommand, buildSpawnCommand, findSessionCwd } from "@wirelessr/pi-webui-components/session-spawn.js";
import { normalizeState, pruneState } from "../public/hub-state-logic.js";
import { buildSessionList, diffBusyTransitions, parseProxyPath, pickSession } from "./hub-helpers.js";

const require = createRequire(import.meta.url);
const HUB_DIR = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(HUB_DIR, "..", "public");
const COMPONENTS_DIR = join(dirname(require.resolve("@wirelessr/pi-webui-components/package.json")), "src");

const PORT = Number.parseInt(process.env.PI_HUB_PORT || "8730", 10);
const HOST = process.env.PI_HUB_HOST || "0.0.0.0";
// Match the extension's default discovery dir so the hub sees real sessions.
const BRIDGE_DIR =
  process.env.PI_BRIDGE_DIR || join(homedir(), ".pi", "agent", "extensions", "pi-webui-extension", "data");
// Hub-owned persistent prefs (sidebar order + groups). One JSON file, atomic
// write. Cross-device: every client hits this one hub, so ordering/grouping is
// shared rather than per-browser.
const HUB_STATE_PATH = join(BRIDGE_DIR, "hub-state.json");

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

// ── Hub state (sidebar order + groups) ──

function loadHubState() {
  try {
    return normalizeState(JSON.parse(readFileSync(HUB_STATE_PATH, "utf-8")));
  } catch {
    return normalizeState(null);
  }
}

// Persist normalized+pruned state atomically (write temp, then rename).
function saveHubState(rawState, liveIds) {
  const state = pruneState(normalizeState(rawState), liveIds);
  const tmp = `${HUB_STATE_PATH}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state));
  renameSync(tmp, HUB_STATE_PATH);
  return state;
}

// ── Cross-session busy watcher + aggregate event stream ──
// Poll each session's status; when one transitions busy→idle, push a
// `session_done` event to every /api/events subscriber. This is what lets
// the single SPA notify for a session the user isn't currently viewing.

let busyState = new Map();
const eventClients = new Set();

function broadcast(obj) {
  const line = `data: ${JSON.stringify(obj)}\n\n`;
  for (const res of eventClients) {
    try {
      res.write(line);
    } catch {
      // client wrote-after-close; the close handler will prune it
    }
  }
}

async function fetchBusy(session) {
  try {
    const res = await fetch(`http://localhost:${session.port}/api/status`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return null;
    const data = await res.json();
    return { sessionId: session.sessionId, sessionName: session.sessionName, busy: !!data.busy };
  } catch {
    return null; // unreachable / slow — treat as unknown, skip this round
  }
}

let polling = false;
async function pollBusy() {
  if (polling) return;
  polling = true;
  try {
    const sessions = listSessions();
    const results = (await Promise.all(sessions.map(fetchBusy))).filter(Boolean);
    const { done, nextBusy } = diffBusyTransitions(busyState, results);
    busyState = nextBusy;
    for (const d of done) {
      broadcast({ type: "session_done", sessionId: d.sessionId, sessionName: d.sessionName });
    }
  } finally {
    polling = false;
  }
}

function currentBusy(sessionId) {
  return busyState.get(sessionId) ?? null;
}

// Spawn a brand-new pi session directly (works even with zero existing
// sessions — no bridge to proxy through). The child writes its discovery
// file into the hub's BRIDGE_DIR via the env below.
function spawnSession(cwd) {
  const cmd = buildSpawnCommand({ logFile: join(BRIDGE_DIR, "hub-spawn.log"), prefix: "[hub-new]" });
  const child = spawn("sh", ["-c", cmd], {
    cwd: cwd || homedir(),
    detached: true,
    stdio: "ignore",
    env: { ...process.env, PI_BRIDGE_DIR: BRIDGE_DIR },
  });
  child.unref();
  if (!child.pid) throw new Error("spawn failed");
  return child.pid;
}

// Open (resume) an existing session by ID. cwd is auto-resolved (shared
// findSessionCwd) from the session's own log so it comes back in the right
// directory — pi refuses to resume from the wrong project directory.
function openSession(sessionId, name) {
  const cmd = buildOpenSessionCommand({ sessionId, name, logFile: join(BRIDGE_DIR, "hub-spawn.log"), prefix: "[hub-open]" });
  const child = spawn("sh", ["-c", cmd], {
    cwd: findSessionCwd(sessionId) || homedir(),
    detached: true,
    stdio: "ignore",
    env: { ...process.env, PI_BRIDGE_DIR: BRIDGE_DIR },
  });
  child.unref();
  if (!child.pid) throw new Error("spawn failed");
  return child.pid;
}

// Clone (fork) an existing session into a new one. Like resume, cwd must be the
// source session's original directory (fork reads its project-bound file), so
// it's auto-resolved with the shared findSessionCwd.
function cloneSession(sessionId, name) {
  const cmd = buildForkSessionCommand({ sessionId, name, logFile: join(BRIDGE_DIR, "hub-spawn.log"), prefix: "[hub-clone]" });
  const child = spawn("sh", ["-c", cmd], {
    cwd: findSessionCwd(sessionId) || homedir(),
    detached: true,
    stdio: "ignore",
    env: { ...process.env, PI_BRIDGE_DIR: BRIDGE_DIR },
  });
  child.unref();
  if (!child.pid) throw new Error("spawn failed");
  return child.pid;
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        resolve({});
      }
    });
    req.on("error", () => resolve({}));
  });
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

  if (url === "/api/hub-state" && req.method === "GET") {
    // Return state pruned against live sessions so clients never see ghosts.
    const liveIds = listSessions().map((s) => s.sessionId);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(pruneState(loadHubState(), liveIds)));
    return;
  }

  if (url === "/api/hub-state" && req.method === "PUT") {
    const body = await readJsonBody(req);
    const liveIds = listSessions().map((s) => s.sessionId);
    try {
      const state = saveHubState(body, liveIds);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(state));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (url === "/api/sessions") {
    const sessions = listSessions().map((s) => ({ ...s, busy: currentBusy(s.sessionId) }));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ sessions }));
    return;
  }

  if (url === "/api/events") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    res.write(": connected\n\n");
    eventClients.add(res);
    const heartbeat = setInterval(() => {
      try {
        res.write(": heartbeat\n\n");
      } catch {
        // pruned on close
      }
    }, 15000);
    res.on("close", () => {
      clearInterval(heartbeat);
      eventClients.delete(res);
    });
    return;
  }

  if (url === "/api/new-session" && req.method === "POST") {
    const body = await readJsonBody(req);
    try {
      const pid = spawnSession(body.cwd);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, pid }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (url === "/api/open-session" && req.method === "POST") {
    const body = await readJsonBody(req);
    if (!body.sessionId) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "sessionId is required" }));
      return;
    }
    try {
      const pid = openSession(body.sessionId, body.name);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, pid }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (url === "/api/clone-session" && req.method === "POST") {
    const body = await readJsonBody(req);
    if (!body.sessionId) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "sessionId is required" }));
      return;
    }
    try {
      const pid = cloneSession(body.sessionId, body.name);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, pid }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
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
  setInterval(pollBusy, 2000);
});
