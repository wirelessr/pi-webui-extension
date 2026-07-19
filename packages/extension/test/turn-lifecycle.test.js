/**
 * Tests for turn-lifecycle.js — the turn state machine extracted from
 * index.ts: turn-active/busy tracking, finalize grace scheduling, orphaned-
 * continuation re-assert, and the coalescing replay buffer.
 *
 * Timers are injected: setTimeoutFn captures the callback + delay, tests fire
 * it manually. No timing-based assertions.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createTurnLifecycle, lastAssistantEndedOnError } from "../turn-lifecycle.js";

/** Manual-fire timer harness. */
function makeTimers() {
  let nextId = 1;
  const scheduled = new Map();
  return {
    setTimeoutFn: (fn, delay) => {
      const id = nextId++;
      scheduled.set(id, { fn, delay });
      return id;
    },
    clearTimeoutFn: (id) => {
      scheduled.delete(id);
    },
    fireAll: () => {
      for (const id of [...scheduled.keys()]) {
        const t = scheduled.get(id);
        scheduled.delete(id);
        t.fn();
      }
    },
    pending: () => [...scheduled.values()],
    count: () => scheduled.size,
  };
}

function makeLifecycle(overrides = {}) {
  const timers = makeTimers();
  const finalized = [];
  const lc = createTurnLifecycle({
    graceMs: 1000,
    errorGraceMs: 15000,
    onFinalize: (event, wasActive) => finalized.push({ event, wasActive }),
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    ...overrides,
  });
  return { lc, timers, finalized };
}

// ── lastAssistantEndedOnError ──────────────────────────

describe("lastAssistantEndedOnError", () => {
  const cases = [
    { desc: "empty messages", messages: [], expected: false },
    { desc: "no assistant messages", messages: [{ role: "user" }], expected: false },
    { desc: "last assistant stopped clean", messages: [{ role: "assistant", stopReason: "stop" }], expected: false },
    { desc: "last assistant errored", messages: [{ role: "assistant", stopReason: "error" }], expected: true },
    {
      desc: "uses the LAST assistant message",
      messages: [
        { role: "assistant", stopReason: "error" },
        { role: "user" },
        { role: "assistant", stopReason: "stop" },
      ],
      expected: false,
    },
    {
      desc: "skips trailing non-assistant messages",
      messages: [{ role: "assistant", stopReason: "error" }, { role: "toolResult" }],
      expected: true,
    },
    { desc: "null message entries are skipped", messages: [null, { role: "assistant", stopReason: "error" }], expected: true },
  ];
  for (const c of cases) {
    test(c.desc, () => {
      assert.equal(lastAssistantEndedOnError(c.messages), c.expected);
    });
  }
});

// ── basic turn flow ────────────────────────────────────

