import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { doInit, doModelCommand, doReattach, doSelectCommand, doSendPrompt, doStop, parseModelCommand, parseResumeCommand, resolveModelArg, syncExpandButtonState } from "../src/flow.js";

// ── Mock helpers ──────────────────────────────────────

function mockChat(overrides = {}) {
  const calls = {
    addMessage: [],
    startAssistantMessage: 0,
    finishAssistantMessage: 0,
    handleEvent: [],
    showError: [],
    loadHistory: [],
  };
  return {
    calls,
    addMessage: (role, text) => calls.addMessage.push({ role, text }),
    startAssistantMessage: () => calls.startAssistantMessage++,
    finishAssistantMessage: () => calls.finishAssistantMessage++,
    handleEvent: (event) => calls.handleEvent.push(event),
    showError: (msg) => calls.showError.push(msg),
    loadHistory: (history) => calls.loadHistory.push(history),
    ...overrides,
  };
}

function mockInput(overrides = {}) {
  const calls = {
    setStreaming: [],
    selectCommand: [],
  };
  return {
    calls,
    setStreaming: (streaming) => calls.setStreaming.push(streaming),
    selectCommand: (cmd) => calls.selectCommand.push(cmd),
    ...overrides,
  };
}

// ── doSendPrompt ──────────────────────────────────────

