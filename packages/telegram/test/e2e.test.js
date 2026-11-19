/**
 * End-to-end: the real bot process + the real hub process, with a mock Telegram
 * Bot API and a stub session bridge standing in for pi (so no model is needed).
 * Everything is isolated: own bridge dir, ephemeral ports, loopback only.
 *
 * Not covered: /new (the hub spawns a real `pi` for it).
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BOT = join(HERE, "..", "src", "server.js");
const HUB = join(HERE, "..", "..", "hub", "src", "server.js");
const CHAT = 42;
const SESSION_ID = "11111111-aaaa-bbbb-cccc-000000000001";
const BRIDGE_PID = 4242;

const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
const freePort = async () => {
  const probe = createServer();
  const port = await listen(probe);
  await new Promise((r) => probe.close(r));
  return port;
};
const readBody = (req) =>
  new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    });
  });
const sendJson = (res, obj, code = 200) => {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
};

/** Resolve once check() returns a truthy value; reject on timeout. No fixed sleeps in assertions. */
async function until(check, what, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

// ── Mock Telegram Bot API ──

function createMockTelegram() {
  const calls = []; // {method, params}
  const queue = [];
  let nextUpdateId = 1;
  let nextMessageId = 100;
  const server = createServer(async (req, res) => {
    const method = req.url.split("/").pop();
    const params = await readBody(req);
    const ok = (result) => sendJson(res, { ok: true, result });
    if (method === "getUpdates") {
      const deadline = Date.now() + 400;
      while (queue.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
      return ok(queue.splice(0));
    }
    calls.push({ method, params });
    if (method === "getMe") return ok({ username: "e2e_bot" });
    if (method === "sendMessage" || method === "editMessageText") {
      // Telegram rejects malformed HTML; emulate that for the fallback test.
      if (params.parse_mode === "HTML" && params.text.includes("MALFORMED")) {
        return sendJson(res, { ok: false, error_code: 400, description: "can't parse entities" }, 400);
      }
      return ok({ message_id: nextMessageId++ });
    }
    return ok(true);
  });
  const push = (update) => queue.push({ update_id: nextUpdateId++, ...update });
  return {
    server,
    calls,
    say: (text, from = CHAT, chat = CHAT) => push({ message: { chat: { id: chat }, from: { id: from }, text } }),
    tap: (data) => push({ callback_query: { id: `cb${nextUpdateId}`, data, from: { id: CHAT }, message: { chat: { id: CHAT } } } }),
    messages: (since = 0) => calls.slice(since).filter((c) => c.method === "sendMessage" || c.method === "editMessageText"),
    mark: () => calls.length,
  };
}

// ── Stub pi session bridge (only the endpoints the bot uses, through the hub) ──

function createStubBridge() {
  const s = {
    busy: false,
    prompts: [],
    steers: [],
    aborts: 0,
    renames: [],
    kills: [],
    history: [],
    script: null, // (emit) => Promise<void>, set per test
  };
  s.server = createServer(async (req, res) => {
    const path = req.url.split("?")[0];
    if (path === "/api/status") return sendJson(res, { busy: s.busy, model: "stub/model", cwd: "/work/proj", context: { percent: 12.4 } });
    if (path === "/api/history") return sendJson(res, { history: s.history });
    if (path === "/api/steer") {
      s.steers.push(await readBody(req));
      return sendJson(res, { ok: true });
    }
    if (path === "/api/abort") {
      s.aborts++;
      return sendJson(res, { ok: true });
    }
    if (path === "/api/rename-session") {
      const b = await readBody(req);
      s.renames.push(b.name);
      return sendJson(res, { ok: true, name: b.name });
    }
    if (path === "/api/kill-session") {
      const b = await readBody(req);
      s.kills.push(b.pid);
      return sendJson(res, { ok: true, pid: b.pid });
    }
    if (path === "/api/prompt") {
      s.prompts.push(await readBody(req));
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const emit = (ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`);
      s.busy = true;
      await s.script(emit);
      s.busy = false;
      return res.end();
    }
    sendJson(res, { error: "not found" }, 404);
  });
  return s;
}

const textBlock = (emit, text) => {
  emit({ type: "text_start" });
  emit({ type: "text_delta", delta: text });
  emit({ type: "text_end" });
};

describe("telegram bot e2e (real bot + real hub, mock Telegram, stub bridge)", () => {
  let dir;
  let tg;
  let bridge;
  let hub;
  let bot;
  let hubUrl;
  let bridgePort;
  const children = [];

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "tg-e2e-"));
    tg = createMockTelegram();
    bridge = createStubBridge();
    const tgPort = await listen(tg.server);
    bridgePort = await listen(bridge.server);

    // Discovery file the hub reads. piPid must be alive: use this test process.
    writeFileSync(
      join(dir, "s1.json"),
      JSON.stringify({
        sessionId: SESSION_ID,
        sessionName: "alpha",
        port: bridgePort,
        pid: BRIDGE_PID,
        piPid: process.pid,
        cwd: "/work/proj",
        startedAt: Date.now(),
      }),
    );

    const hubPort = await freePort();
    hubUrl = `http://127.0.0.1:${hubPort}`;
    hub = spawn(process.execPath, [HUB], {
      env: { ...process.env, PI_HUB_PORT: String(hubPort), PI_HUB_HOST: "127.0.0.1", PI_BRIDGE_DIR: dir },
      stdio: ["ignore", "pipe", "inherit"],
    });
    children.push(hub);
    await new Promise((resolve, reject) => {
      hub.once("exit", (c) => reject(new Error(`hub exited early (${c})`)));
      hub.stdout.on("data", (d) => String(d).includes("listening") && resolve());
    });

    bot = spawn(process.execPath, [BOT], {
      env: {
        ...process.env,
        TELEGRAM_BOT_TOKEN: "e2e-token",
        TELEGRAM_CHAT_ID: String(CHAT),
        TELEGRAM_API_BASE: `http://127.0.0.1:${tgPort}`,
        PI_HUB_URL: hubUrl,
        PI_BRIDGE_DIR: dir,
      },
      stdio: ["ignore", "inherit", "inherit"],
    });
    children.push(bot);
    await until(() => tg.calls.some((c) => c.method === "setMyCommands"), "bot startup");

    // Every later test assumes the session is selected.
    tg.tap(`sel:${SESSION_ID}`);
    await until(() => tg.messages().some((m) => /Selected: alpha/.test(m.params.text)), "session selection");
  });

  after(() => {
    for (const c of children) c.kill("SIGKILL");
    for (const s of [tg?.server, bridge?.server]) s?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("updates from any other chat or sender are ignored", async () => {
    const mark = tg.mark();
    tg.say("/status", 999, 999); // stranger in their own chat
    tg.say("/status", 999, CHAT); // stranger inside the authorized chat (group case)
    tg.say("/status"); // authorized: also the sync point, since updates are handled in order
    await until(() => tg.messages(mark).length >= 1, "status reply");
    const replies = tg.messages(mark);
    assert.equal(replies.length, 1);
    assert.match(replies[0].params.text, /model: stub\/model/);
    assert.match(replies[0].params.text, /context: 12%/);
  });

  test("/sessions lists live sessions with a select button", async () => {
    const mark = tg.mark();
    tg.say("/sessions");
    const m = await until(() => tg.messages(mark)[0], "session list");
    const [[button]] = m.params.reply_markup.inline_keyboard;
    assert.equal(button.callback_data, `sel:${SESSION_ID}`);
    assert.match(button.text, /^\* alpha/); // current one is marked
  });

  test("a prompt streams tool progress then text, in order, with Markdown rendered", async () => {
    bridge.script = async (emit) => {
      emit({ type: "agent_start" });
      emit({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "ls /tmp" } });
      emit({ type: "tool_execution_end", toolCallId: "t1", isError: false });
      textBlock(emit, "Found **3** files in `/tmp`");
      emit({ type: "done", text: "Found **3** files in `/tmp`", toolCalls: ["bash"] });
    };
    const mark = tg.mark();
    tg.say("list tmp");
    await until(() => tg.messages(mark).some((m) => m.params.parse_mode === "HTML"), "final text");
    assert.deepEqual(bridge.prompts.at(-1), { message: "list tmp" });

    const msgs = tg.messages(mark);
    const progress = msgs.find((m) => m.params.text.includes("[run]") || m.params.text.includes("[ok]"));
    const text = msgs.find((m) => m.params.parse_mode === "HTML");
    assert.ok(progress, "tool progress message");
    assert.match(progress.params.text, /^\[alpha\]\n\[(run|ok)\] bash: ls \/tmp/);
    assert.equal(text.params.text, "Found <b>3</b> files in <code>/tmp</code>");
    assert.ok(msgs.indexOf(progress) < msgs.indexOf(text), "progress precedes the text");
    // The tool's final [ok] state is applied before the text, via an edit of the same message.
    const lastProgress = msgs.filter((m) => m.params.text.startsWith("[alpha]\n[")).at(-1);
    assert.match(lastProgress.params.text, /\[ok\] bash/);
  });

  test("text Telegram rejects as malformed HTML is resent as plain text", async () => {
    bridge.script = async (emit) => {
      textBlock(emit, "MALFORMED **x");
      emit({ type: "done", text: "MALFORMED **x" });
    };
    const mark = tg.mark();
    tg.say("go");
    await until(() => tg.messages(mark).some((m) => !m.params.parse_mode && m.params.text.includes("MALFORMED")), "plain fallback");
    const attempts = tg.messages(mark).filter((m) => m.params.text.includes("MALFORMED"));
    assert.equal(attempts[0].params.parse_mode, "HTML");
    assert.equal(attempts[1].params.parse_mode, undefined);
    assert.equal(attempts[1].params.text, "[alpha]\nMALFORMED **x");
  });

  test("a message to a busy session is steered, not sent as a new prompt", async () => {
    bridge.busy = true;
    const prompts = bridge.prompts.length;
    const mark = tg.mark();
    tg.say("also check hidden files");
    const m = await until(() => tg.messages(mark)[0], "steer ack");
    assert.match(m.params.text, /Injected into the running turn/);
    assert.deepEqual(bridge.steers.at(-1), { message: "also check hidden files" });
    assert.equal(bridge.prompts.length, prompts);
    bridge.busy = false;
  });

  test("/stop aborts and /rename renames the selected session", async () => {
    const mark = tg.mark();
    tg.say("/stop");
    tg.say("/rename shiny new name");
    await until(() => tg.messages(mark).length >= 2, "replies");
    assert.equal(bridge.aborts, 1);
    assert.deepEqual(bridge.renames, ["shiny new name"]);
  });

  test("a turn finished elsewhere (web UI) notifies for the selected session only", async () => {
    // Fresh sessions: alpha just delivered a turn itself, which (by design) suppresses its own
    // completion event for a short window. All sessions share the stub bridge, so they flip
    // busy->idle together; only the selected one (beta) may notify. gamma's file sorts first so
    // its event is handled before beta's: a wrongly sent gamma notification shows up in time.
    const extra = (file, sessionId, sessionName, pid) =>
      writeFileSync(
        join(dir, file),
        JSON.stringify({ sessionId, sessionName, port: bridgePort, pid, piPid: process.pid, cwd: "/work/other", startedAt: Date.now() }),
      );
    extra("s2.json", "gamma-id", "gamma", BRIDGE_PID + 2);
    extra("s3.json", "beta-id", "beta", BRIDGE_PID + 1);
    tg.tap("sel:beta-id");
    await until(() => tg.messages().some((m) => /Selected: beta/.test(m.params.text)), "beta selection");

    // The hub learns "busy then idle" by polling the bridge; wait until it has seen busy.
    bridge.busy = true;
    await until(async () => {
      const { sessions } = await (await fetch(`${hubUrl}/api/sessions`)).json();
      return sessions.filter((s) => s.busy === true).length === 3;
    }, "hub to observe busy");
    bridge.history = [
      { role: "user", text: "question" },
      { role: "assistant", text: "first thought" },
      { role: "assistant", text: "the **final** answer" },
    ];
    const mark = tg.mark();
    bridge.busy = false;
    const m = await until(() => tg.messages(mark).find((x) => x.params.text.includes("done")), "completion notification");
    assert.equal(m.params.parse_mode, "HTML");
    assert.equal(m.params.text, "[beta] done\n\nthe <b>final</b> answer");
    assert.equal(tg.messages(mark).filter((x) => x.params.text.includes("done")).length, 1, "unselected sessions do not notify");

    tg.tap(`sel:${SESSION_ID}`); // later tests act on alpha
    await until(() => tg.messages(mark).some((x) => /Selected: alpha/.test(x.params.text)), "alpha reselection");
  });

  test("/kill asks for confirmation, then terminates the session by pid", async () => {
    const mark = tg.mark();
    tg.say("/kill");
    const ask = await until(() => tg.messages(mark)[0], "kill confirmation");
    assert.equal(bridge.kills.length, 0, "nothing is killed before confirming");
    const confirm = ask.params.reply_markup.inline_keyboard[0][0];
    assert.equal(confirm.callback_data, `kill:${SESSION_ID}`);

    tg.tap(confirm.callback_data);
    await until(() => tg.messages(mark).some((m) => /Terminated/.test(m.params.text)), "kill confirmation reply");
    assert.deepEqual(bridge.kills, [BRIDGE_PID]);
  });
});
