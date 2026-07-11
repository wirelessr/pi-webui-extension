import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createStreamAccumulator } from "../http-bridge-web/stream-accumulator.js";

/**
 * Helper: feed a sequence of events to an accumulator.
 * @param {object[]} events
 * @returns {{handleEvent: Function, getState: Function}}
 */
function feed(events) {
  const acc = createStreamAccumulator();
  for (const e of events) acc.handleEvent(e);
  return acc;
}

// ── Text accumulation ─────────────────────────────────

describe("stream accumulator — text", () => {
  test("text_start resets pending text but not committed", () => {
    const acc = createStreamAccumulator();
    acc.handleEvent({ type: "text_delta", delta: "hello" });
    acc.handleEvent({ type: "text_end" });
    acc.handleEvent({ type: "text_start" });
    const state = acc.getState();
    assert.equal(state.committedText, "hello");
    assert.equal(state.pendingText, "");
  });

  test("text_delta accumulates into pending", () => {
    const acc = createStreamAccumulator();
    acc.handleEvent({ type: "text_delta", delta: "hello " });
    acc.handleEvent({ type: "text_delta", delta: "world" });
    const state = acc.getState();
    assert.equal(state.pendingText, "hello world");
    assert.equal(state.committedText, "");
  });

  test("text_end flushes pending to committed", () => {
    const acc = createStreamAccumulator();
    acc.handleEvent({ type: "text_delta", delta: "hello" });
    acc.handleEvent({ type: "text_end" });
    const state = acc.getState();
    assert.equal(state.committedText, "hello");
    assert.equal(state.pendingText, "");
  });

  test("multiple text rounds accumulate in committed", () => {
    const acc = createStreamAccumulator();
    acc.handleEvent({ type: "text_delta", delta: "first " });
    acc.handleEvent({ type: "text_end" });
    acc.handleEvent({ type: "text_start" });
    acc.handleEvent({ type: "text_delta", delta: "second" });
    acc.handleEvent({ type: "text_end" });
    const state = acc.getState();
    assert.equal(state.committedText, "first second");
    assert.equal(state.pendingText, "");
  });

  test("text_end with no pending is a no-op", () => {
    const acc = createStreamAccumulator();
    acc.handleEvent({ type: "text_end" });
    const state = acc.getState();
    assert.equal(state.committedText, "");
    assert.equal(state.pendingText, "");
  });
});

// ── Thinking accumulation ─────────────────────────────

describe("stream accumulator — thinking", () => {
  test("thinking_start resets pending thinking and sets active", () => {
    const acc = createStreamAccumulator();
    acc.handleEvent({ type: "thinking_delta", delta: "hmm" });
    acc.handleEvent({ type: "thinking_end" });
    acc.handleEvent({ type: "thinking_start" });
    const state = acc.getState();
    assert.equal(state.committedThinking, "hmm");
    assert.equal(state.pendingThinking, "");
    assert.equal(state.thinkingActive, true);
  });

  test("thinking_delta accumulates into pending", () => {
    const acc = createStreamAccumulator();
    acc.handleEvent({ type: "thinking_start" });
    acc.handleEvent({ type: "thinking_delta", delta: "step 1 " });
    acc.handleEvent({ type: "thinking_delta", delta: "step 2" });
    const state = acc.getState();
    assert.equal(state.pendingThinking, "step 1 step 2");
  });

  test("thinking_end flushes pending to committed and deactivates", () => {
    const acc = createStreamAccumulator();
    acc.handleEvent({ type: "thinking_start" });
    acc.handleEvent({ type: "thinking_delta", delta: "reasoning" });
    acc.handleEvent({ type: "thinking_end" });
    const state = acc.getState();
    assert.equal(state.committedThinking, "reasoning");
    assert.equal(state.pendingThinking, "");
    assert.equal(state.thinkingActive, false);
  });
});

// ── Tool blocks ───────────────────────────────────────

