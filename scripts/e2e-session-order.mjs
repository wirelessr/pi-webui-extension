#!/usr/bin/env node
/**
 * E2E for activity-ordered sidebar + drag-to-group. No real pi needed: fake
 * discovery files (live pid = a throwaway `sleep`) pointing at JSONL files with
 * controlled mtimes, an isolated hub on :8799, headless Chrome over raw CDP.
 * Never touches the user's sessions. Prints a machine-checkable verdict.
 *
 * Usage: node scripts/e2e-session-order.mjs
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const CDP_PORT = 9225;
const HUB_PORT = 8799;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const procs = [];
let iso;
const cleanup = () => { for (const p of procs) { try { p.kill("SIGKILL"); } catch {} } try { if (iso) rmSync(iso, { recursive: true, force: true }); } catch {} };
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
  iso = mkdtempSync(join(tmpdir(), "e2e-order-"));
  const now = Date.now() / 1000;
  const files = {}; // name -> jsonl path
  const spec = [["A", 7001, 300], ["B", 7002, 200], ["C", 7003, 100], ["D", 7004, 400], ["E", 7005, 3 * 86400], ["F", 7006, 10 * 86400]]; // [name, port, age in s]
  for (const [name, port, age] of spec) {
    const sleeper = spawn("sleep", ["600"], { stdio: "ignore" }); procs.push(sleeper);
    const f = join(iso, `${name}.jsonl`); writeFileSync(f, "{}\n"); utimesSync(f, now - age, now - age); files[name] = f;
    writeFileSync(join(iso, `${name}.json`), JSON.stringify({ port, sessionId: name, sessionName: `sess-${name}`, cwd: "/tmp", pid: sleeper.pid, piPid: sleeper.pid, startedAt: 1, sessionFile: f }));
  }
  // expected newest-first: C(100s) B(200s) A(300s) D(400s) E(3d) F(10d)
  procs.push(spawn("node", ["packages/hub/src/server.js"], { env: { ...process.env, PI_HUB_PORT: String(HUB_PORT), PI_BRIDGE_DIR: iso }, stdio: "ignore" }));
  await sleep(1500);
  procs.push(spawn(CHROME, [`--remote-debugging-port=${CDP_PORT}`, "--headless=new", "--no-first-run", `--user-data-dir=${join(iso, "chrome")}`, `http://localhost:${HUB_PORT}/`], { stdio: "ignore" }));
  let wsUrl;
  for (let i = 0; i < 30 && !wsUrl; i++) { await sleep(500); try { const t = await (await fetch(`http://localhost:${CDP_PORT}/json`)).json(); wsUrl = t.find((x) => x.type === "page" && x.url.includes(`:${HUB_PORT}`))?.webSocketDebuggerUrl; } catch {} }
  if (!wsUrl) throw new Error("chrome page target not found");
  const cdp = await cdpConnect(wsUrl);
  await cdp.send("Runtime.enable");
  await sleep(2500);

  const result = await page(cdp, `
    window.alert = () => {};
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const list = document.getElementById("sessions-list") || document.querySelector("[id*=sessions]");
    const ids = (root) => [...root.querySelectorAll(":scope > .session-item")].map(e => e.dataset.sid);
    const top = () => [...list.children].filter(c => !c.classList.contains("sidebar-divider")).map(c => c.classList.contains("group") ? "g:" + c.dataset.gid + "[" + ids(c.querySelector(".group-body")).join("") + "]" : c.dataset.sid).join(",");
    const put = (items) => fetch("/api/hub-state", { method: "PUT", headers: {"Content-Type":"application/json"}, body: JSON.stringify({ items }) });
    const out = { tops: {} };
    out.dividers = [...list.querySelectorAll(":scope > .sidebar-divider")].map(d => d.textContent);
    // 1) order by mtime, not port (ports ascend A..D)
    out.tops.initial = top();
    // 2) group: time = newest member; members sorted desc
    await put([{ type: "group", id: "g1", name: "G", collapsed: false, members: ["A", "D"] }]);
    await sleep(2500);
    out.tops.grouped = top();
    // 3) drag C (top-level) into g1 via synthetic drag events
    const drag = async (sid, targetSel) => {
      const el = list.querySelector('.session-item[data-sid="' + sid + '"]');
      el.dispatchEvent(new DragEvent("dragstart", { bubbles: true }));
      list.querySelector(targetSel).dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true }));
      el.dispatchEvent(new DragEvent("dragend", { bubbles: true }));
      await sleep(600);
    };
    await drag("C", ".group-body");
    out.tops.afterDragIn = top();
    out.persistedIn = await (await fetch("/api/hub-state")).json();
    // 4) drag C back out to top level
    await drag("C", ":scope > .session-item");
    out.tops.afterDragOut = top();
    out.persistedOut = await (await fetch("/api/hub-state")).json();
    // 5) a no-op drag (dropped where it started) must not reorder or break
    await drag("B", ":scope > .session-item");
    out.tops.afterNoop = top();
    // 6) empty group sorts first
    await put([{ type: "group", id: "g1", name: "G", collapsed: false, members: ["A", "D"] }, { type: "group", id: "gE", name: "E", collapsed: false, members: [] }]);
    await sleep(2500);
    out.tops.emptyGroup = top();
    return out;
  `);

  // 7) touching D's file moves it to the top after the next poll
  utimesSync(files.D, Date.now() / 1000, Date.now() / 1000);
  await sleep(3500); // page polls every 3s
  result.tops.afterTouchD = await page(cdp, `const l=document.getElementById("sessions-list")||document.querySelector("[id*=sessions]"); const ids=(r)=>[...r.querySelectorAll(":scope > .session-item")].map(e=>e.dataset.sid); return [...l.children].filter(c=>!c.classList.contains("sidebar-divider")).map(c=>c.classList.contains("group")?"g:"+c.dataset.gid+"["+ids(c.querySelector(".group-body")).join("")+"]":c.dataset.sid).join(",");`);

  const t = result.tops;
  const checks = {
    "initial: mtime order, not port": t.initial === "C,B,A,D,E,F",
    "group = newest member, members desc": t.grouped === "C,B,g:g1[AD],E,F",
    "drag C into group": t.afterDragIn === "g:g1[CAD],B,E,F" && JSON.stringify(result.persistedIn).includes('"members":["A","D","C"]'),
    "drag C out of group": t.afterDragOut === "C,B,g:g1[AD],E,F" && JSON.stringify(result.persistedOut.items.find((i) => i.id === "g1").members) === '["A","D"]',
    "age dividers: 2 days / 7 days / older": JSON.stringify(result.dividers) === '["Last 2 days","Last 7 days","Older"]',
    "no-op drag leaves order": t.afterNoop === t.afterDragOut,
    "empty group first": t.emptyGroup.startsWith("g:gE[]"),
    "touching D moves its group up": t.afterTouchD.includes("g:g1[DA]") && t.afterTouchD.indexOf("g:g1") < t.afterTouchD.indexOf("C"),
  };
  console.log(JSON.stringify({ tops: t, checks }, null, 2));
  const ok = Object.values(checks).every(Boolean);
  console.log(ok ? "VERDICT: PASS" : "VERDICT: FAIL");
  return ok;
}
main().then((ok) => { cleanup(); process.exit(ok ? 0 : 1); }).catch((e) => { console.error(e); cleanup(); process.exit(2); });
