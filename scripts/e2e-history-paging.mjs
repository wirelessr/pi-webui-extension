#!/usr/bin/env node
/**
 * Real end-to-end for long-session history paging: real pi + the working-tree
 * extension (built flat, like a deploy) + the real hub + headless Chrome.
 *
 * Seeds a 400-turn (1600-entry) session JSONL, resumes it in a throwaway
 * `pi --mode rpc` under an isolated PI_BRIDGE_DIR, runs a test hub on :8799,
 * then plays TWO successive hub clients (fresh page loads) against it. Each
 * must render only the latest page; the second pages back to the start.
 *
 * Isolated (own bridge dir, ports, Chrome profile); never touches real sessions.
 * Prints PASS/FAIL lines, exits non-zero on failure.
 *
 * Usage: node scripts/e2e-history-paging.mjs
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const CDP_PORT = 9226;
const HUB_PORT = 8799;
const REPO = process.cwd();
const TURNS = 400;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const procs = [];
let iso, build, work, failed = false;

const check = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"} ${name} ${detail}`); if (!ok) failed = true; };

function cleanup() {
  for (const p of procs) { try { p.kill("SIGKILL"); } catch {} }
  try {
    for (const f of readdirSync(iso).filter((f) => f.endsWith(".json"))) {
      try {
        const d = JSON.parse(readFileSync(join(iso, f), "utf8"));
        for (const pid of [d.pid, d.piPid]) { if (pid) process.kill(pid, "SIGKILL"); }
      } catch {}
    }
  } catch {}
  for (const d of [iso, build, work]) { try { if (d) rmSync(d, { recursive: true, force: true }); } catch {} }
}

function seedSession(file, cwd) {
  const lines = [{ type: "session", version: 3, id: "e2e00000-0000-7000-8000-000000000001", timestamp: new Date().toISOString(), cwd }];
  let parent = null;
  let n = 0;
  const add = (message) => {
    const id = (++n).toString(16).padStart(8, "0");
    lines.push({ type: "message", id, parentId: parent, timestamp: new Date().toISOString(), message });
    parent = id;
  };
  const ts = Date.now();
  const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const asst = (content, stopReason) => ({ role: "assistant", content, api: "x", provider: "fireworks", model: "m", usage, stopReason, timestamp: ts });
  for (let i = 0; i < TURNS; i++) {
    add({ role: "user", content: [{ type: "text", text: `question ${i}` }], timestamp: ts });
    add(asst([{ type: "toolCall", id: `call_${i}`, name: "bash", arguments: { command: `echo ${i}` } }], "toolUse"));
    add({ role: "toolResult", toolCallId: `call_${i}`, toolName: "bash", content: [{ type: "text", text: `out ${i}` }], isError: false, timestamp: ts });
    add(asst([{ type: "text", text: `answer ${i}` }], "stop"));
  }
  writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
}

async function cdpConnect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("ws open failed")); });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const send = (method, params = {}) => new Promise((res) => { const n = ++id; pending.set(n, res); ws.send(JSON.stringify({ id: n, method, params })); });
  const evalPage = async (body) => {
    const r = await send("Runtime.evaluate", { expression: `(async () => { ${body} })()`, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
    return r.result?.result?.value;
  };
  return { send, evalPage };
}

async function main() {
  iso = mkdtempSync(join(tmpdir(), "e2e-paging-iso-"));
  build = mkdtempSync(join(tmpdir(), "e2e-paging-build-"));
  work = mkdtempSync(join(tmpdir(), "e2e-paging-work-"));
  const sessionFile = join(iso, "seed.jsonl");
  seedSession(sessionFile, work);

  spawnSync("node", ["scripts/build-dist.mjs", "0.0.0", build], { cwd: REPO, stdio: "ignore" });
  spawnSync("npm", ["install", "--omit=dev"], { cwd: build, stdio: "ignore" });

  const piCmd = `tail -f /dev/null | pi --no-extensions -e '${build}/index.ts' --mode rpc --session '${sessionFile}' 2>&1 1>/dev/null >> '${iso}/bridge.log'`;
  procs.push(spawn("sh", ["-c", piCmd], { cwd: work, env: { ...process.env, PI_BRIDGE_DIR: iso }, stdio: "ignore" }));

  let port;
  for (let i = 0; i < 40 && !port; i++) {
    await sleep(500);
    const files = readdirSync(iso).filter((f) => f.endsWith(".json") && !f.startsWith("hub"));
    if (files.length) port = JSON.parse(readFileSync(join(iso, files[0]), "utf8")).port;
  }
  if (!port) throw new Error(`session never came up; bridge.log:\n${readFileSync(join(iso, "bridge.log"), "utf8").slice(-800)}`);

  // Bridge-level: the real readSessionHistory → paginateHistory path.
  const page = await (await fetch(`http://localhost:${port}/api/history?limit=200&align=turn`)).json();
  check("bridge: total is the whole seeded branch", page.total === TURNS * 4, `(total ${page.total})`);
  check("bridge: page is turn-aligned and bounded", page.history[0]?.role === "user" && page.history.length >= 200 && page.history.length < 210 && page.start === page.total - page.history.length, `(len ${page.history.length}, start ${page.start})`);
  const prev = await (await fetch(`http://localhost:${port}/api/history?limit=200&align=turn&before=${page.start}`)).json();
  check("bridge: before=start chains with no gap", prev.start < page.start && prev.history.at(-1)?.text === `answer ${Number(page.history[0].text.split(" ")[1]) - 1}`);
  const tail = await (await fetch(`http://localhost:${port}/api/history?limit=1`)).json();
  check("bridge: limit=1 returns just the last entry", tail.history.length === 1 && tail.history[0].text === `answer ${TURNS - 1}`);

  procs.push(spawn("node", ["packages/hub/src/server.js"], { cwd: REPO, env: { ...process.env, PI_HUB_PORT: String(HUB_PORT), PI_BRIDGE_DIR: iso }, stdio: "ignore" }));
  await sleep(1500);
  procs.push(spawn(CHROME, [`--remote-debugging-port=${CDP_PORT}`, "--headless=new", "--no-first-run", `--user-data-dir=${join(build, "chrome-profile")}`, `http://localhost:${HUB_PORT}/`], { stdio: "ignore" }));

  let wsUrl;
  for (let i = 0; i < 40 && !wsUrl; i++) {
    await sleep(500);
    try {
      const t = (await (await fetch(`http://localhost:${CDP_PORT}/json`)).json()).find((x) => x.type === "page" && x.url.includes(`localhost:${HUB_PORT}`));
      wsUrl = t?.webSocketDebuggerUrl;
    } catch {}
  }
  if (!wsUrl) throw new Error("chrome page target not found");
  const { send, evalPage } = await cdpConnect(wsUrl);
  await send("Runtime.enable");
  await send("Page.enable");

  const users = () => evalPage(`return document.querySelectorAll('#messages .message.user').length`);
  const hasBtn = () => evalPage(`return !!document.querySelector('#messages > .load-earlier')`);
  const histReqs = () => evalPage(`return performance.getEntriesByType('resource').map(e => e.name).filter(n => n.includes('/api/history')).map(n => new URL(n).search)`);

  for (const client of ["client A (first load)", "client B (joins the same session)"]) {
    if (client.startsWith("client B")) { await send("Page.reload"); }
    await sleep(3500);
    await evalPage("window.alert = () => {};");
    const n = await users();
    check(`${client}: renders only the latest page`, n > 0 && n < TURNS / 2, `(${n} of ${TURNS} user bubbles)`);
    const reqs = await histReqs();
    check(`${client}: history requests are limited`, reqs.length > 0 && reqs.every((q) => q.includes("limit=")), reqs.join(" "));
    check(`${client}: load-earlier button present`, await hasBtn());
  }

  for (let i = 0; i < 20 && (await hasBtn()); i++) {
    await evalPage(`document.querySelector('#messages > .load-earlier').click()`);
    await sleep(700);
  }
  const all = await evalPage(`return [...document.querySelectorAll('#messages .message.user')].map(e => e.textContent)`);
  check("paging back reaches the start: full transcript, in order", all.length === TURNS && all.every((t, i) => t === `question ${i}`), `(${all.length} bubbles)`);
  check("button removed at the start", !(await hasBtn()));
  check("every turn's tool result rendered", (await evalPage(`return document.querySelectorAll('#messages .tool-result').length`)) === TURNS);
}

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { cleanup(); process.exit(130); });
main().catch((e) => { console.error("FAIL harness error:", e.message); failed = true; }).finally(() => { cleanup(); process.exit(failed ? 1 : 0); });
