/**
 * Pure parsing/formatting helpers shared by the browser (chat.js) and the
 * Node side (helpers.js re-exports these). No DOM, no fs, no node:* imports,
 * so this module is safe to load in both environments.
 */

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
