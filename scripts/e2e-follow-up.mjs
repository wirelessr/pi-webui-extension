#!/usr/bin/env node
/**
 * Real end-to-end for mid-turn follow-up (Option/Cmd+Enter) next to steer (Enter).
 *
 * Real pi + the working-tree extension (built flat) + the real hub + headless
 * Chrome, two throwaway sessions under an isolated PI_BRIDGE_DIR:
 *   A  driven through the hub: while a slow tool runs, send a steer (Enter), a
 *      follow-up (Option+Enter) and a follow-up (Cmd+Enter). Chips show kinds;
 *      pi delivers the steer right after the tool result and the follow-ups
 *      only after an assistant reply with no tool calls; the chips drain on
 *      echo while the turn is still running.
 *   B  driven through its standalone bridge UI: Ctrl+Enter queues a follow-up.
 *
 * Isolated (own bridge dir, ports, Chrome profile); never touches real sessions.
 * Prints PASS/FAIL lines, exits non-zero on failure.
 *
 * Usage: node scripts/e2e-follow-up.mjs
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const CDP_PORT = 9226;
const HUB_PORT = 8799;
const REPO = process.cwd();
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
      if (d.includes("e2e-follow-up-work")) rmSync(join(process.env.HOME, ".pi/agent/sessions", d), { recursive: true, force: true });
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

async function openPage(match) {
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    try {
      const t = (await (await fetch(`http://localhost:${CDP_PORT}/json`)).json()).find((x) => x.type === "page" && x.url.includes(match));
      if (t?.webSocketDebuggerUrl) {
        const page = await cdpConnect(t.webSocketDebuggerUrl);
        await page.send("Runtime.enable");
        await page.send("Page.enable");
        return page;
      }
    } catch {}
  }
  throw new Error(`page target not found: ${match}`);
}

// mods: { altKey, metaKey, ctrlKey } — a real keydown through createInput's handler.
const typeAndEnter = (text, mods = {}) => `
  const ta = document.getElementById("message-input");
  ta.value = ${JSON.stringify(text)};
  ta.dispatchEvent(new Event("input", { bubbles: true }));
  ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, ...${JSON.stringify(mods)} }));
  return true;
`;
const clickSession = (port) => `
  for (const el of document.querySelectorAll(".session-item")) {
    if ((el.querySelector(".item-meta")?.textContent || "").startsWith(":${port}")) { el.click(); return true; }
  }
  return false;
`;
const chipState = `
  const chips = [...document.querySelectorAll("#queue-chips .queue-chip")];
  return {
    caption: document.querySelector("#queue-chips .queue-header span")?.textContent || "",
    chips: chips.map((c) => ({ kind: c.querySelector(".queue-chip-kind")?.textContent || "", text: c.querySelector(".queue-chip-text")?.textContent || "" })),
  };
`;

const busy = async (port) => !!(await (await fetch(`http://localhost:${port}/api/status`)).json()).busy;
const history = async (port) => (await (await fetch(`http://localhost:${port}/api/history`)).json()).history || [];
const waitIdle = async (port) => { for (let i = 0; i < 360; i++) { await sleep(500); if (!(await busy(port))) return true; } return false; };
const waitBusy = async (port) => { for (let i = 0; i < 60; i++) { await sleep(500); if (await busy(port)) return true; } return false; };
const userIdx = (h, marker) => h.findIndex((m) => m.role === "user" && (m.text || "").includes(marker));
const OPENER = "Use the bash tool to run exactly `sleep 20 && echo slept`. After it returns, reply with the single word FIRSTDONE.";

async function main() {
  iso = mkdtempSync(join(tmpdir(), "e2e-follow-up-iso-"));
  build = mkdtempSync(join(tmpdir(), "e2e-follow-up-build-"));
  work = mkdtempSync(join(tmpdir(), "e2e-follow-up-work-"));

  spawnSync("node", ["scripts/build-dist.mjs", "0.0.0", build], { cwd: REPO, stdio: "ignore" });
  spawnSync("npm", ["install", "--omit=dev"], { cwd: build, stdio: "ignore" });

  const spawnPi = (name) => procs.push(spawn("sh", ["-c",
    `tail -f /dev/null | pi --no-extensions -e '${build}/index.ts' --mode rpc -n '${name}' >> '${iso}/bridge.log' 2>&1`],
    { cwd: work, env: { ...process.env, PI_BRIDGE_DIR: iso }, stdio: "ignore" }));
  spawnPi("follow-up-A");
  await sleep(1200);
  spawnPi("follow-up-B");

  let sessions = [];
  for (let i = 0; i < 40 && sessions.length < 2; i++) {
    await sleep(500);
    sessions = readdirSync(iso).filter((f) => f.endsWith(".json") && !f.startsWith("hub"))
      .map((f) => { try { return JSON.parse(readFileSync(join(iso, f), "utf8")); } catch { return null; } }).filter(Boolean);
  }
  const A = sessions.find((s) => s.sessionName === "follow-up-A");
  const B = sessions.find((s) => s.sessionName === "follow-up-B");
  if (!A || !B) throw new Error("sessions A/B not found by name");

  procs.push(spawn("node", ["packages/hub/src/server.js"], { cwd: REPO, env: { ...process.env, PI_HUB_PORT: String(HUB_PORT), PI_BRIDGE_DIR: iso }, stdio: "ignore" }));
  await sleep(1500);
  procs.push(spawn(CHROME, [`--remote-debugging-port=${CDP_PORT}`, "--headless=new", "--no-first-run", `--user-data-dir=${join(build, "chrome-profile")}`, `http://localhost:${HUB_PORT}/`], { stdio: "ignore" }));

  // ── A: hub ──
  const hub = await openPage(`localhost:${HUB_PORT}`);
  await sleep(2000);
  await hub.evalPage("window.alert = () => {};");
  check("hub: switched to A", await hub.evalPage(clickSession(A.port)));
  await sleep(1500);
  await hub.evalPage(typeAndEnter(OPENER));
  check("A: turn started", await waitBusy(A.port));
  await sleep(5000); // let the model emit the slow tool call

  await hub.evalPage(typeAndEnter("STEER-S1: also include the word STEERED."));
  await hub.evalPage(typeAndEnter("FOLLOW-F1: now reply with the single word FOLLOWED.", { altKey: true }));
  await hub.evalPage(typeAndEnter("FOLLOW-F2: use the bash tool to run `sleep 8`, then reply with the single word LAST.", { metaKey: true }));
  await sleep(500);
  const st = await hub.evalPage(chipState);
  check("hub: caption counts both kinds", st.caption === "1 steer + 2 follow-ups waiting to inject", `("${st.caption}")`);
  check("hub: follow-up chips tagged, steer chip untagged",
    JSON.stringify(st.chips.map((c) => c.kind)) === JSON.stringify(["", "follow-up", "follow-up"]), JSON.stringify(st.chips));

  // Chips must drain on echo, before the turn ends (FOLLOW-F2's sleep keeps it busy).
  let drainedWhileBusy = false;
  for (let i = 0; i < 240; i++) {
    await sleep(500);
    const n = (await hub.evalPage(chipState)).chips.length;
    if (n === 0) { drainedWhileBusy = await busy(A.port); break; }
  }
  check("hub: all chips drained by echo while A still busy", drainedWhileBusy);
  check("A: turn finished", await waitIdle(A.port));

  const h = await history(A.port);
  const iS = userIdx(h, "STEER-S1"), i1 = userIdx(h, "FOLLOW-F1"), i2 = userIdx(h, "FOLLOW-F2");
  check("A: steer + both follow-ups in history, in order", iS > 0 && iS < i1 && i1 < i2, `(${iS}, ${i1}, ${i2})`);
  check("A: steer delivered right after the tool result", h[iS - 1]?.role === "toolResult", `(prev ${h[iS - 1]?.role})`);
  const stoppedBefore = (i) => h[i - 1]?.role === "assistant" && !h[i - 1]?.toolCalls;
  check("A: follow-up 1 delivered only after a final assistant reply", stoppedBefore(i1), `(prev ${h[i1 - 1]?.role}${h[i1 - 1]?.toolCalls ? "+toolCalls" : ""})`);
  check("A: follow-up 2 delivered only after a final assistant reply", stoppedBefore(i2), `(prev ${h[i2 - 1]?.role}${h[i2 - 1]?.toolCalls ? "+toolCalls" : ""})`);
  await sleep(3000);
  const bubbles = await hub.evalPage(`return [...document.querySelectorAll("#messages .message.user")].map((b) => b.textContent || "");`);
  const once = (m) => bubbles.filter((t) => t.includes(m)).length === 1;
  check("hub: steer + follow-up bubbles rendered once each", once("STEER-S1") && once("FOLLOW-F1") && once("FOLLOW-F2"), `(${bubbles.length} user bubbles)`);

  // ── B: standalone bridge UI ──
  await fetch(`http://localhost:${CDP_PORT}/json/new?http://localhost:${B.port}/`, { method: "PUT" }).catch(() => {});
  const solo = await openPage(`localhost:${B.port}`);
  try { await solo.send("Page.bringToFront"); } catch {}
  await sleep(2500);
  await solo.evalPage("window.alert = () => {};");
  await solo.evalPage(typeAndEnter(OPENER));
  check("B: turn started", await waitBusy(B.port));
  await sleep(5000);
  await solo.evalPage(typeAndEnter("FOLLOW-B1: now reply with the single word FOLLOWED.", { ctrlKey: true }));
  await sleep(500);
  const sb = await solo.evalPage(chipState);
  check("standalone: follow-up chip tagged", sb.caption === "1 follow-up waiting to inject" && sb.chips[0]?.kind === "follow-up", JSON.stringify(sb));
  check("B: turn finished", await waitIdle(B.port));
  const hb = await history(B.port);
  const ib = userIdx(hb, "FOLLOW-B1");
  check("B: follow-up delivered only after a final assistant reply", ib > 0 && hb[ib - 1]?.role === "assistant" && !hb[ib - 1]?.toolCalls, `(idx ${ib}, prev ${hb[ib - 1]?.role})`);
  await sleep(1500);
  check("standalone: chip drained", (await solo.evalPage(chipState)).chips.length === 0);
}

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { cleanup(); process.exit(130); });
main().catch((e) => { console.error("FAIL harness error:", e.message); failed = true; }).finally(() => { cleanup(); process.exit(failed ? 1 : 0); });
