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

import { abortAgent, attachStream, clientLog, executeCommand, getHistory, getStatus, navUrl, newSession, openSession, sendPromptStream } from "./api.js";
import { createChat } from "./chat.js";
import { createCommandsView } from "./commands.js";
import { doInit, doReattach, doSelectCommand, doSendPrompt, doStop, syncExpandButtonState } from "./flow.js";
import { createInput } from "./input.js";
import { createMobileNav } from "./mobile-nav.js";
import { initResize } from "./resize.js";
import { createSessionsView } from "./sessions.js";
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

  const chat = createChat({ $messages, $chat, $scrollBottom, isToolsExpanded: () => toolsExpanded, logFn: clientLog });

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

  async function handleSend(text) {
    sending = true;
    let result;
    try {
      result = await doSendPrompt({
        text,
        chat,
        input,
        setBusyFn: setBusy,
        sendPromptStreamFn: sendPromptStream,
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
    clientLog("info", "notifyAgentDone called", { hidden: document.hidden, permission, secureContext: window.isSecureContext });
    if (!document.hidden) return;
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

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && titleAlertActive) {
      titleAlertActive = false;
      document.title = originalTitle;
    }
  });

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

  // ── Init ──────────────────────────────────────────

  function onStreamEvent(event) {
    // Attaching mid-turn means agent_start already streamed before we
    // connected — lazily open an assistant message on the first event,
    // otherwise chat.handleEvent drops everything (no accumulator).
    if (event.type === "agent_start" || (!chat.hasActiveMessage() && event.type !== "done" && event.type !== "error")) {
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
      onStatusFn: (data) => {
        currentPort = data.port;
        $portDisplay.textContent = `:${data.port}`;
        if (data.pid) $pidDisplay.textContent = `pid:${data.pid}`;
        if (data.cwd) {
          const parts = data.cwd.split("/");
          $cwdDisplay.textContent = parts[parts.length - 1] || data.cwd;
          $cwdDisplay.title = data.cwd;
        }
        const prevName = lastKnownSessionName;
        if (data.sessionName) $sessionName.textContent = data.sessionName;
        else if (data.sessionId) $sessionName.textContent = data.sessionId.slice(0, 8);
        if (data.sessionName && data.sessionName !== prevName) {
          lastKnownSessionName = data.sessionName;
          sessionsView.load();
        }
        updateStats(data);
      },
    });
  }

  init();

  // Periodic status poll — detects auto-name changes and other updates
  setInterval(async () => {
    try {
      const status = await getStatus();
      currentPort = status.port;
      $portDisplay.textContent = `:${status.port}`;
      if (status.pid) $pidDisplay.textContent = `pid:${status.pid}`;
      if (status.cwd) {
        const parts = status.cwd.split("/");
        $cwdDisplay.textContent = parts[parts.length - 1] || status.cwd;
        $cwdDisplay.title = status.cwd;
      }
      if (status.sessionName) $sessionName.textContent = status.sessionName;
      else if (status.sessionId) $sessionName.textContent = status.sessionId.slice(0, 8);
      if (status.sessionName && status.sessionName !== lastKnownSessionName) {
        lastKnownSessionName = status.sessionName;
        sessionsView.load();
      }
      updateStats(status);
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