describe("doSendPrompt — core send flow", () => {
  const makeOpts = (overrides = {}) => ({
    text: "hello",
    chat: mockChat(),
    input: mockInput(),
    setBusyFn: () => {},
    sendPromptStreamFn: async () => {},
    getHistoryFn: async () => ({ history: [] }),
    getStatusFn: async () => ({ port: 7331, pid: 12345 }),
    onStatusUpdateFn: () => {},
    ...overrides,
  });

  test("calls onCompleteFn when the stream completes", async () => {
    let called = 0;
    const opts = makeOpts({
      sendPromptStreamFn: async (_msg, onEvent) => { onEvent({ type: "done" }); },
      onCompleteFn: () => { called++; },
    });
    const result = await doSendPrompt(opts);
    assert.equal(result.completed, true);
    assert.equal(called, 1);
  });

  test("swallows errors thrown by onCompleteFn", async () => {
    const opts = makeOpts({
      sendPromptStreamFn: async (_msg, onEvent) => { onEvent({ type: "done" }); },
      onCompleteFn: () => { throw new Error("boom"); },
    });
    const result = await doSendPrompt(opts);
    assert.equal(result.completed, true);
  });

  test("does not call onCompleteFn when the stream is incomplete", async () => {
    let called = 0;
    const opts = makeOpts({
      sendPromptStreamFn: async () => {},
      onCompleteFn: () => { called++; },
    });
    await doSendPrompt(opts);
    assert.equal(called, 0);
  });

  test("shows user message before SSE starts", async () => {
    const order = [];
    const chat = mockChat({
      addMessage: (role, _text) => order.push(`addMessage:${role}`),
      startAssistantMessage: () => order.push("startAssistant"),
    });
    const input = mockInput({
      setStreaming: (s) => order.push(`setStreaming:${s}`),
    });
    const opts = makeOpts({
      chat,
      input,
      setBusyFn: () => order.push("setBusy"),
      sendPromptStreamFn: async () => order.push("stream"),
    });
    await doSendPrompt(opts);
    assert.ok(order.indexOf("addMessage:user") < order.indexOf("setStreaming:true"));
    assert.ok(order.indexOf("setStreaming:true") < order.indexOf("setBusy"));
    assert.ok(order.indexOf("setBusy") < order.indexOf("startAssistant"));
    assert.ok(order.indexOf("startAssistant") < order.indexOf("stream"));
  });

  test("dispatches all SSE events to chat", async () => {
    const chat = mockChat();
    const events = [
      { type: "text_start" },
      { type: "text_delta", delta: "hello" },
      { type: "text_end" },
      { type: "done" },
    ];
    const opts = makeOpts({
      chat,
      sendPromptStreamFn: async (_msg, onEvent) => {
        for (const e of events) onEvent(e);
      },
    });
    await doSendPrompt(opts);
    assert.deepEqual(chat.calls.handleEvent, events);
  });

  test("done event → completed=true, no history reload", async () => {
    const chat = mockChat();
    const opts = makeOpts({
      chat,
      sendPromptStreamFn: async (_msg, onEvent) => onEvent({ type: "done" }),
      getHistoryFn: async () => { throw new Error("should not be called"); },
    });
    const result = await doSendPrompt(opts);
    assert.equal(result.completed, true);
    assert.equal(result.historyReloaded, false);
    assert.equal(chat.calls.loadHistory.length, 0);
  });

  test("compact done event → shows system message, no history reload", async () => {
    const chat = mockChat();
    const opts = makeOpts({
      chat,
      sendPromptStreamFn: async (_msg, onEvent) => onEvent({
        type: "done", text: "summary", compact: true, tokensBefore: 50000,
      }),
      getHistoryFn: async () => { throw new Error("should not be called"); },
    });
    const result = await doSendPrompt(opts);
    assert.equal(result.completed, true);
    assert.equal(result.historyReloaded, false);
    assert.equal(chat.calls.loadHistory.length, 0);
    const sysMsg = chat.calls.addMessage.find((c) => c.role === "system");
    assert.ok(sysMsg, "system message added");
    assert.match(sysMsg.text, /compacted/);
    assert.match(sysMsg.text, /50000/);
    assert.match(sysMsg.text, /summary/);
  });

  test("compact error (tokensBefore=null) → shows error text, not 'compacted'", async () => {
    const chat = mockChat();
    const opts = makeOpts({
      chat,
      sendPromptStreamFn: async (_msg, onEvent) => onEvent({
        type: "done", text: "Compact failed: nothing to compact", compact: true, tokensBefore: null,
      }),
      getHistoryFn: async () => { throw new Error("should not be called"); },
    });
    const result = await doSendPrompt(opts);
    assert.equal(result.completed, true);
    const sysMsg = chat.calls.addMessage.find((c) => c.role === "system");
    assert.ok(sysMsg);
    assert.match(sysMsg.text, /Compact failed/);
    assert.doesNotMatch(sysMsg.text, /Session compacted/);
  });

  test("compact done event + history fetch fails → no crash", async () => {
    const chat = mockChat();
    const opts = makeOpts({
      chat,
      sendPromptStreamFn: async (_msg, onEvent) => onEvent({
        type: "done", compact: true, tokensBefore: 1000,
      }),
      getHistoryFn: async () => { throw new Error("fetch failed"); },
    });
    const result = await doSendPrompt(opts);
    assert.equal(result.completed, true);
    assert.equal(result.historyReloaded, false);
  });

  test("no done event → history reload (safety net)", async () => {
    const chat = mockChat();
    const opts = makeOpts({
      chat,
      sendPromptStreamFn: async () => {}, // stream ends without done
      getHistoryFn: async () => ({ history: [{ role: "user", text: "hi" }] }),
    });
    const result = await doSendPrompt(opts);
    assert.equal(result.completed, false);
    assert.equal(result.historyReloaded, true);
    assert.equal(chat.calls.loadHistory.length, 1);
  });

  test("no done event + empty history → no reload", async () => {
    const chat = mockChat();
    const opts = makeOpts({
      chat,
      sendPromptStreamFn: async () => {},
      getHistoryFn: async () => ({ history: [] }),
    });
    const result = await doSendPrompt(opts);
    assert.equal(result.completed, false);
    assert.equal(result.historyReloaded, false);
  });

  test("stream error → showError + cleanup still runs", async () => {
    const chat = mockChat();
    const input = mockInput();
    let busySet = [];
    const opts = makeOpts({
      chat,
      input,
      setBusyFn: (b) => busySet.push(b),
      sendPromptStreamFn: async () => { throw new Error("Connection refused"); },
    });
    const result = await doSendPrompt(opts);
    assert.equal(result.error, "Connection refused");
    assert.equal(chat.calls.showError.length, 1);
    assert.equal(chat.calls.showError[0], "Connection refused");
    assert.equal(chat.calls.finishAssistantMessage, 1);
    assert.deepEqual(input.calls.setStreaming, [true, false]);
    assert.deepEqual(busySet, [true, false]);
  });

  test("cleanup always runs after error: finishAssistant + setStreaming(false) + setBusy(false)", async () => {
    const chat = mockChat();
    const input = mockInput();
    let busyStates = [];
    const opts = makeOpts({
      chat,
      input,
      setBusyFn: (b) => busyStates.push(b),
      sendPromptStreamFn: async () => { throw new Error("boom"); },
    });
    await doSendPrompt(opts);
    assert.equal(chat.calls.finishAssistantMessage, 1);
    assert.deepEqual(input.calls.setStreaming, [true, false]);
    assert.deepEqual(busyStates, [true, false]);
  });

  test("stats always refreshed after stream", async () => {
    let statusCalled = false;
    const opts = makeOpts({
      sendPromptStreamFn: async (_msg, onEvent) => onEvent({ type: "done" }),
      getStatusFn: async () => { statusCalled = true; return { port: 7331 }; },
    });
    await doSendPrompt(opts);
    assert.ok(statusCalled);
  });

  test("stats refreshed even after stream error", async () => {
    let statusCalled = false;
    const opts = makeOpts({
      sendPromptStreamFn: async () => { throw new Error("fail"); },
      getStatusFn: async () => { statusCalled = true; return { port: 7331 }; },
    });
    await doSendPrompt(opts);
    assert.ok(statusCalled);
  });

  test("onStatusUpdateFn called with status data", async () => {
    let receivedStatus = null;
    const opts = makeOpts({
      getStatusFn: async () => ({ port: 7331, pid: 99999 }),
      onStatusUpdateFn: (s) => { receivedStatus = s; },
    });
    await doSendPrompt(opts);
    assert.equal(receivedStatus.pid, 99999);
  });

  test("getStatus failure does not crash after successful stream", async () => {
    const opts = makeOpts({
      sendPromptStreamFn: async (_msg, onEvent) => onEvent({ type: "done" }),
      getStatusFn: async () => { throw new Error("status fail"); },
    });
    const result = await doSendPrompt(opts);
    assert.equal(result.completed, true);
  });

  test("getHistory failure during safety net does not crash", async () => {
    const opts = makeOpts({
      sendPromptStreamFn: async () => {}, // no done event
      getHistoryFn: async () => { throw new Error("history fail"); },
    });
    const result = await doSendPrompt(opts);
    assert.equal(result.completed, false);
    assert.equal(result.historyReloaded, false);
  });
});

