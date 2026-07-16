/**
 * Artifacts — discover the files an agent authored, from its write/edit tool
 * calls in the transcript. This module only decides *which* files exist; their
 * content is read fresh from disk on demand (so a file later changed via
 * sed/python/redirect still shows its true current content). The same path set
 * is used client-side to build the file chips and server-side as the read
 * allowlist, so the two never drift.
 *
 * Pure and Node-safe (no DOM) — imported by both the browser chat and the
 * extension bridge.
 */

const FILE_TOOLS = new Set(["write", "edit"]);

/** Absolute-or-relative path a write/edit tool call targets, or null. */
function opPath(tc) {
  if (!tc || !FILE_TOOLS.has(tc.name)) return null;
  const a = tc.arguments;
  if (!a || typeof a !== "object") return null;
  return a.path || a.file_path || null;
}

/**
 * Distinct file paths a single assistant message wrote/edited, in first-touch
 * order.
 * @param {Array<{name?: string, arguments?: object}>} toolCalls
 * @returns {string[]}
 */
export function extractFilePaths(toolCalls) {
  if (!Array.isArray(toolCalls)) return [];
  const seen = [];
  for (const tc of toolCalls) {
    const p = opPath(tc);
    if (p && !seen.includes(p)) seen.push(p);
  }
  return seen;
}

/**
 * Every file path the agent wrote/edited across a whole transcript — the read
 * allowlist. A requested path must be in this set to be served.
 * @param {Array<{role?: string, toolCalls?: Array}>} entries
 * @returns {Set<string>}
 */
export function collectWrittenPaths(entries) {
  const paths = new Set();
  if (!Array.isArray(entries)) return paths;
  for (const entry of entries) {
    if (entry?.role !== "assistant") continue;
    for (const p of extractFilePaths(entry.toolCalls)) paths.add(p);
  }
  return paths;
}

/** Basename for a chip label. */
export function fileName(path) {
  const parts = String(path).split("/");
  return parts[parts.length - 1] || String(path);
}

/** Whether a path should render as markdown (vs. plain code). */
export function isMarkdownPath(path) {
  return /\.(md|markdown)$/i.test(String(path));
}
