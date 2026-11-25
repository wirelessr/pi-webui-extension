/**
 * Pure parsing/formatting helpers shared by the browser (chat.js) and the
 * Node side (helpers.js re-exports these). No DOM, no fs, no node:* imports,
 * so this module is safe to load in both environments.
 */

/**
 * Whether a transcript ends mid-turn — the agent stopped without delivering a
 * final answer (e.g. the model stream dropped after a thinking block or a tool
 * call). A normally-finished turn ends with the assistant's text response, so
 * an ending on assistant-thinking / a bare tool call, or on a tool result the
 * agent never wrapped up, means the turn was cut off. Callers pair this with an
 * idle (not-busy) session to show "interrupted" instead of "idle", so it's
 * clear nothing is still running.
 * @param {Array<{role?: string, text?: string}>} history
 * @returns {boolean}
 */
export function isTranscriptInterrupted(history) {
  if (!Array.isArray(history) || history.length === 0) return false;
  // Banners are appended after a run settles (an aborted run gets one too), so
  // they must not hide how the turn itself ended.
  let i = history.length - 1;
  while (i > 0 && isBannerEntry(history[i])) i--;
  const last = history[i];
  if (isBannerEntry(last)) return false;
  if (!last || typeof last !== "object") return false;
  if (last.role === "assistant" && typeof last.text === "string" && last.text.trim() !== "") return false;
  return last.role === "assistant" || last.role === "toolResult";
}

/**
 * Whether a history entry is an extension status banner (e.g. the
 * self-consistency-guard `scg-status` entry mapped by parseHistoryEntry).
 * @param {object} entry
 * @returns {boolean}
 */
export function isBannerEntry(entry) {
  return !!entry && entry.role === "system" && entry.banner === true;
}

/**
 * Reorder banners so none splits an assistant turn. A banner can be persisted
 * between an assistant tool call and its tool result (it is written when the
 * check finishes, possibly while the next run is busy). One that arrives while
 * a turn is open moves to where that turn closes: just before the next user or
 * non-banner system entry, or the end. Everything else keeps its order.
 * @param {Array<object>} history
 * @returns {Array<object>}
 */
export function deferBanners(history) {
  if (!Array.isArray(history)) return [];
  const out = [];
  let held = [];
  let open = false;
  for (const e of history) {
    if (isBannerEntry(e)) {
      if (open) held.push(e);
      else out.push(e);
      continue;
    }
    if (e?.role === "user" || e?.role === "system") {
      out.push(...held);
      held = [];
      open = false;
    } else if (e?.role === "assistant") {
      open = true;
    }
    out.push(e);
  }
  out.push(...held);
  return out;
}

/**
 * Decide whether an idle page should reload history for a changed historyRev
 * (bumped when an extension appends a banner after the stream closed). A
 * change seen while the session or the page is busy must NOT be consumed:
 * it stays pending until a later idle poll reloads, otherwise that banner
 * would never appear live.
 * @param {number|null} lastRev — rev the page last rendered (null = first poll)
 * @param {number|null|undefined} rev — rev from /api/status
 * @param {boolean} busy — session busy or page streaming
 * @returns {{reload: boolean, nextRev: number|null}}
 */
export function historyRevDecision(lastRev, rev, busy) {
  if (rev == null) return { reload: false, nextRev: lastRev };
  if (lastRev == null) return { reload: false, nextRev: rev };
  if (rev === lastRev) return { reload: false, nextRev: lastRev };
  if (busy) return { reload: false, nextRev: lastRev };
  return { reload: true, nextRev: rev };
}

/** History entries to fetch for the "interrupted" pill: enough to look past trailing banners (up to 2 per run). */
export const INTERRUPTED_PROBE_LIMIT = 10;

/**
 * Detect if a tool call is a read of a SKILL.md file.
 * @param {string} toolName
 * @param {object} args — tool call arguments
 * @returns {string|null} the file path if it's a SKILL.md read, null otherwise
 */
