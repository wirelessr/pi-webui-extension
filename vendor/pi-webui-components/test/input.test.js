import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { applyCommand } from "../src/input.js";

const CMD = { name: "skill:gh" };

describe("applyCommand", () => {
  const cases = [
    { name: "empty input → replace with /cmd + space", text: "", cursor: 0, cmd: CMD, expectedValue: "/skill:gh ", expectedCursor: "/skill:gh ".length },
    { name: "plain text without / → replace entire input", text: "hello world", cursor: 5, cmd: CMD, expectedValue: "/skill:gh ", expectedCursor: "/skill:gh ".length },
    { name: "cursor at end of plain text → replace entire input", text: "some text", cursor: 9, cmd: CMD, expectedValue: "/skill:gh ", expectedCursor: "/skill:gh ".length },
    { name: "replace /sk token at start of input", text: "/sk rest", cursor: 3, cmd: CMD, expectedValue: "/skill:gh rest", expectedCursor: "/skill:gh".length },
    { name: "replace / token in middle of text", text: "prefix /sk suffix", cursor: 10, cmd: CMD, expectedValue: "prefix /skill:gh suffix", expectedCursor: "prefix /skill:gh".length },
    { name: "replace / token at end of input", text: "text /sk", cursor: 8, cmd: CMD, expectedValue: "text /skill:gh ", expectedCursor: "text /skill:gh ".length },
    { name: "no trailing space after token → add space", text: "/gh", cursor: 3, cmd: CMD, expectedValue: "/skill:gh ", expectedCursor: "/skill:gh ".length },
    { name: "trailing space after token → no double space", text: "/gh rest", cursor: 3, cmd: CMD, expectedValue: "/skill:gh rest", expectedCursor: "/skill:gh".length },
    { name: "replace entire / token when cursor is on it", text: "/skill:j", cursor: 8, cmd: { name: "skill:jira" }, expectedValue: "/skill:jira ", expectedCursor: "/skill:jira ".length },
    { name: "cursor at position 0 with empty input", text: "", cursor: 0, cmd: CMD, expectedValue: "/skill:gh ", expectedCursor: "/skill:gh ".length },
    { name: "cursor at position 0 with non-empty input (no / at start)", text: "hello", cursor: 0, cmd: CMD, expectedValue: "/skill:gh ", expectedCursor: "/skill:gh ".length },
    { name: "command with no name prefix (builtin)", text: "", cursor: 0, cmd: { name: "compact" }, expectedValue: "/compact ", expectedCursor: "/compact ".length },
  ];
  for (const c of cases) {
    test(c.name, () => {
      const result = applyCommand(c.text, c.cursor, c.cmd);
      assert.equal(result.value, c.expectedValue);
      assert.equal(result.cursor, c.expectedCursor);
    });
  }
});
