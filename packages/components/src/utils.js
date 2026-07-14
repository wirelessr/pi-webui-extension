/**
 * Shared utilities for WebUI modules.
 */

export function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Format token count for compact display.
 * @param {number} n
 * @returns {string}
 */
export function formatTokens(n) {
  if (n < 1000) return String(n);
  if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1000000) return `${Math.round(n / 1000)}k`;
  if (n < 10000000) return `${(n / 1000000).toFixed(1)}M`;
  return `${Math.round(n / 1000000)}M`;
}

/**
 * Build stats display string from status API response.
 * @param {{usage?: object, context?: object}} data
 * @returns {string}
 */
export function formatStats(data) {
  if (!data.usage || !data.context) return "";
  const u = data.usage;
  const ctx = data.context;
  const parts = [];
  if (u.inputTokens) parts.push(`\u2191${formatTokens(u.inputTokens)}`);
  if (u.outputTokens) parts.push(`\u2193${formatTokens(u.outputTokens)}`);
  if (u.cacheReadTokens) parts.push(`R${formatTokens(u.cacheReadTokens)}`);
  if (u.cacheWriteTokens) parts.push(`W${formatTokens(u.cacheWriteTokens)}`);
  if (u.cacheHitRate !== null) parts.push(`CH${u.cacheHitRate.toFixed(1)}%`);
  if (u.totalCost) parts.push(`$${u.totalCost.toFixed(3)}`);
  const ctxStr = ctx.percent !== null
    ? `${ctx.percent.toFixed(1)}%/${formatTokens(ctx.contextWindow)}`
    : `?/${formatTokens(ctx.contextWindow)}`;
  parts.push(ctxStr);
  return parts.join(" \u00b7 ");
}
