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
 * @param {function} [opts.clientLogFn] — (level, message, data) => Promise, for diagnostics
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
    onCompleteFn,
    clientLogFn = async () => {},
  } = opts;

  chat.addMessage("user", text);
  input.setStreaming(true);
  setBusyFn(true);
  chat.startAssistantMessage();

  let streamComplete = false;
  let errorMsg = null;
  let historyReloaded = false;
  let eventCount = 0;
  let compactInfo = null;

  try {
    await sendPromptStreamFn(text, (event) => {
      eventCount++;
      if (event.type === "done") {
        streamComplete = true;
        if (event.compact) compactInfo = { tokensBefore: event.tokensBefore, summary: event.text };
      }
      if (event.type === "error") errorMsg = event.message;
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
    await clientLogFn("warn", "doSendPrompt: stream incomplete, reloading history", { eventCount, errorMsg });
    try {
      const data = await getHistoryFn();
      if (data.history && data.history.length > 0) {
        chat.loadHistory(data.history);
        historyReloaded = true;
      }
    } catch {
      // Best effort
    }
  } else {
    await clientLogFn("info", "doSendPrompt: stream complete", { eventCount });
  }

  if (compactInfo) {
    const tokensMsg = compactInfo.tokensBefore != null ? ` (${compactInfo.tokensBefore} tokens before)` : "";
    const summaryText = compactInfo.summary || "";
    // tokensBefore === null means compact failed (onError sent done with null)
    const msg = compactInfo.tokensBefore === null
      ? summaryText
      : `Session compacted${tokensMsg}${summaryText ? `\n\n${summaryText}` : ""}`;
    chat.addMessage("system", msg);
  }

  try {
    const status = await getStatusFn();
    if (onStatusUpdateFn) onStatusUpdateFn(status);
  } catch {
    // Best effort
  }

  await clientLogFn("info", "doSendPrompt: flow done", { eventCount, streamComplete, historyReloaded, hasOnCompleteFn: !!onCompleteFn });

  if (streamComplete && onCompleteFn) {
    try { onCompleteFn(); } catch (e) { clientLogFn("error", "onCompleteFn threw", { error: e?.message }); }
  } else {
    await clientLogFn("info", "onCompleteFn skipped", { streamComplete, hasOnCompleteFn: !!onCompleteFn });
  }

  return { completed: streamComplete, historyReloaded, error: errorMsg };
}

/**
 * Parse a "/model" command typed in the input.
 *
 * @param {string} text — raw input text
 * @returns {{arg: string}|null} — null if not a /model command; arg is "" for bare /model
 */
export function parseModelCommand(text) {
  const trimmed = (text || "").trim();
  if (trimmed !== "/model" && !trimmed.startsWith("/model ")) return null;
  return { arg: trimmed.slice("/model".length).trim() };
}

/**
 * Resolve a /model argument against the available model list.
 * Match precedence: exact "provider/id" → exact id → exact last path
 * segment of id → case-insensitive substring of "provider/id".
 *
 * @param {Array<{provider: string, id: string}>} models
 * @param {string} arg
 * @returns {Array<{provider: string, id: string}>} matches (may be empty or ambiguous)
 */
export function resolveModelArg(models, arg) {
  const exact = models.filter((m) => `${m.provider}/${m.id}` === arg);
  if (exact.length) return exact;
  const byId = models.filter((m) => m.id === arg);
  if (byId.length) return byId;
  const bySegment = models.filter((m) => m.id.endsWith(`/${arg}`));
  if (bySegment.length) return bySegment;
  const lower = arg.toLowerCase();
  return models.filter((m) => `${m.provider}/${m.id}`.toLowerCase().includes(lower));
}

/**
 * Handle the /model command.
 *
 * Behavioral spec:
 * 1. User message shown immediately (the command echo)
 * 2. Bare /model → system message listing available models, current marked
 * 3. /model <arg> → resolve via resolveModelArg; no match / ambiguous → showError
 * 4. Unique match → setModelFn; success → system message + status refresh
 * 5. Any API failure → showError
 *
 * @param {object} opts
 * @param {string} opts.text — raw input text (echoed as the user message)
 * @param {string} opts.arg — parsed argument ("" to list)
 * @param {object} opts.chat — { addMessage, showError }
 * @param {function} opts.getModelsFn — () => Promise<{current, models}>
 * @param {function} opts.setModelFn — (provider, id) => Promise
 * @param {function} [opts.getStatusFn] — () => Promise<object>
 * @param {function} [opts.onStatusUpdateFn] — (status) => void
 * @returns {Promise<{action: string, reason?: string, count?: number, model?: object}>}
 */
export async function doModelCommand(opts) {
  const { text, arg, chat, getModelsFn, setModelFn, getStatusFn, onStatusUpdateFn } = opts;
  chat.addMessage("user", text);

  let data;
  try {
    data = await getModelsFn();
  } catch (err) {
    chat.showError(err.message || "Failed to load models");
    return { action: "error", reason: "getModels failed" };
  }
  const models = data.models || [];
  const current = data.current;

  if (!arg) {
    const lines = models.map((m) => {
      const isCurrent = current && m.provider === current.provider && m.id === current.id;
      return `${isCurrent ? "*" : " "} ${m.provider}/${m.id}`;
    });
    // Fenced code block: keeps the "*" marker from rendering as a markdown bullet
    const msg = lines.length
      ? `Available models (* = current):\n\n\`\`\`\n${lines.join("\n")}\n\`\`\`\n\nSwitch with /model <provider/model>`
      : "No models with configured auth found.";
    chat.addMessage("system", msg);
    return { action: "listed", count: models.length };
  }

  const matches = resolveModelArg(models, arg);
  if (matches.length === 0) {
    chat.showError(`No model matching "${arg}". Use /model to list available models.`);
    return { action: "error", reason: "no match" };
  }
  if (matches.length > 1) {
    chat.showError(`Ambiguous model "${arg}": ${matches.map((m) => `${m.provider}/${m.id}`).join(", ")}`);
    return { action: "error", reason: "ambiguous" };
  }

  const target = matches[0];
  try {
    await setModelFn(target.provider, target.id);
  } catch (err) {
    chat.showError(err.message || "Failed to switch model");
    return { action: "error", reason: "setModel failed" };
  }
  chat.addMessage("system", `Model switched to ${target.provider}/${target.id}`);
  if (getStatusFn && onStatusUpdateFn) {
    try {
      onStatusUpdateFn(await getStatusFn());
    } catch {
      // Best effort — header refresh only
    }
  }
  return { action: "switched", model: { provider: target.provider, id: target.id } };
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
 * Sync the expand/collapse all button state to the actual DOM state.
 *
 * Behavioral spec:
 * 1. Count tool + thinking blocks in the DOM (via countExpandedFn / countAllFn)
 * 2. If no blocks exist → state is false (no-op, button shows "expand")
 * 3. If all blocks are expanded → state is true (button shows "collapse")
 * 4. If any block is collapsed → state is false (button shows "expand")
 * 5. If toolsExpanded was true but DOM has collapsed blocks → re-expand all
 *
 * This fixes the desync between the button and the DOM after switching
 * sessions: history renders thinking blocks as expanded by default,
 * but the button state resets to false on page load. The user sees
 * expanded blocks but the button says "expand" — first click does nothing.
 *
 * @param {object} opts
 * @param {boolean} opts.toolsExpanded — current button state (pre-sync)
 * @param {function} opts.countAllFn — () => number, count of tool+thinking blocks
 * @param {function} opts.countExpandedFn — () => number, count of expanded blocks
 * @param {function} opts.expandAllToolsFn — () => void
 * @param {function} opts.onStateChange — (expanded: boolean) => void, update button
 * @returns {{expanded: boolean, reason: string}}
 */
export function syncExpandButtonState({ toolsExpanded, countAllFn, countExpandedFn, expandAllToolsFn, onStateChange }) {
  const total = countAllFn();
  if (total === 0) {
    onStateChange(false);
    return { expanded: false, reason: "no blocks" };
  }

  const expandedCount = countExpandedFn();
  const allExpanded = expandedCount === total;

  if (toolsExpanded && !allExpanded) {
    // Button says expanded but DOM has collapsed blocks → re-expand
    expandAllToolsFn();
    onStateChange(true);
    return { expanded: true, reason: "re-expanded to match button" };
  }

  // Sync button to DOM reality
  onStateChange(allExpanded);
  return { expanded: allExpanded, reason: allExpanded ? "all expanded" : "some collapsed" };
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
    attachStreamFn,
    onStreamEventFn,
    setBusyFn,
    setStreamingFn,
    attachMaxAttempts,
    attachRetryDelayMs,
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

  // If agent is busy or has a buffered done event, attach to the SSE stream.
  // Fire-and-forget: the attach stream can stay open for the whole turn.
  try {
    if (attachStreamFn && onStreamEventFn) {
      const status = await getStatusFn();
      doReattach({
        status,
        getStatusFn,
        attachStreamFn,
        onStreamEventFn,
        setBusyFn,
        setStreamingFn,
        onStatusFn,
        attachMaxAttempts,
        attachRetryDelayMs,
      }).catch(() => {});
    }
  } catch {
    // Best effort
  }

  return result;
}

/**
 * Attach to the agent's SSE stream if it is busy (or a done event is
 * buffered server-side). Used on page init, after a dropped prompt stream,
 * and when the tab becomes visible again.
 *
 * When busy, retries a few times: right after switching back to a session,
 * the server may still hold the previous (dead) SSE registration until its
 * socket close event is processed, so the first attach can 409 transiently.
 *
 * Resolves when the attached stream ends (or attach gave up).
 *
 * @param {object} opts
 * @param {object} [opts.status] — pre-fetched status; fetched via getStatusFn when omitted
 * @param {function} opts.getStatusFn
 * @param {function} opts.attachStreamFn — (onEvent) => Promise<boolean>, resolves when stream ends
 * @param {function} opts.onStreamEventFn
 * @param {function} [opts.setBusyFn]
 * @param {function} [opts.setStreamingFn]
 * @param {function} [opts.onStatusFn]
 * @param {number} [opts.attachMaxAttempts] — attempts when busy (default 3)
 * @param {number} [opts.attachRetryDelayMs] — delay between attempts (default 400)
 * @returns {Promise<{attached: boolean, busy: boolean}>}
 */
export async function doReattach(opts) {
  const {
    status: preStatus,
    getStatusFn,
    attachStreamFn,
    onStreamEventFn,
    setBusyFn,
    setStreamingFn,
    onStatusFn,
    attachMaxAttempts,
    attachRetryDelayMs,
  } = opts;

  let status = preStatus;
  if (!status) {
    try {
      status = await getStatusFn();
    } catch {
      return { attached: false, busy: false };
    }
  }
  if (onStatusFn) onStatusFn(status);

  if (status.busy) {
    setBusyFn?.(true);
    setStreamingFn?.(true);
  }

  const maxAttempts = status.busy ? (attachMaxAttempts ?? 3) : 1;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const attached = await attachStreamFn(onStreamEventFn);
      if (attached) return { attached: true, busy: !!status.busy };
    } catch {
      // Treat like a failed attempt and retry
    }
    if (i < maxAttempts - 1) await new Promise((r) => setTimeout(r, attachRetryDelayMs ?? 400));
  }

  if (status.busy) {
    setBusyFn?.(false);
    setStreamingFn?.(false);
  }
  return { attached: false, busy: !!status.busy };
}
