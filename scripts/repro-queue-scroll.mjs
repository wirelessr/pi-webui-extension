#!/usr/bin/env node
/**
 * Self-contained repro for the "queued turn doesn't auto-scroll" bug.
 *
 * Builds an isolated extension, spawns ONE throwaway pi session + a test hub on
 * :8799, launches headless Chrome, drives the SPA over raw CDP, and injects a
 * single in-page harness that runs the whole scenario at 100ms sampling and
 * returns the full timeline in one shot (no per-action round trips).
 *
 * Scenario (the user's report): viewing a session, scroll UP during turn1 to
 * disengage follow, then a QUEUED turn2 dispatches — does the viewport follow
 * the new content, or stay stranded at the previous turn's end?
 *
 * Everything is isolated (own PI_BRIDGE_DIR, own port, own Chrome profile) and
 * torn down at the end. Never touches the user's real sessions.
 *
 * Usage: node scripts/repro-queue-scroll.mjs
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const CDP_PORT = 9224;
const HUB_PORT = 8799;
const REPO = process.cwd();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const procs = [];
let iso, build, work;

function log(...a) { console.log("[repro]", ...a); }

function cleanup() {
  for (const p of procs) { try { p.kill("SIGKILL"); } catch {} }
  // kill any isolated pi by its discovery pid
  try {
    for (const f of readdirSync(iso).filter((f) => f.endsWith(".json"))) {
      try { const pid = JSON.parse(readFileSync(join(iso, f), "utf8")).pid; if (pid) process.kill(pid, "SIGKILL"); } catch {}
    }
  } catch {}
  for (const d of [iso, build, work]) { try { if (d) rmSync(d, { recursive: true, force: true }); } catch {} }
  try {
    for (const d of readdirSync(join(process.env.HOME, ".pi/agent/sessions"))) {
      if (d.includes("repro-scroll-work")) rmSync(join(process.env.HOME, ".pi/agent/sessions", d), { recursive: true, force: true });
    }
  } catch {}
}

// ── Minimal raw-CDP client over the DevTools websocket ──
async function cdpConnect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = (e) => rej(new Error("ws open failed")); });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { const { res } = pending.get(msg.id); pending.delete(msg.id); res(msg); }
  };
  const send = (method, params = {}) => new Promise((res) => { const mid = ++id; pending.set(mid, { res }); ws.send(JSON.stringify({ id: mid, method, params })); });
  return { ws, send };
}

// Evaluate an async function body in the page, awaiting the promise, returning JSON.
async function evalInPage(cdp, fnBody) {
  const r = await cdp.send("Runtime.evaluate", {
    expression: `(async () => { ${fnBody} })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
  if (r.result?.result?.subtype === "error") throw new Error(r.result.result.description);
  return r.result?.result?.value;
}

async function main() {
  iso = mkdtempSync(join(tmpdir(), "repro-scroll-iso-"));
  build = mkdtempSync(join(tmpdir(), "repro-scroll-build-"));
  work = mkdtempSync(join(tmpdir(), "repro-scroll-work-"));
  log("iso", iso);

  log("building flat extension…");
  spawnSync("node", ["scripts/build-dist.mjs", "0.6.3", build], { cwd: REPO, stdio: "ignore" });
  spawnSync("npm", ["install", "--omit=dev"], { cwd: build, stdio: "ignore" });

  log("spawning throwaway pi session…");
  const piCmd = `tail -f /dev/null | pi --no-extensions -e '${build}/index.ts' --mode rpc -n 'repro-scroll' 2>&1 1>/dev/null >> '${iso}/bridge.log'`;
  procs.push(spawn("sh", ["-c", piCmd], { cwd: work, env: { ...process.env, PI_BRIDGE_DIR: iso }, detached: false, stdio: "ignore" }));

  // wait for discovery file
  let port, sid;
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    const files = readdirSync(iso).filter((f) => f.endsWith(".json") && !f.startsWith("hub"));
    if (files.length) { const d = JSON.parse(readFileSync(join(iso, files[0]), "utf8")); port = d.port; sid = d.sessionId; break; }
  }
  if (!port) throw new Error("session never came up");
  log("session", sid, "port", port);

  log("starting test hub on", HUB_PORT);
  procs.push(spawn("node", ["packages/hub/src/server.js"], { cwd: REPO, env: { ...process.env, PI_HUB_PORT: String(HUB_PORT), PI_BRIDGE_DIR: iso }, stdio: "ignore" }));
  await sleep(1500);

  log("launching headless chrome…");
  const profile = join(build, "chrome-profile");
  procs.push(spawn(CHROME, [`--remote-debugging-port=${CDP_PORT}`, "--headless=new", "--no-first-run", `--user-data-dir=${profile}`, `http://localhost:${HUB_PORT}/`], { stdio: "ignore" }));

  // find the page target
  let wsUrl;
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    try {
      const targets = await (await fetch(`http://localhost:${CDP_PORT}/json`)).json();
      const page = targets.find((t) => t.type === "page" && t.url.includes(`localhost:${HUB_PORT}`));
      if (page?.webSocketDebuggerUrl) { wsUrl = page.webSocketDebuggerUrl; break; }
    } catch {}
  }
  if (!wsUrl) throw new Error("chrome page target not found");
  const cdp = await cdpConnect(wsUrl);
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  log("CDP connected; waiting for SPA boot…");
  await sleep(2500);

  // Seed turn1 (long) directly on the bridge, queue turn2 (long) behind it.
  const prompt = (msg) => fetch(`http://localhost:${port}/api/prompt`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: msg, timeout: 120000 }) }).catch(() => {});
  const queue = (msg) => fetch(`http://localhost:${HUB_PORT}/api/queue`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId: sid, message: msg }) });

  log("firing turn1 (long) + queued turn2 (very long)…");
  prompt("Write a 300-word story about a robot. End with the token GGEND1.");
  await sleep(2000);
  await queue("Write a 600-word detailed story about a dragon, with several paragraphs. End with the token HHEND2.");

  // Single in-page harness. Tests the REPORTED scenario: the user stays at the
  // bottom (end of the previous turn) and NEVER scrolls away. A queued turn2
  // dispatches — sticky-follow should keep the viewport pinned to the new
  // content. Desired behavior (per user): follow ONLY when already at bottom.
  // We start at the bottom (mirrors having watched turn1 finish), then go
  // HANDS-OFF; a large sustained gap during turn2 means follow was lost = bug.
  log("running in-page sampler (stay-at-bottom scenario)…");
  const result = await evalInPage(cdp, `
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const scroller = document.getElementById("chat");
    const msgs = document.getElementById("messages");
    const gap = () => Math.round(scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight);
    window.alert = () => {};
    const timeline = [];
    // The REPORTED sequence: during turn1 the user scrolls UP to read (follow
    // disengages), then scrolls BACK to the bottom, and is at the bottom when
    // the queued turn2 dispatches. Question: does scrolling back re-engage
    // follow so turn2 is tracked, or is follow stuck off?
    timeline.push({ mark: "initial", gap: gap() });
    // 1) wait for turn1 to be streaming, scroll UP to disengage
    for (let i = 0; i < 80 && !/GGEND1|robot|机器人|機器人/.test(msgs.textContent); i++) await sleep(100);
    scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -400, bubbles: true }));
    scroller.scrollTop = Math.max(0, scroller.scrollTop - 500);
    await sleep(150);
    timeline.push({ mark: "scrolled-up", gap: gap() });
    // 2) wait for turn1 to finish (GGEND1 present)
    for (let i = 0; i < 200 && !msgs.textContent.includes("GGEND1"); i++) await sleep(100);
    timeline.push({ mark: "turn1-done", gap: gap() });
    // 3) scroll BACK to the bottom (a real scroll to the end → should engage).
    scroller.scrollTop = scroller.scrollHeight;
    scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
    await sleep(200);
    timeline.push({ mark: "scrolled-back-to-bottom", gap: gap() });
    // 4) HANDS-OFF from here. Watch the queued turn2 dispatch + stream.
    let sawH = false, ticks = 0, maxGapDuringTurn2 = 0, turn2Started = false;
    const gg = msgs.textContent.length; // baseline length
    const maxTicks = 1400;
    while (ticks < maxTicks) {
      await sleep(100); ticks++;
      const txt = msgs.textContent;
      const g = gap();
      const H = txt.includes("HHEND2");
      const dragon = [...msgs.querySelectorAll(".message.user")].some(b => b.textContent.includes("dragon"));
      if (dragon && !turn2Started) { timeline.push({ mark: "turn2-dispatched", tick: ticks, gap: g }); turn2Started = true; }
      if (turn2Started) maxGapDuringTurn2 = Math.max(maxGapDuringTurn2, g);
      if (turn2Started && ticks % 5 === 0) timeline.push({ tick: ticks, gap: g });
      if (H && !sawH) { timeline.push({ mark: "turn2-done", tick: ticks, gap: g }); break; }
    }
    return {
      timeline,
      maxGapDuringTurn2,
      // At bottom when turn2 dispatches → should stay pinned. Sustained gap = bug.
      verdict: maxGapDuringTurn2 > 100 ? "STRANDED (bug: re-engage failed, turn2 not followed)" : "followed (correct)",
    };
  `);

  log("RESULT:");
  console.log(JSON.stringify(result, null, 2));
}

main().then(() => { cleanup(); process.exit(0); }).catch((e) => { console.error("[repro] ERROR", e); cleanup(); process.exit(1); });
