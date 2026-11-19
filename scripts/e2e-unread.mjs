#!/usr/bin/env node
/**
 * E2E for the "finished but not yet viewed" sidebar highlight. Fake bridges
 * (tiny HTTP servers answering /api/status) let the test flip busy -> idle
 * deterministically; isolated hub on :8799, headless Chrome over raw CDP.
 * Never touches the user's sessions. Prints a machine-checkable verdict.
 *
 * Usage: node scripts/e2e-unread.mjs
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const CDP_PORT = 9226;
const HUB_PORT = 8799;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const procs = [];
const servers = [];
let iso;
const cleanup = () => { for (const p of procs) { try { p.kill("SIGKILL"); } catch {} } for (const s of servers) s.close(); try { if (iso) rmSync(iso, { recursive: true, force: true }); } catch {} };
process.on("SIGINT", () => { cleanup(); process.exit(1); });

async function cdpConnect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("ws open failed")); });
  let id = 0; const pending = new Map();
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  return { send: (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); }) };
}
async function page(cdp, body) {
  const r = await cdp.send("Runtime.evaluate", { expression: `(async () => { ${body} })()`, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
  return r.result?.result?.value;
}

async function main() {
  iso = mkdtempSync(join(tmpdir(), "e2e-unread-"));
  const busy = { X: false, Y: false };
  const ports = { X: 7101, Y: 7102 };
  for (const name of ["X", "Y"]) {
    const srv = createServer((req, res) => {
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/api/status") return res.end(JSON.stringify({ busy: busy[name], sessionId: name }));
      res.statusCode = 404; res.end("{}");
    });
    await new Promise((r) => srv.listen(ports[name], r)); servers.push(srv);
    const sleeper = spawn("sleep", ["600"], { stdio: "ignore" }); procs.push(sleeper);
    writeFileSync(join(iso, `${name}.json`), JSON.stringify({ port: ports[name], sessionId: name, sessionName: `sess-${name}`, cwd: "/tmp", pid: sleeper.pid, piPid: sleeper.pid, startedAt: name === "X" ? 2 : 1 }));
  }
  procs.push(spawn("node", ["packages/hub/src/server.js"], { env: { ...process.env, PI_HUB_PORT: String(HUB_PORT), PI_BRIDGE_DIR: iso }, stdio: "ignore" }));
  await sleep(1500);
  procs.push(spawn(CHROME, [`--remote-debugging-port=${CDP_PORT}`, "--headless=new", "--no-first-run", `--user-data-dir=${join(iso, "chrome")}`, `http://localhost:${HUB_PORT}/`], { stdio: "ignore" }));
  let wsUrl;
  for (let i = 0; i < 30 && !wsUrl; i++) { await sleep(500); try { const t = await (await fetch(`http://localhost:${CDP_PORT}/json`)).json(); wsUrl = t.find((x) => x.type === "page" && x.url.includes(`:${HUB_PORT}`))?.webSocketDebuggerUrl; } catch {} }
  if (!wsUrl) throw new Error("chrome page target not found");
  const cdp = await cdpConnect(wsUrl);
  await cdp.send("Runtime.enable");
  await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }); // headless: make hasFocus() true
  await sleep(2500);

  const unreadIds = () => page(cdp, `return [...document.querySelectorAll("#sessions-list .session-item.session-unread")].map(e => e.dataset.sid).sort().join(",");`);
  const hubUnread = async () => (await (await fetch(`http://localhost:${HUB_PORT}/api/sessions`)).json()).sessions.filter((s) => s.unread).map((s) => s.sessionId).sort().join(",");
  const active = () => page(cdp, `return document.querySelector("#sessions-list .session-item.current")?.dataset.sid || null;`);
  const flip = async (name) => { busy[name] = true; await sleep(2600); busy[name] = false; await sleep(2600); }; // hub polls every 2s; page every 3s
  const r = {};
  await page(cdp, `window.alert = () => {};`);

  r.active0 = await active();
  r.initial = await unreadIds();

  // 1) background session finishes -> highlighted, server agrees
  const bg = r.active0 === "X" ? "Y" : "X";
  await flip(bg);
  await sleep(1500);
  r.afterBgDone = await unreadIds();
  r.hubAfterBgDone = await hubUnread();

  // 2) active session finishes while page is focused -> never stays highlighted
  await flip(r.active0);
  await sleep(1500);
  r.afterActiveFocusedDone = await unreadIds();

  // 3) click the highlighted background session -> cleared locally and on the hub
  await page(cdp, `document.querySelector('#sessions-list .session-item[data-sid="${bg}"]').click();`);
  await sleep(1500);
  r.afterClick = await unreadIds();
  r.hubAfterClick = await hubUnread();

  // 4) active session finishes while the page is NOT focused -> stays highlighted; focus clears it
  await page(cdp, `window.__hasFocus = document.hasFocus; document.hasFocus = () => false;`);
  const act = await active();
  await flip(act);
  await sleep(1500);
  r.afterActiveUnfocusedDone = await unreadIds();
  await page(cdp, `document.hasFocus = window.__hasFocus; window.dispatchEvent(new Event("focus"));`);
  await sleep(800);
  r.afterRefocus = await unreadIds();
  r.hubAfterRefocus = await hubUnread();

  const checks = {
    "nothing unread initially": r.initial === "",
    "background finish is highlighted (UI + hub)": r.afterBgDone === bg && r.hubAfterBgDone === bg,
    "focused active session is not left highlighted": r.afterActiveFocusedDone === bg,
    "opening it clears the highlight (UI + hub)": r.afterClick === "" && r.hubAfterClick === "",
    "unfocused active finish stays highlighted": r.afterActiveUnfocusedDone === act,
    "returning to the page clears it (UI + hub)": r.afterRefocus === "" && r.hubAfterRefocus === "",
  };
  console.log(JSON.stringify({ r, checks }, null, 2));
  const ok = Object.values(checks).every(Boolean);
  console.log(ok ? "VERDICT: PASS" : "VERDICT: FAIL");
  return ok;
}
main().then((ok) => { cleanup(); process.exit(ok ? 0 : 1); }).catch((e) => { console.error(e); cleanup(); process.exit(2); });