// ── doSelectCommand ───────────────────────────────────

describe("doSelectCommand — command dispatch", () => {
  test("executable builtin → executeCommand + system message", async () => {
    const chat = mockChat();
    let execCalled = null;
    const result = await doSelectCommand({
      cmd: { name: "compact", source: "builtin", executable: true },
      chat,
      input: mockInput(),
      executeCommandFn: async (name) => { execCalled = name; },
    });
    assert.equal(result.action, "executed");
    assert.equal(execCalled, "compact");
    assert.equal(chat.calls.addMessage.length, 1);
    assert.equal(chat.calls.addMessage[0].role, "system");
    assert.equal(chat.calls.addMessage[0].text, "/compact triggered");
  });

  test("executable builtin error → showError", async () => {
    const chat = mockChat();
    const result = await doSelectCommand({
      cmd: { name: "reload", source: "builtin", executable: true },
      chat,
      input: mockInput(),
      executeCommandFn: async () => { throw new Error("reload failed"); },
    });
    assert.equal(result.action, "error");
    assert.equal(chat.calls.showError.length, 1);
    assert.match(chat.calls.showError[0], /reload failed/);
  });

  const nonExecCases = [
    { name: "skill → insert into input", cmd: { name: "skill:gh", source: "skill" } },
    { name: "template → insert into input", cmd: { name: "fix-tests", source: "template" } },
    { name: "non-executable builtin → insert into input", cmd: { name: "help", source: "builtin", executable: false } },
  ];
  for (const c of nonExecCases) {
    test(c.name, async () => {
      const input = mockInput();
      const result = await doSelectCommand({
        cmd: c.cmd,
        chat: mockChat(),
        input,
        executeCommandFn: async () => { throw new Error("should not call"); },
      });
      assert.equal(result.action, "inserted");
      assert.equal(input.calls.selectCommand.length, 0);
    });
  }
});

// ── doStop ────────────────────────────────────────────

describe("doStop — abort flow", () => {
  test("successful abort", async () => {
    let abortCalled = false;
    const result = await doStop({
      chat: mockChat(),
      abortFn: async () => { abortCalled = true; },
    });
    assert.equal(result.action, "aborted");
    assert.ok(abortCalled);
  });

  test("abort error → showError", async () => {
    const chat = mockChat();
    const result = await doStop({
      chat,
      abortFn: async () => { throw new Error("abort failed"); },
    });
    assert.equal(result.action, "error");
    assert.equal(chat.calls.showError.length, 1);
    assert.match(chat.calls.showError[0], /abort failed/);
  });
});

// ── doInit ────────────────────────────────────────────