describe("turn flow", () => {
  test("initial state is idle and inactive", () => {
    const { lc } = makeLifecycle();
    assert.equal(lc.isTurnActive(), false);
    assert.equal(lc.isBusy(), false);
    assert.equal(lc.hasPendingFinalize(), false);
  });

  test("beginTurn + agentStart claims the turn without re-assert", () => {
    const { lc } = makeLifecycle();
    lc.beginTurn();
    const { reasserted } = lc.agentStart();
    assert.equal(reasserted, false);
    assert.equal(lc.isTurnActive(), true);
    assert.equal(lc.isBusy(), true);
  });

  test("clean agent_end schedules the short grace, finalize emits done", () => {
    const { lc, timers, finalized } = makeLifecycle();
    lc.beginTurn();
    lc.agentStart();
    const res = lc.agentEnd({ messages: [] }, { willRetry: false, endedOnError: false });
    assert.deepEqual(res, { scheduled: true, graceMs: 1000 });
    assert.equal(lc.hasPendingFinalize(), true);
    assert.equal(lc.isBusy(), true); // busy holds until the grace expires
    timers.fireAll();
    assert.equal(lc.isBusy(), false);
    assert.equal(lc.isTurnActive(), false);
    assert.equal(lc.hasPendingFinalize(), false);
    assert.deepEqual(finalized, [{ event: { messages: [] }, wasActive: true }]);
  });

  test("error agent_end schedules the long grace", () => {
    const { lc, timers } = makeLifecycle();
    lc.beginTurn();
    lc.agentStart();
    const res = lc.agentEnd({}, { endedOnError: true });
    assert.deepEqual(res, { scheduled: true, graceMs: 15000 });
    assert.equal(timers.pending()[0].delay, 15000);
  });

  test("willRetry keeps the turn fully alive — no finalize scheduled", () => {
    const { lc, timers, finalized } = makeLifecycle();
    lc.beginTurn();
    lc.agentStart();
    const res = lc.agentEnd({}, { willRetry: true });
    assert.deepEqual(res, { scheduled: false, graceMs: 0 });
    assert.equal(lc.hasPendingFinalize(), false);
    assert.equal(timers.count(), 0);
    assert.equal(lc.isBusy(), true);
    assert.equal(finalized.length, 0);
  });

  test("continuation agent_start within the grace cancels the finalize", () => {
    const { lc, timers, finalized } = makeLifecycle();
    lc.beginTurn();
    lc.agentStart();
    lc.agentEnd({}, {});
    const { reasserted } = lc.agentStart(); // retry landed inside the window
    assert.equal(reasserted, false); // turn was still ours
    assert.equal(lc.hasPendingFinalize(), false);
    assert.equal(timers.count(), 0);
    assert.equal(finalized.length, 0);
    assert.equal(lc.isTurnActive(), true);
  });

  test("continuation AFTER finalize re-asserts the orphaned turn", () => {
    const { lc, timers, finalized } = makeLifecycle();
    lc.beginTurn();
    lc.agentStart();
    lc.agentEnd({}, { endedOnError: true });
    timers.fireAll(); // backoff outran the grace — turn finalized
    assert.equal(finalized.length, 1);
    assert.equal(lc.isTurnActive(), false);
    const { reasserted } = lc.agentStart(); // the retry finally lands
    assert.equal(reasserted, true);
    assert.equal(lc.isTurnActive(), true);
    assert.equal(lc.isBusy(), true);
  });

  test("re-scheduled agent_end replaces the previous pending finalize", () => {
    const { lc, timers, finalized } = makeLifecycle();
    lc.beginTurn();
    lc.agentStart();
    lc.agentEnd({ n: 1 }, {});
    lc.agentEnd({ n: 2 }, {});
    assert.equal(timers.count(), 1); // first timer was cleared
    timers.fireAll();
    assert.deepEqual(finalized, [{ event: { n: 2 }, wasActive: true }]);
  });

  test("finalize with an abandoned turn reports wasActive=false", () => {
    const { lc, timers, finalized } = makeLifecycle();
    lc.beginTurn();
    lc.agentStart();
    lc.abandonTurn(); // watchdog gave up on the turn
    lc.agentEnd({}, {});
    timers.fireAll();
    assert.equal(lc.isBusy(), false);
    assert.deepEqual(finalized, [{ event: {}, wasActive: false }]);
  });

  test("abandonTurn leaves busy tracking alone", () => {
    const { lc } = makeLifecycle();
    lc.beginTurn();
    lc.agentStart();
    lc.abandonTurn();
    assert.equal(lc.isTurnActive(), false);
    assert.equal(lc.isBusy(), true);
  });

  test("shutdown drops everything without emitting a finalize", () => {
    const { lc, timers, finalized } = makeLifecycle();
    lc.beginTurn();
    lc.agentStart();
    lc.recordEvent({ type: "text_delta", delta: "x" });
    lc.agentEnd({}, {});
    lc.shutdown();
    assert.equal(lc.isTurnActive(), false);
    assert.equal(lc.isBusy(), false);
    assert.equal(lc.hasPendingFinalize(), false);
    assert.equal(lc.bufferedCount(), 0);
    assert.equal(timers.count(), 0);
    timers.fireAll();
    assert.equal(finalized.length, 0);
  });

  test("cancelPendingFinalize is a no-op with nothing scheduled", () => {
    const { lc } = makeLifecycle();
    lc.cancelPendingFinalize(); // must not throw
    assert.equal(lc.hasPendingFinalize(), false);
  });

  test("default grace values match the production constants", () => {
    const timers = makeTimers();
    const lc = createTurnLifecycle({ setTimeoutFn: timers.setTimeoutFn, clearTimeoutFn: timers.clearTimeoutFn });
    lc.beginTurn();
    lc.agentStart();
    assert.deepEqual(lc.agentEnd({}, {}), { scheduled: true, graceMs: 1000 });
    assert.deepEqual(lc.agentEnd({}, { endedOnError: true }), { scheduled: true, graceMs: 15000 });
    timers.fireAll(); // default onFinalize must not throw
  });

  test("agentEnd defaults flags when omitted", () => {
    const { lc } = makeLifecycle();
    lc.beginTurn();
    lc.agentStart();
    assert.deepEqual(lc.agentEnd({}), { scheduled: true, graceMs: 1000 });
  });
});

