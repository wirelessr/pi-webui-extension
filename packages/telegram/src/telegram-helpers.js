/**
 * Pure helpers for the Telegram bot — no IO, unit-tested. server.js wires the
 * Telegram Bot API and the hub around these.
 */

export const MAX_MESSAGE = 4000; // Telegram caps at 4096; leave headroom.

/**
 * Authorize an update: the chat AND the sender must both be the configured id.
 * (A private chat id equals the user id; checking both keeps the bot inert if
 * it is ever added to a group.)
 * @param {object} update — Telegram update
 * @param {string} allowedId — TELEGRAM_CHAT_ID
 * @returns {boolean}
 */
export function isAuthorized(update, allowedId) {
  const allowed = String(allowedId ?? "");
  if (!allowed) return false;
  const msg = update?.message ?? update?.callback_query?.message;
  const from = update?.message?.from ?? update?.callback_query?.from;
  if (!msg || !from) return false;
  return String(msg.chat?.id) === allowed && String(from.id) === allowed;
}

/**
 * Split text into chunks no longer than max, preferring newline boundaries.
 * @param {string} text
 * @param {number} [max]
 * @returns {string[]}
 */
export function splitMessage(text, max = MAX_MESSAGE) {
  const out = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max / 2) cut = max; // no usable newline: hard cut
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest.length > 0) out.push(rest);
  return out;
}

/**
 * Parse a bot command such as `/new@MyBot ~/proj`.
 * @param {string} text
 * @returns {{cmd: string, args: string} | null} null when text is not a command
 */
export function parseCommand(text) {
  const m = (text ?? "").trim().match(/^\/([A-Za-z_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/);
  if (!m) return null;
  return { cmd: m[1].toLowerCase(), args: (m[2] ?? "").trim() };
}

/**
 * Display name: the session name, else a short id. Prefixes replies so it is
 * always clear which session spoke.
 * @param {{sessionId: string, sessionName?: string|null}} s
 * @returns {string}
 */
export function sessionTag(s) {
  return s.sessionName || s.sessionId.slice(0, 8);
}

/**
 * Short human label for a session.
 * @param {{sessionId: string, sessionName?: string|null, cwd?: string|null, busy?: boolean|null}} s
 * @returns {string}
 */
export function sessionLabel(s) {
  const name = sessionTag(s);
  const dir = s.cwd ? ` (${s.cwd.split("/").filter(Boolean).pop() ?? "/"})` : "";
  return `${s.busy ? "[busy] " : ""}${name}${dir}`;
}

/**
 * Inline keyboard for picking a session; the current one is marked.
 * @param {Array<object>} sessions
 * @param {string|null} currentId
 * @returns {{inline_keyboard: Array<Array<{text: string, callback_data: string}>>}}
 */
export function buildSessionKeyboard(sessions, currentId) {
  return {
    inline_keyboard: sessions.map((s) => [
      { text: `${s.sessionId === currentId ? "* " : ""}${sessionLabel(s)}`, callback_data: `sel:${s.sessionId}` },
    ]),
  };
}

/**
 * Text of the most recent assistant message that has any.
 * @param {Array<{role: string, text?: string}>} history
 * @returns {string|null}
 */
export function lastAssistantText(history) {
  for (let i = history.length - 1; i >= 0; i--) {
    const e = history[i];
    if (e.role === "assistant" && e.text?.trim()) return e.text;
  }
  return null;
}

/**
 * Message body for a finished turn (SSE `done` event).
 * @param {{text?: string, toolCalls?: string[]}} done
 * @returns {string}
 */
export function formatDone(done) {
  if (done.text?.trim()) return done.text;
  const n = done.toolCalls?.length ?? 0;
  return n > 0 ? `(no text reply; ${n} tool call${n === 1 ? "" : "s"})` : "(no text reply)";
}

/**
 * Find the session a just-spawned process became (matched by spawn pid).
 * @param {Array<{sessionId: string, pid: number}>} sessions
 * @param {number} pid
 * @returns {object|null}
 */
export function findSessionByPid(sessions, pid) {
  return sessions.find((s) => s.pid === pid) ?? null;
}

/**
 * Normalize persisted bot state. Unknown shapes collapse to the empty state.
 * @param {unknown} raw
 * @returns {{selected: string|null}}
 */
export function normalizeState(raw) {
  const sel = raw && typeof raw === "object" ? raw.selected : null;
  return { selected: typeof sel === "string" && sel ? sel : null };
}