describe("doInit — initialization sequence", () => {
  test("loads status, commands, sessions, history in order", async () => {
    const order = [];
    const result = await doInit({
      getStatusFn: async () => { order.push("status"); return { port: 7331, pid: 1, sessionName: "test" }; },
      getHistoryFn: async () => { order.push("history"); return { history: [{ role: "user", text: "hi" }] }; },
      loadCommandsFn: async () => { order.push("commands"); },
      loadSessionsFn: () => { order.push("sessions"); },
      loadHistoryFn: () => { order.push("loadHistory"); },
      autoResizeFn: () => { order.push("autoResize"); },
      onStatusFn: () => { order.push("onStatus"); },
    });
    assert.ok(result.statusLoaded);
    assert.ok(result.commandsLoaded);
    assert.ok(result.sessionsLoaded);
    assert.ok(result.historyLoaded);
    // Status first, then commands, then sessions, then autoResize, then history
    assert.equal(order[0], "status");
    assert.equal(order[1], "onStatus");
    assert.equal(order[2], "commands");
    assert.equal(order[3], "sessions");
    assert.equal(order[4], "autoResize");
    assert.equal(order[5], "history");
    assert.equal(order[6], "loadHistory");
  });

  test("status failure does not block commands/sessions/history", async () => {
    const result = await doInit({
      getStatusFn: async () => { throw new Error("not ready"); },
      getHistoryFn: async () => ({ history: [{ role: "user", text: "hi" }] }),
      loadCommandsFn: async () => {},
      loadSessionsFn: () => {},
      loadHistoryFn: () => {},
      autoResizeFn: () => {},
      onStatusFn: () => {},
    });
    assert.equal(result.statusLoaded, false);
    assert.ok(result.commandsLoaded);
    assert.ok(result.sessionsLoaded);
    assert.ok(result.historyLoaded);
  });

  test("empty history → historyLoaded=false", async () => {
    const result = await doInit({
      getStatusFn: async () => ({ port: 7331 }),
      getHistoryFn: async () => ({ history: [] }),
      loadCommandsFn: async () => {},
      loadSessionsFn: () => {},
      loadHistoryFn: () => {},
      autoResizeFn: () => {},
      onStatusFn: () => {},
    });
    assert.equal(result.historyLoaded, false);
  });

  test("history failure does not crash init", async () => {
    const result = await doInit({
      getStatusFn: async () => ({ port: 7331 }),
      getHistoryFn: async () => { throw new Error("no history"); },
      loadCommandsFn: async () => {},
      loadSessionsFn: () => {},
      loadHistoryFn: () => {},
      autoResizeFn: () => {},
      onStatusFn: () => {},
    });
    assert.equal(result.historyLoaded, false);
    assert.ok(result.statusLoaded);
  });

  test("onStatusFn receives full status object", async () => {
    let received = null;
    await doInit({
      getStatusFn: async () => ({ port: 7331, pid: 12345, sessionName: "my-session", sessionId: "abc123" }),
      getHistoryFn: async () => ({ history: [] }),
      loadCommandsFn: async () => {},
      loadSessionsFn: () => {},
      loadHistoryFn: () => {},
      autoResizeFn: () => {},
      onStatusFn: (s) => { received = s; },
    });
    assert.equal(received.port, 7331);
    assert.equal(received.pid, 12345);
    assert.equal(received.sessionName, "my-session");
  });

  test("commands failure does not block sessions/history", async () => {
    const result = await doInit({
      getStatusFn: async () => ({ port: 7331 }),
      getHistoryFn: async () => ({ history: [{ role: "user", text: "hi" }] }),
      loadCommandsFn: async () => { throw new Error("commands fail"); },
      loadSessionsFn: () => {},
      loadHistoryFn: () => {},
      autoResizeFn: () => {},
      onStatusFn: () => {},
    });
    assert.equal(result.commandsLoaded, false);
    assert.ok(result.sessionsLoaded);
    assert.ok(result.historyLoaded);
  });

  test("sessions failure does not block history", async () => {
    const result = await doInit({
      getStatusFn: async () => ({ port: 7331 }),
      getHistoryFn: async () => ({ history: [{ role: "user", text: "hi" }] }),
      loadCommandsFn: async () => {},
      loadSessionsFn: () => { throw new Error("sessions fail"); },
      loadHistoryFn: () => {},
      autoResizeFn: () => {},
      onStatusFn: () => {},
    });
    assert.ok(result.commandsLoaded);
    assert.equal(result.sessionsLoaded, false);
    assert.ok(result.historyLoaded);
  });

  test("busy session triggers attachStream", async () => {
    let busyCalled = false;
    let streamingCalled = false;
    let attachCalled = false;
    await doInit({
      getStatusFn: async () => { return { port: 7331, busy: true }; },
      getHistoryFn: async () => ({ history: [] }),
      loadCommandsFn: async () => {},
      loadSessionsFn: () => {},
      loadHistoryFn: () => {},
      autoResizeFn: () => {},
      onStatusFn: () => {},
      attachStreamFn: (onEvent) => { attachCalled = true; return Promise.resolve(true); },
      onStreamEventFn: () => {},
      setBusyFn: (v) => { busyCalled = v; },
      setStreamingFn: (v) => { streamingCalled = v; },
    });
    assert.ok(attachCalled, "attachStreamFn should be called when busy");
    assert.ok(busyCalled, "setBusyFn should be called with true");
    assert.ok(streamingCalled, "setStreamingFn should be called with true");
  });

  test("not busy session still tries attachStream (for buffered done)", async () => {
    let attachCalled = false;
    await doInit({
      getStatusFn: async () => { return { port: 7331, busy: false }; },
      getHistoryFn: async () => ({ history: [] }),
      loadCommandsFn: async () => {},
      loadSessionsFn: () => {},
      loadHistoryFn: () => {},
      autoResizeFn: () => {},
      onStatusFn: () => {},
      attachStreamFn: () => { attachCalled = true; return Promise.resolve(false); },
      onStreamEventFn: () => {},
      setBusyFn: () => {},
      setStreamingFn: () => {},
    });
    // attachStream is always called now; backend returns 409 if nothing to attach
    assert.equal(attachCalled, true);
  });

  // Retry/rejection behavior is exercised directly against doReattach (below),
  // which is awaitable — doInit fires it fire-and-forget, so asserting on it
  // through doInit would be timing-dependent and flaky.
});

