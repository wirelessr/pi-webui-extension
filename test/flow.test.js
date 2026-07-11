import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { doInit, doSelectCommand, doSendPrompt, doStop } from "../http-bridge-web/flow.js";

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
      assert.equal(input.calls.selectCommand.length, 1);
      assert.deepEqual(input.calls.selectCommand[0], c.cmd);
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
});
