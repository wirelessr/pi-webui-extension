/**
 * pi WebUI Telegram bot — drives pi sessions through the hub from one
 * authorized chat. Long polling (no public endpoint). Talks only to the hub's
 * HTTP API; it never touches a session's bridge directly.
 *
 * Env:
 *   TELEGRAM_BOT_TOKEN  bot token (required)
 *   TELEGRAM_CHAT_ID    the only chat/user the bot obeys (required)
 *   PI_HUB_URL          hub base URL (default http://127.0.0.1:8730)
 *   PI_BRIDGE_DIR       where telegram-state.json lives (same dir the hub uses)
 *   TELEGRAM_NOTIFY     "selected" (default) or "all": which sessions push a
 *                       completion message for turns not started from Telegram
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parseSseBuffer } from "@wirelessr/pi-webui-components/sse-parser.js";
import {
  buildSessionKeyboard,
  findSessionByPid,
  isAuthorized,
  lastAssistantText,
  normalizeState,
  parseCommand,
  sessionLabel,
  sessionTag,
  splitMessage,
} from "./telegram-helpers.js";
import { markdownToTelegramHtml, splitMarkdown } from "./telegram-markdown.js";
import { createTurnReporter } from "./turn-reporter.js";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const HUB = new URL(process.env.PI_HUB_URL || "http://127.0.0.1:8730");
const API_BASE = process.env.TELEGRAM_API_BASE || "https://api.telegram.org"; // overridable for tests
const NOTIFY = process.env.TELEGRAM_NOTIFY === "all" ? "all" : "selected";
const BRIDGE_DIR =
  process.env.PI_BRIDGE_DIR || join(homedir(), ".pi", "agent", "extensions", "pi-webui-extension", "data");
const STATE_PATH = join(BRIDGE_DIR, "telegram-state.json");
// A turn we streamed ourselves is reported on its own stream; the hub's
// session_done for it arrives up to a poll later and must not repeat it.
const DUP_WINDOW_MS = 15000;

if (!TOKEN || !CHAT_ID) {
  console.error("[telegram] TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are required");
  process.exit(1);
}

const log = (...a) => console.log(new Date().toISOString(), "[telegram]", ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── State ──

let state = (() => {
  try {
    return normalizeState(JSON.parse(readFileSync(STATE_PATH, "utf-8")));
  } catch {
    return normalizeState(null);
  }
})();

function saveState() {
  try {
    mkdirSync(dirname(STATE_PATH), { recursive: true });
    const tmp = `${STATE_PATH}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(state));
    renameSync(tmp, STATE_PATH);
  } catch (err) {
    log("state save failed:", err.message);
  }
}

function select(sessionId) {
  state = { selected: sessionId };
  saveState();
}

const inflight = new Set(); // sessionIds with a Telegram-initiated prompt stream open
const deliveredAt = new Map(); // sessionId -> ms of the last turn we delivered ourselves

// ── Telegram Bot API ──

async function tg(method, params = {}, timeoutMs = 20000) {
  const res = await fetch(`${API_BASE}/bot${TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) {
    const err = new Error(`telegram ${method}: ${data.description || res.status}`);
    err.code = data.error_code || res.status;
    throw err;
  }
  return data.result;
}

// Bot-authored messages (menus, status, errors) are plain text: no escaping hazards.
async function send(text, extra = {}) {
  const chunks = splitMessage(text || "(empty)");
  for (let i = 0; i < chunks.length; i++) {
    const last = i === chunks.length - 1;
    await tg("sendMessage", { chat_id: CHAT_ID, text: chunks[i], ...(last ? extra : {}) }).catch((err) =>
      log("send failed:", err.message),
    );
  }
}

// Agent output is Markdown. Render it as Telegram HTML; if Telegram rejects a
// chunk (invalid nesting, too long after escaping), resend that chunk as plain text.
async function sendAgent(text) {
  for (const chunk of splitMarkdown(text || "(empty)")) {
    try {
      await tg("sendMessage", { chat_id: CHAT_ID, text: markdownToTelegramHtml(chunk), parse_mode: "HTML" });
    } catch (err) {
      log("html send failed, resending plain:", err.message);
      await send(chunk);
    }
  }
}

// Per-turn output: strictly ordered sends, with tool-progress edits throttled
// (Telegram rate-limits edits) and flushed before the next text block so the
// chat reads chronologically.
const EDIT_INTERVAL_MS = 1500;
function createTurnOutput() {
  let chain = Promise.resolve();
  const enqueue = (fn) => {
    chain = chain.then(fn).catch((err) => log("turn output failed:", err.message));
    return chain;
  };
  const messageIds = new Map(); // progress group -> telegram message_id
  const latest = new Map(); // progress group -> text not yet sent
  let timer = null;
  let lastEdit = 0;

  function flushProgress() {
    clearTimeout(timer);
    timer = null;
    if (latest.size > 0) lastEdit = Date.now();
    for (const [group, text] of latest) {
      enqueue(async () => {
        const id = messageIds.get(group);
        if (id === undefined) {
          const m = await tg("sendMessage", { chat_id: CHAT_ID, text });
          messageIds.set(group, m.message_id);
        } else {
          await tg("editMessageText", { chat_id: CHAT_ID, message_id: id, text }).catch((err) => {
            if (!/not modified/i.test(err.message)) throw err;
          });
        }
      });
    }
    latest.clear();
  }

  return {
    apply(actions) {
      for (const a of actions) {
        if (a.kind === "progress") {
          latest.set(a.group, a.text);
          if (!timer) timer = setTimeout(flushProgress, Math.max(0, EDIT_INTERVAL_MS - (Date.now() - lastEdit)));
        } else {
          flushProgress();
          enqueue(() => (a.kind === "text" ? sendAgent(a.text) : send(a.text)));
        }
      }
    },
    drain() {
      flushProgress();
      return chain;
    },
  };
}

// ── Hub HTTP ──

async function hubJson(path, { method = "GET", body, timeoutMs = 10000 } = {}) {
  const res = await fetch(new URL(path, HUB), {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `hub ${path}: HTTP ${res.status}`);
  return data;
}

// SSE over node:http: fetch (undici) enforces a 5 min body timeout, which a long
// quiet tool call would trip. node:http has no such default.
function hubSse(path, { method = "GET", body, onEvent }) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = httpRequest(
      {
        host: HUB.hostname,
        port: HUB.port,
        path,
        method,
        headers: {
          Accept: "text/event-stream",
          ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        if (res.statusCode !== 200) {
          let raw = "";
          res.on("data", (c) => {
            raw += c;
          });
          res.on("end", () => {
            let msg = `HTTP ${res.statusCode}`;
            try {
              msg = JSON.parse(raw).error || msg;
            } catch {}
            reject(new Error(msg));
          });
          return;
        }
        let buf = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          buf += chunk;
          const { events, rest } = parseSseBuffer(buf);
          buf = rest;
          for (const ev of events) onEvent(ev);
        });
        res.on("end", resolve);
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const listSessions = async () => (await hubJson("/api/sessions")).sessions;

// The selected session if still alive. With nothing selected and exactly one
// session running, that one is picked up automatically.
async function currentSession() {
  const sessions = await listSessions();
  let s = sessions.find((x) => x.sessionId === state.selected);
  if (!s && sessions.length === 1) {
    s = sessions[0];
    select(s.sessionId);
  }
  return s ?? null;
}

// ── Turns ──

async function runTurn(session, text) {
  const id = session.sessionId;
  inflight.add(id);
  const typing = setInterval(() => tg("sendChatAction", { chat_id: CHAT_ID, action: "typing" }).catch(() => {}), 4000);
  tg("sendChatAction", { chat_id: CHAT_ID, action: "typing" }).catch(() => {});
  const reporter = createTurnReporter(sessionTag(session));
  const out = createTurnOutput();
  let finished = false;
  try {
    await hubSse(`/s/${encodeURIComponent(id)}/api/prompt`, {
      method: "POST",
      body: { message: text },
      onEvent: (ev) => {
        if (ev.type === "done" || ev.type === "error") finished = true;
        if (ev.type === "done") deliveredAt.set(id, Date.now());
        out.apply(reporter.push(ev));
      },
    });
    if (!finished) send(`[${sessionTag(session)}] The stream closed before the turn finished. You will be notified when it completes.`);
  } catch (err) {
    send(`[${sessionTag(session)}] prompt failed: ${err.message}`);
  } finally {
    await out.drain();
    clearInterval(typing);
    inflight.delete(id);
  }
}

async function handleText(text) {
  const session = await currentSession();
  if (!session) return send("No session selected. Use /sessions to pick one or /new to start one.");
  const id = encodeURIComponent(session.sessionId);
  const busy = inflight.has(session.sessionId) || (await hubJson(`/s/${id}/api/status`)).busy;
  if (busy) {
    await hubJson(`/s/${id}/api/steer`, { method: "POST", body: { message: text } });
    return send(`[${sessionTag(session)}] Injected into the running turn.`);
  }
  runTurn(session, text); // not awaited: the poll loop must stay free for /stop
}

// ── Commands ──

async function showSessions() {
  const sessions = await listSessions();
  if (sessions.length === 0) return send("No live sessions. Use /new to start one.");
  return send("Sessions (tap to select):", { reply_markup: buildSessionKeyboard(sessions, state.selected) });
}

async function newSession(arg) {
  const cwd = arg ? arg.replace(/^~(?=$|\/)/, homedir()) : undefined;
  const { pid } = await hubJson("/api/new-session", { method: "POST", body: { cwd } });
  for (let i = 0; i < 40; i++) {
    const s = findSessionByPid(await listSessions(), pid);
    if (s) {
      select(s.sessionId);
      return send(`Started and selected: ${sessionLabel(s)}`);
    }
    await sleep(500);
  }
  return send(`Spawned pid ${pid} but it has not registered yet. Check /sessions in a moment.`);
}

async function withSession(fn) {
  const session = await currentSession();
  if (!session) return send("No session selected. Use /sessions first.");
  return fn(session, encodeURIComponent(session.sessionId));
}

const COMMANDS = {
  start: () => send("Commands: /sessions /new [cwd] /status /stop /rename <name> /kill"),
  help: () => COMMANDS.start(),
  sessions: showSessions,
  new: (args) => newSession(args),
  stop: () =>
    withSession(async (_s, id) => {
      await hubJson(`/s/${id}/api/abort`, { method: "POST" });
      return send("Abort sent.");
    }),
  status: () =>
    withSession(async (s, id) => {
      const st = await hubJson(`/s/${id}/api/status`);
      const pct = st.context?.percent == null ? "?" : `${Math.round(st.context.percent)}%`;
      return send(`${sessionLabel({ ...s, busy: st.busy })}\nmodel: ${st.model ?? "?"}\ncontext: ${pct}\ncwd: ${st.cwd}`);
    }),
  rename: (args) =>
    withSession(async (_s, id) => {
      if (!args) return send("Usage: /rename <name>");
      await hubJson(`/s/${id}/api/rename-session`, { method: "POST", body: { name: args } });
      return send(`Renamed to: ${args}`);
    }),
  kill: () =>
    withSession((s) =>
      send(`Terminate ${sessionLabel(s)}?`, {
        reply_markup: { inline_keyboard: [[{ text: "Confirm kill", callback_data: `kill:${s.sessionId}` }]] },
      }),
    ),
};

async function handleCallback(cb) {
  tg("answerCallbackQuery", { callback_query_id: cb.id }).catch(() => {});
  const [action, sessionId] = [cb.data.slice(0, cb.data.indexOf(":")), cb.data.slice(cb.data.indexOf(":") + 1)];
  const s = (await listSessions()).find((x) => x.sessionId === sessionId);
  if (!s) return send("That session is no longer running.");
  if (action === "sel") {
    select(sessionId);
    return send(`Selected: ${sessionLabel(s)}`);
  }
  if (action === "kill") {
    await hubJson(`/s/${encodeURIComponent(sessionId)}/api/kill-session`, { method: "POST", body: { pid: s.pid } });
    if (state.selected === sessionId) select(null);
    return send(`Terminated: ${sessionLabel(s)}`);
  }
}

async function handleUpdate(update) {
  if (!isAuthorized(update, CHAT_ID)) {
    // Silent to the sender (do not reveal the bot), but visible in our log.
    const m = update.message ?? update.callback_query?.message;
    const from = update.message?.from ?? update.callback_query?.from;
    log(`ignored update from chat=${m?.chat?.id} user=${from?.id} (expected ${CHAT_ID})`);
    return;
  }
  try {
    if (update.callback_query) return await handleCallback(update.callback_query);
    const text = update.message?.text;
    if (!text) return;
    const cmd = parseCommand(text);
    if (!cmd) return await handleText(text);
    const fn = COMMANDS[cmd.cmd];
    return await (fn ? fn(cmd.args) : send(`Unknown command /${cmd.cmd}. Try /help.`));
  } catch (err) {
    await send(`error: ${err.message}`);
  }
}

// ── Completion notifications (turns not started from here, e.g. the web UI) ──

async function onSessionDone(ev) {
  if (NOTIFY === "selected" && ev.sessionId !== state.selected) return;
  if (inflight.has(ev.sessionId)) return;
  if (Date.now() - (deliveredAt.get(ev.sessionId) ?? 0) < DUP_WINDOW_MS) return;
  const { history } = await hubJson(`/s/${encodeURIComponent(ev.sessionId)}/api/history?limit=20`);
  await sendAgent(`[${sessionTag(ev)}] done\n\n${lastAssistantText(history) ?? "(no text reply)"}`);
}

async function watchEvents() {
  for (;;) {
    try {
      await hubSse("/api/events", {
        onEvent: (ev) => {
          if (ev.type === "session_done") onSessionDone(ev).catch((err) => log("notify failed:", err.message));
        },
      });
    } catch (err) {
      log("events stream error:", err.message);
    }
    await sleep(3000);
  }
}

// ── Long polling ──

async function pollLoop() {
  let offset = 0;
  for (;;) {
    try {
      const updates = await tg("getUpdates", { offset, timeout: 50, allowed_updates: ["message", "callback_query"] }, 65000);
      for (const u of updates) {
        offset = u.update_id + 1;
        await handleUpdate(u);
      }
    } catch (err) {
      // 409 = another poller holds this token; back off longer.
      log("poll error:", err.message);
      await sleep(err.code === 409 ? 10000 : 2000);
    }
  }
}

const me = await tg("getMe");
await tg("setMyCommands", {
  commands: [
    { command: "sessions", description: "List and select a session" },
    { command: "new", description: "Start a new session [cwd]" },
    { command: "status", description: "Selected session status" },
    { command: "stop", description: "Abort the running turn" },
    { command: "rename", description: "Rename the selected session" },
    { command: "kill", description: "Terminate the selected session" },
  ],
}).catch((err) => log("setMyCommands failed:", err.message));
log(`started as @${me.username}, hub ${HUB.origin}, notify=${NOTIFY}`);
watchEvents();
pollLoop();