export function isSkillRead(toolName, args) {
  if (toolName !== "read") return null;
  const filePath = args?.file_path || args?.path;
  if (!filePath?.endsWith("SKILL.md")) return null;
  return filePath;
}

/**
 * Parse SKILL.md frontmatter to extract skill name and body content.
 * @param {string} text — raw SKILL.md file content
 * @returns {{name: string, content: string} | null}
 */
export function parseSkillFrontmatter(text) {
  if (!text) return null;
  const match = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]+)$/);
  if (!match) return null;
  const nameMatch = match[1].match(/^name:\s*(\S+)/m);
  if (!nameMatch) return null;
  return { name: nameMatch[1], content: match[2].trim() };
}

/**
 * Parse a skill block from user message text.
 * Matches pi's format: <skill name="..." location="...">...</skill>
 * @param {string} text — user message text
 * @returns {{name: string, location: string, content: string, userMessage: string|undefined} | null}
 */
export function parseSkillBlock(text) {
  const match = text.match(/^<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+))?$/);
  if (!match) return null;
  return {
    name: match[1],
    location: match[2],
    content: match[3],
    userMessage: match[4]?.trim() || undefined,
  };
}

/**
 * Determine subagent result status.
 * @param {{exitCode: number, stopReason?: string}} result
 * @returns {"running"|"done"|"error"}
 */
export function subagentStatus(result) {
  const code = result.exitCode ?? 0;
  if (code === -1) return "running";
  if (code !== 0 || result.stopReason === "error" || result.stopReason === "aborted") return "error";
  return "done";
}

/**
 * Extract subagent view descriptors from a tool result's details.
 * Handles single/parallel/chain modes.
 * @param {string} toolCallId — parent tool call id
 * @param {object} details — { mode, results: [...] }
 * @returns {Array<{id: string, agent: string, task: string, status: string, usage: object, model: string, messages: Array}>}
 */
export function extractSubagentViews(toolCallId, details) {
  if (!details?.results) return [];
  return details.results.map((r, i) => ({
    id: `${toolCallId}-${i}`,
    agent: r.agent || "unknown",
    task: r.task || "",
    status: subagentStatus(r),
    usage: r.usage || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
    model: r.model || "",
    messages: r.messages || [],
  }));
}

/**
 * Convert a subagent's internal messages array into history entries
 * compatible with parseHistoryLine output. This allows loadHistory-style
 * rendering without duplicating the rendering logic.
 * @param {Array} messages — subagent's Message[] array
 * @returns {Array} history entries (same format as parseHistoryLine)
 */
export function parseSubagentMessages(messages) {
  if (!Array.isArray(messages)) return [];
  const entries = [];
  for (const msg of messages) {
    const role = msg.role;
    const content = msg.content;
    const entry = { role };

    if (typeof content === "string") {
      entry.text = content;
    } else if (Array.isArray(content)) {
      const texts = [];
      const toolCalls = [];
      const thinking = [];
      for (const part of content) {
        if (part.type === "text" && part.text) {
          texts.push(part.text);
        } else if (part.type === "thinking" && part.thinking) {
          thinking.push(part.thinking);
        } else if (part.type === "toolCall") {
          toolCalls.push({ id: part.id, name: part.name, arguments: part.arguments });
        }
      }
      if (texts.length) entry.text = texts.join("");
      if (thinking.length) entry.thinking = thinking.join("");
      if (toolCalls.length) entry.toolCalls = toolCalls;
    }

    if (role === "toolResult") {
      entry.toolCallId = msg.toolCallId;
      entry.toolName = msg.toolName;
      entry.isError = msg.isError;
      if (Array.isArray(content)) {
        entry.text = content.map((c) => c.text || "").join("");
      } else if (typeof content === "string") {
        entry.text = content;
      }
    }

    if (entry.text || entry.toolCalls || entry.thinking) {
      entries.push(entry);
    }
  }
  return entries;
}