describe("stream accumulator — tools", () => {
  test("tool_execution_start registers tool with running status", () => {
    const acc = createStreamAccumulator();
    acc.handleEvent({ type: "tool_execution_start", toolCallId: "tc1", toolName: "bash", args: { cmd: "ls" } });
    const state = acc.getState();
    assert.equal(state.tools.length, 1);
    assert.equal(state.tools[0].toolCallId, "tc1");
    assert.equal(state.tools[0].toolName, "bash");
    assert.deepEqual(state.tools[0].args, { cmd: "ls" });
    assert.equal(state.tools[0].status, "running");
  });

  test("tool_execution_end updates status to done", () => {
    const acc = createStreamAccumulator();
    acc.handleEvent({ type: "tool_execution_start", toolCallId: "tc1", toolName: "bash", args: {} });
    acc.handleEvent({ type: "tool_execution_end", toolCallId: "tc1", isError: false });
    const state = acc.getState();
    assert.equal(state.tools[0].status, "done");
  });

  test("tool_execution_end with isError updates to error", () => {
    const acc = createStreamAccumulator();
    acc.handleEvent({ type: "tool_execution_start", toolCallId: "tc1", toolName: "bash", args: {} });
    acc.handleEvent({ type: "tool_execution_end", toolCallId: "tc1", isError: true });
    const state = acc.getState();
    assert.equal(state.tools[0].status, "error");
  });

  test("tool_execution_end for unknown toolCallId is ignored", () => {
    const acc = createStreamAccumulator();
    acc.handleEvent({ type: "tool_execution_start", toolCallId: "tc1", toolName: "bash", args: {} });
    acc.handleEvent({ type: "tool_execution_end", toolCallId: "tc999", isError: false });
    const state = acc.getState();
    assert.equal(state.tools[0].status, "running");
  });

  test("multiple tools tracked independently", () => {
    const acc = createStreamAccumulator();
    acc.handleEvent({ type: "tool_execution_start", toolCallId: "tc1", toolName: "bash", args: {} });
    acc.handleEvent({ type: "tool_execution_start", toolCallId: "tc2", toolName: "read", args: {} });
    acc.handleEvent({ type: "tool_execution_end", toolCallId: "tc1", isError: false });
    acc.handleEvent({ type: "tool_execution_end", toolCallId: "tc2", isError: true });
    const state = acc.getState();
    assert.equal(state.tools.length, 2);
    assert.equal(state.tools[0].status, "done");
    assert.equal(state.tools[1].status, "error");
  });

  test("tool_execution_start flushes pending text first", () => {
    const acc = createStreamAccumulator();
    acc.handleEvent({ type: "text_delta", delta: "let me run " });
    acc.handleEvent({ type: "tool_execution_start", toolCallId: "tc1", toolName: "bash", args: {} });
    const state = acc.getState();
    assert.equal(state.committedText, "let me run ");
    assert.equal(state.pendingText, "");
  });

  test("null args stored as null", () => {
    const acc = createStreamAccumulator();
    acc.handleEvent({ type: "tool_execution_start", toolCallId: "tc1", toolName: "bash" });
    const state = acc.getState();
    assert.equal(state.tools[0].args, null);
  });
});

// ── Done and error ────────────────────────────────────

describe("stream accumulator — done & error", () => {
  test("done flushes text and thinking, sets done=true", () => {
    const acc = createStreamAccumulator();
    acc.handleEvent({ type: "text_delta", delta: "answer" });
    acc.handleEvent({ type: "thinking_start" });
    acc.handleEvent({ type: "thinking_delta", delta: "reasoning" });
    acc.handleEvent({ type: "done" });
    const state = acc.getState();
    assert.equal(state.done, true);
    assert.equal(state.committedText, "answer");
    assert.equal(state.pendingText, "");
    assert.equal(state.committedThinking, "reasoning");
    assert.equal(state.pendingThinking, "");
  });

  test("turn_end flushes text and thinking but does not set done", () => {
    const acc = createStreamAccumulator();
    acc.handleEvent({ type: "text_delta", delta: "text" });
    acc.handleEvent({ type: "thinking_delta", delta: "think" });
    acc.handleEvent({ type: "turn_end" });
    const state = acc.getState();
    assert.equal(state.done, false);
    assert.equal(state.committedText, "text");
    assert.equal(state.committedThinking, "think");
  });

  test("error stores message, does not flush", () => {
    const acc = createStreamAccumulator();
    acc.handleEvent({ type: "text_delta", delta: "partial" });
    acc.handleEvent({ type: "error", message: "connection lost" });
    const state = acc.getState();
    assert.equal(state.error, "connection lost");
    assert.equal(state.committedText, "");
    assert.equal(state.pendingText, "partial");
  });

  test("error without message uses default", () => {
    const acc = createStreamAccumulator();
    acc.handleEvent({ type: "error" });
    const state = acc.getState();
    assert.equal(state.error, "Unknown error");
  });

  test("done after error still flushes and sets done", () => {
    const acc = createStreamAccumulator();
    acc.handleEvent({ type: "text_delta", delta: "partial" });
    acc.handleEvent({ type: "error", message: "oops" });
    acc.handleEvent({ type: "done" });
    const state = acc.getState();
    assert.equal(state.done, true);
    assert.equal(state.committedText, "partial");
    assert.equal(state.error, "oops");
  });
});

