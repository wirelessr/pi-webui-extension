import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatStats, formatTokens } from "../src/utils.js";

describe("formatTokens", () => {
  const cases = [
    { name: "returns raw number below 1000", input: 0, expected: "0" },
    { name: "42", input: 42, expected: "42" },
    { name: "999", input: 999, expected: "999" },
    { name: "returns 1-decimal k for 1k-10k", input: 1000, expected: "1.0k" },
    { name: "1500", input: 1500, expected: "1.5k" },
    { name: "9999", input: 9999, expected: "10.0k" },
    { name: "returns rounded k for 10k-1M", input: 10000, expected: "10k" },
    { name: "424000", input: 424000, expected: "424k" },
    { name: "999999", input: 999999, expected: "1000k" },
    { name: "returns 1-decimal M for 1M-10M", input: 1000000, expected: "1.0M" },
    { name: "3800000", input: 3800000, expected: "3.8M" },
    { name: "9999999", input: 9999999, expected: "10.0M" },
    { name: "returns rounded M for 10M+", input: 10000000, expected: "10M" },
    { name: "213000000", input: 213000000, expected: "213M" },
  ];
  for (const c of cases) {
    it(c.name, () => assert.equal(formatTokens(c.input), c.expected));
  }
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

  it("leads with the model short name when model is set", () => {
    const result = formatStats({
      model: "accounts/fireworks/models/glm-5p2",
      usage: { inputTokens: 1000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cacheHitRate: null, totalCost: 0 },
      context: { tokens: null, contextWindow: 200000, percent: null },
    });
    assert.equal(result, "glm-5p2 · ↑1.0k · ?/200k");
  });

  it("uses a plain model id as-is", () => {
    const result = formatStats({
      model: "claude-opus-4-8",
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cacheHitRate: null, totalCost: 0 },
      context: { tokens: 0, contextWindow: 200000, percent: 0 },
    });
    assert.equal(result, "claude-opus-4-8 · 0.0%/200k");
  });
});
