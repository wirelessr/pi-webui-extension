#!/usr/bin/env node
/**
 * Real end-to-end for a pending-steer chip leaking after switching away.
 *
 * Real pi + the working-tree extension (built flat) + the real hub + headless
 * Chrome. Two throwaway sessions A and B. On A, fire a turn that runs a slow
 * tool, steer it while the tool runs (chip appears), then switch to B BEFORE pi
 * injects the steer. The injection echo goes to nobody, and the later attach on
 * A only replays the buffered `done`. Once A is idle, the chip (and the
 * sidebar's "· N pending") must be gone, both while away and after switching back.
 *
 * Isolated (own bridge dir, ports, Chrome profile); never touches real sessions.
 * Prints PASS/FAIL lines, exits non-zero on failure.
 *
 * Usage: node scripts/e2e-steer-switch-away.mjs
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const CDP_PORT = 9226;
const HUB_PORT = 8799;
const REPO = process.cwd();
const MARKER = "STEER-AWAY";
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
  try {
    for (const d of readdirSync(join(process.env.HOME, ".pi/agent/sessions"))) {
      if (d.includes("e2e-steer-away-work")) rmSync(join(process.env.HOME, ".pi/agent/sessions", d), { recursive: true, force: true });
    }
  } catch {}
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

const typeAndEnter = (text) => `
  const ta = document.getElementById("message-input");
  ta.value = ${JSON.stringify(text)};
  ta.dispatchEvent(new Event("input", { bubbles: true }));
  ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  return true;
`;
const clickSession = (port) => `
  for (const el of document.querySelectorAll(".session-item")) {
    if ((el.querySelector(".item-meta")?.textContent || "").startsWith(":${port}")) { el.click(); return true; }
  }
  return false;
`;
const sidebarMeta = (port) => `
  for (const el of document.querySelectorAll(".session-item")) {
    const t = el.querySelector(".item-meta")?.textContent || "";
    if (t.startsWith(":${port}")) return t;
  }
  return null;
`;
const chipCount = `return document.querySelectorAll("#queue-chips .queue-chip .queue-chip-text").length;`;

async function main() {
  iso = mkdtempSync(join(tmpdir(), "e2e-steer-away-iso-"));
  build = mkdtempSync(join(tmpdir(), "e2e-steer-away-build-"));
  work = mkdtempSync(join(tmpdir(), "e2e-steer-away-work-"));

  spawnSync("node", ["scripts/build-dist.mjs", "0.0.0", build], { cwd: REPO, stdio: "ignore" });
  spawnSync("npm", ["install", "--omit=dev"], { cwd: build, stdio: "ignore" });

  const spawnPi = (name) => procs.push(spawn("sh", ["-c",
    `tail -f /dev/null | pi --no-extensions -e '${build}/index.ts' --mode rpc -n '${name}' >> '${iso}/bridge.log' 2>&1`],
    { cwd: work, env: { ...process.env, PI_BRIDGE_DIR: iso }, stdio: "ignore" }));
  spawnPi("steer-away-A");
  await sleep(1200);
  spawnPi("steer-away-B");

  let sessions = [];
  for (let i = 0; i < 40 && sessions.length < 2; i++) {
    await sleep(500);
    sessions = readdirSync(iso).filter((f) => f.endsWith(".json") && !f.startsWith("hub"))
      .map((f) => { try { return JSON.parse(readFileSync(join(iso, f), "utf8")); } catch { return null; } }).filter(Boolean);
  }
  if (sessions.length < 2) throw new Error(`expected 2 sessions, got ${sessions.length}`);
  const A = sessions.find((s) => s.sessionName === "steer-away-A");
  const B = sessions.find((s) => s.sessionName === "steer-away-B");
  if (!A || !B) throw new Error("sessions A/B not found by name");

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
  await sleep(2000);
  await evalPage("window.alert = () => {};");

  const busy = async (s) => !!(await (await fetch(`http://localhost:${s.port}/api/status`)).json()).busy;

  // 1. View A and start a turn whose first step is a slow tool call.
  check("hub: switched to session A", await evalPage(clickSession(A.port)));
  await sleep(1500);
  await evalPage(typeAndEnter("Use the bash tool to run exactly `sleep 20 && echo slept`. After it returns, reply with the single word FIRSTDONE."));
  let started = false;
  for (let i = 0; i < 60 && !started; i++) { await sleep(500); started = await busy(A); }
  check("A: turn started", started);
  // Let the model emit the tool call so the steer waits behind the sleep.
  await sleep(5000);

  // 2. Steer while the tool runs: the optimistic chip appears.
  await evalPage(typeAndEnter(`${MARKER}: also reply with the word STEERED.`));
  await sleep(500);
  check("A: pending chip shown after steer", (await evalPage(chipCount)) === 1);

  // 3. Switch to B before pi injects the steer.
  check("A: still busy when switching away (steer not injected yet)", await busy(A));
  await evalPage(clickSession(B.port));

  // 4. Wait for A to finish while we're away, then give the hub's busy poll
  //    (2s) + the client's sidebar poll (3s) time to run.
  let idle = false;
  for (let i = 0; i < 240 && !idle; i++) { await sleep(500); idle = !(await busy(A)); }
  check("A: turn finished while away", idle);
  await sleep(6000);

  const hist = await (await fetch(`http://localhost:${A.port}/api/history`)).json();
  check("A: steer was actually injected (in history)", (hist.history || []).some((m) => m.role === "user" && (m.text || "").includes(MARKER)));
  const metaAway = await evalPage(sidebarMeta(A.port));
  check("sidebar: A no longer shows pending steering while away", metaAway != null && !metaAway.includes("pending"), `(meta "${metaAway}")`);

  // 5. Switch back to A: no leaked chip.
  await evalPage(clickSession(A.port));
  await sleep(3000);
  const n = await evalPage(chipCount);
  check("A: no leaked pending chip after switching back", n === 0, `(${n} chips)`);
  const steerBubble = await evalPage(`return [...document.querySelectorAll("#messages .message.user")].some((b) => (b.textContent || "").includes(${JSON.stringify(MARKER)}));`);
  check("A: steer bubble rendered from history", steerBubble);
}

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { cleanup(); process.exit(130); });
main().catch((e) => { console.error("FAIL harness error:", e.message); failed = true; }).finally(() => { cleanup(); process.exit(failed ? 1 : 0); });
