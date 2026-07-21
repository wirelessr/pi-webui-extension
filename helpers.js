import { join, normalize } from "node:path";

/**
 * Pure helper functions extracted from index.ts for testability.
 * No DOM, no fs, no side effects — pure input → output.
 */

/**
 * Extract text content from assistant messages.
 * @param {Array} messages — agent messages with role + content blocks
 * @returns {string} all text blocks joined by double newline
 */
export function extractText(messages) {
  const texts = [];
  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    const blocks = Array.isArray(msg.content) ? msg.content : [];
    for (const block of blocks) {
      if (block?.type === "text") texts.push(block.text);
    }
  }
  return texts.join("\n\n");
}

/**
 * Extract tool call summaries from assistant messages.
 * @param {Array} messages — agent messages with role + content blocks
 * @returns {string[]} formatted tool calls like "name({args...})"
 */
export function extractToolCalls(messages) {
  const calls = [];
  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    const blocks = Array.isArray(msg.content) ? msg.content : [];
    for (const block of blocks) {
      if (block?.type === "toolCall") {
        calls.push(`${block.name}(${JSON.stringify(block.arguments).slice(0, 200)})`);
      }
    }
  }
  return calls;
}

/**
 * Extract thinking content from assistant messages.
 * @param {Array} messages — agent messages with role + content blocks
 * @returns {string} all thinking blocks joined by double newline
 */
export function extractThinking(messages) {
  const parts = [];
  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    const blocks = Array.isArray(msg.content) ? msg.content : [];
    for (const block of blocks) {
      if (block?.type === "thinking") parts.push(block.thinking);
    }
  }
  return parts.join("\n\n");
}

/**
 * Parse a single JSONL line into a history entry, or null if not a message.
 * @param {string} line — raw JSONL line
 * @returns {object|null} history entry or null
 */
export function parseHistoryLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let obj;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return null;
  }
  return parseHistoryEntry(obj);
}

/**
 * Transform one already-parsed session entry (a JSONL line object, or a
 * SessionEntry from sessionManager.getBranch()) into a history entry.
 * @param {object} obj — session entry object
 * @returns {object|null} history entry or null
 */
export function parseHistoryEntry(obj) {
  if (obj.type !== "message") {
    // Compaction entries: show as a system message marker
    if (obj.type === "compaction" && obj.summary) {
      return {
        id: obj.id,
        timestamp: obj.timestamp,
        role: "system",
        text: `--- Compacted (${obj.tokensBefore ?? "?"} tokens before) ---\n\n${obj.summary}`,
      };
    }
    return null;
  }
  const msg = obj.message;
  if (!msg) return null;
  const role = msg.role;
  const content = msg.content;

  if (role === "system") return null;

  const entry = {
    id: obj.id,
    timestamp: obj.timestamp,
    role,
  };

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
        toolCalls.push({
          id: part.id,
          name: part.name,
          arguments: part.arguments,
        });
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
    if (msg.toolName === "subagent" && msg.details) {
      entry.subagentDetails = msg.details;
    }
  }

  if (!entry.text && !entry.toolCalls && !entry.thinking) return null;

  return entry;
}

/**
 * Transform an array of session entries (e.g. the active branch from
 * sessionManager.getBranch()) into history entries.
 * @param {Array<object>} entries — session entry objects
 * @returns {Array} parsed history entries
 */
export function parseHistoryEntries(entries) {
  const history = [];
  for (const obj of entries) {
    const entry = parseHistoryEntry(obj);
    if (entry) history.push(entry);
  }
  return history;
}

/**
 * Parse JSONL text into history entries.
 * @param {string} data — raw JSONL file content
 * @returns {Array} parsed history entries
 */
export function parseHistoryData(data) {
  const allHistory = [];
  for (const line of data.split("\n")) {
    const entry = parseHistoryLine(line);
    if (entry) allHistory.push(entry);
  }
  return allHistory;
}

/**
 * Apply cursor-based pagination to a history array.
 * offset counts from the tail: offset=0 → last `limit` items,
 * offset=50 → items[-(limit+50):-50]. limit=0 → all.
 * @param {Array} allHistory — full history array
 * @param {number} limit — max items (0 = all)
 * @param {number} offset — items to skip from the end
 * @returns {{history: Array, total: number}}
 */
export function paginateHistory(allHistory, limit = 0, offset = 0) {
  const total = allHistory.length;
  if (limit > 0) {
    const start = Math.max(0, total - offset - limit);
    const end = Math.max(0, total - offset);
    return { history: allHistory.slice(start, end), total };
  }
  return { history: allHistory, total };
}

