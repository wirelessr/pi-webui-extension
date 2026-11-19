import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  buildSessionKeyboard,
  findSessionByPid,
  formatDone,
  isAuthorized,
  lastAssistantText,
  normalizeState,
  parseCommand,
  sessionLabel,
  sessionTag,
  splitMessage,
} from "../src/telegram-helpers.js";

describe("isAuthorized", () => {
  const msg = (chat, from) => ({ message: { chat: { id: chat }, from: { id: from }, text: "x" } });
  const cb = (chat, from) => ({ callback_query: { from: { id: from }, message: { chat: { id: chat } } } });
  const cases = [
    { name: "matching message", update: msg(5, 5), allowed: "5", expected: true },
    { name: "numeric vs string id", update: msg(5, 5), allowed: 5, expected: true },
    { name: "matching callback", update: cb(5, 5), allowed: "5", expected: true },
    { name: "wrong chat", update: msg(6, 5), allowed: "5", expected: false },
    { name: "right chat, other sender (group)", update: msg(5, 9), allowed: "5", expected: false },
    { name: "callback from other sender", update: cb(5, 9), allowed: "5", expected: false },
    { name: "unconfigured id rejects everything", update: msg(5, 5), allowed: "", expected: false },
    { name: "undefined id rejects everything", update: msg(5, 5), allowed: undefined, expected: false },
    { name: "update without message", update: { edited_message: {} }, allowed: "5", expected: false },
    { name: "null update", update: null, allowed: "5", expected: false },
  ];
  for (const c of cases) test(c.name, () => assert.equal(isAuthorized(c.update, c.allowed), c.expected));
});

describe("splitMessage", () => {
  test("short text is one chunk", () => assert.deepEqual(splitMessage("hi"), ["hi"]));
  test("empty text yields no chunks", () => assert.deepEqual(splitMessage(""), []));
  test("prefers newline boundaries and keeps all content", () => {
    const text = `${"a".repeat(60)}\n${"b".repeat(60)}`;
    const out = splitMessage(text, 100);
    assert.deepEqual(out, ["a".repeat(60), "b".repeat(60)]);
  });
  test("hard cuts when there is no usable newline", () => {
    const out = splitMessage("x".repeat(250), 100);
    assert.deepEqual(out.map((c) => c.length), [100, 100, 50]);
    assert.equal(out.join(""), "x".repeat(250));
  });
  test("a newline too early to be useful does not cause tiny chunks", () => {
    const out = splitMessage(`a\n${"b".repeat(150)}`, 100);
    assert.equal(out[0].length, 100);
  });
});

describe("parseCommand", () => {
  const cases = [
    { text: "/sessions", expected: { cmd: "sessions", args: "" } },
    { text: "/new ~/proj", expected: { cmd: "new", args: "~/proj" } },
    { text: "/NEW@MyBot  /tmp/x ", expected: { cmd: "new", args: "/tmp/x" } },
    { text: "/rename two words", expected: { cmd: "rename", args: "two words" } },
    { text: "plain text", expected: null },
    { text: "see /sessions", expected: null },
    { text: "", expected: null },
    { text: undefined, expected: null },
  ];
  for (const c of cases) test(String(c.text), () => assert.deepEqual(parseCommand(c.text), c.expected));
});

describe("sessionTag", () => {
  test("name wins", () => assert.equal(sessionTag({ sessionId: "abcdefghij", sessionName: "fix bug" }), "fix bug"));
  test("short id when unnamed", () => assert.equal(sessionTag({ sessionId: "abcdefghij" }), "abcdefgh"));
});

describe("sessionLabel", () => {
  test("name, cwd basename, busy marker", () =>
    assert.equal(sessionLabel({ sessionId: "abcdefghij", sessionName: "fix bug", cwd: "/a/b/proj", busy: true }), "[busy] fix bug (proj)"));
  test("falls back to short id, no cwd", () =>
    assert.equal(sessionLabel({ sessionId: "abcdefghij", sessionName: null, cwd: null }), "abcdefgh"));
  test("root cwd", () => assert.equal(sessionLabel({ sessionId: "abcdefghij", cwd: "/" }), "abcdefgh (/)"));
});

describe("buildSessionKeyboard", () => {
  test("one row per session, current marked, callback carries id", () => {
    const kb = buildSessionKeyboard(
      [
        { sessionId: "s1", sessionName: "one" },
        { sessionId: "s2", sessionName: "two" },
      ],
      "s2",
    );
    assert.deepEqual(kb.inline_keyboard, [
      [{ text: "one", callback_data: "sel:s1" }],
      [{ text: "* two", callback_data: "sel:s2" }],
    ]);
  });
});

describe("lastAssistantText", () => {
  test("latest assistant entry with text", () =>
    assert.equal(
      lastAssistantText([
        { role: "assistant", text: "old" },
        { role: "user", text: "q" },
        { role: "assistant", text: "new" },
        { role: "toolResult", text: "r" },
      ]),
      "new",
    ));
  test("skips assistant entries without text (tool-call only)", () =>
    assert.equal(lastAssistantText([{ role: "assistant", text: "answer" }, { role: "assistant", toolCalls: [{}] }]), "answer"));
  test("null when none", () => assert.equal(lastAssistantText([{ role: "user", text: "q" }]), null));
});

describe("formatDone", () => {
  test("text wins", () => assert.equal(formatDone({ text: "hello", toolCalls: ["a"] }), "hello"));
  test("whitespace-only text with tool calls", () => assert.equal(formatDone({ text: " ", toolCalls: ["a", "b"] }), "(no text reply; 2 tool calls)"));
  test("single tool call is singular", () => assert.equal(formatDone({ toolCalls: ["a"] }), "(no text reply; 1 tool call)"));
  test("nothing at all", () => assert.equal(formatDone({}), "(no text reply)"));
});

describe("findSessionByPid", () => {
  const sessions = [{ sessionId: "a", pid: 1 }, { sessionId: "b", pid: 2 }];
  test("match", () => assert.equal(findSessionByPid(sessions, 2).sessionId, "b"));
  test("miss", () => assert.equal(findSessionByPid(sessions, 3), null));
});

describe("normalizeState", () => {
  const cases = [
    { raw: { selected: "s1" }, expected: { selected: "s1" } },
    { raw: { selected: "" }, expected: { selected: null } },
    { raw: { selected: 5 }, expected: { selected: null } },
    { raw: {}, expected: { selected: null } },
    { raw: null, expected: { selected: null } },
    { raw: "junk", expected: { selected: null } },
  ];
  for (const c of cases) test(JSON.stringify(c.raw), () => assert.deepEqual(normalizeState(c.raw), c.expected));
});
