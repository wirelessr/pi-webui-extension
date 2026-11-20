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

import { randomBytes, randomUUID } from "node:crypto";
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildCronRunArgv,
  buildForkSessionCommand,
  buildOpenSessionCommand,
  buildSpawnCommand,
  findSessionCwd,
  listSessionFileIds,
  sessionShellArgv,
} from "@wirelessr/pi-webui-components/session-spawn.js";
import { normalizeState, pruneState } from "../public/hub-state-logic.js";
import { createCronRunner } from "./cron-runner.js";
import { spawnDetached } from "./detached-spawn.js";
import { buildSessionList, diffBusyTransitions, lastMessageTimestamp, parseProxyPath, pickSession, updateUnread } from "./hub-helpers.js";

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
  return buildSessionList(discoveries, isPidAlive, sessionActivityMs);
}

// Last conversation time of a session file. Cached on (mtime, size) so the tail
// is only re-read when the file changed; listSessions runs on every request.
const activityCache = new Map();
const TAIL_START = 64 * 1024;
const TAIL_MAX = 16 * 1024 * 1024;
function sessionActivityMs(file) {
  let st;
  try {
    st = statSync(file);
  } catch {
    return null;
  }
  const hit = activityCache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.at;
  let at = null;
  try {
    const fd = openSync(file, "r");
    try {
      // A conversation entry can be huge (tool output), so widen the tail until
      // one is found or the whole file has been read.
      for (let len = TAIL_START; at == null; len *= 4) {
        const n = Math.min(len, st.size);
        const buf = Buffer.alloc(n);
        readSync(fd, buf, 0, n, st.size - n);
        at = lastMessageTimestamp(buf.toString("utf-8"), n === st.size);
        if (n === st.size || len >= TAIL_MAX) break;
      }
    } finally {
      closeSync(fd);
    }
  } catch {
    // unreadable: fall through to mtime
  }
  at ??= st.mtimeMs; // no conversation yet (fresh session): file creation time
  activityCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, at });
  return at;
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
// Sessions whose turn finished while nobody was looking. In memory only (lost
// on hub restart); cleared by the viewing client via POST /api/mark-seen.
let unread = new Set();
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
    if (!res.ok) return { sessionId: session.sessionId, sessionName: session.sessionName, busy: null };
    const data = await res.json();
    return { sessionId: session.sessionId, sessionName: session.sessionName, busy: !!data.busy };
  } catch {
    // unreachable / slow — unknown, not idle; diffBusyTransitions keeps the last value
    return { sessionId: session.sessionId, sessionName: session.sessionName, busy: null };
  }
}

