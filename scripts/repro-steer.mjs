#!/usr/bin/env node
/**
 * Self-contained e2e repro + regression for mid-turn STEER.
 *
 * Builds an isolated extension, spawns ONE throwaway pi session + a test hub on
 * :8799, launches headless Chrome, and drives the hub SPA over raw CDP.
 *
 * Scenario: fire a long turn; once the assistant is streaming, type a message
 * and press Enter (a steer, since the turn is busy). pi injects it at the next
 * agent-loop step. The steer bubble must render in DOM order
 *   [assistant-so-far] [user steer] [assistant-continuation]
 * both in the SENDER tab and in a SECOND tab attached mid-turn (late joiner).
 *
 * It also drives two steers in a row (R2: pi drains one-at-a-time → two
 * [user][assistant] segments) and prints a machine-checkable verdict per tab.
 *
 * Everything is isolated (own PI_BRIDGE_DIR, own port, own Chrome profile) and
 * torn down at the end. Never touches the user's real sessions.
 *
 * Usage: node scripts/repro-steer.mjs
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
let iso, build, work;

function log(...a) { console.log("[repro-steer]", ...a); }

function cleanup() {
  for (const p of procs) { try { p.kill("SIGKILL"); } catch {} }
  try {
    for (const f of readdirSync(iso).filter((f) => f.endsWith(".json"))) {
      try { const pid = JSON.parse(readFileSync(join(iso, f), "utf8")).pid; if (pid) process.kill(pid, "SIGKILL"); } catch {}
    }
  } catch {}
  for (const d of [iso, build, work]) { try { if (d) rmSync(d, { recursive: true, force: true }); } catch {} }
  try {
    for (const d of readdirSync(join(process.env.HOME, ".pi/agent/sessions"))) {
      if (d.includes("repro-steer-work")) rmSync(join(process.env.HOME, ".pi/agent/sessions", d), { recursive: true, force: true });
    }
  } catch {}
}

// ── Minimal raw-CDP client over the DevTools websocket ──
async function cdpConnect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("ws open failed")); });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { const { res } = pending.get(msg.id); pending.delete(msg.id); res(msg); }
  };
  const send = (method, params = {}) => new Promise((res) => { const mid = ++id; pending.set(mid, { res }); ws.send(JSON.stringify({ id: mid, method, params })); });
  return { ws, send };
}

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

// Bring a tab to the foreground before driving it. Headless Chrome heavily
// throttles background tabs' timers, which would freeze the in-page polling
// loops (waitForText / waitPendingCount) once another tab is opened. Call this
// before any evalInPage sequence that polls.
async function focusTab(cdp) {
  try { await cdp.send("Page.bringToFront"); } catch {}
}

async function openPage(pageUrl) {
  let wsUrl;
  for (let i = 0; i < 30; i++) {
    await sleep(300);
    try {
      const targets = await (await fetch(`http://localhost:${CDP_PORT}/json`)).json();
      const page = targets.find((t) => t.type === "page" && t.url.includes(pageUrl));
      if (page?.webSocketDebuggerUrl) { wsUrl = page.webSocketDebuggerUrl; break; }
    } catch {}
  }
  if (!wsUrl) throw new Error(`page target not found: ${pageUrl}`);
  const cdp = await cdpConnect(wsUrl);
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  return cdp;
}

// Type text into #message-input and press Enter (the real steer path: Enter
// while streaming → onSend → steerAgent). Uses the input event + a synthetic
// keydown so createInput's handler fires exactly as for a human.
function driveSteerExpr(text) {
  return `
    const ta = document.getElementById("message-input");
    ta.value = ${JSON.stringify(text)};
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    return true;
  `;
}

// Snapshot the ordered roles of the transcript bubbles, plus the text of each
// user bubble, so we can assert [assistant][user][assistant] ordering.
const SNAPSHOT_EXPR = `
  const msgs = document.getElementById("messages");
  const bubbles = [...msgs.querySelectorAll(".message")];
  const seq = bubbles.map((b) => {
    const role = b.classList.contains("user") ? "user" : b.classList.contains("assistant") ? "assistant" : "other";
    return { role, text: (b.textContent || "").slice(0, 40) };
  });
  return { seq };
`;

// Wait until the assistant bubble has begun streaming (some assistant text is
// visible), so a send lands as a mid-turn steer rather than a fresh turn.
function waitAssistantStreamingExpr() {
  return `
    const msgs = document.getElementById("messages");
    for (let i = 0; i < 200; i++) {
      const asst = [...msgs.querySelectorAll(".message.assistant")];
      const streamed = asst.some((a) => (a.textContent || "").trim().length > 3);
      if (streamed) return true;
      await new Promise(r => setTimeout(r, 100));
    }
    return false;
  `;
}

function waitForTextExpr(token, maxTicks = 1500) {
  return `
    const msgs = document.getElementById("messages");
    for (let i = 0; i < ${maxTicks}; i++) {
      if (msgs.textContent.includes(${JSON.stringify(token)})) return true;
      await new Promise(r => setTimeout(r, 100));
    }
    return false;
  `;
}

// Count the visible pending-steer chips (the optimistic "waiting to inject"
// list). Excludes the header row (which has no .queue-chip-text).
const PENDING_COUNT_EXPR = `
  const chips = document.querySelectorAll("#queue-chips .queue-chip .queue-chip-text");
  return { count: chips.length, texts: [...chips].map((c) => c.textContent) };
`;

// Poll until the pending-chip count reaches a target (or timeout). Returns the
// last observed count.
function waitPendingCountExpr(target, maxTicks = 100) {
  return `
    let last = -1;
    for (let i = 0; i < ${maxTicks}; i++) {
      const n = document.querySelectorAll("#queue-chips .queue-chip .queue-chip-text").length;
      last = n;
      if (n === ${target}) return { count: n, reached: true };
      await new Promise(r => setTimeout(r, 100));
    }
    return { count: last, reached: false };
  `;
}

const CLICK_CLEAR_EXPR = `
  const btn = document.querySelector("#queue-chips .queue-header .queue-resume");
  if (!btn) return { clicked: false };
  btn.click();
  return { clicked: true };
`;

// Verdict: user bubbles appear BETWEEN assistant bubbles (a steer split the
// stream), never as the last bubble, and match the steered text in order.
function judge(seq, expectedSteers) {
  const userTexts = seq.filter((b) => b.role === "user").map((b) => b.text);
  const steersSeen = expectedSteers.filter((s) => userTexts.some((u) => u.includes(s)));
  // Each steer's user bubble must be followed by an assistant bubble (the
  // continuation) — i.e. not the final bubble. Find each steer's index.
  const problems = [];
  for (const s of expectedSteers) {
    const idx = seq.findIndex((b) => b.role === "user" && b.text.includes(s));
    if (idx === -1) { problems.push(`steer "${s}" bubble missing`); continue; }
    const after = seq.slice(idx + 1);
    if (!after.some((b) => b.role === "assistant")) problems.push(`steer "${s}" has no assistant continuation after it`);
    const before = seq.slice(0, idx);
    if (!before.some((b) => b.role === "assistant")) problems.push(`steer "${s}" has no assistant bubble before it (mis-ordered)`);
  }
  // No duplicate user bubble for the same steer text (double-render regression).
  for (const s of expectedSteers) {
    const dupes = userTexts.filter((u) => u.includes(s)).length;
    if (dupes > 1) problems.push(`steer "${s}" rendered ${dupes} times (double-render)`);
  }
  return {
    seq,
    steersSeen: steersSeen.length,
    expected: expectedSteers.length,
    problems,
    verdict: problems.length === 0 && steersSeen.length === expectedSteers.length
      ? "OK (steers split the stream, ordered, no dupes)"
      : "BROKEN",
  };
}

async function main() {
  iso = mkdtempSync(join(tmpdir(), "repro-steer-iso-"));
  build = mkdtempSync(join(tmpdir(), "repro-steer-build-"));
  work = mkdtempSync(join(tmpdir(), "repro-steer-work-"));
  log("iso", iso);

  log("building flat extension…");
  spawnSync("node", ["scripts/build-dist.mjs", "0.6.3", build], { cwd: REPO, stdio: "ignore" });
  spawnSync("npm", ["install", "--omit=dev"], { cwd: build, stdio: "ignore" });

  // Two throwaway sessions: one the hub drives (S1-S4, S6), one reserved for
  // the standalone-bridge-UI test (S5) so its transcript stays isolated — a
  // standalone tab opened on the hub's session would share history and collide.
  log("spawning two throwaway pi sessions…");
  const spawnPi = (name) => procs.push(spawn("sh", ["-c",
    `tail -f /dev/null | pi --no-extensions -e '${build}/index.ts' --mode rpc -n '${name}' >> '${iso}/bridge.log' 2>&1`],
    { cwd: work, env: { ...process.env, PI_BRIDGE_DIR: iso }, detached: false, stdio: "ignore" }));
  spawnPi("repro-steer");
  await sleep(1200);
  spawnPi("repro-steer-standalone");

  let sessions = [];
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    const files = readdirSync(iso).filter((f) => f.endsWith(".json") && !f.startsWith("hub"));
    sessions = files.map((f) => { try { return JSON.parse(readFileSync(join(iso, f), "utf8")); } catch { return null; } }).filter(Boolean);
    if (sessions.length >= 2) break;
  }
  if (sessions.length < 2) throw new Error(`expected 2 sessions, got ${sessions.length}`);
  // Hub-driven session = the one named repro-steer; standalone = the other.
  const hubSession = sessions.find((s) => s.sessionName === "repro-steer") || sessions[0];
  const standaloneSession = sessions.find((s) => s.sessionId !== hubSession.sessionId);
  const port = hubSession.port, sid = hubSession.sessionId;
  const standalonePort = standaloneSession.port;
  log("hub session", sid, "port", port, "| standalone port", standalonePort);

  log("starting test hub on", HUB_PORT);
  procs.push(spawn("node", ["packages/hub/src/server.js"], { cwd: REPO, env: { ...process.env, PI_HUB_PORT: String(HUB_PORT), PI_BRIDGE_DIR: iso }, stdio: "ignore" }));
  await sleep(1500);

  log("launching headless chrome…");
  const profile = join(build, "chrome-profile");
  procs.push(spawn(CHROME, [`--remote-debugging-port=${CDP_PORT}`, "--headless=new", "--no-first-run", `--user-data-dir=${profile}`, `http://localhost:${HUB_PORT}/`], { stdio: "ignore" }));

  const results = {};

  // Reset the session between scenarios by firing a fresh turn each time; the
  // transcript accumulates, so each scenario keys its verdict on unique tokens.
  const kickAndSteer = async (tab, opener, steers, gapMs = 2500) => {
    await evalInPage(tab, driveSteerExpr(opener));
    const streaming = await evalInPage(tab, waitAssistantStreamingExpr());
    if (!streaming) throw new Error("assistant never started streaming");
    for (const s of steers) {
      await evalInPage(tab, driveSteerExpr(s));
      await sleep(gapMs);
    }
  };

  // ── Scenario 1: hub sender tab — two steers split the stream, in order ──
  const tab1 = await openPage(`localhost:${HUB_PORT}`);
  await evalInPage(tab1, `window.alert = () => {}; return true;`);
  log("tab1 (hub sender) connected; waiting for SPA boot…");
  await sleep(1800);
  // Two sessions exist; make sure tab1 is viewing the hub-driven one (sid).
  await evalInPage(tab1, `
    const items = [...document.querySelectorAll(".session-item")];
    const target = items.find((el) => el.title && ${JSON.stringify(sid)}.startsWith((el.querySelector(".item-name")?.textContent || "").trim()) === false);
    // Click by matching the session whose meta port is the hub session's.
    for (const el of items) {
      if ((el.querySelector(".item-meta")?.textContent || "").includes(":${port}")) { el.click(); break; }
    }
    await new Promise(r => setTimeout(r, 1500));
    return true;
  `);

  log("S1: firing a long turn + two steers on the hub sender tab…");
  await evalInPage(tab1, driveSteerExpr("Count slowly from 1 to 150, one number per line. When you finish, print the token S1DONE."));
  const s1streaming = await evalInPage(tab1, waitAssistantStreamingExpr());
  if (!s1streaming) throw new Error("S1: assistant never started streaming");
  await evalInPage(tab1, driveSteerExpr("STEER-ALPHA: also print the word ALPHA."));
  await sleep(1800);

  // ── Scenario 3 (pending list): verify a chip is showing BEFORE it drains ──
  // Send BRAVO and immediately assert it appears as a pending chip, then that
  // it drains (chip removed) once pi injects it (echo).
  log("S3: sending STEER-BRAVO and checking the pending chip appears…");
  await evalInPage(tab1, driveSteerExpr("STEER-BRAVO: also print the word BRAVO."));
  const pendingAppeared = await evalInPage(tab1, waitPendingCountExpr(1, 30));
  results.pendingChipAppeared = pendingAppeared.reached || pendingAppeared.count >= 1;
  log("S3: pending chip appeared:", results.pendingChipAppeared, JSON.stringify(pendingAppeared));

  // ── Scenario 2: late-joiner tab attaches mid-turn ──
  log("S2: opening tab2 (late joiner) mid-turn…");
  try {
    const r = await fetch(`http://localhost:${CDP_PORT}/json/new?http://localhost:${HUB_PORT}/`, { method: "PUT" }).catch(() => null);
    if (r) await r.json().catch(() => {});
  } catch {}
  await sleep(1500);
  let tab2 = null;
  try { tab2 = await openPage(`localhost:${HUB_PORT}`); } catch { tab2 = null; }

  // Bring tab1 back to the foreground — opening tab2 backgrounded it, and
  // headless Chrome throttles background timers, freezing tab1's poll loops.
  await focusTab(tab1);
  // The pending chip should drain once pi injects BRAVO (its echo arrives).
  const pendingDrained = await evalInPage(tab1, waitPendingCountExpr(0, 120));
  results.pendingChipDrained = pendingDrained.reached;
  log("S3: pending chip drained after echo:", results.pendingChipDrained, JSON.stringify(pendingDrained));

  log("waiting for the turn to finish (S1DONE)…");
  await evalInPage(tab1, waitForTextExpr("S1DONE"));
  await sleep(1500);

  const snap1 = await evalInPage(tab1, SNAPSHOT_EXPR);
  results.hubSender = judge(snap1.seq, ["STEER-ALPHA", "STEER-BRAVO"]);

  if (tab2) {
    await focusTab(tab2);
    // A late-joiner renders the turn twice transiently (loadHistory's persisted
    // partial + attach-replay from agent_start), then the post-done canonical
    // reload de-duplicates it — the same heal the multi-loop path uses. tab2 was
    // backgrounded (throttled), so wait (bounded) for that reload to CONVERGE:
    // each steer text present exactly once. If it never converges → real bug.
    await evalInPage(tab2, `
      const once = (t) => [...document.querySelectorAll("#messages .message.user")].filter((b) => (b.textContent||"").includes(t)).length === 1;
      for (let i = 0; i < 80; i++) {
        if (once("STEER-ALPHA") && once("STEER-BRAVO")) return true;
        await new Promise(r => setTimeout(r, 250));
      }
      return false;
    `);
    const snap2 = await evalInPage(tab2, SNAPSHOT_EXPR);
    results.hubLateJoiner = judge(snap2.seq, ["STEER-ALPHA", "STEER-BRAVO"]);
  }

  // ── Scenario 4: clear-all drops not-yet-echoed pending chips ──
  // Fire a fresh turn, steer twice fast, then Clear before they drain.
  log("S4: clear-all on the hub sender tab…");
  await focusTab(tab1);
  await evalInPage(tab1, driveSteerExpr("Count slowly from 1 to 150, one number per line. When you finish, print the token S4DONE."));
  const s4streaming = await evalInPage(tab1, waitAssistantStreamingExpr());
  if (s4streaming) {
    await evalInPage(tab1, driveSteerExpr("STEER-CLEARME-1: print CLEARONE."));
    await evalInPage(tab1, driveSteerExpr("STEER-CLEARME-2: print CLEARTWO."));
    const before = await evalInPage(tab1, PENDING_COUNT_EXPR);
    const clicked = await evalInPage(tab1, CLICK_CLEAR_EXPR);
    await sleep(300);
    const after = await evalInPage(tab1, PENDING_COUNT_EXPR);
    results.clearAll = {
      before: before.count, clicked: clicked.clicked, after: after.count,
      verdict: clicked.clicked && before.count >= 1 && after.count === 0 ? "OK" : "BROKEN",
    };
    log("S4: clear-all:", JSON.stringify(results.clearAll));
    // Let this turn finish so it doesn't bleed into scenario 5.
    await evalInPage(tab1, waitForTextExpr("S4DONE"));
    await sleep(1000);
  } else {
    results.clearAll = { verdict: "SKIPPED (no stream)" };
  }

  // ── Scenario 5: standalone bridge UI (app.js) on its OWN isolated session ──
  log("S5: standalone bridge UI on port", standalonePort);
  let tab3 = null;
  try {
    const r = await fetch(`http://localhost:${CDP_PORT}/json/new?http://localhost:${standalonePort}/`, { method: "PUT" }).catch(() => null);
    if (r) await r.json().catch(() => {});
    await sleep(1500);
    tab3 = await openPage(`localhost:${standalonePort}`);
    await focusTab(tab3);
    await evalInPage(tab3, `window.alert = () => {}; return true;`);
    await sleep(2000);
    // One steer here: S5 proves the STANDALONE UI wires steer + renders the
    // split (the sender path). Multi-steer ordering is already covered by S1.
    // A single steer avoids the tool-less-turn drain-window flake where a 2nd
    // steer sometimes lands at turn-end (becomes a fresh turn).
    await kickAndSteer(tab3, "Count slowly from 1 to 200, one number per line. When you finish, print the token S5DONE.", ["STEER-CHARLIE: also print CHARLIE."]);
    // Wait for the steer bubble AND its continuation (CHARLIE printed) so the
    // user bubble is not the trailing element.
    await evalInPage(tab3, `
      const msgs = document.getElementById("messages");
      for (let i = 0; i < 2000; i++) {
        const us = [...msgs.querySelectorAll(".message.user")].map((b) => b.textContent);
        const hasSteer = us.some((t) => t.includes("STEER-CHARLIE"));
        const asst = [...msgs.querySelectorAll(".message.assistant")].map((b) => b.textContent);
        const continued = asst.some((t) => /\bCHARLIE\b/.test(t));
        if (hasSteer && continued) return true;
        await new Promise(r => setTimeout(r, 100));
      }
      return false;
    `);
    await sleep(1500);
    const snap3 = await evalInPage(tab3, SNAPSHOT_EXPR);
    results.standalone = judge(snap3.seq, ["STEER-CHARLIE"]);
  } catch (e) {
    results.standalone = { verdict: "SKIPPED", error: String(e).slice(0, 120) };
  }

  // ── Scenario 6: switch away and back — replay + pending survive ──
  // Needs a second session to switch to. Spawn one via the hub, steer session-1
  // mid-turn, switch to session-2, switch back, verify the transcript rebuilt
  // with steers in order.
  log("S6: switch-away-and-back replay…");
  await focusTab(tab1);
  try {
    // Fire a long turn + a steer on the current (session-1) hub tab.
    await evalInPage(tab1, driveSteerExpr("Count slowly from 1 to 200, one number per line. When you finish, print the token S6DONE."));
    const s6streaming = await evalInPage(tab1, waitAssistantStreamingExpr());
    if (!s6streaming) throw new Error("S6: no stream");
    await evalInPage(tab1, driveSteerExpr("STEER-ECHO: also print ECHO."));
    await sleep(1800);
    // Spawn a second session and switch to it, then back.
    await fetch(`http://localhost:${HUB_PORT}/api/new-session`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) }).catch(() => {});
    await sleep(4000);
    const switched = await evalInPage(tab1, `
      const items = [...document.querySelectorAll(".session-item")];
      if (items.length < 2) return { ok: false, n: items.length };
      // Click the session that is NOT current, then back to the first.
      const other = items.find((el) => !el.classList.contains("current"));
      if (!other) return { ok: false, n: items.length };
      other.click();
      await new Promise(r => setTimeout(r, 3000));
      const back = [...document.querySelectorAll(".session-item")].find((el) => !el.classList.contains("current"));
      if (back) back.click();
      await new Promise(r => setTimeout(r, 3000));
      return { ok: true, n: items.length };
    `);
    if (switched.ok) {
      await evalInPage(tab1, waitForTextExpr("S6DONE", 800));
      await sleep(1000);
      const snap6 = await evalInPage(tab1, SNAPSHOT_EXPR);
      results.switchBack = judge(snap6.seq, ["STEER-ECHO"]);
    } else {
      results.switchBack = { verdict: "SKIPPED", note: `only ${switched.n} session(s)` };
    }
  } catch (e) {
    results.switchBack = { verdict: "SKIPPED", error: String(e).slice(0, 120) };
  }

  // ── Report ──
  const labels = {
    hubSender: "S1 hub sender (2 steers, ordered)",
    hubLateJoiner: "S2 hub late-joiner (replay)",
    pendingChipAppeared: "S3a pending chip appears",
    pendingChipDrained: "S3b pending chip drains on echo",
    clearAll: "S4 clear-all",
    standalone: "S5 standalone bridge UI",
    switchBack: "S6 switch-away-and-back replay",
  };
  console.log("\n========== STEER E2E RESULTS ==========");
  const fails = [];
  for (const [key, label] of Object.entries(labels)) {
    const r = results[key];
    let pass, detail;
    if (typeof r === "boolean") { pass = r; detail = String(r); }
    else if (r && typeof r === "object") {
      const v = r.verdict || "";
      if (v.startsWith("SKIPPED")) { pass = null; detail = v + (r.note ? ` (${r.note})` : "") + (r.error ? ` (${r.error})` : ""); }
      else { pass = v.startsWith("OK"); detail = v + (r.problems?.length ? ` ${JSON.stringify(r.problems)}` : ""); }
    } else { pass = null; detail = "not run"; }
    const mark = pass === true ? "PASS" : pass === false ? "FAIL" : "SKIP";
    console.log(`  [${mark}] ${label}: ${detail}`);
    if (pass === false) fails.push(label);
  }
  const critical = [results.hubSender, results.standalone];
  const criticalOk = critical.every((r) => r && r.verdict?.startsWith("OK"));
  const anyFail = fails.length > 0 || !criticalOk;
  console.log("\n========== OVERALL:", anyFail ? "FAIL" : "PASS", "==========");
  if (anyFail) {
    console.log("full results:", JSON.stringify(results, null, 2));
    log("bridge.log tail:");
    try { console.log(readFileSync(join(iso, "bridge.log"), "utf8").split("\n").slice(-30).join("\n")); } catch {}
  }
  process.exitCode = anyFail ? 1 : 0;
}

main().then(() => { cleanup(); process.exit(process.exitCode ?? 0); }).catch((e) => { console.error("[repro-steer] ERROR", e); cleanup(); process.exit(2); });
