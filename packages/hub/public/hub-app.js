/**
 * pi hub — SPA shell.
 *
 * Reuses the shared components (chat / flow / input / api) unchanged. The
 * only hub-specific piece is addressing: every session's API lives behind
 * `/s/<sessionId>/api/...` on the hub, so we hand the components a
 * session-scoped fetch that rewrites `/api/*` to that prefix.
 *
 * Switching sessions happens in-page (no navigation), so the page and any
 * open SSE survive — which is what lets notifications fire for a session
 * whose tab you've since switched away from.
 */

import { abortAgent, attachStream, getHistory, getStatus, sendPromptStream } from "/api.js";
import { createChat } from "/chat.js";
import { createCommandsView } from "/commands.js";
import { doInit, doSendPrompt, doStop } from "/flow.js";
import { createInput } from "/input.js";
import { createMobileNav } from "/mobile-nav.js";
import { formatStats } from "/utils.js";

(function () {
  const $app = document.getElementById("app");
  const $messages = document.getElementById("messages");
  const $chat = document.getElementById("chat");
  const $scrollBottom = document.getElementById("scroll-bottom");
  const $input = document.getElementById("message-input");
  const $sendBtn = document.getElementById("send-btn");
  const $busyIndicator = document.getElementById("busy-indicator");
  const $portDisplay = document.getElementById("port-display");
  const $pidDisplay = document.getElementById("pid-display");
  const $cwdDisplay = document.getElementById("cwd-display");
  const $sessionName = document.getElementById("session-name");
  const $statsDisplay = document.getElementById("stats-display");
  const $sessionsList = document.getElementById("sessions-list");
  const $refreshSessions = document.getElementById("refresh-sessions");
  const $commandsList = document.getElementById("commands-list");
  const $commandsCount = document.getElementById("commands-count");
  const $commandsTitle = document.getElementById("commands-title");

  let sessions = [];
  let activeSessionId = null;
  let activeAttach = null; // AbortController for the active session's attach SSE

  let toolsExpanded = localStorage.getItem("pi-hub-tools-expanded") === "true";
  const chat = createChat({ $messages, $chat, $scrollBottom, isToolsExpanded: () => toolsExpanded });
  const mobileNav = createMobileNav({ $app });
  // Kept for the input's "/" command filtering; not populated in v1 (the hub
  // has no aggregated /api/commands endpoint yet).
  const commandsView = createCommandsView({ $list: $commandsList, $count: $commandsCount, $title: $commandsTitle, onSelect: (cmd) => input.selectCommand(cmd) });
  const input = createInput({ $input, $sendBtn, commandsView, mobileNav, onSend: handleSend, onSelectCommand: () => {}, onStop: handleStop });

  // ── Session-scoped addressing ──

  function scopedFetch(sessionId, signal) {
    return (url, init) => {
      const u = typeof url === "string" && url.startsWith("/api/") ? `/s/${encodeURIComponent(sessionId)}${url}` : url;
      return fetch(u, signal ? { ...init, signal } : init);
    };
  }

  function activeName() {
    const s = sessions.find((x) => x.sessionId === activeSessionId);
    return s?.sessionName || s?.sessionId?.slice(0, 8) || "session";
  }

  // ── Header / busy ──

  function setBusy(busy) {
    $busyIndicator.textContent = busy ? "busy" : "idle";
    $busyIndicator.className = `status ${busy ? "busy" : "idle"}`;
  }

  function updateHeader(status) {
    if (!status) return;
    if (status.port) $portDisplay.textContent = `:${status.port}`;
    if (status.pid) $pidDisplay.textContent = `pid:${status.pid}`;
    if (status.cwd) {
      const parts = status.cwd.split("/");
      $cwdDisplay.textContent = parts[parts.length - 1] || status.cwd;
      $cwdDisplay.title = status.cwd;
    }
    if (status.sessionName) $sessionName.textContent = status.sessionName;
    else if (status.sessionId) $sessionName.textContent = status.sessionId.slice(0, 8);
    if (status.usage && status.context) $statsDisplay.textContent = formatStats(status);
  }

  // ── Notifications (fire unless the page is both visible and focused) ──

  const originalTitle = document.title;
  let titleAlertActive = false;

  // Raw notification — no focus gate. Used for background sessions: if a
  // session you're NOT viewing finishes, notify regardless of window focus.
  function fireNotification(name) {
    const permission = "Notification" in window ? Notification.permission : "unsupported";
    if (permission === "granted") {
      const n = new Notification("Agent done", { body: name, tag: name });
      n.onclick = () => { window.focus(); n.close(); };
    } else {
      titleAlertActive = true;
      document.title = `[done] ${originalTitle}`;
    }
  }

  // Active session: only notify when you're not actually looking at it
  // (window hidden or unfocused). If you're staring at it, no need.
  function notifyActiveDone(name) {
    if (!document.hidden && document.hasFocus()) return;
    fireNotification(name);
  }
  function clearTitleAlert() {
    if (titleAlertActive) { titleAlertActive = false; document.title = originalTitle; }
  }
  document.addEventListener("visibilitychange", () => { if (!document.hidden) clearTitleAlert(); });
  window.addEventListener("focus", clearTitleAlert);
  if ("Notification" in window && Notification.permission === "default") {
    const req = () => { Notification.requestPermission(); document.removeEventListener("click", req); };
    document.addEventListener("click", req);
  }

  // ── Stream event handler (bound to the session it was created for) ──

  function makeStreamHandler(sessionId) {
    return (event) => {
      if (sessionId !== activeSessionId) return; // stale stream after a switch
      if (event.type === "agent_start" || (!chat.hasActiveMessage() && event.type !== "done" && event.type !== "error")) {
        chat.startAssistantMessage();
      }
      if (event.type === "done" || event.type === "error") {
        chat.handleEvent(event);
        chat.finishAssistantMessage();
        input.setStreaming(false);
        setBusy(false);
        if (event.type === "done") {
          notifyActiveDone(activeName());
          getHistory(scopedFetch(sessionId)).then((data) => {
            if (sessionId === activeSessionId && data.history?.length) chat.loadHistory(data.history);
          }).catch(() => {});
        }
      } else {
        chat.handleEvent(event);
      }
    };
  }

  // ── Session switching (in-page) ──

  async function switchTo(sessionId) {
    if (activeAttach) { activeAttach.abort(); activeAttach = null; }
    activeSessionId = sessionId;
    renderSessions();
    $messages.innerHTML = "";
    setBusy(false);
    input.setStreaming(false);

    const attach = new AbortController();
    activeAttach = attach;
    const f = scopedFetch(sessionId);
    const attachF = scopedFetch(sessionId, attach.signal);

    await doInit({
      getStatusFn: () => getStatus(f),
      getHistoryFn: () => getHistory(f),
      loadCommandsFn: async () => {},
      loadSessionsFn: () => {},
      loadHistoryFn: (history) => { if (sessionId === activeSessionId) chat.loadHistory(history); },
      autoResizeFn: () => input.autoResize(),
      onStatusFn: (status) => { if (sessionId === activeSessionId) updateHeader(status); },
      attachStreamFn: (onEvent) => attachStream(onEvent, attachF),
      onStreamEventFn: makeStreamHandler(sessionId),
      setBusyFn: (b) => { if (sessionId === activeSessionId) setBusy(b); },
      setStreamingFn: (s) => { if (sessionId === activeSessionId) input.setStreaming(s); },
    });
  }

  // ── Send / stop (active session) ──

  async function handleSend(text) {
    if (!activeSessionId) return;
    const id = activeSessionId;
    const f = scopedFetch(id);
    const result = await doSendPrompt({
      text, chat, input,
      setBusyFn: (b) => { if (id === activeSessionId) setBusy(b); },
      sendPromptStreamFn: (msg, onEvent) => sendPromptStream(msg, onEvent, f),
      getHistoryFn: () => getHistory(f),
      getStatusFn: () => getStatus(f),
      onCompleteFn: () => notifyActiveDone(activeName()),
      onStatusUpdateFn: (status) => { if (id === activeSessionId) updateHeader(status); },
    });
    if (result && !result.completed && id === activeSessionId) {
      // dropped stream — reattach
      const attach = new AbortController();
      if (activeAttach) activeAttach.abort();
      activeAttach = attach;
      attachStream(makeStreamHandler(id), scopedFetch(id, attach.signal)).catch(() => {});
    }
  }

  async function handleStop() {
    if (!activeSessionId) return;
    await doStop({ chat, abortFn: () => abortAgent(scopedFetch(activeSessionId)) });
  }

  // ── Session sidebar ──

  function renderSessions() {
    $sessionsList.innerHTML = "";
    if (!sessions.length) { $sessionsList.innerHTML = '<div class="cmd-empty">No active sessions</div>'; return; }
    for (const s of sessions) {
      const el = document.createElement("div");
      el.className = "session-item";
      if (s.sessionId === activeSessionId) el.classList.add("current");
      const name = s.sessionName || s.sessionId?.slice(0, 8) || "unknown";
      el.title = name;
      el.innerHTML = `<div class="session-item-row"><div class="session-item-info"><div class="item-name"></div></div></div><div class="item-meta"></div>`;
      el.querySelector(".item-name").textContent = name;
      el.querySelector(".item-meta").textContent = s.busy ? `:${s.port} · busy` : `:${s.port}`;
      if (s.busy) el.classList.add("session-busy");
      el.addEventListener("click", () => { if (s.sessionId !== activeSessionId) switchTo(s.sessionId); });
      $sessionsList.appendChild(el);
    }
  }

  async function loadSessions() {
    try {
      const data = await (await fetch("/api/sessions")).json();
      sessions = data.sessions || [];
    } catch {
      sessions = [];
    }
    renderSessions();
    if (!activeSessionId && sessions.length) switchTo(sessions[0].sessionId);
  }

  $refreshSessions?.addEventListener("click", loadSessions);
  $commandsTitle.textContent = "commands";
  $commandsCount.textContent = "";

  // ── Aggregate event stream: notify for background sessions ──
  // The active session is notified by its own stream handler (focus-gated).
  // Here we handle every OTHER session finishing — that's the cross-session
  // notification: "the session you're not looking at is done".
  function subscribeEvents() {
    const es = new EventSource("/api/events");
    es.onmessage = (e) => {
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      if (msg.type === "session_done" && msg.sessionId !== activeSessionId) {
        fireNotification(msg.sessionName || msg.sessionId.slice(0, 8));
        loadSessions(); // refresh busy badges
      }
    };
    es.onerror = () => {}; // EventSource auto-reconnects
  }

  loadSessions();
  subscribeEvents();
  setInterval(loadSessions, 3000);
})();