let polling = false;
async function pollBusy() {
  if (polling) return;
  polling = true;
  try {
    const sessions = listSessions();
    const results = await Promise.all(sessions.map(fetchBusy));
    const { done, nextBusy } = diffBusyTransitions(busyState, results);
    busyState = nextBusy;
    unread = updateUnread(unread, done, sessions.map((s) => s.sessionId));
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

// Busy-time sends are now injected into the running turn as STEERS (proxied
// straight to the bridge's /api/steer), so the hub keeps NO server-side message
// queue: the "waiting to be injected" list is tracked optimistically in the
// browser (added on send, removed when pi echoes the message back as a
// user_message). See hub-app.js. No dispatch loop, no persistence, no pause.

// Spawn a brand-new pi session directly (works even with zero existing
// sessions — no bridge to proxy through). The child writes its discovery
// file into the hub's BRIDGE_DIR via the env below.
function spawnSession(cwd) {
  const cmd = buildSpawnCommand({ logFile: join(BRIDGE_DIR, "hub-spawn.log"), prefix: "[hub-new]" });
  return spawnDetached(sessionShellArgv(cmd), {
    cwd: cwd || homedir(),
    env: { ...process.env, PI_BRIDGE_DIR: BRIDGE_DIR },
  });
}

// Open (resume) an existing session by ID. cwd is auto-resolved (shared
// findSessionCwd) from the session's own log so it comes back in the right
// directory — pi refuses to resume from the wrong project directory.
function openSession(sessionId, name) {
  const cmd = buildOpenSessionCommand({ sessionId, name, logFile: join(BRIDGE_DIR, "hub-spawn.log"), prefix: "[hub-open]" });
  return spawnDetached(sessionShellArgv(cmd), {
    cwd: findSessionCwd(sessionId) || homedir(),
    env: { ...process.env, PI_BRIDGE_DIR: BRIDGE_DIR },
  });
}

// Clone (fork) an existing session into a new one. Like resume, cwd must be the
// source session's original directory (fork reads its project-bound file), so
// it's auto-resolved with the shared findSessionCwd.
function cloneSession(sessionId, name) {
  const cmd = buildForkSessionCommand({ sessionId, name, logFile: join(BRIDGE_DIR, "hub-spawn.log"), prefix: "[hub-clone]" });
  return spawnDetached(sessionShellArgv(cmd), {
    cwd: findSessionCwd(sessionId) || homedir(),
    env: { ...process.env, PI_BRIDGE_DIR: BRIDGE_DIR },
  });
}

// ── Cron scheduler + Run now + run records (see cron-runner.js) ──
// Files live in BRIDGE_DIR/cron/ (not top level: discovery scans would see them).

const CRON_TICK_VALID = /^[1-9]\d*$/.test(process.env.PI_CRON_TICK_MS ?? "");
const CRON_TICK_MS = CRON_TICK_VALID ? Number(process.env.PI_CRON_TICK_MS) : 60000;
if (process.env.PI_CRON_TICK_MS !== undefined && !CRON_TICK_VALID) {
  console.error(`[hub] cron: ignoring PI_CRON_TICK_MS=${JSON.stringify(process.env.PI_CRON_TICK_MS)} (not a positive integer), using 60000`);
}
const SYSTEM_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
const cron = createCronRunner({
  cronDir: join(BRIDGE_DIR, "cron"),
  bridgeDir: BRIDGE_DIR,
  env: process.env,
  piBin: process.env.PI_CRON_PI_BIN || "pi",
  tickMs: CRON_TICK_MS,
  systemTz: SYSTEM_TZ,
  now: Date.now,
  randomHex4: () => randomBytes(2).toString("hex"),
  randomUUID,
  buildArgv: buildCronRunArgv,
  spawnDetached,
  isPidAlive,
  listSessionFileIds: () => listSessionFileIds(),
  liveSessionIds: () => new Set(listSessions().map((s) => s.sessionId)),
});

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

// Build token = newest mtime across the served frontend JS. Reflects the code a
// freshly-loaded page would run (dev repo or deployed); works without git and
// changes whenever any served .js is saved. Injected into index.html as
// window.__HUB_BUILD so every client log can carry a [ver] prefix — a long-open
// (stale-cached) tab keeps reporting the build it was loaded with.
function buildToken() {
  let newest = 0;
  for (const base of [PUBLIC_DIR, COMPONENTS_DIR]) {
    try {
      for (const f of readdirSync(base)) {
        if (!f.endsWith(".js")) continue;
        const m = statSync(join(base, f)).mtimeMs;
        if (m > newest) newest = m;
      }
    } catch {
      // dir missing — skip
    }
  }
  return String(Math.round(newest));
}

async function serveStatic(reqPath, res) {
  const rel = normalize(reqPath === "/" ? "/index.html" : reqPath).replace(/^(\.\.[/\\])+/, "").replace(/^\//, "");
  for (const base of [PUBLIC_DIR, COMPONENTS_DIR]) {
    const filePath = join(base, rel);
    if (!filePath.startsWith(base)) continue; // traversal guard
    if (existsSync(filePath)) {
      try {
        const data = await readFile(filePath);
        if (rel === "index.html") {
          const html = data.toString().replace("</head>", `<script>window.__HUB_BUILD=${JSON.stringify(buildToken())}</script></head>`);
          res.writeHead(200, { "Content-Type": MIME[".html"], "Cache-Control": "no-cache" });
          res.end(html);
          return;
        }
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
    const sessions = listSessions().map((s) => ({ ...s, busy: currentBusy(s.sessionId), unread: unread.has(s.sessionId) }));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ sessions }));
    return;
  }

  if (url === "/api/mark-seen" && req.method === "POST") {
    const body = await readJsonBody(req);
    unread.delete(body?.sessionId);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
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

  if (url.startsWith("/api/cron/")) {
    let r;
    try {
      r = cron.handle(req.method, url.split("?")[0]);
    } catch (err) {
      r = { status: 500, body: { error: err.message } };
    }
    res.writeHead(r.status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(r.body));
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

// Best-effort lock release; a lock left behind names a dead pid and is stale.
process.on("exit", () => cron.release());
for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]]) process.once(signal, () => process.exit(code));

server.listen(PORT, HOST, () => {
  console.log(`[hub] listening on http://${HOST}:${PORT} (discovery: ${BRIDGE_DIR})`);
  console.log(`[hub] cron: system timezone ${SYSTEM_TZ}, jobs file ${join(BRIDGE_DIR, "cron", "cron-jobs.json")}, tick ${CRON_TICK_MS} ms`);
  // First tick immediately (it can only take the lock; acting starts on the
  // next tick once the lock still names this pid), then every tick.
  const cronTick = () => {
    try {
      cron.tick();
    } catch (err) {
      console.error(`[hub] cron: tick failed: ${err.message}`);
    }
  };
  cronTick();
  setInterval(cronTick, CRON_TICK_MS);
  setInterval(pollBusy, 2000);
});