/**
 * Check if a path is safe to serve (within the base directory).
 * @param {string} requestPath — path from URL
 * @param {string} baseDir — absolute base directory
 * @returns {{safe: boolean, reason: string|null}}
 */
export function isPathSafe(requestPath, baseDir) {
  const safePath = normalize(requestPath).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(baseDir, safePath);
  if (!filePath.startsWith(baseDir)) {
    return { safe: false, reason: "Forbidden" };
  }
  return { safe: true, reason: null };
}

/**
 * Parse the prompt request body.
 * @param {string} body — raw request body
 * @param {string} contentType — content-type header
 * @returns {{message: string, timeoutMs: number, includeFull: boolean, stream: boolean} | {error: string}}
 */
export function parsePromptBody(body, contentType) {
  let message;
  let timeoutMs = 300000;
  let includeFull = false;
  let stream = false;

  if (contentType.includes("application/json")) {
    try {
      const parsed = JSON.parse(body);
      message = parsed.message;
      if (typeof parsed.timeout === "number") timeoutMs = parsed.timeout;
      if (parsed.full === true) includeFull = true;
      if (parsed.stream === true) stream = true;
      if (!message || typeof message !== "string") {
        return { error: "Missing or invalid 'message' field" };
      }
    } catch {
      return { error: "Invalid JSON body" };
    }
  } else {
    message = body;
  }

  return { message, timeoutMs, includeFull, stream };
}

/**
 * Strip YAML frontmatter (---\n...\n---\n) from content.
 * @param {string} content — raw file content
 * @returns {string} content without frontmatter
 */
export function stripFrontmatter(content) {
  const fmMatch = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/);
  return fmMatch ? content.slice(fmMatch[0].length) : content;
}

/**
 * Parse a /skill:name args string into components.
 * @param {string} text — input text
 * @returns {{isSkill: boolean, skillName: string|null, args: string}}
 */
export function parseSkillCommand(text) {
  if (!text.startsWith("/skill:")) return { isSkill: false, skillName: null, args: "" };
  const spaceIndex = text.indexOf(" ");
  const skillName = spaceIndex === -1 ? text.slice(7) : text.slice(7, spaceIndex);
  const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1).trim();
  return { isSkill: true, skillName, args };
}

/**
 * Parse a /templateName args string into components.
 * @param {string} text — input text
 * @returns {{isTemplate: boolean, templateName: string|null, args: string}}
 */
export function parsePromptTemplate(text) {
  if (!text.startsWith("/")) return { isTemplate: false, templateName: null, args: "" };
  const spaceIndex = text.indexOf(" ");
  const templateName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
  const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1).trim();
  return { isTemplate: true, templateName, args };
}

/**
 * Compute usage stats from session entries. Token counts and cost are
 * cumulative across the session; cacheHitRate is the LATEST assistant
 * message's rate (not cumulative) — it reflects current cache warmth.
 * @param {Array} entries — session entries from sessionManager.getEntries()
 * @returns {{inputTokens: number, outputTokens: number, cacheReadTokens: number, cacheWriteTokens: number, cacheHitRate: number|null, totalCost: number}}
 */
export function computeUsageStats(entries) {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let totalCost = 0;
  let latestCacheHitRate = null;

  if (!entries) return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, cacheHitRate: latestCacheHitRate, totalCost };

  for (const entry of entries) {
    if (entry.type === "message" && entry.message?.role === "assistant") {
      const usage = entry.message.usage;
      if (!usage) continue;
      inputTokens += usage.input ?? 0;
      outputTokens += usage.output ?? 0;
      cacheReadTokens += usage.cacheRead ?? 0;
      cacheWriteTokens += usage.cacheWrite ?? 0;
      totalCost += usage.cost?.total ?? 0;
      const promptTokens = (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
      if (promptTokens > 0) {
        latestCacheHitRate = ((usage.cacheRead ?? 0) / promptTokens) * 100;
      }
    }
  }

  return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, cacheHitRate: latestCacheHitRate, totalCost };
}

// ── Shared pure parsers ───────────────────────────────────────────
// These live in parsers.js (browser + node safe). Re-exported here so
// existing `helpers.*` importers keep working; chat.js imports parsers
// directly. Single definition source — no more duplication.
export {
  extractSubagentViews,
  isSkillRead,
  parseSkillBlock,
  parseSkillFrontmatter,
  parseSubagentMessages,
  subagentStatus,
} from "@wirelessr/pi-webui-components/parsers.js";
