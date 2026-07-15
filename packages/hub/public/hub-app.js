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

import { abortAgent, attachStream, getCommands, getHistory, getStatus, killSession, pollUntil, reloadSession, renameSession, sendPromptStream } from "/api.js";
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
  const commandsView = createCommandsView({
    $list: $commandsList, $count: $commandsCount, $title: $commandsTitle,
    onSelect: (cmd) => input.selectCommand(cmd),
    // Commands are per-session — load them from the active session's bridge.
    getCommandsFn: () => (activeSessionId ? getCommands(scopedFetch(activeSessionId)) : Promise.resolve({ commands: [] })),
  });
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
      loadCommandsFn: () => commandsView.load(),
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
      el.innerHTML = `<div class="session-item-row"><div class="session-item-info"><div class="item-name"></div></div><button class="qr-btn" title="Reload session">&#10227;</button><button class="close-btn" title="Close session">&times;</button></div><div class="item-meta"></div>`;
      const nameEl = el.querySelector(".item-name");
      nameEl.textContent = name;
      nameEl.title = "Double-click to rename";
      nameEl.addEventListener("dblclick", (e) => { e.stopPropagation(); handleRename(s); });
      el.querySelector(".item-meta").textContent = s.busy ? `:${s.port} · busy` : `:${s.port}`;
      if (s.busy) el.classList.add("session-busy");
      el.querySelector(".qr-btn").addEventListener("click", (e) => { e.stopPropagation(); handleReload(s); });
      el.querySelector(".close-btn").addEventListener("click", (e) => { e.stopPropagation(); handleClose(s); });
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
    // Self-heal: if the session we were viewing vanished (killed elsewhere,
    // or reloaded under a new id), drop the stale active so we re-select.
    if (activeSessionId && !sessions.some((s) => s.sessionId === activeSessionId)) {
      activeSessionId = null;
    }
    renderSessions();
    if (!activeSessionId && sessions.length) switchTo(sessions[0].sessionId);
  }

  // ── Session management (proxied to a session's bridge) ──

  const $newSession = document.getElementById("new-session");
  const $reloadAll = document.getElementById("reload-all");
  const $sessionModal = document.getElementById("new-session-modal");
  const $sessionIdInput = document.getElementById("session-id-input");
  const $sessionCwdInput = document.getElementById("session-cwd-input");
  const $sessionModalCancel = document.getElementById("session-modal-cancel");
  const $sessionModalOk = document.getElementById("session-modal-ok");

  // Spawn a fresh session, or resume an existing one by ID.
  //  - sessionId given  → resume; cwd is ignored (server resolves the session's
  //    original cwd from its history — pi won't resume from the wrong project).
  //  - no sessionId, cwd given → new session in that cwd.
  //  - no sessionId, no cwd    → new session inheriting the currently-viewed
  //    session's cwd (server falls back to homedir when there's no active one).
  async function handleNew(sessionId, cwd) {
    // Already open (exact id, or the 8-char prefix shown in the sidebar)?
    // Just switch to it instead of spawning a duplicate.
    if (sessionId) {
      const existing = sessions.find((s) => s.sessionId === sessionId || s.sessionId.startsWith(sessionId));
      if (existing) { switchTo(existing.sessionId); return; }
    }
    const prevIds = new Set(sessions.map((s) => s.sessionId));
    let endpoint;
    let body;
    if (sessionId) {
      endpoint = "/api/open-session";
      body = JSON.stringify({ sessionId });
    } else {
      endpoint = "/api/new-session";
      const inheritCwd = cwd || sessions.find((s) => s.sessionId === activeSessionId)?.cwd;
      body = JSON.stringify(inheritCwd ? { cwd: inheritCwd } : {});
    }
    try {
      const res = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
    } catch (err) {
      alert(`Failed to ${sessionId ? "open" : "create"} session: ${err.message}`);
      return;
    }
    // wait for the new session's discovery to appear, then switch to it
    const fresh = await pollUntil(async () => {
      const data = await (await fetch("/api/sessions")).json();
      sessions = data.sessions || [];
      return (data.sessions || []).find((s) => !prevIds.has(s.sessionId)) || false;
    }, 1000, 15);
    renderSessions();
    if (fresh) {
      switchTo(fresh.sessionId);
    } else if (sessionId) {
      // pi exits silently when it can't resume the id, so no bridge appears.
      alert(`Could not open session "${sessionId}".\nCheck it's a valid pi session id with saved history.`);
    }
  }

  function openSessionModal() {
    $sessionIdInput.value = "";
    $sessionCwdInput.value = "";
    $sessionModal.classList.remove("hidden");
    $sessionIdInput.focus();
  }
  function closeSessionModal() {
    $sessionModal.classList.add("hidden");
  }
  function submitSessionModal() {
    const sessionId = $sessionIdInput.value.trim();
    const cwd = $sessionCwdInput.value.trim();
    closeSessionModal();
    handleNew(sessionId || undefined, cwd || undefined);
  }
  $sessionModalCancel?.addEventListener("click", closeSessionModal);
  $sessionModal?.addEventListener("click", (e) => { if (e.target === $sessionModal) closeSessionModal(); });
  $sessionModalOk?.addEventListener("click", submitSessionModal);
  const modalKeydown = (e) => {
    if (e.key === "Enter") { e.preventDefault(); submitSessionModal(); }
    if (e.key === "Escape") closeSessionModal();
  };
  $sessionIdInput?.addEventListener("keydown", modalKeydown);
  $sessionCwdInput?.addEventListener("keydown", modalKeydown);

  async function handleClose(s) {
    if (!confirm(`Close session "${s.sessionName || s.sessionId.slice(0, 8)}"?`)) return;
    try {
      await killSession(s.pid, scopedFetch(s.sessionId));
    } catch (err) {
      alert(`Failed to close: ${err.message}`);
      return;
    }
    if (s.sessionId === activeSessionId) {
      if (activeAttach) { activeAttach.abort(); activeAttach = null; }
      activeSessionId = null;
      $messages.innerHTML = "";
    }
    await pollUntil(async () => {
      const data = await (await fetch("/api/sessions")).json();
      sessions = data.sessions || [];
      return !sessions.some((x) => x.sessionId === s.sessionId);
    }, 500, 10);
    renderSessions();
    if (!activeSessionId && sessions.length) switchTo(sessions[0].sessionId);
  }

  async function handleReload(s) {
    if (!confirm(`Reload session "${s.sessionName || s.sessionId.slice(0, 8)}"?`)) return;
    const port = s.port;
    const wasActive = s.sessionId === activeSessionId;
    if (wasActive && activeAttach) { activeAttach.abort(); activeAttach = null; }
    try {
      await reloadSession("", scopedFetch(s.sessionId));
    } catch (err) {
      alert(`Failed to reload: ${err.message}`);
      return;
    }
    // Reload respawns on the same port with a new process (and possibly a new
    // sessionId). Wait for the port to come back, then re-attach to it.
    const back = await pollUntil(async () => {
      const data = await (await fetch("/api/sessions")).json();
      sessions = data.sessions || [];
      renderSessions();
      return sessions.find((x) => x.port === port) || false;
    }, 1000, 12);
    if (wasActive) {
      activeSessionId = null;
      if (back) switchTo(back.sessionId);
    }
  }

  async function handleRename(s) {
    const current = s.sessionName || s.sessionId.slice(0, 8);
    const name = prompt("Rename session:", current);
    if (name == null) return;
    const trimmed = name.trim();
    if (!trimmed || trimmed === current) return;
    try {
      await renameSession(trimmed, "", scopedFetch(s.sessionId));
    } catch (err) {
      alert(`Rename failed: ${err.message}`);
      return;
    }
    await pollUntil(async () => {
      const data = await (await fetch("/api/sessions")).json();
      sessions = data.sessions || [];
      const u = sessions.find((x) => x.sessionId === s.sessionId);
      if (u && u.sessionName === trimmed) {
        renderSessions();
        if (s.sessionId === activeSessionId) $sessionName.textContent = trimmed;
        return true;
      }
      return false;
    }, 300, 8);
  }

  async function handleReloadAll() {
    if (!sessions.length) return;
    if (!confirm(`Reload all ${sessions.length} session(s)?`)) return;
    await Promise.allSettled(sessions.map((s) => reloadSession("", scopedFetch(s.sessionId))));
    setTimeout(loadSessions, 2500);
  }

  $newSession?.addEventListener("click", openSessionModal);
  $reloadAll?.addEventListener("click", handleReloadAll);
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
