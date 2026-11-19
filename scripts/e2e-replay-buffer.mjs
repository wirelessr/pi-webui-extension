#!/usr/bin/env node
/**
 * Real end-to-end for the attach replay buffer: real pi + the extension built
 * flat (like a deploy) + the real hub + headless Chrome, run TWICE — once from
 * `git HEAD` (baseline) and once from the working tree (candidate).
 *
 * A throwaway extension registers a `subagent`-shaped tool whose execute()
 * streams hundreds of CUMULATIVE tool updates (shared, growing `details`, like
 * the real subagent), then holds the turn open. While the turn is busy we:
 *   - attach as a late joiner and measure replay bytes, time, event mix, and the
 *     bridge's /api/status latency while it replays (the stall that made the hub
 *     report "unknown busy");
 *   - compare what a LIVE browser tab (sent the prompt, saw every event) shows
 *     for the subagent block + its opened transcript with what a LATE-JOINER tab
 *     (replay) shows.
 *
 * Verdict: candidate replay is a small fraction of baseline, status stays
 * responsive, and live == late-joiner DOM in BOTH builds. Isolated (own bridge
 * dir, ports, Chrome profile); never touches real sessions. Needs a working pi
 * model (whatever pi is configured with).
 *
 * Usage: node scripts/e2e-replay-buffer.mjs
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const CDP_PORT = 9227;
const HUB_PORT = 8799;
const REPO = process.cwd();
const STEPS = 300;
const STEP_BYTES = 3000;
const HOLD_S = 150;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const procs = [];
const dirs = [];
let failed = false;
const check = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"} ${name} ${detail}`); if (!ok) failed = true; };
const log = (...a) => console.log("[e2e-replay]", ...a);

const FAKE_EXT = (marker) => `
export default function (pi) {
  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: "Synthetic long-running subagent. Call it once with any task.",
    parameters: { type: "object", properties: { task: { type: "string" } } },
    async execute(_id, _params, _signal, onUpdate) {
      const fs = await import("node:fs");
      const result = { agent: "worker", task: "synthetic", exitCode: -1, messages: [], model: "m",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 } };
      const details = { mode: "single", agentScope: "user", projectAgentsDir: null, results: [result] };
      for (let i = 0; i < ${STEPS}; i++) {
        result.messages.push({ role: "assistant", content: [{ type: "text", text: "step" + i + " " + "x".repeat(${STEP_BYTES}) }] });
        result.usage.turns = i + 1;
        onUpdate?.({ content: [{ type: "text", text: "step" + i }], details });
        await new Promise((r) => setTimeout(r, 15));
      }
      fs.writeFileSync(${JSON.stringify(marker)}, "done");
      await new Promise((r) => setTimeout(r, ${HOLD_S} * 1000));
      result.exitCode = 0;
      return { content: [{ type: "text", text: "final" }], details };
    },
  });
}
`;

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
  return { send, evalPage, close: () => ws.close() };
}

async function newTab(url) {
  const r = await fetch(`http://localhost:${CDP_PORT}/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
  const t = await r.json();
  const c = await cdpConnect(t.webSocketDebuggerUrl);
  await c.send("Runtime.enable");
  await c.send("Page.enable");
  // Close the target itself (not just the socket): an orphaned tab keeps SSE
  // connections open and starves a later tab's connection pool for this host.
  return { ...c, close: async () => { c.close(); await fetch(`http://localhost:${CDP_PORT}/json/close/${t.id}`).catch(() => {}); } };
}

function buildExtension(srcRoot, label) {
  const out = mkdtempSync(join(tmpdir(), `e2e-replay-build-${label}-`));
  dirs.push(out);
  spawnSync("node", ["scripts/build-dist.mjs", "0.0.0", out], { cwd: srcRoot, stdio: "ignore" });
  spawnSync("npm", ["install", "--omit=dev"], { cwd: out, stdio: "ignore" });
  return out;
}

// Late-joiner attach: read until the stream goes quiet; count bytes/events and
// sample /api/status latency while the bridge is replaying.
async function measureReplay(port) {
  const t0 = performance.now();
  let bytes = 0; let firstByte = null; let lastChunk = t0;
  const types = {};
  let carry = "";
  const ac = new AbortController();
  let maxStatusMs = 0; let statusFailures = 0; let probing = true;
  (async () => {
    while (probing) {
      const s = performance.now();
      try { await fetch(`http://localhost:${port}/api/status`, { signal: AbortSignal.timeout(1500) }); maxStatusMs = Math.max(maxStatusMs, performance.now() - s); }
      catch { statusFailures++; maxStatusMs = Math.max(maxStatusMs, 1500); }
      await sleep(200);
    }
  })();
  const res = await fetch(`http://localhost:${port}/api/stream/attach`, { headers: { Accept: "text/event-stream" }, signal: ac.signal });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  const idle = setInterval(() => { if (performance.now() - lastChunk > 2500 && bytes > 0) ac.abort(); }, 250);
  const cap = setTimeout(() => ac.abort(), 180_000);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      lastChunk = performance.now();
      if (firstByte === null) firstByte = lastChunk - t0;
      bytes += value.length;
      const text = carry + dec.decode(value, { stream: true });
      const parts = text.split("\n\n");
      carry = parts.pop();
      for (const p of parts) { const m = p.match(/^data: \{"type":"([a-z_]+)"/); if (m) types[m[1]] = (types[m[1]] || 0) + 1; }
      if (carry.length > 1_000_000) carry = carry.slice(-200); // big partial frame: type already counted by prefix below
    }
  } catch {}
  clearInterval(idle); clearTimeout(cap); probing = false;
  return { bytes, firstByteMs: Math.round(firstByte ?? -1), totalMs: Math.round(lastChunk - t0), types, maxStatusMs: Math.round(maxStatusMs), statusFailures };
}

const SNAP = `
  const txt = (e) => (e ? e.innerText.replace(/\\s+/g, " ").trim() : null);
  const blocks = [...document.querySelectorAll('.subagent-block')];
  const first = blocks[0];
  if (first) first.querySelector('.subagent-open-btn')?.click();
  await new Promise(r => setTimeout(r, 800));
  const view = document.querySelector('.subagent-view');
  const out = { blocks: blocks.length, header: txt(first?.querySelector('.subagent-header')),
    viewHasLast: !!view && view.innerText.includes('step${STEPS - 1} '), viewSteps: view ? (view.innerText.match(/step\\d+ /g) || []).length : 0 };
  document.querySelector('.subagent-back-btn')?.click();
  return out;`;

async function scenario(label, buildDir) {
  log(`=== ${label} ===`);
  const iso = mkdtempSync(join(tmpdir(), `e2e-replay-iso-${label}-`));
  const work = mkdtempSync(join(tmpdir(), `e2e-replay-work-${label}-`));
  dirs.push(iso, work);
  const marker = join(iso, "updates-done");
  const fake = join(iso, "fakesub.ts");
  writeFileSync(fake, FAKE_EXT(marker));
  const mine = [];
  const piCmd = `tail -f /dev/null | pi --no-extensions -e '${buildDir}/index.ts' -e '${fake}' --mode rpc 2>&1 1>/dev/null >> '${iso}/bridge.log'`;
  const pi = spawn("sh", ["-c", piCmd], { cwd: work, env: { ...process.env, PI_BRIDGE_DIR: iso }, stdio: "ignore" });
  mine.push(pi); procs.push(pi);

  let disc;
  for (let i = 0; i < 60 && !disc; i++) {
    await sleep(500);
    const f = existsSync(iso) ? readdirSync(iso).filter((x) => x.endsWith(".json") && !x.startsWith("hub")) : [];
    if (f.length) disc = JSON.parse(readFileSync(join(iso, f[0]), "utf8"));
  }
  if (!disc) throw new Error(`session never came up; bridge.log:\n${existsSync(`${iso}/bridge.log`) ? readFileSync(`${iso}/bridge.log`, "utf8").slice(-800) : "(none)"}`);
  const killAll = () => { for (const pid of [disc.pid, disc.piPid]) { try { process.kill(pid, "SIGKILL"); } catch {} } };

  const hub = spawn("node", ["packages/hub/src/server.js"], { cwd: REPO, env: { ...process.env, PI_HUB_PORT: String(HUB_PORT), PI_BRIDGE_DIR: iso, PI_HUB_HOST: "127.0.0.1" }, stdio: "ignore" });
  procs.push(hub);
  await sleep(1800);

  const live = await newTab(`http://localhost:${HUB_PORT}/`);
  await sleep(3500);
  await live.evalPage("window.alert = () => {};");
  await live.evalPage(`document.getElementById('message-input').value = 'Call the subagent tool exactly once with task "go". After it returns, reply with the single word finished.'; document.getElementById('send-btn').click();`);

  for (let i = 0; i < 240 && !existsSync(marker); i++) await sleep(500);
  const toolRan = existsSync(marker);
  check(`${label}: model called the synthetic subagent tool`, toolRan);
  if (!toolRan) { killAll(); hub.kill(); return null; }

  const m = await measureReplay(disc.port);
  log(label, JSON.stringify(m));

  const late = await newTab(`http://localhost:${HUB_PORT}/`);
  await sleep(9000); // let the late tab attach + replay
  await late.evalPage("window.alert = () => {};");
  const a = await live.evalPage(SNAP);
  const b = await late.evalPage(SNAP);
  log(label, "live tab:", JSON.stringify(a));
  log(label, "late tab:", JSON.stringify(b));
  check(`${label}: live tab shows the subagent block and its last step`, a?.blocks === 1 && a.viewHasLast, JSON.stringify(a));
  check(`${label}: late-joiner tab == live tab (block header, transcript)`, JSON.stringify(a) === JSON.stringify(b), JSON.stringify(b));

  if (JSON.stringify(a) !== JSON.stringify(b)) {
    const diag = `(() => ({ pill: document.getElementById('busy-indicator')?.textContent, msgs: [...document.querySelectorAll('#messages > *')].map(e => e.className + ':' + e.innerText.replace(/\\s+/g, ' ').slice(0, 80)) }))()`;
    log(label, "late tab DOM:", JSON.stringify(await late.evalPage(`return ${diag}`)));
    log(label, "live tab DOM:", JSON.stringify(await live.evalPage(`return ${diag}`)));
  }
  await live.close();
  await late.close();
  killAll();
  hub.kill();
  await sleep(500);
  return m;
}

async function main() {
  const baseSrc = mkdtempSync(join(tmpdir(), "e2e-replay-head-"));
  dirs.push(baseSrc);
  spawnSync("sh", ["-c", `git archive HEAD | tar -x -C '${baseSrc}'`], { cwd: REPO });
  const baseBuild = buildExtension(baseSrc, "base");
  const candBuild = buildExtension(REPO, "cand");

  const chrome = spawn(CHROME, [`--remote-debugging-port=${CDP_PORT}`, "--headless=new", "--no-first-run", `--user-data-dir=${join(candBuild, "chrome-profile")}`, "about:blank"], { stdio: "ignore" });
  procs.push(chrome);
  for (let i = 0; i < 40; i++) { try { await fetch(`http://localhost:${CDP_PORT}/json/version`); break; } catch { await sleep(500); } }

  const only = process.env.ONLY; // "cand" / "base": run just one build while debugging
  const base = only === "cand" ? null : await scenario("baseline(HEAD)", baseBuild);
  const cand = only === "base" ? null : await scenario("candidate(working tree)", candBuild);

  if (base && cand) {
    check("candidate replay bytes << baseline", cand.bytes * 20 < base.bytes, `(baseline ${(base.bytes / 1e6).toFixed(1)} MB, candidate ${(cand.bytes / 1e6).toFixed(2)} MB)`);
    check("candidate replay completes faster", cand.totalMs < base.totalMs, `(baseline ${base.totalMs} ms, candidate ${cand.totalMs} ms)`);
    check("candidate bridge stays responsive during replay", cand.statusFailures === 0 && cand.maxStatusMs < 1000, `(max /api/status ${cand.maxStatusMs} ms, ${cand.statusFailures} timeouts; baseline max ${base.maxStatusMs} ms, ${base.statusFailures} timeouts)`);
    check("candidate buffers no toolcall_* events", !cand.types.toolcall_delta && !cand.types.toolcall_start, JSON.stringify(cand.types));
    check("candidate keeps one tool_execution_update for the tool", cand.types.tool_execution_update === 1, `(baseline ${base.types.tool_execution_update}, candidate ${cand.types.tool_execution_update})`);
  }
}

function cleanup() {
  for (const p of procs) { try { p.kill("SIGKILL"); } catch {} }
  for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
}
process.on("SIGINT", () => { cleanup(); process.exit(130); });
try { await main(); } catch (e) { console.error(e); failed = true; } finally { cleanup(); }
console.log(failed ? "VERDICT: RED" : "VERDICT: GREEN");
process.exit(failed ? 1 : 0);
