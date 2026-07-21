/**
 * pi bridge — main entry point
 *
 * Wires together all modules:
 *   - api:     HTTP fetch wrappers
 *   - sse:     SSE stream reading (inside api.sendPromptStream)
 *   - chat:    message rendering, streaming, tool/thinking blocks
 *   - sessions: left sidebar session list
 *   - commands: right sidebar command list + filtering
 *   - input:   textarea handling, keyboard, auto-resize
 *   - mobile-nav: bottom tab bar for mobile
 */

import { abortAgent, attachStream, clientLog, executeCommand, getFile, getHistory, getModels, getStatus, getTree, navigateTree, navUrl, pollUntil, sendPromptStream, setModel, statFiles, steerAgent } from "./api.js";
import { createChat } from "./chat.js";
import { createCommandsView } from "./commands.js";
import { doInit, doModelCommand, doReattach, doSelectCommand, doSendPrompt, doStop, parseModelCommand, syncExpandButtonState } from "./flow.js";
import { createInput } from "./input.js";
import { createMobileNav } from "./mobile-nav.js";
import { createModelView } from "./model-view.js";
import { createOverlayManager } from "./overlay-manager.js";
import { initResize } from "./resize.js";
import { createSessionsView } from "./sessions.js";
import { createTreeView } from "./tree-view.js";
import { formatStats } from "./utils.js";

