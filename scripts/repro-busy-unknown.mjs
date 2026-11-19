#!/usr/bin/env node
/**
 * Repro + regression: a bridge that stops answering /api/status (event loop
 * blocked, e.g. replaying a huge turn buffer) must read as UNKNOWN, not idle.
 *
 * Spawns a test hub on :8799 against an isolated PI_BRIDGE_DIR with one stub
 * bridge, then drives the stub through busy -> unresponsive -> idle.
 *   S1  busy:true while the stub answers
 *   S2  busy stays true (not null/false) while /api/status times out
 *   S3  busy -> unresponsive -> idle still emits exactly one session_done
 * Red before the fix (S2 sees null), green after. Never touches real sessions.
 *
 * Usage: node scripts/repro-busy-unknown.mjs
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HUB_PORT = 8799;
const STUB_PORT = 17331;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = mkdtempSync(join(tmpdir(), "repro-busy-"));
let mode = "busy"; // busy | hang | idle
const hung = new Set();

const stub = http.createServer((req, res) => {
  if (req.url !== "/api/status") { res.writeHead(404); res.end(); return; }
  if (mode === "hang") { hung.add(res); return; } // never answer
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ busy: mode === "busy" }));
});
await new Promise((r) => stub.listen(STUB_PORT, r));

writeFileSync(join(iso, "stub-session.json"), JSON.stringify({
  port: STUB_PORT, host: "127.0.0.1", sessionId: "stub-session", sessionName: "stub",
  cwd: "/tmp", pid: process.pid, piPid: process.pid, startedAt: Date.now(),
}));

const hub = spawn("node", ["packages/hub/src/server.js"], {
  env: { ...process.env, PI_BRIDGE_DIR: iso, PI_HUB_PORT: String(HUB_PORT), PI_HUB_HOST: "127.0.0.1" },
  stdio: "ignore",
});

const doneEvents = [];
let sse;
const results = [];
const check = (name, ok, detail) => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"} ${name}: ${detail}`); };
const busyNow = async () => {
  const r = await fetch(`http://127.0.0.1:${HUB_PORT}/api/sessions`);
  return (await r.json()).sessions.find((s) => s.sessionId === "stub-session")?.busy;
};

try {
  for (let i = 0; i < 50; i++) { try { await busyNow(); break; } catch { await sleep(200); } }
  const ac = new AbortController();
  fetch(`http://127.0.0.1:${HUB_PORT}/api/events`, { signal: ac.signal }).then(async (r) => {
    const dec = new TextDecoder();
    for await (const chunk of r.body) {
      for (const line of dec.decode(chunk).split("\n")) {
        if (line.startsWith("data: ")) doneEvents.push(JSON.parse(line.slice(6)));
      }
    }
  }).catch(() => {});
  sse = ac;

  await sleep(2600); // let a poll observe busy:true
  const s1 = await busyNow();
  check("S1 busy while answering", s1 === true, `busy=${s1}`);

  mode = "hang";
  const seen = new Set();
  for (let i = 0; i < 12; i++) { seen.add(String(await busyNow())); await sleep(500); }
  check("S2 busy stays true while unresponsive", seen.size === 1 && seen.has("true"), `observed={${[...seen]}}`);

  mode = "idle";
  for (const r of hung) r.destroy();
  await sleep(5000);
  const dones = doneEvents.filter((e) => e.type === "session_done" && e.sessionId === "stub-session");
  check("S3 one session_done after busy->unresponsive->idle", dones.length === 1, `session_done events=${dones.length}`);
} finally {
  sse?.abort();
  hub.kill();
  stub.close();
  for (const r of hung) r.destroy();
  rmSync(iso, { recursive: true, force: true });
}
const ok = results.length === 3 && results.every(Boolean);
console.log(ok ? "VERDICT: GREEN" : "VERDICT: RED");
process.exit(ok ? 0 : 1);
