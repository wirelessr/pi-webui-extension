#!/usr/bin/env node
/**
 * Repro/regression for long-session history paging in the standalone UI.
 *
 * Serves packages/components/src with a fake bridge whose /api/history uses the
 * REAL paginateHistory on a 600-turn transcript, drives headless Chrome over raw
 * CDP, and checks: (1) a fresh client renders only the latest page, (2) "Load
 * earlier" prepends older turns while keeping the viewport anchored, (3) paging
 * to the start yields the full transcript in order and removes the button.
 *
 * Prints PASS/FAIL lines and exits non-zero on failure. Isolated (own port,
 * own Chrome profile); touches no real session.
 *
 * Usage: node scripts/repro-history-paging.mjs
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { paginateHistory } from "../packages/extension/helpers.js";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const CDP_PORT = 9225;
const SRV_PORT = 8798;
const SRC = join(process.cwd(), "packages/components/src");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TURNS = 600;
const history = [];
for (let i = 0; i < TURNS; i++) {
  history.push({ role: "user", text: `question ${i}` });
  history.push({ role: "assistant", text: `answer ${i}`, toolCalls: [{ id: `t${i}`, name: "bash", arguments: { command: `echo ${i}` } }] });
  history.push({ role: "toolResult", toolCallId: `t${i}`, text: `out ${i}` });
}

const types = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html" };
const requests = [];
const server = createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  const json = (o, code = 200) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
  if (url.pathname === "/api/history") {
    requests.push(req.url);
    const q = url.searchParams;
    const opts = { align: q.get("align") || undefined };
    if (q.has("before")) opts.before = Number(q.get("before"));
    return json(paginateHistory(history, Number(q.get("limit") || 0), Number(q.get("offset") || 0), opts));
  }
  if (url.pathname === "/api/status") return json({ port: SRV_PORT, pid: 1, sessionName: "repro", busy: false, startedAt: 1 });
  if (url.pathname === "/api/stream/attach") return json({}, 409);
  if (url.pathname.startsWith("/api/")) return json({ commands: [], sessions: [] });
  const file = join(SRC, url.pathname === "/" ? "index.html" : url.pathname);
  try {
    res.writeHead(200, { "content-type": types[extname(file)] || "application/octet-stream" });
    res.end(readFileSync(file));
  } catch { res.writeHead(404); res.end(); }
}).listen(SRV_PORT);

const profile = mkdtempSync(join(tmpdir(), "repro-paging-"));
const chrome = spawn(CHROME, [`--remote-debugging-port=${CDP_PORT}`, "--headless=new", "--no-first-run", `--user-data-dir=${profile}`, `http://localhost:${SRV_PORT}/`], { stdio: "ignore" });
const cleanup = () => { try { chrome.kill("SIGKILL"); } catch {} server.close(); try { rmSync(profile, { recursive: true, force: true }); } catch {} };

let failed = false;
const check = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"} ${name} ${detail}`); if (!ok) failed = true; };

try {
  let targets;
  for (let i = 0; i < 40; i++) {
    try { targets = await (await fetch(`http://localhost:${CDP_PORT}/json`)).json(); if (targets.some((t) => t.type === "page")) break; } catch {}
    await sleep(250);
  }
  const page = targets.find((t) => t.type === "page");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const send = (method, params = {}) => new Promise((res) => { const n = ++id; pending.set(n, res); ws.send(JSON.stringify({ id: n, method, params })); });
  const evalPage = async (body) => {
    const r = await send("Runtime.evaluate", { expression: `(async () => { ${body} })()`, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
    return r.result?.result?.value;
  };
  await send("Runtime.enable");
  await send("Page.reload");
  await sleep(2500);
  await evalPage("window.alert = () => {};");

  const count = () => evalPage(`return document.querySelectorAll('#messages .message.user').length`);
  const n1 = await count();
  check("initial render is a single page, not the whole transcript", n1 > 0 && n1 < TURNS, `(${n1} user bubbles of ${TURNS})`);
  check("initial request is limited + turn-aligned", requests[0]?.includes("limit=200") && requests[0]?.includes("align=turn"), requests[0]);
  check("load-earlier button is shown", await evalPage(`return !!document.querySelector('#messages > .load-earlier')`));

  // Anchor: remember which bubble is on screen, click, confirm it didn't move.
  const anchor = await evalPage(`
    const chat = document.getElementById('chat');
    chat.scrollTop = 0;
    const el = document.querySelectorAll('#messages .message.user')[0];
    window.__anchorEl = el;
    window.__anchorTop = el.getBoundingClientRect().top;
    document.querySelector('#messages > .load-earlier').click();
    return true;`);
  await sleep(800);
  const drift = await evalPage(`return Math.abs(window.__anchorEl.getBoundingClientRect().top - window.__anchorTop)`);
  const n2 = await count();
  check("earlier page prepended", n2 > n1, `(${n1} -> ${n2})`);
  check("viewport stays anchored on the bubble being read", drift < 2, `(drift ${drift}px)`);

  for (let i = 0; i < 10; i++) {
    const has = await evalPage(`const b = document.querySelector('#messages > .load-earlier'); if (b) b.click(); return !!b`);
    if (!has) break;
    await sleep(500);
  }
  const all = await evalPage(`return [...document.querySelectorAll('#messages .message.user')].map(e => e.textContent)`);
  check("button gone after reaching the start", !(await evalPage(`return !!document.querySelector('#messages > .load-earlier')`)));
  check("full transcript rendered in order, no gaps or duplicates", all.length === TURNS && all.every((t, i) => t === `question ${i}`), `(${all.length} bubbles)`);
  check("tool results stayed paired with their turn", (await evalPage(`return document.querySelectorAll('#messages .tool-result').length`)) === TURNS);
  ws.close();
} catch (err) {
  console.log("FAIL harness error:", err.message);
  failed = true;
} finally {
  cleanup();
}
process.exit(failed ? 1 : 0);