// ── syncExpandButtonState ─────────────────────────────

describe("syncExpandButtonState", () => {
  const cases = [
    { desc: "no blocks → button false", total: 0, expanded: 0, toolsExpanded: false, expectButton: false, expectExpandCalled: false },
    { desc: "all expanded → button true", total: 3, expanded: 3, toolsExpanded: false, expectButton: true, expectExpandCalled: false },
    { desc: "some collapsed → button false", total: 3, expanded: 1, toolsExpanded: false, expectButton: false, expectExpandCalled: false },
    { desc: "button says expanded but DOM collapsed → re-expand", total: 2, expanded: 0, toolsExpanded: true, expectButton: true, expectExpandCalled: true },
    { desc: "button says expanded and DOM matches → stay true", total: 2, expanded: 2, toolsExpanded: true, expectButton: true, expectExpandCalled: false },
  ];

  for (const { desc, total, expanded, toolsExpanded, expectButton, expectExpandCalled } of cases) {
    test(desc, () => {
      let buttonState = null;
      let expandCalled = false;
      const result = syncExpandButtonState({
        toolsExpanded,
        countAllFn: () => total,
        countExpandedFn: () => expanded,
        expandAllToolsFn: () => { expandCalled = true; },
        onStateChange: (val) => { buttonState = val; },
      });
      assert.strictEqual(buttonState, expectButton);
      assert.strictEqual(expandCalled, expectExpandCalled);
      assert.strictEqual(result.expanded, expectButton);
    });
  }
});

// ── doInit attach error handling ──────────────────────

describe("doInit — attach block error handling", () => {
  test("swallows errors when status fetch throws with attach configured", async () => {
    const result = await doInit({
      getStatusFn: async () => { throw new Error("server down"); },
      getHistoryFn: async () => ({ history: [] }),
      loadCommandsFn: async () => {},
      loadSessionsFn: () => {},
      loadHistoryFn: () => {},
      autoResizeFn: () => {},
      onStatusFn: () => {},
      attachStreamFn: () => Promise.resolve(true),
      onStreamEventFn: () => {},
      setBusyFn: () => {},
      setStreamingFn: () => {},
    });
    // getStatus threw, so status never loaded — but doInit must not reject.
    assert.equal(result.statusLoaded, false);
  });
});

// ── doReattach ────────────────────────────────────────

