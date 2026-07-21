import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { diffLines } from "../src/diff.js";

describe("diffLines", () => {
  test("identical text → all context", () => {
    assert.deepEqual(diffLines("a\nb", "a\nb"), [
      { type: "context", text: "a" },
      { type: "context", text: "b" },
    ]);
  });

  test("a changed middle line → remove old, add new, keep context", () => {
    assert.deepEqual(diffLines("a\nb\nc", "a\nB\nc"), [
      { type: "context", text: "a" },
      { type: "remove", text: "b" },
      { type: "add", text: "B" },
      { type: "context", text: "c" },
    ]);
  });

  test("pure addition (empty old) → all adds", () => {
    assert.deepEqual(diffLines("", "x\ny"), [
      { type: "add", text: "x" },
      { type: "add", text: "y" },
    ]);
  });

  test("appended line keeps the original as context", () => {
    assert.deepEqual(diffLines("a", "a\nb"), [
      { type: "context", text: "a" },
      { type: "add", text: "b" },
    ]);
  });

  test("removed line", () => {
    assert.deepEqual(diffLines("a\nb\nc", "a\nc"), [
      { type: "context", text: "a" },
      { type: "remove", text: "b" },
      { type: "context", text: "c" },
    ]);
  });

  test("null/empty inputs → no lines", () => {
    assert.deepEqual(diffLines(null, null), []);
    assert.deepEqual(diffLines("", ""), []);
  });

  test("pure deletion (empty new) → all removes", () => {
    assert.deepEqual(diffLines("x\ny", ""), [
      { type: "remove", text: "x" },
      { type: "remove", text: "y" },
    ]);
  });
});