// ── replay buffer + coalescing ─────────────────────────

describe("replay buffer", () => {
  test("recordEvent drops events when no turn is active", () => {
    const { lc } = makeLifecycle();
    assert.equal(lc.recordEvent({ type: "text_delta", delta: "x" }), false);
    assert.equal(lc.bufferedCount(), 0);
  });

  test("agentStart resets the buffer", () => {
    const { lc } = makeLifecycle();
    lc.beginTurn();
    lc.agentStart();
    lc.recordEvent({ type: "text_delta", delta: "old" });
    lc.agentStart();
    assert.equal(lc.bufferedCount(), 0);
  });

  test("consecutive text_deltas coalesce into one event", () => {
    const { lc } = makeLifecycle();
    lc.beginTurn();
    lc.agentStart();
    assert.equal(lc.recordEvent({ type: "text_start" }), true);
    lc.recordEvent({ type: "text_delta", delta: "he" });
    lc.recordEvent({ type: "text_delta", delta: "ll" });
    lc.recordEvent({ type: "text_delta", delta: "o" });
    lc.recordEvent({ type: "text_end" });
    assert.deepEqual(lc.bufferedEvents(), [
      { type: "text_start" },
      { type: "text_delta", delta: "hello" },
      { type: "text_end" },
    ]);
  });

  test("thinking_deltas coalesce too, but never merge with text_deltas", () => {
    const { lc } = makeLifecycle();
    lc.beginTurn();
    lc.agentStart();
    lc.recordEvent({ type: "thinking_delta", delta: "a" });
    lc.recordEvent({ type: "thinking_delta", delta: "b" });
    lc.recordEvent({ type: "text_delta", delta: "c" });
    lc.recordEvent({ type: "text_delta", delta: "d" });
    assert.deepEqual(lc.bufferedEvents(), [
      { type: "thinking_delta", delta: "ab" },
      { type: "text_delta", delta: "cd" },
    ]);
  });

  test("segment boundaries break the coalescing run", () => {
    const { lc } = makeLifecycle();
    lc.beginTurn();
    lc.agentStart();
    lc.recordEvent({ type: "text_delta", delta: "before " });
    lc.recordEvent({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash" });
    lc.recordEvent({ type: "text_delta", delta: "after" });
    assert.deepEqual(lc.bufferedEvents(), [
      { type: "text_delta", delta: "before " },
      { type: "tool_execution_start", toolCallId: "t1", toolName: "bash" },
      { type: "text_delta", delta: "after" },
    ]);
  });

  test("a text_start between deltas starts a fresh buffered delta", () => {
    const { lc } = makeLifecycle();
    lc.beginTurn();
    lc.agentStart();
    lc.recordEvent({ type: "text_delta", delta: "seg1" });
    lc.recordEvent({ type: "text_end" });
    lc.recordEvent({ type: "text_start" });
    lc.recordEvent({ type: "text_delta", delta: "seg2" });
    assert.deepEqual(lc.bufferedEvents(), [
      { type: "text_delta", delta: "seg1" },
      { type: "text_end" },
      { type: "text_start" },
      { type: "text_delta", delta: "seg2" },
    ]);
  });

  test("coalescing copies rather than mutating the recorded event", () => {
    const { lc } = makeLifecycle();
    lc.beginTurn();
    lc.agentStart();
    const first = { type: "text_delta", delta: "a" };
    lc.recordEvent(first);
    lc.recordEvent({ type: "text_delta", delta: "b" });
    assert.equal(first.delta, "a"); // the live-SSE copy is untouched
    assert.deepEqual(lc.bufferedEvents(), [{ type: "text_delta", delta: "ab" }]);
  });

  test("a delta with a non-string payload is buffered as-is, no merge", () => {
    const { lc } = makeLifecycle();
    lc.beginTurn();
    lc.agentStart();
    lc.recordEvent({ type: "text_delta", delta: "a" });
    lc.recordEvent({ type: "text_delta", delta: 42 });
    assert.equal(lc.bufferedCount(), 2);
  });

  test("bufferedEvents returns a snapshot, not the live array", () => {
    const { lc } = makeLifecycle();
    lc.beginTurn();
    lc.agentStart();
    lc.recordEvent({ type: "text_delta", delta: "a" });
    const snap = lc.bufferedEvents();
    snap.push({ type: "bogus" });
    assert.equal(lc.bufferedCount(), 1);
  });
});

describe("noteAbortRequested — immediate finalize on manual abort", () => {
  test("agent_end after an abort finalizes synchronously, no grace timer", () => {
    const { lc, timers, finalized } = makeLifecycle();
    lc.beginTurn();
    lc.agentStart();
    lc.noteAbortRequested();
    const result = lc.agentEnd({ id: "e" }, { endedOnError: false });
    assert.deepEqual(result, { scheduled: true, graceMs: 0 });
    assert.equal(finalized.length, 1);
    assert.equal(finalized[0].wasActive, true);
    assert.equal(lc.isBusy(), false);
    assert.equal(lc.hasPendingFinalize(), false);
    assert.equal(timers.count(), 0);
  });

  test("abort wins over willRetry and endedOnError", () => {
    const { lc, finalized } = makeLifecycle();
    lc.beginTurn();
    lc.agentStart();
    lc.noteAbortRequested();
    lc.agentEnd({}, { willRetry: true, endedOnError: true });
    assert.equal(finalized.length, 1);
    assert.equal(lc.isBusy(), false);
  });

  test("flag is one-shot: the next agent_end schedules normally", () => {
    const { lc, timers, finalized } = makeLifecycle();
    lc.beginTurn();
    lc.agentStart();
    lc.noteAbortRequested();
    lc.agentEnd({}, {});
    assert.equal(finalized.length, 1);
    lc.beginTurn();
    lc.agentStart();
    const result = lc.agentEnd({}, {});
    assert.deepEqual(result, { scheduled: true, graceMs: 1000 });
    assert.equal(finalized.length, 1);
    timers.fireAll();
    assert.equal(finalized.length, 2);
  });

  test("abort-while-idle does not poison the next turn (agentStart clears it)", () => {
    const { lc, timers, finalized } = makeLifecycle();
    lc.noteAbortRequested(); // abort clicked with no turn running
    lc.beginTurn();
    lc.agentStart();
    const result = lc.agentEnd({}, {});
    assert.deepEqual(result, { scheduled: true, graceMs: 1000 });
    assert.equal(finalized.length, 0);
    timers.fireAll();
    assert.equal(finalized.length, 1);
  });

  test("shutdown clears a pending abort flag", () => {
    const { lc, timers, finalized } = makeLifecycle();
    lc.beginTurn();
    lc.agentStart();
    lc.noteAbortRequested();
    lc.shutdown();
    lc.beginTurn();
    lc.agentStart();
    const result = lc.agentEnd({}, {});
    assert.deepEqual(result, { scheduled: true, graceMs: 1000 });
    assert.equal(finalized.length, 0);
    timers.fireAll();
    assert.equal(finalized.length, 1);
  });
});