describe("doReattach", () => {
  test("fetches status when not provided and attaches when busy", async () => {
    let attached = false;
    const busyValues = [];
    const result = await doReattach({
      getStatusFn: async () => ({ port: 7331, busy: true }),
      attachStreamFn: () => { attached = true; return Promise.resolve(true); },
      onStreamEventFn: () => {},
      setBusyFn: (v) => busyValues.push(v),
      setStreamingFn: () => {},
      onStatusFn: () => {},
      attachRetryDelayMs: 0,
    });
    assert.ok(attached);
    assert.deepEqual(result, { attached: true, busy: true });
    assert.deepEqual(busyValues, [true]);
  });

  test("returns early when status fetch throws", async () => {
    let attachCalled = false;
    const result = await doReattach({
      getStatusFn: async () => { throw new Error("down"); },
      attachStreamFn: () => { attachCalled = true; return Promise.resolve(true); },
      onStreamEventFn: () => {},
    });
    assert.equal(attachCalled, false);
    assert.deepEqual(result, { attached: false, busy: false });
  });

  test("idle with nothing buffered makes a single attempt", async () => {
    let attempts = 0;
    const result = await doReattach({
      getStatusFn: async () => ({ port: 7331, busy: false }),
      attachStreamFn: () => { attempts++; return Promise.resolve(false); },
      onStreamEventFn: () => {},
      attachRetryDelayMs: 0,
    });
    assert.equal(attempts, 1);
    assert.deepEqual(result, { attached: false, busy: false });
  });

  test("busy attach retries up to 3 times then resets busy state", async () => {
    const busyValues = [];
    let attempts = 0;
    const result = await doReattach({
      status: { port: 7331, busy: true },
      attachStreamFn: () => { attempts++; return Promise.resolve(false); },
      onStreamEventFn: () => {},
      setBusyFn: (v) => busyValues.push(v),
      setStreamingFn: () => {},
      attachRetryDelayMs: 0,
    });
    assert.equal(attempts, 3, "busy attach should retry up to 3 times");
    assert.deepEqual(busyValues, [true, false]);
    assert.deepEqual(result, { attached: false, busy: true });
  });

  test("busy attach stops retrying once it succeeds (transient 409)", async () => {
    const busyValues = [];
    let attempts = 0;
    const result = await doReattach({
      status: { port: 7331, busy: true },
      attachStreamFn: () => { attempts++; return Promise.resolve(attempts >= 2); },
      onStreamEventFn: () => {},
      setBusyFn: (v) => busyValues.push(v),
      setStreamingFn: () => {},
      attachRetryDelayMs: 0,
    });
    assert.equal(attempts, 2, "attach should stop retrying once it succeeds");
    // Busy stays true — the done event from the stream clears it later.
    assert.deepEqual(busyValues, [true]);
    assert.equal(result.attached, true);
  });

  test("busy attach rejection resets busy state after retries", async () => {
    const busyValues = [];
    const result = await doReattach({
      status: { port: 7331, busy: true },
      attachStreamFn: () => Promise.reject(new Error("attach failed")),
      onStreamEventFn: () => {},
      setBusyFn: (v) => busyValues.push(v),
      setStreamingFn: () => {},
      attachRetryDelayMs: 0,
    });
    assert.deepEqual(busyValues, [true, false]);
    assert.equal(result.attached, false);
  });

  test("uses a pre-fetched status without calling getStatusFn", async () => {
    let statusFetched = false;
    const result = await doReattach({
      status: { port: 7331, busy: true },
      getStatusFn: async () => { statusFetched = true; return { busy: false }; },
      attachStreamFn: () => Promise.resolve(true),
      onStreamEventFn: () => {},
      setBusyFn: () => {},
      setStreamingFn: () => {},
      attachRetryDelayMs: 0,
    });
    assert.equal(statusFetched, false);
    assert.equal(result.attached, true);
  });
});

describe("parseModelCommand", () => {
  const cases = [
    { name: "bare /model", text: "/model", expected: { arg: "" } },
    { name: "with arg", text: "/model fireworks/glm-5p2", expected: { arg: "fireworks/glm-5p2" } },
    { name: "extra whitespace", text: "  /model   foo  ", expected: { arg: "foo" } },
    { name: "not a model command", text: "hello", expected: null },
    { name: "prefix but different command", text: "/models", expected: null },
    { name: "mid-sentence /model", text: "use /model please", expected: null },
    { name: "empty string", text: "", expected: null },
    { name: "undefined", text: undefined, expected: null },
  ];
  for (const c of cases) {
    test(c.name, () => assert.deepEqual(parseModelCommand(c.text), c.expected));
  }
});

