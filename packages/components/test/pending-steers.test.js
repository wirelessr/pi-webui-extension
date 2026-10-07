import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { pendingCaption, pendingDrainIndex } from "../src/pending-steers.js";

const s = (text) => ({ text, kind: "steer" });
const f = (text) => ({ text, kind: "followUp" });

describe("pendingDrainIndex", () => {
  const cases = [
    { name: "empty list → -1", list: [], text: "a", expected: -1 },
    { name: "exact steer match", list: [s("a"), s("b")], text: "b", expected: 1 },
    { name: "exact follow-up match", list: [s("a"), f("b")], text: "b", expected: 1 },
    { name: "same text in both kinds → the steer", list: [f("x"), s("x")], text: "x", expected: 1 },
    { name: "no match → oldest steer, even behind a follow-up", list: [f("a"), s("b"), s("c")], text: "expanded", expected: 1 },
    { name: "no match, only follow-ups → oldest", list: [f("a"), f("b")], text: "expanded", expected: 0 },
  ];
  for (const c of cases) {
    test(c.name, () => {
      assert.equal(pendingDrainIndex(c.list, c.text), c.expected);
    });
  }
});

describe("pendingCaption", () => {
  const cases = [
    { name: "one steer", list: [s("a")], expected: "1 steer waiting to inject" },
    { name: "two steers", list: [s("a"), s("b")], expected: "2 steers waiting to inject" },
    { name: "one follow-up", list: [f("a")], expected: "1 follow-up waiting to inject" },
    { name: "mixed", list: [s("a"), s("b"), f("c")], expected: "2 steers + 1 follow-up waiting to inject" },
    { name: "two follow-ups + one steer", list: [f("a"), s("b"), f("c")], expected: "1 steer + 2 follow-ups waiting to inject" },
  ];
  for (const c of cases) {
    test(c.name, () => {
      assert.equal(pendingCaption(c.list), c.expected);
    });
  }
});
