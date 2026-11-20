#!/usr/bin/env node
/**
 * Real end-to-end for the hub cron scheduler.
 *
 * Real pi (`pi -p` under the zsh wrapper) + the working-tree hub + headless
 * Chrome, all against an isolated PI_BRIDGE_DIR (mktemp) and free ports:
 *   1  a dummy every-minute job fires on its own for at least 2 slots
 *      (trigger=schedule, scheduledFor on the minute)
 *   2  while running, its session is in /api/sessions with the `cron:` prefix;
 *      once finished, the Cron panel lists the run with action=open
 *   3  clicking Open in the panel switches to that run's session; a follow-up
 *      typed into the input box is answered with the random number the run
 *      wrote to out.txt; the button becomes "Go to session"; one process group
 *   4  every finished run's discovery file is gone
 *
 * The hub gets an env -i style environment: HOME/USER/PATH/LANG plus
 * FIREWORKS_API_KEY/AWS_PROFILE/AWS_REGION passed through from the caller when
 * set (the real hub's pm2 env carries them; a resumed session needs a model).
 * Cron runs read the rest of their credentials from ~/.zshenv, as in production.
 *
 * Self-cleaning on any exit (incl. SIGINT): kills only the process groups it
 * recorded, deletes only the session files of the session ids it recorded,
 * keeps the isolated dir (logs, screenshots, run records) and prints its path.
 * Never touches the real hub, real sessions or the real data/ dir.
 * Prints PASS/FAIL lines and a VERDICT line, exits non-zero on failure.
 *
 * Usage: node scripts/e2e-cron.mjs
 *   E2E_CRON_MODEL   pi --model for the dummy job (default: a cheap Fireworks model)
 *   CHROME           Chrome executable (default: the macOS app path)
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const MODEL = process.env.E2E_CRON_MODEL || "fireworks/accounts/fireworks/models/deepseek-v4p1-flash";
const SESSIONS_ROOT = join(homedir(), ".pi", "agent", "sessions");
const REPO = process.cwd();
const JOB_ID = "e2e-cron";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const groups = new Set(); // process-group leaders this script started or learned from its own records
const sessionIds = new Set(); // session ids of this script's runs
let iso, cronDir, runsDir, hubPort, failed = false, cleaned = false;

const check = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"} ${name} ${detail}`); if (!ok) failed = true; };
const fatal = (msg) => { console.error(`ERROR ${msg}`); process.exit(2); };

function freePort() {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once("error", rej);
    s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => res(port)); });
  });
}

const groupAlive = (pgid) => { try { process.kill(-pgid, 0); return true; } catch { return false; } };

function sessionFiles() {
  const out = [];
  for (const sid of sessionIds) {
    let dirs = [];
    try { dirs = readdirSync(SESSIONS_ROOT, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch {}
    for (const d of dirs) {
      let files = [];
      try { files = readdirSync(join(SESSIONS_ROOT, d.name)); } catch {}
      for (const f of files) if (f.endsWith(`_${sid}.jsonl`)) out.push(join(SESSIONS_ROOT, d.name, f));
    }
  }
  return out;
}

function readRuns() {
  let names = [];
  try { names = readdirSync(runsDir); } catch {}
  return names.map((n) => {
    try {
      const run = JSON.parse(readFileSync(join(runsDir, n, "run.json"), "utf8"));
      const exitText = existsSync(join(runsDir, n, "exit")) ? readFileSync(join(runsDir, n, "exit"), "utf8").trim() : null;
      if (run.sessionId) sessionIds.add(run.sessionId);
      return { ...run, exit: exitText };
    } catch { return null; }
  }).filter(Boolean).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
}

function discoveries() {
  try {
    return readdirSync(iso).filter((f) => f.endsWith(".json")).map((f) => {
      try { return JSON.parse(readFileSync(join(iso, f), "utf8")); } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

// Sync so it also runs from signal handlers and process exit.
function cleanup() {
  if (cleaned) return;
  cleaned = true;
  // Learn the groups this script's runs still hold: a run wrapper that has not
  // written its exit file yet, and any session of a recorded id (the resumed one).
  // A finished run's pid is not reused as a kill target.
  for (const r of readRuns()) if (r.shellPid && r.exit == null) groups.add(r.shellPid);
  for (const d of discoveries()) if (sessionIds.has(d.sessionId) && d.pid) groups.add(d.pid);
  for (const g of groups) { try { process.kill(-g, "SIGTERM"); } catch {} }
  for (let i = 0; i < 20 && [...groups].some(groupAlive); i++) sleepSync(250);
  for (const g of groups) { if (groupAlive(g)) { try { process.kill(-g, "SIGKILL"); } catch {} } }
  const left = [...groups].filter(groupAlive);
  // A killed session keeps its discovery file for auto-recover; drop this
  // script's ones so nothing pointed at the kept dir respawns them.
  try { for (const f of readdirSync(iso)) if (f.endsWith(".json") && sessionIds.has(f.slice(0, -5))) rmSync(join(iso, f)); } catch {}
  const files = sessionFiles();
  for (const f of files) { try { rmSync(f); } catch {} }
  console.log(`cleanup: ${groups.size} recorded process groups ended${left.length ? `, STILL ALIVE: ${left.join(",")}` : ""}`);
  console.log(`cleanup: deleted ${files.length} session file(s) of recorded ids:${files.map((f) => `\n  ${f}`).join("")}`);
  const leftFiles = sessionFiles();
  if (leftFiles.length) console.log(`cleanup: COULD NOT DELETE ${leftFiles.join(", ")}`);
  if (iso) console.log(`evidence kept in ${iso}`);
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

const api = async (path, init) => (await fetch(`http://127.0.0.1:${hubPort}${path}`, init)).json();

async function main() {
  if (!process.env.FIREWORKS_API_KEY) fatal("FIREWORKS_API_KEY is not set in the caller's environment; the dummy job and the resumed session need it");
  if (!existsSync(CHROME)) fatal(`Chrome not found at ${CHROME} (set CHROME=<path to a Chrome/Chromium executable>)`);
  if (spawnSync("sh", ["-c", "command -v pi"], { env: process.env }).status !== 0) fatal("pi is not on PATH");
  if (spawnSync("sh", ["-c", "command -v zsh"]).status !== 0) fatal("zsh is not installed (cron runs use a zsh wrapper)");

  iso = mkdtempSync(join(tmpdir(), "e2e-cron-"));
  cronDir = join(iso, "cron");
  runsDir = join(cronDir, "runs");
  const work = join(iso, "work");
  const shots = join(iso, "shots");
  for (const d of [cronDir, work, shots]) mkdirSync(d, { recursive: true });
  hubPort = await freePort();
  const cdpPort = await freePort();
  console.log(`isolated dir ${iso}, hub :${hubPort}, model ${MODEL}`);

  const prompt = 'Use the bash tool to run exactly this command: echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $RANDOM$RANDOM" >> ./out.txt && tail -n 1 ./out.txt\nThen reply with one short sentence that states the random number (the second field) you just wrote.';
  const job = { id: JOB_ID, name: "e2e cron", schedule: "* * * * *", model: MODEL, cwd: work, enabled: true, since: new Date().toISOString(), prompt };
  const writeJobs = (enabled) => writeFileSync(join(cronDir, "cron-jobs.json"), JSON.stringify({ jobs: [{ ...job, enabled }] }, null, 2));
  writeJobs(true);

  // Sessions bind loopback and search for a port upward from their own base, away from the live range.
  const sessionPortBase = await freePort();
  const env = { PI_BRIDGE_DIR: iso, PI_HUB_PORT: String(hubPort), PI_HUB_HOST: "127.0.0.1", PI_HTTP_HOST: "127.0.0.1", PI_HTTP_PORT: String(sessionPortBase), PI_CRON_TICK_MS: "5000" };
  for (const k of ["HOME", "USER", "PATH", "LANG", "FIREWORKS_API_KEY", "AWS_PROFILE", "AWS_REGION"]) if (process.env[k] !== undefined) env[k] = process.env[k];
  const hubLog = openSync(join(iso, "hub.log"), "a");
  const hub = spawn("node", ["packages/hub/src/server.js"], { cwd: REPO, env, detached: true, stdio: ["ignore", hubLog, hubLog] });
  groups.add(hub.pid);

  // ── Watch: until 2 schedule runs finished (or timeout) ──
  const seenInList = new Map(); // sessionId -> sessionName seen in /api/sessions while its run was running
  const deadline = Date.now() + 210_000;
  let runs = [];
  while (Date.now() < deadline) {
    await sleep(1000);
    runs = readRuns();
    try {
      const list = (await api("/api/sessions")).sessions || [];
      for (const s of list) {
        const run = runs.find((r) => r.sessionId === s.sessionId);
        if (run && run.exit == null) seenInList.set(s.sessionId, s.sessionName);
      }
    } catch {}
    if (runs.filter((r) => r.trigger === "schedule" && r.exit != null).length >= 2) break;
  }
  writeJobs(false); // no further slots while the UI part runs
  await sleep(6000); // let a tick reconcile the last run
  runs = readRuns();
  const sched = runs.filter((r) => r.trigger === "schedule");
  const onTheMinute = sched.every((r) => new Date(r.scheduledFor).getUTCSeconds() === 0 && Date.parse(r.startedAt) - Date.parse(r.scheduledFor) < 15_000);
  check("1 schedule: >= 2 slots fired by the scheduler", sched.length >= 2 && onTheMinute,
    sched.map((r) => `[${r.trigger} slot=${r.scheduledFor} started=${r.startedAt} exit=${r.exit} state=${r.state}]`).join(" "));

  const okRuns = runs.filter((r) => r.state === "ok" && r.exit === "0");
  check("2a list: a running cron session appeared in /api/sessions with the cron: prefix",
    seenInList.size > 0 && [...seenInList.values()].every((n) => n?.startsWith("cron: ")), JSON.stringify([...seenInList.values()]));
  check("4 discovery: no discovery file left for finished runs", !discoveries().some((d) => runs.some((r) => r.sessionId === d.sessionId)),
    `(${discoveries().length} discovery files)`);

  const target = okRuns[0];
  const outTxt = existsSync(join(work, "out.txt")) ? readFileSync(join(work, "out.txt"), "utf8") : "";
  const outLog = target ? readFileSync(join(runsDir, target.runId, "out.log"), "utf8") : "";
  const number = (outLog.match(/\d{3,}/g) || []).find((n) => outTxt.split("\n").some((l) => l.endsWith(` ${n}`)));
  if (!target || !number) {
    check("3 resume: a finished run with a number in out.txt to resume", false, `(ok runs ${okRuns.length}, number ${number ?? "none"})`);
    return;
  }

  // ── UI ──
  const chrome = spawn(CHROME, [`--remote-debugging-port=${cdpPort}`, "--headless=new", "--no-first-run", "--window-size=1400,900", `--user-data-dir=${join(iso, "chrome-profile")}`, "about:blank"], { detached: true, stdio: "ignore" });
  groups.add(chrome.pid);
  let wsUrl;
  for (let i = 0; i < 40 && !wsUrl; i++) {
    await sleep(500);
    try { wsUrl = (await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json()).find((t) => t.type === "page")?.webSocketDebuggerUrl; } catch {}
  }
  if (!wsUrl) throw new Error("Chrome DevTools target not found");
  const page = await cdpConnect(wsUrl);
  await page.send("Runtime.enable");
  await page.send("Page.enable");
  await page.send("Page.addScriptToEvaluateOnNewDocument", { source: "window.alert = () => {}; localStorage.setItem('pi-hub-cron-collapsed', 'false');" });
  await page.send("Page.navigate", { url: `http://127.0.0.1:${hubPort}/` });
  const waitFor = (cond, ms) => page.evalPage(`for (let i = 0; i < ${ms / 250}; i++) { if (${cond}) return true; await new Promise((r) => setTimeout(r, 250)); } return false;`);
  const shot = async (name) => { const r = await page.send("Page.captureScreenshot", { format: "png" }); writeFileSync(join(shots, `${name}.png`), Buffer.from(r.result.data, "base64")); };

  // The panel lists runs newest first by createdAt, like the API: find the target's row by index.
  const apiRuns = (await api(`/api/cron/jobs/${JOB_ID}/runs`)).runs;
  const row = apiRuns.findIndex((r) => r.runId === target.runId);
  await waitFor(`document.querySelector('.cron-job')`, 15000);
  await page.evalPage(`[...document.querySelectorAll('.cron-job-name')].find((e) => e.textContent.includes('e2e cron')).click();`);
  await waitFor(`document.querySelectorAll('.cron-run').length === ${apiRuns.length}`, 15000);
  const rowButtons = (i) => page.evalPage(`return [...(document.querySelectorAll('.cron-run')[${i}]?.querySelectorAll('.cron-btn') || [])].map((b) => b.textContent);`);
  const before = await rowButtons(row);
  await shot("1-panel");
  check("2b panel: the finished run is listed with action=open", apiRuns[row]?.action === "open" && before.includes("Open") && (await page.evalPage(`return document.querySelectorAll('.cron-run')[${row}].textContent.includes('finished');`)),
    `(api action ${apiRuns[row]?.action}, buttons ${JSON.stringify(before)})`);

  await page.evalPage(`[...document.querySelectorAll('.cron-run')[${row}].querySelectorAll('.cron-btn')].find((b) => b.textContent === 'Open').click();`);
  const switched = await waitFor(`document.getElementById('session-name').textContent === ${JSON.stringify(target.name)}`, 30000);
  const history = await waitFor(`document.getElementById('messages').textContent.includes(${JSON.stringify(number)})`, 20000);
  await shot("2-opened");
  check("3a open: header is the run's name and the transcript is the run's history", switched && history, `(name ${JSON.stringify(target.name)}, number ${number})`);

  const assistants = `document.querySelectorAll('#messages .message.assistant').length`;
  const n0 = await page.evalPage(`return ${assistants};`);
  await page.evalPage(`const ta = document.getElementById('message-input'); ta.value = 'Which random number did you write to out.txt earlier in this session? Reply with only that number.'; ta.dispatchEvent(new Event('input', { bubbles: true })); ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));`);
  const answered = await waitFor(`${assistants} > ${n0} && document.getElementById('busy-indicator').textContent.trim() === 'idle'`, 120000);
  const reply = await page.evalPage(`return [...document.querySelectorAll('#messages .message.assistant')].at(-1)?.textContent.replace(/\\s+/g, ' ').trim() ?? '';`);
  await shot("3-follow-up");
  check("3b follow-up: the resumed session answers with the out.txt number", answered && reply.includes(number), `(reply ${JSON.stringify(reply.slice(-80))}, expected ${number})`);

  const goTo = await waitFor(`[...(document.querySelectorAll('.cron-run')[${row}]?.querySelectorAll('.cron-btn') || [])].some((b) => b.textContent === 'Go to session')`, 15000);
  await shot("4-panel-after");
  check("3c panel: the button became Go to session", goTo, JSON.stringify(await rowButtons(row)));

  const ps = spawnSync("ps", ["-axo", "pgid=,command="], { encoding: "utf8" }).stdout.split("\n");
  const pgids = new Set(ps.filter((l) => l.includes(target.sessionId) && l.includes("--session")).map((l) => l.trim().split(/\s+/)[0]));
  const disc = discoveries().filter((d) => d.sessionId === target.sessionId);
  for (const d of disc) if (d.pid) groups.add(d.pid);
  check("3d resume: one process group and one discovery file for the session (no respawn)", pgids.size === 1 && disc.length === 1, `(pgids ${[...pgids].join(",")}, discovery files ${disc.length})`);
}

process.on("exit", cleanup);
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { failed = true; process.exit(130); });
main()
  .catch((e) => { console.error("FAIL harness error:", e.message); failed = true; })
  .finally(() => { console.log(`VERDICT: ${failed ? "RED" : "GREEN"}`); process.exit(failed ? 1 : 0); });
