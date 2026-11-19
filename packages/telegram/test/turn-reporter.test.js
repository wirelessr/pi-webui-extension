import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createTurnReporter, renderProgress, toolSummary } from "../src/turn-reporter.js";

const run = (tag, events) => {
  const r = createTurnReporter(tag);
  return events.map((e) => r.push(e));
};
const textEvents = (text) => [
  { type: "text_start" },
  { type: "text_delta", delta: text },
  { type: "text_end" },
];
const start = (id, name, args) => ({ type: "tool_execution_start", toolCallId: id, toolName: name, args });
const end = (id, isError = false) => ({ type: "tool_execution_end", toolCallId: id, isError });

describe("toolSummary", () => {
  const cases = [
    { name: "null args", args: null, expected: "" },
    { name: "string args", args: "  ls   -la ", expected: "ls -la" },
    { name: "prefers command", args: { command: "ls /tmp", path: "/x" }, expected: "ls /tmp" },
    { name: "path", args: { path: "/a/b.js" }, expected: "/a/b.js" },
    { name: "unknown shape falls back to json", args: { n: 1 }, expected: '{"n":1}' },
    { name: "multiline collapsed", args: { command: "a\n  b" }, expected: "a b" },
    { name: "long values truncated", args: { command: "x".repeat(200) }, expected: `${"x".repeat(79)}\u2026` },
  ];
  for (const c of cases) test(c.name, () => assert.equal(toolSummary(c.args), c.expected));
});

describe("renderProgress", () => {
  test("marks status and shows args", () =>
    assert.equal(
      renderProgress("s", [
        { toolName: "bash", args: { command: "ls" }, status: "done" },
        { toolName: "read", args: null, status: "running" },
        { toolName: "edit", args: { path: "a" }, status: "error" },
      ]),
      "[s]\n[ok] bash: ls\n[run] read\n[err] edit: a",
    ));
  test("caps the list and counts the hidden ones", () => {
    const tools = Array.from({ length: 15 }, (_, i) => ({ toolName: `t${i}`, args: null, status: "done" }));
    const lines = renderProgress("s", tools).split("\n");
    assert.equal(lines[1], "(3 earlier)");
    assert.equal(lines.length, 2 + 12);
    assert.equal(lines[2], "[ok] t3");
  });
});

describe("createTurnReporter", () => {
  test("text block is sent when it completes, with the tag on the first message", () => {
    const [a, b, c] = run("s", textEvents("hello"));
    assert.deepEqual(a, []);
    assert.deepEqual(b, []);
    assert.deepEqual(c, [{ kind: "text", text: "[s]\nhello" }]);
  });

  test("tool, text, tool alternate in order and group by text boundary", () => {
    const out = run("s", [
      start("t1", "bash", { command: "ls" }),
      end("t1"),
      ...textEvents("found it"),
      start("t2", "read", { path: "f" }),
      end("t2"),
      { type: "done", text: "found it" },
    ]).flat();
    assert.deepEqual(out, [
      { kind: "progress", group: 0, text: "[s]\n[run] bash: ls" },
      { kind: "progress", group: 0, text: "[s]\n[ok] bash: ls" },
      { kind: "text", text: "found it" },
      { kind: "progress", group: 1, text: "[s]\n[run] read: f" },
      { kind: "progress", group: 1, text: "[s]\n[ok] read: f" },
    ]);
  });

  test("text flushed by a tool start precedes that tool's progress", () => {
    const out = run("s", [{ type: "text_start" }, { type: "text_delta", delta: "narration" }, start("t1", "bash", {})]).flat();
    assert.deepEqual(out.map((a) => a.kind), ["text", "progress"]);
    assert.equal(out[0].text, "[s]\nnarration");
    assert.equal(out[1].group, 1);
  });

  test("final text not closed by text_end is delivered on done", () => {
    const out = run("s", [{ type: "text_start" }, { type: "text_delta", delta: "tail" }, { type: "done", text: "tail" }]).flat();
    assert.deepEqual(out, [{ kind: "text", text: "[s]\ntail" }]);
  });

  test("done with no streamed text falls back to the done payload", () => {
    assert.deepEqual(run("s", [{ type: "done", text: "whole" }]).flat(), [{ kind: "text", text: "[s]\nwhole" }]);
  });

  test("done after tools only reports the tool count, without repeating the tag", () => {
    const out = run("s", [start("t1", "bash", {}), end("t1"), { type: "done", toolCalls: ["bash"] }]).flat();
    assert.deepEqual(out.at(-1), { kind: "text", text: "(no text reply; 1 tool call)" });
  });

  test("whitespace-only text blocks are not sent but still close the group", () => {
    const out = run("s", [...textEvents("  \n"), start("t1", "bash", {})]).flat();
    assert.deepEqual(out.map((a) => a.kind), ["progress"]);
    assert.equal(out[0].group, 1);
  });

  test("error event", () => {
    assert.deepEqual(run("s", [{ type: "error", message: "boom" }]).flat(), [{ kind: "error", text: "[s] error: boom" }]);
    assert.deepEqual(run("s", [{ type: "error" }]).flat(), [{ kind: "error", text: "[s] error: Unknown error" }]);
  });

  test("a tool end from an earlier group is ignored", () => {
    const out = run("s", [start("t1", "a", {}), ...textEvents("mid"), start("t2", "b", {}), end("t1")]).flat();
    assert.equal(out.filter((a) => a.kind === "progress").length, 2);
  });

  test("unrelated events produce nothing", () => {
    assert.deepEqual(run("s", [{ type: "agent_start" }, { type: "turn_start" }, { type: "tool_execution_update", toolCallId: "x" }]).flat(), []);
  });
});
