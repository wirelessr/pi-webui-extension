/**
 * Turns the prompt SSE stream into Telegram-sized actions. Pure state machine:
 * the shared stream accumulator tracks text and tools, this decides what to
 * send and when. server.js performs the actual sends and throttles edits.
 *
 * Actions:
 *   {kind:"text", text}               a completed assistant text block (Markdown)
 *   {kind:"progress", group, text}    tool list for one group; same group = edit in place
 *   {kind:"error", text}              turn failed (plain text)
 *
 * A "group" is the run of tool calls between two text blocks, so messages stay
 * in chronological order: tools, text, tools, text...
 */

import { createStreamAccumulator } from "@wirelessr/pi-webui-components/stream-accumulator.js";
import { formatDone } from "./telegram-helpers.js";

const MAX_TOOL_LINES = 12;
const MAX_ARG_CHARS = 80;
const ARG_KEYS = ["command", "path", "file_path", "query", "pattern", "url"];

/**
 * One-line description of a tool call's arguments.
 * @param {object|null|undefined} args
 * @returns {string}
 */
export function toolSummary(args) {
  if (args == null) return "";
  let raw;
  if (typeof args === "string") raw = args;
  else {
    const key = ARG_KEYS.find((k) => typeof args[k] === "string");
    raw = key ? args[key] : JSON.stringify(args);
  }
  const one = raw.replace(/\s+/g, " ").trim();
  return one.length > MAX_ARG_CHARS ? `${one.slice(0, MAX_ARG_CHARS - 1)}\u2026` : one;
}

const MARK = { running: "[run]", done: "[ok]", error: "[err]" };

/**
 * @param {string} tag — session display name
 * @param {Array<{toolName: string, args: object|null, status: string}>} tools
 * @returns {string}
 */
export function renderProgress(tag, tools) {
  const hidden = Math.max(0, tools.length - MAX_TOOL_LINES);
  const lines = tools.slice(hidden).map((t) => {
    const arg = toolSummary(t.args);
    return `${MARK[t.status]} ${t.toolName}${arg ? `: ${arg}` : ""}`;
  });
  if (hidden > 0) lines.unshift(`(${hidden} earlier)`);
  return `[${tag}]\n${lines.join("\n")}`;
}

/**
 * @param {string} tag — session display name, shown on the first message of the turn
 */
export function createTurnReporter(tag) {
  const acc = createStreamAccumulator();
  let sentLen = 0;
  let group = 0;
  let groupTools = [];
  let emitted = false; // any message produced yet (it carries the [tag] header)
  let sentText = false;

  const withTag = (text) => (emitted ? text : `[${tag}]\n${text}`);

  /** @param {object} event — one parsed SSE event; returns the actions it caused */
  function push(event) {
    acc.handleEvent(event);
    const actions = [];

    if (event.type === "error") {
      actions.push({ kind: "error", text: `[${tag}] error: ${event.message ?? "Unknown error"}` });
      return actions;
    }

    const committed = acc.getState().committedText;
    if (committed.length > sentLen) {
      const text = committed.slice(sentLen);
      sentLen = committed.length;
      if (text.trim()) {
        actions.push({ kind: "text", text: withTag(text) });
        emitted = true;
        sentText = true;
      }
      group++;
      groupTools = [];
    }

    if (event.type === "tool_execution_start") groupTools.push(event.toolCallId);
    // An end for a tool from an earlier group has nothing to update here.
    const touchesGroup =
      event.type === "tool_execution_start" ||
      (event.type === "tool_execution_end" && groupTools.includes(event.toolCallId));
    if (touchesGroup) {
      actions.push({ kind: "progress", group, text: renderProgress(tag, groupTools.map((id) => acc.getTool(id))) });
      emitted = true;
    }

    if (event.type === "done" && !sentText) {
      actions.push({ kind: "text", text: withTag(formatDone(event)) });
      emitted = true;
    }
    return actions;
  }

  return { push };
}
