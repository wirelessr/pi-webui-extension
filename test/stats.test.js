import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computeUsageStats } from "../http-bridge-web/helpers.js";
import { formatStats, formatTokens } from "../http-bridge-web/utils.js";

describe("formatTokens", () => {
  it("returns raw number below 1000", () => {
    assert.equal(formatTokens(0), "0");
    assert.equal(formatTokens(42), "42");
    assert.equal(formatTokens(999), "999");
  });

  it("returns 1-decimal k for 1k-10k", () => {
    assert.equal(formatTokens(1000), "1.0k");
    assert.equal(formatTokens(1500), "1.5k");
    assert.equal(formatTokens(9999), "10.0k");
  });

  it("returns rounded k for 10k-1M", () => {
    assert.equal(formatTokens(10000), "10k");
    assert.equal(formatTokens(424000), "424k");
    assert.equal(formatTokens(999999), "1000k");
  });

  it("returns 1-decimal M for 1M-10M", () => {
    assert.equal(formatTokens(1000000), "1.0M");
    assert.equal(formatTokens(3800000), "3.8M");
    assert.equal(formatTokens(9999999), "10.0M");
  });

  it("returns rounded M for 10M+", () => {
    assert.equal(formatTokens(10000000), "10M");
    assert.equal(formatTokens(213000000), "213M");
  });
});

describe("formatStats", () => {
  it("returns empty string when no usage or context", () => {
    assert.equal(formatStats({}), "");
    assert.equal(formatStats({ usage: null }), "");
    assert.equal(formatStats({ context: null }), "");
  });

  it("shows only context when all token counts are 0", () => {
    const result = formatStats({
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cacheHitRate: null, totalCost: 0 },
      context: { tokens: 0, contextWindow: 1000000, percent: 0 },
    });
    assert.equal(result, "0.0%/1.0M");
  });

  it("shows all fields with non-zero values", () => {
    const result = formatStats({
      usage: { inputTokens: 3800000, outputTokens: 424000, cacheReadTokens: 213000000, cacheWriteTokens: 50000, cacheHitRate: 99.9, totalCost: 62.461 },
      context: { tokens: 87000, contextWindow: 1000000, percent: 8.7 },
    });
    assert.equal(result, "↑3.8M · ↓424k · R213M · W50k · CH99.9% · $62.461 · 8.7%/1.0M");
  });

  it("skips zero token fields but still shows context", () => {
    const result = formatStats({
      usage: { inputTokens: 6100, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cacheHitRate: 0, totalCost: 0.009 },
      context: { tokens: 600, contextWindow: 1000000, percent: 0.6 },
    });
    assert.equal(result, "↑6.1k · CH0.0% · $0.009 · 0.6%/1.0M");
  });

  it("shows ? for context percent when null", () => {
    const result = formatStats({
      usage: { inputTokens: 1000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cacheHitRate: null, totalCost: 0 },
      context: { tokens: null, contextWindow: 200000, percent: null },
    });
    assert.equal(result, "↑1.0k · ?/200k");
  });
});

describe("computeUsageStats", () => {
  it("returns zeros for null entries", () => {
    const result = computeUsageStats(null);
    assert.deepEqual(result, {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cacheHitRate: null,
      totalCost: 0,
    });
  });

  it("returns zeros for empty entries", () => {
    const result = computeUsageStats([]);
    assert.deepEqual(result, {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cacheHitRate: null,
      totalCost: 0,
    });
  });

  it("skips non-assistant messages", () => {
    const entries = [
      { type: "message", message: { role: "user", content: "hello" } },
      { type: "message", message: { role: "toolResult", content: "result" } },
      { type: "compaction", summary: "..." },
    ];
    const result = computeUsageStats(entries);
    assert.equal(result.inputTokens, 0);
    assert.equal(result.totalCost, 0);
  });

  it("accumulates usage from assistant messages", () => {
    const entries = [
      {
        type: "message",
        message: {
          role: "assistant",
          usage: { input: 1000, output: 500, cacheRead: 2000, cacheWrite: 100, cost: { total: 0.01 } },
        },
      },
      {
        type: "message",
        message: {
          role: "assistant",
          usage: { input: 2000, output: 800, cacheRead: 3000, cacheWrite: 200, cost: { total: 0.02 } },
        },
      },
    ];
    const result = computeUsageStats(entries);
    assert.equal(result.inputTokens, 3000);
    assert.equal(result.outputTokens, 1300);
    assert.equal(result.cacheReadTokens, 5000);
    assert.equal(result.cacheWriteTokens, 300);
    assert.equal(result.totalCost, 0.03);
  });

  it("computes cache hit rate from latest assistant message", () => {
    const entries = [
      {
        type: "message",
        message: {
          role: "assistant",
          usage: { input: 1000, output: 0, cacheRead: 0, cacheWrite: 1000, cost: { total: 0 } },
        },
      },
      {
        type: "message",
        message: {
          role: "assistant",
          usage: { input: 100, output: 0, cacheRead: 900, cacheWrite: 0, cost: { total: 0 } },
        },
      },
    ];
    const result = computeUsageStats(entries);
    // Latest: promptTokens = 100 + 900 + 0 = 1000, cacheRead = 900, hitRate = 90%
    assert.equal(result.cacheHitRate, 90);
  });

  it("cache hit rate is null when all prompt tokens are 0", () => {
    const entries = [
      {
        type: "message",
        message: {
          role: "assistant",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
        },
      },
    ];
    const result = computeUsageStats(entries);
    assert.equal(result.cacheHitRate, null);
  });

  it("handles missing usage field gracefully", () => {
    const entries = [
      { type: "message", message: { role: "assistant" } },
      { type: "message", message: { role: "assistant", usage: null } },
    ];
    const result = computeUsageStats(entries);
    assert.equal(result.inputTokens, 0);
  });

  it("handles missing cost.total with default 0", () => {
    const entries = [
      {
        type: "message",
        message: {
          role: "assistant",
          usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 },
        },
      },
    ];
    const result = computeUsageStats(entries);
    assert.equal(result.totalCost, 0);
  });
});