describe("parseResumeCommand", () => {
  const cases = [
    { name: "with id", text: "/resume 019f5f1a-aca9-73c3-8675-9fdc4cbc3582", expected: { id: "019f5f1a-aca9-73c3-8675-9fdc4cbc3582" } },
    { name: "short prefix id", text: "/resume 019f5f1a", expected: { id: "019f5f1a" } },
    { name: "extra whitespace", text: "  /resume   abc123  ", expected: { id: "abc123" } },
    { name: "bare /resume (no id) → null", text: "/resume", expected: null },
    { name: "/resume with only spaces → null", text: "/resume   ", expected: null },
    { name: "not a resume command", text: "hello", expected: null },
    { name: "prefix but different command", text: "/resumes", expected: null },
    { name: "mid-sentence /resume", text: "please /resume x", expected: null },
    { name: "empty string", text: "", expected: null },
    { name: "undefined", text: undefined, expected: null },
  ];
  for (const c of cases) {
    test(c.name, () => assert.deepEqual(parseResumeCommand(c.text), c.expected));
  }
});

describe("resolveModelArg", () => {
  const models = [
    { provider: "fireworks", id: "accounts/fireworks/models/glm-5p2" },
    { provider: "anthropic", id: "claude-opus-4-8" },
    { provider: "anthropic", id: "claude-haiku-4-5" },
    { provider: "other", id: "claude-opus-4-8" },
  ];
  const cases = [
    { name: "exact provider/id wins", arg: "anthropic/claude-opus-4-8", expected: [models[1]] },
    { name: "exact id (unique)", arg: "accounts/fireworks/models/glm-5p2", expected: [models[0]] },
    { name: "exact id (duplicated across providers)", arg: "claude-opus-4-8", expected: [models[1], models[3]] },
    { name: "exact last path segment beats substring", arg: "glm-5p2", expected: [models[0]] },
    { name: "substring unique", arg: "glm", expected: [models[0]] },
    { name: "substring case-insensitive", arg: "HAIKU", expected: [models[2]] },
    { name: "substring ambiguous", arg: "claude", expected: [models[1], models[2], models[3]] },
    { name: "no match", arg: "nope", expected: [] },
  ];
  for (const c of cases) {
    test(c.name, () => assert.deepEqual(resolveModelArg(models, c.arg), c.expected));
  }

  test("last-segment match is not fooled by a longer variant", () => {
    const withVariant = [
      { provider: "fireworks", id: "accounts/fireworks/models/glm-5p2" },
      { provider: "fireworks", id: "accounts/fireworks/routers/glm-5p2-fast" },
    ];
    assert.deepEqual(resolveModelArg(withVariant, "glm-5p2"), [withVariant[0]]);
  });
});

