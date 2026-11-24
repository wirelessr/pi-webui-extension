#!/usr/bin/env node
/**
 * Real end-to-end for session auto-naming with a placeholder + retitle after
 * the first turn (name-generator.js createRetitleTracker, index.ts wiring).
 *
 * Real pi + a freshly built copy of the extension (`-e <build>/index.ts`), no
 * hub: each scenario starts its own throwaway pi under `zsh -c` (process-group
 * leader recorded), talks to its bridge directly, and decides from the
 * bridge.log lines the extension writes (`auto-named session:`, `retitle: ...`):
 *   1  bare link + vague verb (title model SKIPs): the name is a placeholder
 *      without the URL; after the turn `retitle: applied` and the name is a
 *      content-based title
 *   2  descriptive prompt: normal title, and no `retitle:` line ever
 *   3  bare link, then a manual rename right after the placeholder: the manual
 *      name wins (`retitle: dropped (renamed)` or `retitle: skipped-renamed`);
 *      `retitle: applied` before the rename returned is INCONCLUSIVE (rerun)
 *   4  bare link, turn aborted at agent_start: `retitle: dropped (...)` and the
 *      placeholder stays
 *
 * Red on a build without the feature (E2E_REF=<old commit>): the name stays the
 * raw URL and no `retitle:` line appears. Green on the working tree.
 *
 * Environment: env -i style (HOME/USER/PATH/LANG + the title-model and agent
 * credentials when set), an empty isolated ZDOTDIR, its own PI_BRIDGE_DIR and
 * loopback ports. Needs PI_AUTO_NAME_API_KEY or FIREWORKS_API_KEY (without a
 * title key nothing SKIPs, so red and green cannot differ).
 *
 * Self-cleaning on any exit: ends only the process groups it started, deletes
 * only its own discovery files and the session files of the ids it recorded,
 * keeps the isolated dir (bridge.log, builds) and prints its path. Never
 * touches the live hub, live sessions, the real data/ dir or the deployed
 * extension. Prints PASS/FAIL/INCONCLUSIVE lines and a VERDICT line; exit 0
 * green, 1 red, 3 inconclusive, 2 setup error.
 *
 * Usage: node scripts/e2e-session-retitle.mjs   (from the repo root)
 *   E2E_REF     git ref to build instead of the working tree (e.g. main)
 *   E2E_MODEL   pi --model for the agent (default: a cheap Fireworks model)
 *   E2E_URL     public URL for the SKIP prompt (default https://example.com)
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const REPO = process.cwd();
const REF = process.env.E2E_REF || "";
const MODEL = process.env.E2E_MODEL || "fireworks/accounts/fireworks/models/deepseek-v4p1-flash";
const URL_ = process.env.E2E_URL || "https://example.com";
const SKIP_PROMPT = `${URL_} 看一下`;
const DESCRIPTIVE_PROMPT = "Explain in one sentence what HTTP status 418 means.";
const MANUAL_NAME = "manual e2e name";
const SETTINGS = join(homedir(), ".pi", "agent", "settings.json");
const SESSIONS_ROOT = join(homedir(), ".pi", "agent", "sessions");
const DECISION_RE = /retitle: (applied|dropped \(([^)]*)\)|skipped-renamed|null-title|error)/;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const groups = new Set(); // process-group leaders this script started
const sessions = []; // { pgid, sessionId, sessionFile } learned from our own discovery files
let iso, ext, cleaned = false, settingsHash = null;
const results = []; // "pass" | "fail" | "inconclusive"

const report = (status, name, detail = "") => {
  results.push(status);
  console.log(`${status.toUpperCase()} ${name}${detail ? ` ${detail}` : ""}`);
};
const check = (name, ok, detail = "") => report(ok ? "pass" : "fail", name, detail);
const fatal = (msg) => { console.error(`ERROR ${msg}`); process.exit(2); };

function freePort() {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once("error", rej);
    s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => res(port)); });
  });
}

const groupAlive = (pgid) => { try { process.kill(-pgid, 0); return true; } catch { return false; } };
const hashFile = (p) => { try { return createHash("sha256").update(readFileSync(p)).digest("hex"); } catch { return null; } };

// Poll a condition until it holds or the deadline passes (a bound, not a sleep).
async function waitFor(fn, timeoutMs) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return null;
    await sleep(250);
  }
}

function logLines(port) {
  let text = "";
  try { text = readFileSync(join(iso, "bridge.log"), "utf8"); } catch {}
  const tag = `[${port}] [http-bridge] `;
  return text.split("\n").filter((l) => l.includes(tag)).map((l) => l.slice(l.indexOf(tag) + tag.length));
}
const autoNamed = (port) => logLines(port).find((l) => l.startsWith("auto-named session: "))?.slice("auto-named session: ".length) ?? null;
const decisions = (port) => logLines(port).map((l, i) => ({ i, m: l.match(DECISION_RE) })).filter((x) => x.m);

function discoveries() {
  try {
    return readdirSync(iso).filter((f) => f.endsWith(".json")).map((f) => {
      try { return JSON.parse(readFileSync(join(iso, f), "utf8")); } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

function sessionFilesOf(rec) {
  const out = new Set();
  if (rec.sessionFile && existsSync(rec.sessionFile)) out.add(rec.sessionFile);
  if (rec.sessionId) {
    let dirs = [];
    try { dirs = readdirSync(SESSIONS_ROOT, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch {}
    for (const d of dirs) {
      let files = [];
      try { files = readdirSync(join(SESSIONS_ROOT, d.name)); } catch {}
      for (const f of files) if (f.endsWith(`_${rec.sessionId}.jsonl`)) out.add(join(SESSIONS_ROOT, d.name, f));
    }
  }
  return [...out];
}

function shadowEnv(port) {
  const env = { PI_BRIDGE_DIR: iso, PI_HTTP_HOST: "127.0.0.1", PI_HTTP_PORT: String(port), ZDOTDIR: join(iso, "zdot") };
  for (const k of ["HOME", "USER", "PATH", "LANG", "FIREWORKS_API_KEY", "PI_AUTO_NAME_API_KEY", "PI_AUTO_NAME_API_URL", "PI_AUTO_NAME_MODEL", "AWS_PROFILE", "AWS_REGION"]) {
    if (process.env[k] !== undefined) env[k] = process.env[k];
  }
  return env;
}

async function startSession(label) {
  const port = await freePort();
  const work = join(iso, `work-${label}`);
  mkdirSync(work, { recursive: true });
  const cmd = `tail -f /dev/null | pi --mode rpc --no-extensions -e '${ext}/index.ts' --model '${MODEL}'`;
  const child = spawn("zsh", ["-c", cmd], { cwd: work, env: shadowEnv(port), detached: true, stdio: "ignore" });
  child.unref();
  groups.add(child.pid);
  const d = await waitFor(() => discoveries().find((x) => x.pid === child.pid && x.port), 60000);
  if (!d) throw new Error(`${label}: no discovery file with pid ${child.pid} (see ${iso}/bridge.log)`);
  const rec = { pgid: child.pid, sessionId: d.sessionId, sessionFile: d.sessionFile, port: d.port };
  sessions.push(rec);
  const url = `http://127.0.0.1:${d.port}`;
  const ok = await waitFor(async () => { try { return (await fetch(`${url}/api/status`)).ok; } catch { return false; } }, 30000);
  if (!ok) throw new Error(`${label}: bridge on :${d.port} never answered`);
  console.log(`session ${label}: pgid ${child.pid}, port ${d.port}, id ${d.sessionId}`);
  return { ...rec, url };
}

const status = async (s) => (await fetch(`${s.url}/api/status`)).json();
const post = async (s, path, body) => (await fetch(`${s.url}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json().catch(() => ({}));
const prompt = (s, message) => post(s, "/api/prompt", { message, timeout: 240000 });

async function stopSession(s) {
  try { await post(s, "/api/kill-session", { pid: s.pgid }); } catch {}
  await waitFor(() => !groupAlive(s.pgid), 10000);
  // A leftover discovery file would be recovered (respawned) by the next pi in $ISO.
  if (!groupAlive(s.pgid)) { try { rmSync(join(iso, `${s.sessionId}.json`)); } catch {} }
}

const hasUrl = (name) => typeof name === "string" && /:\/\//.test(name);
// After the turn returned, the decision (if any) is a title call away.
const waitDecision = (port) => waitFor(() => decisions(port)[0] ?? null, 90000);

async function scenarioSkip() {
  const s = await startSession("skip");
  const turn = prompt(s, SKIP_PROMPT);
  const placeholder = await waitFor(() => autoNamed(s.port), 60000);
  check("1 skip: auto-named", !!placeholder, `(${JSON.stringify(placeholder)})`);
  check("1 skip: placeholder has no URL", !!placeholder && !hasUrl(placeholder), `(${JSON.stringify(placeholder)})`);
  await turn;
  const d = await waitDecision(s.port);
  check("1 skip: retitle applied", d?.m[1] === "applied", `(${d ? d.m[0] : "no retitle: line"})`);
  const name = d?.m[1] === "applied"
    ? await waitFor(async () => { const n = (await status(s)).sessionName; return n && n !== placeholder ? n : null; }, 10000)
    : (await status(s)).sessionName;
  check("1 skip: final name is a new title", !!name && name !== placeholder && !hasUrl(name) && name.length <= 60, `(${JSON.stringify(name)})`);
  await stopSession(s);
}

async function scenarioDescriptive() {
  const s = await startSession("descriptive");
  const turn = prompt(s, DESCRIPTIVE_PROMPT);
  const title = await waitFor(() => autoNamed(s.port), 60000);
  await turn;
  check("2 descriptive: titled", !!title && !hasUrl(title) && title !== DESCRIPTIVE_PROMPT, `(${JSON.stringify(title)})`);
  // Both the title decision and the first settle are past: the tracker is done
  // (or never left wait), so a retitle line could only come from a bug.
  const lines = decisions(s.port);
  check("2 descriptive: no retitle: line", lines.length === 0, lines.length ? `(${lines[0].m[0]})` : "");
  await stopSession(s);
}

async function scenarioRenamed() {
  const s = await startSession("renamed");
  const turn = prompt(s, SKIP_PROMPT);
  const placeholder = await waitFor(() => autoNamed(s.port), 60000);
  if (!placeholder) {
    check("3 renamed: auto-named", false, "(no auto-named line)");
    await turn;
    await stopSession(s);
    return;
  }
  const beforeSend = logLines(s.port).length;
  await post(s, "/api/rename-session", { name: MANUAL_NAME });
  const afterReturn = logLines(s.port).length;
  await turn;
  const d = await waitDecision(s.port);
  const name = (await status(s)).sessionName;
  const kind = d?.m[1];
  const renamedDrop = kind === "skipped-renamed" || (kind?.startsWith("dropped") && d.m[2] === "renamed");
  if (kind === "applied" && d.i < afterReturn) {
    // The retitle landed before (or while) the rename request was in flight:
    // the precondition (placeholder still current at decision time) did not hold.
    report("inconclusive", "3 renamed: retitle applied before the rename returned, rerun", `(line ${d.i}, sent at ${beforeSend}, returned at ${afterReturn}, name ${JSON.stringify(name)})`);
  } else {
    check("3 renamed: manual name kept, retitle dropped", name === MANUAL_NAME && renamedDrop, `(${d ? d.m[0] : "no retitle: line"}, name ${JSON.stringify(name)})`);
  }
  await stopSession(s);
}

async function scenarioAborted() {
  const s = await startSession("aborted");
  const turn = prompt(s, SKIP_PROMPT);
  const started = await waitFor(() => logLines(s.port).some((l) => l.startsWith("agent_start fired") && l.includes("foreign=false")), 60000);
  if (started) await post(s, "/api/abort", {});
  await turn;
  const placeholder = await waitFor(() => autoNamed(s.port), 60000);
  const d = await waitDecision(s.port);
  const name = (await status(s)).sessionName;
  if (d?.m[1] === "applied") {
    report("inconclusive", "4 aborted: the turn finished before the abort, rerun", `(${d.m[0]})`);
  } else {
    check("4 aborted: retitle dropped", !!d && d.m[1].startsWith("dropped"), `(${d ? d.m[0] : "no retitle: line"})`);
    check("4 aborted: placeholder stays", !!placeholder && name === placeholder && !hasUrl(name), `(placeholder ${JSON.stringify(placeholder)}, name ${JSON.stringify(name)})`);
  }
  await stopSession(s);
}

// Sync so it also runs from signal handlers.
function cleanup() {
  if (cleaned) return;
  cleaned = true;
  for (const g of groups) { if (groupAlive(g)) { try { process.kill(-g, "SIGTERM"); } catch {} } }
  for (let i = 0; i < 20 && [...groups].some(groupAlive); i++) sleepSync(250);
  for (const g of groups) { if (groupAlive(g)) { try { process.kill(-g, "SIGKILL"); } catch {} } }
  const left = [...groups].filter(groupAlive);
  // Drop our discovery files so nothing pointed at the kept dir respawns them.
  for (const s of sessions) {
    for (const f of [`${s.sessionId}.json`, `${s.sessionId}.json.recovering`]) { try { rmSync(join(iso, f)); } catch {} }
  }
  const deleted = [];
  for (const s of sessions) {
    for (const f of sessionFilesOf(s)) {
      try { rmSync(f); deleted.push(f); } catch {}
      try { if (readdirSync(join(f, "..")).length === 0) rmdirSync(join(f, "..")); } catch {}
    }
  }
  console.log(`cleanup: ${groups.size} recorded process groups ended${left.length ? `, STILL ALIVE: ${left.join(",")}` : ""}`);
  console.log(`cleanup: deleted ${deleted.length} session file(s) of recorded ids:${deleted.map((f) => `\n  ${f}`).join("")}`);
  const leftFiles = sessions.flatMap(sessionFilesOf);
  if (leftFiles.length) console.log(`cleanup: COULD NOT DELETE ${leftFiles.join(", ")}`);
  if (settingsHash !== null && hashFile(SETTINGS) !== settingsHash) console.log(`WARNING ${SETTINGS} changed during the run; original copy in ${join(iso, "settings.json.before")}`);
  if (iso) console.log(`evidence kept in ${iso}`);
}

async function main() {
  if (!process.env.PI_AUTO_NAME_API_KEY && !process.env.FIREWORKS_API_KEY) fatal("neither PI_AUTO_NAME_API_KEY nor FIREWORKS_API_KEY is set; without a title model nothing SKIPs");
  if (process.env.PI_AUTO_NAME === "0") fatal("PI_AUTO_NAME=0 disables the feature under test");
  for (const bin of ["pi", "zsh", "tail"]) if (spawnSync("sh", ["-c", `command -v ${bin}`]).status !== 0) fatal(`${bin} is not on PATH`);

  iso = mkdtempSync(join(tmpdir(), "e2e-session-retitle-"));
  ext = join(iso, "ext");
  mkdirSync(join(iso, "zdot"));
  writeFileSync(join(iso, "zdot", ".zshenv"), "");
  settingsHash = hashFile(SETTINGS);
  if (settingsHash !== null) writeFileSync(join(iso, "settings.json.before"), readFileSync(SETTINGS));

  let src = REPO;
  if (REF) {
    src = join(iso, "src");
    mkdirSync(src);
    const r = spawnSync("sh", ["-c", `git -C '${REPO}' archive '${REF}' | tar -x -C '${src}'`], { stdio: "inherit" });
    if (r.status !== 0) fatal(`git archive ${REF} failed`);
  }
  if (spawnSync("node", ["scripts/build-dist.mjs", "0.0.0-shadow", ext], { cwd: src, stdio: "ignore" }).status !== 0) fatal("build-dist failed");
  if (spawnSync("npm", ["install", "--omit=dev", "--no-audit", "--no-fund"], { cwd: ext, stdio: "ignore" }).status !== 0) fatal("npm install in the build failed");
  console.log(`isolated dir ${iso}, build of ${REF || "working tree"}, agent model ${MODEL}, prompt ${JSON.stringify(SKIP_PROMPT)}`);

  for (const scenario of [scenarioSkip, scenarioDescriptive, scenarioRenamed, scenarioAborted]) {
    try { await scenario(); } catch (e) { report("fail", `${scenario.name}: harness error`, e.message); }
  }
}

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { cleanup(); process.exit(130); });
main()
  .catch((e) => { report("fail", "harness error", e.message); })
  .finally(() => {
    cleanup();
    const verdict = results.includes("fail") ? "RED" : results.includes("inconclusive") ? "INCONCLUSIVE" : "GREEN";
    console.log(`VERDICT ${verdict}`);
    process.exit(verdict === "GREEN" ? 0 : verdict === "RED" ? 1 : 3);
  });