(function () {

  // ── DOM refs ──────────────────────────────────────

  const $app = document.getElementById("app");
  const $messages = document.getElementById("messages");
  const $chat = document.getElementById("chat");
  const $scrollBottom = document.getElementById("scroll-bottom");
  const $input = document.getElementById("message-input");
  const $sendBtn = document.getElementById("send-btn");
  const $busyIndicator = document.getElementById("busy-indicator");
  const $portDisplay = document.getElementById("port-display");
  const $expandToolsBtn = document.getElementById("expand-tools-btn");
  const $pidDisplay = document.getElementById("pid-display");
  const $cwdDisplay = document.getElementById("cwd-display");
  const $sessionName = document.getElementById("session-name");
  const $statsDisplay = document.getElementById("stats-display");
  const $sessionsList = document.getElementById("sessions-list");
  const $refreshSessions = document.getElementById("refresh-sessions");
  const $newSession = document.getElementById("new-session");
  const $sessionModal = document.getElementById("new-session-modal");
  const $sessionIdInput = document.getElementById("session-id-input");
  const $sessionModalCancel = document.getElementById("session-modal-cancel");
  const $sessionModalOk = document.getElementById("session-modal-ok");
  const $reloadAll = document.getElementById("reload-all");
  const $commandsList = document.getElementById("commands-list");
  const $commandsCount = document.getElementById("commands-count");
  const $commandsTitle = document.getElementById("commands-title");

  // ── State ─────────────────────────────────────────

  let currentPort = null;
  let lastKnownSessionName = null;

  // ── Module instances ──────────────────────────────

  const overlays = createOverlayManager({ $chat, $messages });

  const chat = createChat({ $messages, $chat, $scrollBottom, isToolsExpanded: () => toolsExpanded, logFn: clientLog, getFileContentFn: (path) => getFile(path), statFilesFn: (paths) => statFiles(paths), overlays });

  let treeNavStartedAt = 0;
  const treeView = createTreeView({
    $chat,
    overlays,
    getTreeFn: getTree,
    navigateFn: (targetId) => {
      treeNavStartedAt = Date.now();
      return navigateTree(targetId);
    },
    isBusyFn: () => $busyIndicator.classList.contains("busy"),
    onNavigated: async (result) => {
      // A real switch reloads the session (new process, same port) — wait for
      // the respawned bridge before fetching the new branch's history.
      if (result?.reload) {
        await pollUntil(async () => {
          const s = await getStatus();
          return s.startedAt > treeNavStartedAt ? s : false;
        }, 1000, 20);
      }
      try {
        const data = await getHistory();
        chat.loadHistory(data.history || []);
        chat.addMessage("system", "Switched branch");
        updateStats(await getStatus());
      } catch {
        // Best effort — the next poll/interaction refreshes
      }
    },
  });
  document.getElementById("tree-btn")?.addEventListener("click", () => treeView.toggle());

  const modelView = createModelView({
    $chat,
    overlays,
    getModelsFn: getModels,
    setModelFn: setModel,
    onSwitched: async (m) => {
      chat.addMessage("system", `Model switched to ${m.provider}/${m.id}`);
      try {
        updateStats(await getStatus());
      } catch {
        // Best effort
      }
    },
  });

  const mobileNav = createMobileNav({ $app });

  // Sidebar resize (desktop only)
  initResize({ $sidebar: $sessionsList.parentElement, $handle: document.getElementById("sidebar-resize") });

  const sessionsView = createSessionsView({
    $list: $sessionsList,
    getCurrentPort: () => currentPort,
    onOpen: (s) => {
      // Keep the hostname the user opened the page with (localhost stays
      // localhost — switching sessions must not drop the secure context).
      window.location.href = navUrl(s);
    },
  });

  const commandsView = createCommandsView({
    $list: $commandsList,
    $count: $commandsCount,
    $title: $commandsTitle,
    onSelect: (cmd) => input.selectCommand(cmd),
  });

  const input = createInput({
    $input,
    $sendBtn,
    commandsView,
    mobileNav,
    onSend: handleSend,
    onSelectCommand: handleSelectCommand,
    onStop: handleStop,
    // Allow Enter to submit mid-turn: a send while streaming becomes a steer
    // (injected into the running turn). The button still acts as Stop.
    allowQueueWhileStreaming: true,
  });


  // ── Session refresh ───────────────────────────────

  $refreshSessions?.addEventListener("click", () => sessionsView.load());
  $newSession?.addEventListener("click", () => {
    $sessionIdInput.value = "";
    $sessionModal.classList.remove("hidden");
    $sessionIdInput.focus();
  });

  $sessionModalCancel?.addEventListener("click", () => {
    $sessionModal.classList.add("hidden");
  });

  $sessionModal?.addEventListener("click", (e) => {
    if (e.target === $sessionModal) $sessionModal.classList.add("hidden");
  });

  async function handleSessionModalOk() {
    const sessionId = $sessionIdInput.value.trim();
    $sessionModal.classList.add("hidden");
    if (sessionId) {
      await sessionsView.handleOpen(sessionId);
    } else {
      await sessionsView.handleNew();
    }
  }

  $sessionModalOk?.addEventListener("click", handleSessionModalOk);
  $sessionIdInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); handleSessionModalOk(); }
    if (e.key === "Escape") $sessionModal.classList.add("hidden");
  });
  $reloadAll?.addEventListener("click", () => sessionsView.handleReloadAll());

  // ── Expand/collapse all tool blocks (persisted in localStorage) ──

  let toolsExpanded = localStorage.getItem("pi-webui-tools-expanded") === "true";
  function setExpandButtonState(expanded) {
    toolsExpanded = expanded;
    localStorage.setItem("pi-webui-tools-expanded", String(expanded));
    if ($expandToolsBtn) {
      $expandToolsBtn.textContent = expanded ? "▲" : "▼";
      $expandToolsBtn.title = expanded ? "Collapse all tool/thinking blocks" : "Expand all tool/thinking blocks";
    }
  }
  $expandToolsBtn?.addEventListener("click", () => {
    if (toolsExpanded) {
      chat.collapseAllTools();
      setExpandButtonState(false);
    } else {
      chat.expandAllTools();
      setExpandButtonState(true);
    }
  });

  // ── Command selection ──

  async function handleSelectCommand(cmd) {
    await doSelectCommand({
      cmd,
      chat,
      input,
      executeCommandFn: executeCommand,
    });
  }

  // ── Stop flow ──────────────────────────────────────

  async function handleStop() {
    await doStop({ chat, abortFn: abortAgent });
  }

  // ── Send flow ─────────────────────────────────────

  let sending = false;

  // Optimistic pending-steer list: messages steered into the running turn but
  // not yet injected by pi (no readable steering queue exists). Added on send,
  // removed when the message's own user_message echo arrives. No persistence.
  const $queueChips = document.getElementById("queue-chips");
  let pendingSteers = [];

  function renderPendingSteers() {
    if (!$queueChips) return;
    $queueChips.innerHTML = "";
    if (pendingSteers.length === 0) { $queueChips.classList.add("hidden"); return; }
    $queueChips.classList.remove("hidden");
    const header = document.createElement("div");
    header.className = "queue-header";
    const caption = document.createElement("span");
    caption.textContent = pendingSteers.length === 1 ? "1 steer waiting to inject" : `${pendingSteers.length} steers waiting to inject`;
    const clear = document.createElement("button");
    clear.className = "queue-resume"; clear.textContent = "Clear";
    clear.title = "Stop showing pending steers (already-injected ones still land)";
    clear.addEventListener("click", () => { pendingSteers = []; renderPendingSteers(); });
    header.appendChild(caption); header.appendChild(clear);
    $queueChips.appendChild(header);
    for (const text of pendingSteers) {
      const chip = document.createElement("div");
      chip.className = "queue-chip";
      const label = document.createElement("span");
      label.className = "queue-chip-text";
      label.textContent = text; label.title = text;
      chip.appendChild(label);
      $queueChips.appendChild(chip);
    }
  }

  function addPendingSteer(text) { pendingSteers.push(text); renderPendingSteers(); }
  function removePendingSteerOnEcho(text) {
    const i = pendingSteers.indexOf(text); // FIFO: oldest match is the one pi just injected
    if (i === -1) return;
    pendingSteers.splice(i, 1);
    renderPendingSteers();
  }
  function removePendingSteerByText(text) {
    const i = pendingSteers.lastIndexOf(text); // send failed: drop the one we just added
    if (i === -1) return;
    pendingSteers.splice(i, 1);
    renderPendingSteers();
  }

  async function handleSend(text) {
    if (text.trim() === "/tree") {
      treeView.open();
      return;
    }
    const modelCmd = parseModelCommand(text);
    if (modelCmd && modelCmd.arg === "") {
      modelView.open();
      return;
    }
    if (modelCmd) {
      await doModelCommand({
        text,
        arg: modelCmd.arg,
        chat,
        getModelsFn: getModels,
        setModelFn: setModel,
        getStatusFn: getStatus,
        onStatusUpdateFn: (status) => updateStats(status),
      });
      return;
    }
    // Busy → STEER into the running turn. The bubble is not rendered here; the
    // bridge echoes it back as a user_message on our live stream (the still-open
    // prompt stream, or the reattach), so rendering has a single owner and the
    // DOM order matches a later history reload. The pending list (added now,
    // removed on echo) shows what's waiting to inject — pi has no readable queue.
    if (sending || $busyIndicator.classList.contains("busy")) {
      addPendingSteer(text);
      try {
        await steerAgent(text);
      } catch (err) {
        removePendingSteerByText(text); // send failed → never entered pi's queue
        chat.showError(`Steer failed: ${err.message}`);
      }
      return;
    }
    sending = true;
    let result;
    try {
      result = await doSendPrompt({
        text,
        chat,
        input,
        setBusyFn: setBusy,
        // Observe the sender's own stream for steer echoes (a steer sent while
        // this prompt is still streaming echoes back here, not via onStreamEvent).
        sendPromptStreamFn: (msg, onEvent) => sendPromptStream(msg, (event) => {
          if (event.type === "user_message" && typeof event.text === "string") removePendingSteerOnEcho(event.text);
          onEvent(event);
        }),
        getHistoryFn: getHistory,
        getStatusFn: getStatus,
        clientLogFn: clientLog,
        onCompleteFn: notifyAgentDone,
        onStatusUpdateFn: (status) => {
          updateStats(status);
          if (status.pid) $pidDisplay.textContent = `pid:${status.pid}`;
        },
      });
    } finally {
      sending = false;
    }
    // Stream dropped without a done event (network blip, mobile suspend):
    // the agent may still be running — reattach to pick up the rest.
    if (result && !result.completed) tryReattach();
  }

  // ── Stream reattach (dropped stream / tab became visible) ──

  let reattaching = false;

  async function tryReattach() {
    if (reattaching || sending) return;
    reattaching = true;
    try {
      await doReattach({
        getStatusFn: getStatus,
        attachStreamFn: attachStream,
        onStreamEventFn: onStreamEvent,
        setBusyFn: setBusy,
        setStreamingFn: (streaming) => input.setStreaming(streaming),
        onStatusFn: (status) => updateStats(status),
        clientLogFn: clientLog,
      });
    } catch {
      // Best effort
    } finally {
      reattaching = false;
    }
  }

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) tryReattach();
  });

  // ── Busy indicator ────────────────────────────────

  function setBusy(busy) {
    $busyIndicator.textContent = busy ? "busy" : "idle";
    $busyIndicator.className = `status ${busy ? "busy" : "idle"}`;
  }

  // ── Browser notification ────────────────────────────────

  const originalTitle = document.title;
  let titleAlertActive = false;

  function notifyAgentDone() {
    const permission = "Notification" in window ? Notification.permission : "unsupported";
    // document.hidden only catches tab-level hiding (backgrounded/minimized tab).
    // It stays false when you switch to another app while the tab remains the
    // active tab in its window, which is the common "working elsewhere" case.
    // hasFocus() is false whenever the window isn't focused, covering that gap.
    const looking = !document.hidden && document.hasFocus();
    clientLog("info", "notifyAgentDone called", { hidden: document.hidden, hasFocus: document.hasFocus(), looking, permission, secureContext: window.isSecureContext });
    if (looking) return;
    const name = $sessionName?.textContent || "session";
    if (permission === "granted") {
      const n = new Notification("Agent done", {
        body: name,
        tag: String(currentPort),
      });
      n.onclick = () => {
        window.focus();
        n.close();
      };
    } else {
      // Notification API is unavailable on insecure origins (plain http over
      // LAN IP: permission is forced to "denied"). Fall back to a title
      // marker, cleared when the tab becomes visible again.
      titleAlertActive = true;
      document.title = `[done] ${originalTitle}`;
    }
  }

  function clearTitleAlert() {
    if (titleAlertActive) {
      titleAlertActive = false;
      document.title = originalTitle;
    }
  }
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) clearTitleAlert();
  });
  window.addEventListener("focus", clearTitleAlert);

  if ("Notification" in window && Notification.permission === "default") {
    const requestPerm = () => {
      Notification.requestPermission();
      document.removeEventListener("click", requestPerm);
    };
    document.addEventListener("click", requestPerm);
  } else if (!window.isSecureContext) {
    clientLog("warn", "System notifications unavailable: insecure origin. Open via localhost or HTTPS to enable them; falling back to tab-title alerts.");
  }

  // ── Stats formatting ───────────────────────────────

  function updateStats(data) {
    $statsDisplay.textContent = formatStats(data);
  }

  // Single owner for the header fields (port/pid/cwd/name) + stats. Both the
  // initial status callback and the periodic poll route through here, and it
  // reloads the sessions list only when the name actually changed.
  function updateHeader(data) {
    currentPort = data.port;
    $portDisplay.textContent = `:${data.port}`;
    if (data.pid) $pidDisplay.textContent = `pid:${data.pid}`;
    if (data.cwd) {
      const parts = data.cwd.split("/");
      $cwdDisplay.textContent = parts[parts.length - 1] || data.cwd;
      $cwdDisplay.title = data.cwd;
    }
    if (data.sessionName) $sessionName.textContent = data.sessionName;
    else if (data.sessionId) $sessionName.textContent = data.sessionId.slice(0, 8);
    if (data.sessionName && data.sessionName !== lastKnownSessionName) {
      lastKnownSessionName = data.sessionName;
      sessionsView.load();
    }
    updateStats(data);
  }

  // ── Init ──────────────────────────────────────────

  function onStreamEvent(event) {
    // A user_message echo means pi injected a steer — drop its pending chip.
    if (event.type === "user_message" && typeof event.text === "string") {
      removePendingSteerOnEcho(event.text);
    }
    // Attaching mid-turn means agent_start already streamed before we
    // connected — lazily open an assistant message on the first event,
    // otherwise chat.handleEvent drops everything (no accumulator).
    // user_message precedes agent_start in the replay — it must not trigger
    // the lazy assistant-bubble open, or the user bubble lands below it.
    if (event.type === "agent_start" || (!chat.hasActiveMessage() && event.type !== "done" && event.type !== "error" && event.type !== "user_message")) {
      chat.startAssistantMessage();
    }
    if (event.type === "done" || event.type === "error") {
      clientLog("info", "onStreamEvent: done/error received", { type: event.type, hidden: document.hidden });
      chat.handleEvent(event);
      chat.finishAssistantMessage();
      input.setStreaming(false);
      setBusy(false);
      if (event.type === "done") {
        notifyAgentDone();
        getHistory().then((data) => {
          if (data.history && data.history.length > 0) {
            chat.loadHistory(data.history);
          }
        }).catch(() => {});
      }
    } else {
      chat.handleEvent(event);
    }
  }

  async function init() {
    await doInit({
      getStatusFn: getStatus,
      getHistoryFn: getHistory,
      loadCommandsFn: () => commandsView.load(),
      loadSessionsFn: () => sessionsView.load(),
      loadHistoryFn: (history) => {
        chat.loadHistory(history);
        syncExpandButtonState({
          toolsExpanded,
          countAllFn: () => $messages.querySelectorAll(".tool-block, .thinking-block").length,
          countExpandedFn: () => $messages.querySelectorAll(".tool-block.expanded, .thinking-block.expanded").length,
          expandAllToolsFn: chat.expandAllTools,
          onStateChange: setExpandButtonState,
        });
      },
      autoResizeFn: () => input.autoResize(),
      attachStreamFn: attachStream,
      onStreamEventFn: onStreamEvent,
      setBusyFn: setBusy,
      setStreamingFn: (streaming) => input.setStreaming(streaming),
      onStatusFn: updateHeader,
    });
  }

  init();

  // Periodic status poll — detects auto-name changes and other updates
  setInterval(async () => {
    try {
      updateHeader(await getStatus());
    } catch {
      // Server might be temporarily unavailable
    }
  }, 5000);

  // ── Global error logging ───────────────────────────

  window.addEventListener("error", (e) => {
    clientLog("error", "window.error", {
      message: e.message,
      filename: e.filename,
      lineno: e.lineno,
    });
  });

  window.addEventListener("unhandledrejection", (e) => {
    clientLog("error", "unhandledrejection", {
      reason: e.reason?.message || String(e.reason),
      stack: e.reason?.stack?.split("\n").slice(0, 3).join(" | "),
    });
  });
})();