describe("doModelCommand", () => {
  function mockChat() {
    const messages = [];
    const errors = [];
    return {
      messages,
      errors,
      addMessage: (role, text) => messages.push({ role, text }),
      showError: (msg) => errors.push(msg),
    };
  }

  const MODELS = {
    current: { provider: "fireworks", id: "glm-5p2" },
    models: [
      { provider: "fireworks", id: "glm-5p2", contextWindow: 1048575, reasoning: true, costInput: 1.4, costOutput: 4.4 },
      { provider: "anthropic", id: "claude-opus-4-8", vision: true },
    ],
  };

  test("bare /model lists models as a markdown table with current marked", async () => {
    const chat = mockChat();
    const result = await doModelCommand({
      text: "/model", arg: "", chat,
      getModelsFn: async () => MODELS,
      setModelFn: async () => { throw new Error("should not be called"); },
    });
    assert.equal(result.action, "listed");
    assert.equal(result.count, 2);
    assert.equal(chat.messages[0].role, "user");
    assert.equal(chat.messages[1].role, "system");
    assert.match(chat.messages[1].text, /\| Model \| Context \| Vision \| Reasoning \|/);
    assert.match(chat.messages[1].text, /\| \* \| fireworks\/glm-5p2 \| 1\.0M \| {2}\| yes \| 1\.4 \/ 4\.4 \|/);
    assert.match(chat.messages[1].text, /\| {2}\| anthropic\/claude-opus-4-8 \| {2}\| yes \| {2}\| {2}\|/);
  });

  test("empty model list shows a no-models message", async () => {
    const chat = mockChat();
    const result = await doModelCommand({
      text: "/model", arg: "", chat,
      getModelsFn: async () => ({ current: null, models: [] }),
      setModelFn: async () => {},
    });
    assert.equal(result.action, "listed");
    assert.equal(result.count, 0);
    assert.match(chat.messages[1].text, /No models/);
  });

  test("tolerates a payload without a models field", async () => {
    const chat = mockChat();
    const result = await doModelCommand({
      text: "/model", arg: "", chat,
      getModelsFn: async () => ({ current: null }),
      setModelFn: async () => {},
    });
    assert.equal(result.count, 0);
  });

  test("switch: unique match calls setModelFn and refreshes status", async () => {
    const chat = mockChat();
    const setCalls = [];
    const statusUpdates = [];
    const result = await doModelCommand({
      text: "/model opus", arg: "opus", chat,
      getModelsFn: async () => MODELS,
      setModelFn: async (provider, id) => { setCalls.push({ provider, id }); },
      getStatusFn: async () => ({ model: "claude-opus-4-8" }),
      onStatusUpdateFn: (s) => statusUpdates.push(s),
    });
    assert.equal(result.action, "switched");
    assert.deepEqual(setCalls, [{ provider: "anthropic", id: "claude-opus-4-8" }]);
    assert.match(chat.messages[1].text, /Model switched to anthropic\/claude-opus-4-8/);
    assert.deepEqual(statusUpdates, [{ model: "claude-opus-4-8" }]);
  });

  test("switch works without status hooks", async () => {
    const chat = mockChat();
    const result = await doModelCommand({
      text: "/model opus", arg: "opus", chat,
      getModelsFn: async () => MODELS,
      setModelFn: async () => {},
    });
    assert.equal(result.action, "switched");
  });

  test("status refresh failure is swallowed", async () => {
    const chat = mockChat();
    const result = await doModelCommand({
      text: "/model opus", arg: "opus", chat,
      getModelsFn: async () => MODELS,
      setModelFn: async () => {},
      getStatusFn: async () => { throw new Error("status down"); },
      onStatusUpdateFn: () => {},
    });
    assert.equal(result.action, "switched");
    assert.equal(chat.errors.length, 0);
  });

  test("no match shows an error", async () => {
    const chat = mockChat();
    const result = await doModelCommand({
      text: "/model nope", arg: "nope", chat,
      getModelsFn: async () => MODELS,
      setModelFn: async () => { throw new Error("should not be called"); },
    });
    assert.equal(result.action, "error");
    assert.equal(result.reason, "no match");
    assert.match(chat.errors[0], /No model matching "nope"/);
  });

  test("ambiguous match lists candidates", async () => {
    const chat = mockChat();
    const result = await doModelCommand({
      text: "/model l", arg: "l", chat,
      getModelsFn: async () => MODELS,
      setModelFn: async () => { throw new Error("should not be called"); },
    });
    assert.equal(result.action, "error");
    assert.equal(result.reason, "ambiguous");
    assert.match(chat.errors[0], /fireworks\/glm-5p2, anthropic\/claude-opus-4-8/);
  });

  test("getModels failure shows an error", async () => {
    const chat = mockChat();
    const result = await doModelCommand({
      text: "/model", arg: "", chat,
      getModelsFn: async () => { throw new Error("bridge down"); },
      setModelFn: async () => {},
    });
    assert.equal(result.action, "error");
    assert.equal(result.reason, "getModels failed");
    assert.equal(chat.errors[0], "bridge down");
  });

  test("getModels failure without a message uses the fallback", async () => {
    const chat = mockChat();
    await doModelCommand({
      text: "/model", arg: "", chat,
      getModelsFn: async () => { throw new Error(""); },
      setModelFn: async () => {},
    });
    assert.equal(chat.errors[0], "Failed to load models");
  });

  test("setModel failure shows the server error", async () => {
    const chat = mockChat();
    const result = await doModelCommand({
      text: "/model opus", arg: "opus", chat,
      getModelsFn: async () => MODELS,
      setModelFn: async () => { throw new Error("No API key"); },
    });
    assert.equal(result.action, "error");
    assert.equal(result.reason, "setModel failed");
    assert.equal(chat.errors[0], "No API key");
  });

  test("setModel failure without a message uses the fallback", async () => {
    const chat = mockChat();
    await doModelCommand({
      text: "/model opus", arg: "opus", chat,
      getModelsFn: async () => MODELS,
      setModelFn: async () => { throw new Error(""); },
    });
    assert.equal(chat.errors[0], "Failed to switch model");
  });
});
