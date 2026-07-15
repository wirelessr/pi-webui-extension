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
import { addGroup, displayLayout, rebuildItems, removeGroup, renameGroup, setGroupCollapsed } from "/hub-state-logic.js";
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
  let hubState = { items: [] }; // interleaved sidebar layout (sessions + groups)
  let draggingSid = null; // sessionId being dragged (suppresses re-render mid-drag)
  let draggingGroupId = null; // group being dragged (reorders groups)
  let activeStreaming = false; // a live stream is feeding the active header (so the poll must not override it)
  let activePromptAbort = null; // AbortController for the active session's outgoing /api/prompt stream

  let toolsExpanded = localStorage.getItem("pi-hub-tools-expanded") === "true";
  const chat = createChat({ $messages, $chat, $scrollBottom, isToolsExpanded: () => toolsExpanded });
  const mobileNav = createMobileNav({ $app });
  // Kept for the input's "/" command filtering; commands load per active
  // session (the hub has no aggregated /api/commands endpoint).
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
        activeStreaming = false;
        if (event.type === "done") {
          notifyActiveDone(activeName());
          getHistory(scopedFetch(sessionId)).then((data) => {
            if (sessionId === activeSessionId && data.history?.length) chat.loadHistory(data.history);
          }).catch(() => {});
        }
      } else {
        activeStreaming = true;
        chat.handleEvent(event);
      }
    };
  }

  // ── Session switching (in-page) ──

  async function switchTo(sessionId) {
    if (activeAttach) { activeAttach.abort(); activeAttach = null; }
    // Release any outgoing prompt stream we were holding on the session we're
    // leaving, so its bridge frees the SSE slot. Otherwise switching back can't
    // re-attach (the bridge won't let attach steal an active prompt stream →
    // 409). The turn keeps running on the bridge; re-attach resumes it live.
    if (activePromptAbort) { activePromptAbort.abort(); activePromptAbort = null; }
    activeSessionId = sessionId;
    activeStreaming = false;
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
      setBusyFn: (b) => { if (sessionId === activeSessionId) { setBusy(b); activeStreaming = b; } },
      setStreamingFn: (s) => { if (sessionId === activeSessionId) input.setStreaming(s); },
    });

    // If we couldn't attach (e.g. the turn is owned by another client's prompt
    // stream on this session), the header would otherwise show a false idle.
    // Fall back to the polled busy state so it matches the sidebar; the poll in
    // loadSessions keeps it in sync and clears it when the turn ends.
    if (!activeStreaming && sessionId === activeSessionId) {
      const s = sessions.find((x) => x.sessionId === sessionId);
      if (s) setBusy(!!s.busy);
    }
  }

  // ── Send / stop (active session) ──

  // doSendPrompt drives the shared chat/input directly and isn't session-aware,
  // so wrap them to no-op once we've switched away — otherwise a prompt stream
  // aborted on switch (or finishing in the background) would splatter its
  // cleanup (error bubble, old-session history reload) onto the session we
  // switched to.
  function guardedFor(id) {
    const g = (fn) => (...a) => { if (id === activeSessionId) return fn(...a); };
    return {
      chat: {
        addMessage: g((...a) => chat.addMessage(...a)),
        startAssistantMessage: g((...a) => chat.startAssistantMessage(...a)),
        finishAssistantMessage: g((...a) => chat.finishAssistantMessage(...a)),
        handleEvent: g((...a) => chat.handleEvent(...a)),
        showError: g((...a) => chat.showError(...a)),
        loadHistory: g((...a) => chat.loadHistory(...a)),
      },
      input: { setStreaming: g((s) => input.setStreaming(s)) },
    };
  }

  async function handleSend(text) {
    if (!activeSessionId) return;
    const id = activeSessionId;
    const f = scopedFetch(id);
    const promptAbort = new AbortController();
    if (activePromptAbort) activePromptAbort.abort();
    activePromptAbort = promptAbort;
    const streamFetch = scopedFetch(id, promptAbort.signal);
    const guard = guardedFor(id);
    const result = await doSendPrompt({
      text, chat: guard.chat, input: guard.input,
      setBusyFn: (b) => { if (id === activeSessionId) { setBusy(b); activeStreaming = b; } },
      sendPromptStreamFn: (msg, onEvent) => sendPromptStream(msg, onEvent, streamFetch),
      getHistoryFn: () => getHistory(f),
      getStatusFn: () => getStatus(f),
      onCompleteFn: () => notifyActiveDone(activeName()),
      onStatusUpdateFn: (status) => { if (id === activeSessionId) updateHeader(status); },
    });
    if (activePromptAbort === promptAbort) activePromptAbort = null;
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

  // First live session in display order (for auto-selecting on load).
  function firstLiveSessionId() {
    for (const it of displayLayout(hubState, sessions.map((s) => s.sessionId))) {
      if (it.type === "session") return it.id;
      if (it.type === "group" && it.members.length) return it.members[0];
    }
    return sessions[0]?.sessionId;
  }

  function makeSessionEl(s) {
    const el = document.createElement("div");
    el.className = "session-item";
    el.draggable = true;
    el.dataset.sid = s.sessionId;
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
    el.addEventListener("dragstart", (e) => { e.stopPropagation(); draggingSid = s.sessionId; el.classList.add("dragging"); });
    el.addEventListener("dragend", () => {
      el.classList.remove("dragging");
      draggingSid = null;
      commitLayout();
    });
    return el;
  }

  // After any drag, the DOM is the source of truth: walk the top-level items
  // (sessions and groups, interleaved), read each group's members, and persist.
  function commitLayout() {
    const layout = [];
    for (const child of $sessionsList.children) {
      if (child.classList.contains("session-item")) {
        layout.push({ type: "session", id: child.dataset.sid });
      } else if (child.classList.contains("group")) {
        const members = [...child.querySelectorAll(".group-body > .session-item")].map((x) => x.dataset.sid);
        layout.push({ type: "group", id: child.dataset.gid, members });
      }
    }
    hubState = rebuildItems(hubState, layout);
    persistHubState();
  }

  function makeGroupEl(g) {
    const byId = new Map(sessions.map((s) => [s.sessionId, s]));
    const wrap = document.createElement("div");
    wrap.className = `group${g.collapsed ? " collapsed" : ""}`;
    wrap.dataset.gid = g.id;

    const header = document.createElement("div");
    header.className = "group-header";
    header.draggable = true; // drag the header to move the whole group in the list
    header.addEventListener("dragstart", (e) => {
      e.stopPropagation(); // a group drag, not a session drag
      draggingGroupId = g.id;
      wrap.classList.add("group-dragging");
    });
    header.addEventListener("dragend", () => {
      draggingGroupId = null;
      wrap.classList.remove("group-dragging");
      commitLayout();
    });
    header.innerHTML = `<span class="group-toggle">${g.collapsed ? "▸" : "▾"}</span><span class="group-name"></span><span class="group-count"></span><button class="group-del" title="Delete group">&times;</button>`;
    header.querySelector(".group-name").textContent = g.name;
    header.querySelector(".group-count").textContent = g.members.length;
    header.addEventListener("click", (e) => {
      if (e.target.closest(".group-del") || e.target.closest(".group-name")) return;
      hubState = setGroupCollapsed(hubState, g.id, !g.collapsed);
      persistHubState();
      renderSessions();
    });
    header.querySelector(".group-name").addEventListener("dblclick", (e) => {
      e.stopPropagation();
      const name = prompt("Rename group:", g.name);
      if (name?.trim()) { hubState = renameGroup(hubState, g.id, name.trim()); persistHubState(); renderSessions(); }
    });
    header.querySelector(".group-del").addEventListener("click", (e) => {
      e.stopPropagation();
      if (!confirm(`Delete group "${g.name}"? Sessions stay, just ungrouped.`)) return;
      hubState = removeGroup(hubState, g.id);
      persistHubState();
      renderSessions();
    });
    wrap.appendChild(header);

    const body = document.createElement("div");
    body.className = "group-body";
    for (const sid of g.members) { const s = byId.get(sid); if (s) body.appendChild(makeSessionEl(s)); }
    wrap.appendChild(body);
    return wrap;
  }

  function renderSessions() {
    if (draggingSid || draggingGroupId) return; // don't yank the DOM out from under an active drag
    $sessionsList.innerHTML = "";
    if (!sessions.length) { $sessionsList.innerHTML = '<div class="cmd-empty">No active sessions</div>'; return; }
    const byId = new Map(sessions.map((s) => [s.sessionId, s]));
    // Sessions and groups are peers in one ordered list, rendered as direct
    // children of the sidebar so they reorder together.
    for (const it of displayLayout(hubState, sessions.map((s) => s.sessionId))) {
      if (it.type === "group") {
        $sessionsList.appendChild(makeGroupEl(it));
      } else {
        const s = byId.get(it.id);
        if (s) $sessionsList.appendChild(makeSessionEl(s));
      }
    }
  }

  // Position the dragged element by cursor midpoint among a set of candidates.
  function placeByCursor(dragged, container, candidates, y) {
    const after = candidates.find((el) => y < el.getBoundingClientRect().top + el.getBoundingClientRect().height / 2);
    if (after) container.insertBefore(dragged, after);
    else container.appendChild(dragged);
  }
  // Top-level items = direct children that are a session or a group.
  const topLevelItems = (exclude) =>
    [...$sessionsList.children].filter((c) => c !== exclude && (c.classList.contains("session-item") || c.classList.contains("group")));

  // Live DOM move while dragging (container outlives re-renders → attached once).
  $sessionsList.addEventListener("dragover", (e) => {
    if (draggingGroupId) {
      // A group moves among the top-level items (it can't nest in another group).
      e.preventDefault();
      const dragging = $sessionsList.querySelector(".group.group-dragging");
      if (dragging) placeByCursor(dragging, $sessionsList, topLevelItems(dragging), e.clientY);
      return;
    }
    if (!draggingSid) return;
    e.preventDefault();
    const dragging = $sessionsList.querySelector(".session-item.dragging");
    if (!dragging) return;
    // Into a group? (hovering its body, or its header — which expands it)
    let body = e.target.closest(".group-body");
    if (!body) {
      const header = e.target.closest(".group-header");
      if (header) {
        const group = header.closest(".group");
        group.classList.remove("collapsed");
        body = group.querySelector(".group-body");
      }
    }
    if (body) {
      placeByCursor(dragging, body, [...body.querySelectorAll(".session-item:not(.dragging)")], e.clientY);
    } else {
      // Top level — reorders alongside groups.
      placeByCursor(dragging, $sessionsList, topLevelItems(dragging), e.clientY);
    }
  });

  async function persistHubState() {
    try {
      const res = await fetch("/api/hub-state", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(hubState),
      });
      if (res.ok) hubState = await res.json(); // server returns normalized + pruned
    } catch {}
  }

  async function loadSessions() {
    try {
      const data = await (await fetch("/api/sessions")).json();
      sessions = data.sessions || [];
    } catch {
      sessions = [];
    }
    // Refresh persisted order/groups too (best-effort; keeps cross-device in sync).
    try {
      hubState = await (await fetch("/api/hub-state")).json();
    } catch {}
    // Self-heal: if the session we were viewing vanished (killed elsewhere,
    // or reloaded under a new id), drop the stale active so we re-select.
    if (activeSessionId && !sessions.some((s) => s.sessionId === activeSessionId)) {
      activeSessionId = null;
    }
    renderSessions();
    // Keep the active session's header busy in sync with the poll (same source
    // as the sidebar), unless a live stream is currently driving it. This
    // clears a stuck "busy" when a turn we couldn't attach to ends.
    if (!activeStreaming) {
      const active = sessions.find((s) => s.sessionId === activeSessionId);
      if (active) setBusy(!!active.busy);
    }
    if (!activeSessionId && sessions.length) switchTo(firstLiveSessionId());
  }

  // ── Session management (proxied to a session's bridge) ──

  const $newSession = document.getElementById("new-session");
  const $reloadAll = document.getElementById("reload-all");
  const $newGroup = document.getElementById("new-group");

  function makeGroupId() {
    // Not crypto.randomUUID(): that needs a secure context, unavailable over
    // http:// on the LAN IP (phone). This is unique enough for local prefs.
    return `g_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
  }
  function handleNewGroup() {
    const name = prompt("New group name:", "group");
    if (name == null) return;
    hubState = addGroup(hubState, { id: makeGroupId(), name: name.trim() || "group" });
    persistHubState();
    renderSessions();
  }
  const $sessionModal = document.getElementById("new-session-modal");
  const $sessionIdInput = document.getElementById("session-id-input");
  const $sessionCwdInput = document.getElementById("session-cwd-input");
  const $sessionCwdList = document.getElementById("session-cwd-candidates");
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
    // Offer the cwds of currently-running sessions as pick-or-type candidates.
    const cwds = [...new Set(sessions.map((s) => s.cwd).filter(Boolean))].sort();
    $sessionCwdList.innerHTML = cwds
      .map((c) => `<option value="${c.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"></option>`)
      .join("");
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
  $newGroup?.addEventListener("click", handleNewGroup);
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
