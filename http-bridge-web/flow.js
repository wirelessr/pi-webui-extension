/**
 * Core UI flows — extracted from app.js as injectable functions.
 *
 * These functions encode the behavioral spec of the WebUI:
 * what happens when the user sends a message, selects a command,
 * or stops a running turn. All side effects (chat rendering, input
 * state, API calls, DOM updates) are injected via opts, making
 * the orchestration logic fully testable without a browser.
 */

/**
 * Send a prompt and handle the SSE streaming response.
 *
 * Behavioral spec:
 * 1. User message shown immediately in chat
 * 2. Streaming + busy state set BEFORE SSE starts
 * 3. Assistant message container created before events arrive
 * 4. Every SSE event dispatched to chat.handleEvent
 * 5. `done` event marks stream as complete
 * 6. On stream error: showError, then cleanup in finally
 * 7. Finally ALWAYS: finishAssistantMessage, setStreaming(false), setBusy(false)
 * 8. If no `done` event (connection dropped): reload history as safety net
 * 9. If `done` received: NO history reload (avoid flicker)
 * 10. Stats always refreshed after stream ends
 *
 * @param {object} opts
 * @param {string} opts.text — user message
 * @param {object} opts.chat — { addMessage, startAssistantMessage, handleEvent, finishAssistantMessage, showError, loadHistory }
 * @param {object} opts.input — { setStreaming }
 * @param {function} opts.setBusyFn — (busy: boolean) => void
 * @param {function} opts.sendPromptStreamFn — (message, onEvent) => Promise<void>
 * @param {function} opts.getHistoryFn — () => Promise<{history: Array}>
 * @param {function} opts.getStatusFn — () => Promise<object>
 * @param {function} [opts.onStatusUpdateFn] — (status) => void, optional
 * @returns {Promise<{completed: boolean, historyReloaded: boolean, error: string|null}>}
 */
export async function doSendPrompt(opts) {
  const {
    text,
    chat,
    input,
    setBusyFn,
    sendPromptStreamFn,
    getHistoryFn,
    getStatusFn,
    onStatusUpdateFn,
  } = opts;

  chat.addMessage("user", text);
  input.setStreaming(true);
  setBusyFn(true);
  chat.startAssistantMessage();

  let streamComplete = false;
  let errorMsg = null;
  let historyReloaded = false;

  try {
    await sendPromptStreamFn(text, (event) => {
      if (event.type === "done") streamComplete = true;
      chat.handleEvent(event);
    });
  } catch (err) {
    errorMsg = err.message || "Connection failed";
    chat.showError(errorMsg);
  }

  // Cleanup — always runs
  chat.finishAssistantMessage();
  input.setStreaming(false);
  setBusyFn(false);

  if (!streamComplete) {
    try {
      const data = await getHistoryFn();
      if (data.history && data.history.length > 0) {
        chat.loadHistory(data.history);
        historyReloaded = true;
      }
    } catch {
      // Best effort
    }
  }

  try {
    const status = await getStatusFn();
    if (onStatusUpdateFn) onStatusUpdateFn(status);
  } catch {
    // Best effort
  }

  return { completed: streamComplete, historyReloaded, error: errorMsg };
}

/**
 * Handle command selection from the sidebar.
 *
 * Behavioral spec:
 * 1. Executable builtin (compact, reload) → call executeCommand API
 * 2. On success → show system message "/cmd triggered"
 * 3. On error → showError
 * 4. Non-executable (skills, prompts, non-exec builtins) → input.selectCommand
 *
 * @param {object} opts
 * @param {object} opts.cmd — command object { name, source, executable }
 * @param {object} opts.chat — { addMessage, showError }
 * @param {object} opts.input — { selectCommand }
 * @param {function} opts.executeCommandFn — (name) => Promise
 * @returns {Promise<{action: string, reason: string}>}
 */
export async function doSelectCommand(opts) {
  const { cmd, chat, input, executeCommandFn } = opts;

  if (cmd.source === "builtin" && cmd.executable) {
    try {
      await executeCommandFn(cmd.name);
      chat.addMessage("system", `/${cmd.name} triggered`);
      return { action: "executed", reason: "builtin command triggered" };
    } catch (err) {
      chat.showError(err.message || `Failed to execute /${cmd.name}`);
      return { action: "error", reason: err.message || "execution failed" };
    }
  }

  input.selectCommand(cmd);
  return { action: "inserted", reason: "command inserted into input" };
}

/**
 * Handle stop button click.
 *
 * Behavioral spec:
 * 1. Call abort API
 * 2. On error → showError
 *
 * @param {object} opts
 * @param {object} opts.chat — { showError }
 * @param {function} opts.abortFn — () => Promise
 * @returns {Promise<{action: string, error: string|null}>}
 */
export async function doStop(opts) {
  const { chat, abortFn } = opts;
  try {
    await abortFn();
    return { action: "aborted", error: null };
  } catch (err) {
    chat.showError(err.message || "Failed to abort");
    return { action: "error", error: err.message || "abort failed" };
  }
}

/**
 * Initialize the WebUI on page load.
 *
 * Behavioral spec:
 * 1. Fetch status → set port, pid, sessionName, stats display
 * 2. Load commands list
 * 3. Load sessions list
 * 4. Auto-resize input
 * 5. Fetch history → render in chat
 * 6. Any step failing does NOT block subsequent steps
 *
 * @param {object} opts
 * @param {function} opts.getStatusFn — () => Promise<{port, pid, sessionName, sessionId, ...}>
 * @param {function} opts.getHistoryFn — () => Promise<{history: Array}>
 * @param {function} opts.loadCommandsFn — () => Promise<void>
 * @param {function} opts.loadSessionsFn — () => Promise<void>
 * @param {function} opts.loadHistoryFn — (history) => void
 * @param {function} opts.autoResizeFn — () => void
 * @param {function} opts.onStatusFn — (status) => void (update port/pid/name/stats display)
 * @returns {Promise<{statusLoaded: boolean, historyLoaded: boolean, commandsLoaded: boolean, sessionsLoaded: boolean}>}
 */
export async function doInit(opts) {
  const {
    getStatusFn,
    getHistoryFn,
    loadCommandsFn,
    loadSessionsFn,
    loadHistoryFn,
    autoResizeFn,
    onStatusFn,
  } = opts;

  const result = { statusLoaded: false, historyLoaded: false, commandsLoaded: false, sessionsLoaded: false };

  try {
    const status = await getStatusFn();
    result.statusLoaded = true;
    if (onStatusFn) onStatusFn(status);
  } catch {
    // Server might not be ready yet
  }

  try {
    await loadCommandsFn();
    result.commandsLoaded = true;
  } catch {
    // Commands might not be available
  }

  try {
    loadSessionsFn();
    result.sessionsLoaded = true;
  } catch {
    // Sessions might not be available
  }

  autoResizeFn();

  try {
    const data = await getHistoryFn();
    if (data.history && data.history.length > 0) {
      loadHistoryFn(data.history);
      result.historyLoaded = true;
    }
  } catch {
    // History might not be available
  }

  return result;
}
