import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computeUsageStats } from "../helpers.js";

describe("computeUsageStats", () => {
  const zeroCases = [
    { name: "returns zeros for null entries", input: null },
    { name: "returns zeros for empty entries", input: [] },
  ];
  for (const c of zeroCases) {
    it(c.name, () =>
      assert.deepEqual(computeUsageStats(c.input), {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        cacheHitRate: null,
        totalCost: 0,
      }));
  }

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