// ── No-op events ──────────────────────────────────────

describe("stream accumulator — no-op events", () => {
  const noopEvents = ["agent_start", "turn_start", "toolcall_start", "toolcall_end"];
  for (const type of noopEvents) {
    test(`${type} does not change state`, () => {
      const acc = feed([{ type }]);
      const state = acc.getState();
      assert.equal(state.committedText, "");
      assert.equal(state.pendingText, "");
      assert.equal(state.done, false);
      assert.equal(state.error, null);
      assert.equal(state.tools.length, 0);
    });
  }

  test("unknown event type is ignored", () => {
    const acc = feed([{ type: "future_event", data: "something" }]);
    const state = acc.getState();
    assert.equal(state.done, false);
  });
});

// ── Full stream lifecycle ─────────────────────────────

describe("stream accumulator — full lifecycle", () => {
  test("typical assistant turn: text → tool → text → done", () => {
    const acc = feed([
      { type: "agent_start" },
      { type: "text_start" },
      { type: "text_delta", delta: "Let me check " },
      { type: "text_delta", delta: "the files." },
      { type: "text_end" },
      { type: "tool_execution_start", toolCallId: "tc1", toolName: "bash", args: { cmd: "ls" } },
      { type: "tool_execution_end", toolCallId: "tc1", isError: false },
      { type: "text_start" },
      { type: "text_delta", delta: "Here are the results." },
      { type: "text_end" },
      { type: "done" },
    ]);
    const state = acc.getState();
    assert.equal(state.done, true);
    assert.equal(state.committedText, "Let me check the files.Here are the results.");
    assert.equal(state.tools.length, 1);
    assert.equal(state.tools[0].status, "done");
  });

  test("thinking → text → done", () => {
    const acc = feed([
      { type: "thinking_start" },
      { type: "thinking_delta", delta: "I should " },
      { type: "thinking_delta", delta: "consider..." },
      { type: "thinking_end" },
      { type: "text_start" },
      { type: "text_delta", delta: "Here is my answer." },
      { type: "text_end" },
      { type: "done" },
    ]);
    const state = acc.getState();
    assert.equal(state.committedThinking, "I should consider...");
    assert.equal(state.committedText, "Here is my answer.");
  });

  test("text interrupted by tool flushes before tool registers", () => {
    const acc = feed([
      { type: "text_delta", delta: "Running " },
      { type: "text_delta", delta: "a command..." },
      { type: "tool_execution_start", toolCallId: "tc1", toolName: "bash", args: {} },
    ]);
    const state = acc.getState();
    assert.equal(state.committedText, "Running a command...");
    assert.equal(state.pendingText, "");
    assert.equal(state.tools.length, 1);
  });

  test("multiple rounds of text and tools", () => {
    const acc = feed([
      { type: "text_delta", delta: "Step 1: " },
      { type: "text_end" },
      { type: "tool_execution_start", toolCallId: "tc1", toolName: "bash", args: { cmd: "echo 1" } },
      { type: "tool_execution_end", toolCallId: "tc1", isError: false },
      { type: "text_start" },
      { type: "text_delta", delta: "Step 2: " },
      { type: "text_end" },
      { type: "tool_execution_start", toolCallId: "tc2", toolName: "write", args: { path: "/tmp/x" } },
      { type: "tool_execution_end", toolCallId: "tc2", isError: true },
      { type: "text_start" },
      { type: "text_delta", delta: "Done." },
      { type: "done" },
    ]);
    const state = acc.getState();
    assert.equal(state.committedText, "Step 1: Step 2: Done.");
    assert.equal(state.tools.length, 2);
    assert.equal(state.tools[0].status, "done");
    assert.equal(state.tools[1].status, "error");
  });
});
