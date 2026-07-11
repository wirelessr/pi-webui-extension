import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { applyCommand } from "../http-bridge-web/input.js";

const CMD = { name: "skill:gh" };

describe("applyCommand - no / token (click from sidebar)", () => {
  test("empty input → replace with /cmd + space", () => {
    const result = applyCommand("", 0, CMD);
    assert.equal(result.value, "/skill:gh ");
    assert.equal(result.cursor, "/skill:gh ".length);
  });

  test("plain text without / → replace entire input", () => {
    const result = applyCommand("hello world", 5, CMD);
    assert.equal(result.value, "/skill:gh ");
    assert.equal(result.cursor, "/skill:gh ".length);
  });

  test("cursor at end of plain text → replace entire input", () => {
    const result = applyCommand("some text", 9, CMD);
    assert.equal(result.value, "/skill:gh ");
    assert.equal(result.cursor, "/skill:gh ".length);
  });
});

describe("applyCommand - with / token (typing in input)", () => {
  test("replace /sk token at start of input", () => {
    const result = applyCommand("/sk rest", 3, CMD);
    assert.equal(result.value, "/skill:gh rest");
    assert.equal(result.cursor, "/skill:gh".length);
  });

  test("replace / token in middle of text", () => {
    const result = applyCommand("prefix /sk suffix", 10, CMD);
    assert.equal(result.value, "prefix /skill:gh suffix");
    assert.equal(result.cursor, "prefix /skill:gh".length);
  });

  test("replace / token at end of input", () => {
    const result = applyCommand("text /sk", 8, CMD);
    assert.equal(result.value, "text /skill:gh ");
    assert.equal(result.cursor, "text /skill:gh ".length);
  });

  test("no trailing space after token → add space", () => {
    const result = applyCommand("/gh", 3, CMD);
    assert.equal(result.value, "/skill:gh ");
    assert.equal(result.cursor, "/skill:gh ".length);
  });

  test("trailing space after token → no double space", () => {
    const result = applyCommand("/gh rest", 3, CMD);
    assert.equal(result.value, "/skill:gh rest");
    assert.equal(result.cursor, "/skill:gh".length);
  });

  test("replace entire / token when cursor is on it", () => {
    const result = applyCommand("/skill:j", 8, { name: "skill:jira" });
    assert.equal(result.value, "/skill:jira ");
    assert.equal(result.cursor, "/skill:jira ".length);
  });
});

describe("applyCommand - edge cases", () => {
  test("cursor at position 0 with empty input", () => {
    const result = applyCommand("", 0, CMD);
    assert.equal(result.value, "/skill:gh ");
  });

  test("cursor at position 0 with non-empty input (no / at start)", () => {
    const result = applyCommand("hello", 0, CMD);
    assert.equal(result.value, "/skill:gh ");
  });

  test("command with no name prefix (builtin)", () => {
    const result = applyCommand("", 0, { name: "compact" });
    assert.equal(result.value, "/compact ");
    assert.equal(result.cursor, "/compact ".length);
  });
});
