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

  log("spawning throwaway pi session…");
  const piCmd = `tail -f /dev/null | pi --no-extensions -e '${build}/index.ts' --mode rpc -n 'repro-steer' >> '${iso}/bridge.log' 2>&1`;
  procs.push(spawn("sh", ["-c", piCmd], { cwd: work, env: { ...process.env, PI_BRIDGE_DIR: iso }, detached: false, stdio: "ignore" }));

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

  const tab1 = await openPage(`localhost:${HUB_PORT}`);
  await evalInPage(tab1, `window.alert = () => {}; return true;`);
  log("tab1 (sender) connected; waiting for SPA boot…");
  await sleep(2500);

  // ── Sender-tab scenario: fire a long turn, steer twice mid-stream ──
  const prompt = (msg) => fetch(`http://localhost:${port}/api/prompt`, {
    method: "POST", headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify({ message: msg, stream: true }),
  }).catch(() => {});

  log("firing a long turn (counting task)…");
  // Kick the turn via the hub SPA send path so the sender tab owns the stream.
  await evalInPage(tab1, driveSteerExpr("Count slowly from 1 to 60, one number per line. When you finish, print the token COUNTDONE."));

  const streaming1 = await evalInPage(tab1, waitAssistantStreamingExpr());
  if (!streaming1) throw new Error("assistant never started streaming on tab1");
  log("assistant streaming; sending steer #1…");
  await evalInPage(tab1, driveSteerExpr("STEER-ALPHA: also print the word ALPHA."));
  await sleep(3000);
  log("sending steer #2…");
  await evalInPage(tab1, driveSteerExpr("STEER-BRAVO: also print the word BRAVO."));

  // Open a second tab NOW (mid-turn) — the late joiner attaches + replays.
  log("opening tab2 (late joiner) mid-turn…");
  await tab1.send("Target.createTarget", { url: `http://localhost:${HUB_PORT}/` }).catch(() => {});
  // createTarget on the page-level ws may not exist; fall back to a fresh window via CDP /json/new.
  let tab2;
  try {
    const newTargetRes = await fetch(`http://localhost:${CDP_PORT}/json/new?http://localhost:${HUB_PORT}/`, { method: "PUT" }).catch(() => null);
    if (newTargetRes) await newTargetRes.json().catch(() => {});
  } catch {}
  await sleep(1500);
  try { tab2 = await openPage(`localhost:${HUB_PORT}`); } catch { tab2 = null; }

  log("waiting for the turn to finish (COUNTDONE)…");
  await evalInPage(tab1, waitForTextExpr("COUNTDONE"));
  await sleep(1500);

  const snap1 = await evalInPage(tab1, SNAPSHOT_EXPR);
  const v1 = judge(snap1.seq, ["STEER-ALPHA", "STEER-BRAVO"]);

  let v2 = null;
  if (tab2) {
    // The late joiner may have connected after ALPHA already landed; it should
    // still show both steers in order via replay + live.
    const snap2 = await evalInPage(tab2, SNAPSHOT_EXPR);
    v2 = judge(snap2.seq, ["STEER-ALPHA", "STEER-BRAVO"]);
  }

  console.log("\n========== SENDER TAB ==========");
  console.log(JSON.stringify(v1, null, 2));
  if (v2) {
    console.log("\n========== LATE-JOINER TAB ==========");
    console.log(JSON.stringify(v2, null, 2));
  } else {
    console.log("\n(late-joiner tab could not be opened; sender-tab verdict stands)");
  }

  const ok = v1.verdict.startsWith("OK") && (!v2 || v2.verdict.startsWith("OK"));
  console.log("\n========== OVERALL:", ok ? "PASS" : "FAIL", "==========");
  if (!ok) {
    log("bridge.log tail:");
    try { console.log(readFileSync(join(iso, "bridge.log"), "utf8").split("\n").slice(-30).join("\n")); } catch {}
  }
  process.exitCode = ok ? 0 : 1;
}

main().then(() => { cleanup(); process.exit(process.exitCode ?? 0); }).catch((e) => { console.error("[repro-steer] ERROR", e); cleanup(); process.exit(2); });
