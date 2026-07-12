/**
 * Sessions view — left sidebar, lists all active pi bridge sessions.
 * Global management: add, close, rename, reload any session.
 */

import {
  getSessions,
  killSession,
  newSession,
  pollUntil,
  reloadSession,
  renameSession,
  sessionUrl,
} from "./api.js";
import { createQrCode } from "./qr.js";
import { clampMenuPosition, decideSessionClick } from "./ui-behaviors.js";
import { escapeHtml } from "./utils.js";

/**
 * Given a list of sessions and the pid being closed, return the session
 * to redirect to (first available that isn't the one being closed).
 * Returns null if no other session exists.
 */
export function pickRedirectTarget(sessions, closedPid) {
  return sessions.find((s) => s.pid !== closedPid) || null;
}

/**
 * Check if all previous PIDs have been replaced by new ones.
 * @param {Array} currentSessions - current session list
 * @param {Set} prevPids - set of PIDs before reload
 * @returns {boolean} true if none of the current sessions have an old PID
 */
export function allPidsReplaced(currentSessions, prevPids) {
  if (currentSessions.length === 0) return false;
  return currentSessions.every((s) => !prevPids.has(s.pid));
}

/**
 * Decide what to do after reload-all polling completes.
 * @param {boolean} pollSucceeded - whether allPidsReplaced returned true within retry budget
 * @returns {"reloadPage" | "loadList"}
 */
export function reloadAllOutcome(pollSucceeded) {
  return pollSucceeded ? "reloadPage" : "loadList";
}

/**
 * Core reload-all behavior with injectable side effects.
 * @param {object} opts
 * @param {Array} opts.sessions - current session list
 * @param {function} opts.confirmFn - returns boolean (user confirms)
 * @param {function} opts.reloadSessionFn - (url) => Promise, called per session
 * @param {function} opts.sessionUrlFn - (session) => string
 * @param {function} opts.refreshSessionsFn - () => Promise<Array>, returns updated session list
 * @param {function} opts.pollUntilFn - (fn, interval, max) => Promise<boolean>
 * @param {function} opts.renderFn - () => void
 * @param {function} opts.loadFn - () => Promise
 * @param {function} opts.reloadPageFn - () => void (window.location.reload)
 * @returns {Promise<{action: string, reason: string}>}
 */
export async function doReloadAll(opts) {
  const {
    sessions,
    confirmFn,
    reloadSessionFn,
    sessionUrlFn,
    refreshSessionsFn,
    pollUntilFn,
    renderFn,
    loadFn,
    reloadPageFn,
  } = opts;

  if (sessions.length === 0) return { action: "noop", reason: "no sessions" };
  if (!confirmFn(`Reload all ${sessions.length} session(s)?`)) {
    return { action: "noop", reason: "user cancelled" };
  }

  const prevPids = new Set(sessions.map((s) => s.pid));

  await Promise.allSettled(
    sessions.map((s) => reloadSessionFn(sessionUrlFn(s))),
  );

  const result = await pollUntilFn(async () => {
    const all = await refreshSessionsFn();
    if (allPidsReplaced(all, prevPids)) {
      renderFn();
      return true;
    }
    return false;
  }, 1000, 15);

  const outcome = reloadAllOutcome(result);
  if (outcome === "loadList") {
    await loadFn();
    return { action: "loadList", reason: "poll timed out" };
  }
  reloadPageFn();
  return { action: "reloadPage", reason: "all PIDs replaced" };
}

/**
 * Core new-session behavior with injectable side effects.
 * @param {object} opts
 * @param {number} opts.prevCount - current session count
 * @param {function} opts.newSessionFn - () => Promise
 * @param {function} opts.refreshSessionsFn - () => Promise<Array>
 * @param {function} opts.pollUntilFn - (fn, interval, max) => Promise
 * @param {function} opts.renderFn - () => void
 * @returns {Promise<{action: string, reason: string}>}
 */
export async function doNewSession(opts) {
  const { prevCount, newSessionFn, refreshSessionsFn, pollUntilFn, renderFn } = opts;
  try {
    await newSessionFn();
    const result = await pollUntilFn(async () => {
      const all = await refreshSessionsFn();
      if (all.length > prevCount) {
        renderFn();
        return true;
      }
      return false;
    }, 1000, 10);
    if (!result) return { action: "showError", reason: "New session not detected — try refresh" };
    return { action: "rendered", reason: "new session detected" };
  } catch (err) {
    return { action: "showError", reason: `Failed to create: ${err.message}` };
  }
}

/**
 * Core close-session behavior with injectable side effects.
 * @param {object} opts
 * @param {Array} opts.sessions - current session list
 * @param {object} opts.session - the session to close
 * @param {function} opts.confirmFn - (msg) => boolean
 * @param {function} opts.killSessionFn - (pid) => Promise
 * @param {function} opts.sessionUrlFn - (session) => string
 * @param {function} opts.getCurrentPortFn - () => number
 * @param {function} opts.refreshSessionsFn - () => Promise<Array>
 * @param {function} opts.pollUntilFn - (fn, interval, max) => Promise
 * @param {function} opts.renderFn - () => void
 * @param {function} opts.loadFn - () => Promise
 * @param {function} opts.redirectFn - (url) => void (window.location.href = url)
 * @returns {Promise<{action: string, reason: string}>}
 */
export async function doCloseSession(opts) {
  const {
    sessions, session, confirmFn, killSessionFn, sessionUrlFn,
    getCurrentPortFn, refreshSessionsFn, pollUntilFn, renderFn, loadFn, redirectFn,
  } = opts;

  if (sessions.length <= 1) return { action: "showError", reason: "Cannot close the last session" };

  const label = session.sessionName || session.sessionId?.slice(0, 8);
  if (!confirmFn(`Close session "${label}"?`)) return { action: "noop", reason: "user cancelled" };

  const isCurrent = session.port === getCurrentPortFn();

  try {
    await killSessionFn(session.pid);
  } catch (err) {
    return { action: "showError", reason: `Failed to close: ${err.message}` };
  }

  if (isCurrent) {
    const other = pickRedirectTarget(sessions, session.pid);
    if (other) {
      redirectFn(sessionUrlFn(other));
      return { action: "redirect", reason: "closed current session" };
    }
    return { action: "showError", reason: "Session closed" };
  }

  const result = await pollUntilFn(async () => {
    const all = await refreshSessionsFn();
    if (!all.some((x) => x.pid === session.pid)) {
      renderFn();
      return true;
    }
    return false;
  }, 500, 5);
  if (!result) {
    await loadFn();
    return { action: "loadList", reason: "poll timed out" };
  }
  return { action: "rendered", reason: "session disappeared from discovery" };
}

/**
 * Core rename-session behavior with injectable side effects.
 * @param {object} opts
 * @param {object} opts.session - the session to rename
 * @param {string} opts.newName - the new name (already trimmed)
 * @param {string} opts.currentName - the current name for comparison
 * @param {function} opts.renameSessionFn - (name, baseUrl) => Promise
 * @param {function} opts.sessionUrlFn - (session) => string
 * @param {function} opts.refreshSessionsFn - () => Promise<Array>
 * @param {function} opts.pollUntilFn - (fn, interval, max) => Promise
 * @param {function} opts.renderFn - () => void
 * @returns {Promise<{action: string, reason: string}>}
 */
export async function doRenameSession(opts) {
  const { session, newName, currentName, renameSessionFn, sessionUrlFn, refreshSessionsFn, pollUntilFn, renderFn } = opts;

  if (!newName || newName === currentName) {
    return { action: "rendered", reason: "no change" };
  }

  try {
    await renameSessionFn(newName, sessionUrlFn(session));
    const result = await pollUntilFn(async () => {
      const all = await refreshSessionsFn();
      const updated = all.find((x) => x.pid === session.pid);
      if (updated && updated.sessionName === newName) {
        renderFn();
        return true;
      }
      return false;
    }, 300, 5);
    if (!result) {
      renderFn();
      return { action: "rendered", reason: "poll timed out" };
    }
    return { action: "rendered", reason: "name updated" };
  } catch (err) {
    renderFn();
    return { action: "showError", reason: `Rename failed: ${err.message}` };
  }
}

export function createSessionsView({ $list, getCurrentPort, onOpen }) {
  let sessions = [];
  const qr = createQrCode();

  async function load() {
    try {
      const data = await getSessions();
      sessions = data.sessions || [];
      render();
    } catch {
      $list.innerHTML = '<div class="cmd-empty">Failed to load</div>';
    }
  }

  async function refreshSessions() {
    const data = await getSessions();
    sessions = data.sessions || [];
    return sessions;
  }

  function render() {
    $list.innerHTML = "";

    if (sessions.length === 0) {
      $list.innerHTML = '<div class="cmd-empty">No active sessions</div>';
      return;
    }

    const port = getCurrentPort();
    for (const s of sessions) {
      const el = document.createElement("div");
      el.className = "session-item";
      if (s.port === port) el.classList.add("current");

      const name = s.sessionName || s.sessionId?.slice(0, 8) || "unknown";
      const url = sessionUrl(s);
      el.innerHTML = `
        <div class="session-item-row">
          <div class="session-item-info">
            <div class="item-name" title="${escapeHtml(name)}">${escapeHtml(name)}</div>
          </div>
          <button class="qr-btn" title="Show QR code" data-url="${escapeHtml(url)}">&#9641;</button>
          <button class="close-btn" title="Close session" data-pid="${s.pid}">&times;</button>
        </div>
        <div class="item-meta">${escapeHtml(url)}</div>
      `;

      el.addEventListener("click", (e) => {
        const action = decideSessionClick({ targetClass: e.target.className });
        if (action === "qr") {
          e.stopPropagation();
          qr.show(url);
          return;
        }
        if (action === "close") {
          e.stopPropagation();
          handleClose(s);
          return;
        }
        onOpen(s);
      });

      const nameEl = el.querySelector(".item-name");
      nameEl.addEventListener("dblclick", (e) => {
        e.stopPropagation();
        handleRename(s, nameEl);
      });

      el.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        e.stopPropagation();
        showSessionMenu(e, s, nameEl);
      });

      $list.appendChild(el);
    }
  }

  // ── Context menu ────────────────────────────────────

  let $sessionMenu = null;
  function closeSessionMenu() {
    if ($sessionMenu) {
      $sessionMenu.remove();
      $sessionMenu = null;
    }
  }
  document.addEventListener("click", closeSessionMenu);
  document.addEventListener("scroll", closeSessionMenu, true);

  function showSessionMenu(e, s, nameEl) {
    closeSessionMenu();
    $sessionMenu = document.createElement("div");
    $sessionMenu.className = "context-menu";

    const renameItem = document.createElement("button");
    renameItem.className = "context-menu-item";
    renameItem.textContent = "Rename";
    renameItem.addEventListener("click", () => {
      closeSessionMenu();
      handleRename(s, nameEl);
    });
    $sessionMenu.appendChild(renameItem);

    const closeItem = document.createElement("button");
    closeItem.className = "context-menu-item";
    closeItem.textContent = "Close";
    closeItem.addEventListener("click", () => {
      closeSessionMenu();
      handleClose(s);
    });
    $sessionMenu.appendChild(closeItem);

    const pos = clampMenuPosition(e.clientX, e.clientY, window.innerWidth, window.innerHeight);
    $sessionMenu.style.left = `${pos.left}px`;
    $sessionMenu.style.top = `${pos.top}px`;
    document.body.appendChild($sessionMenu);
  }

  // ── Rename ──────────────────────────────────────────

  function handleRename(s, nameEl) {
    const currentName = s.sessionName || s.sessionId?.slice(0, 8) || "unknown";
    const input = document.createElement("input");
    input.type = "text";
    input.value = currentName;
    input.className = "rename-input";
    input.maxLength = 100;

    nameEl.replaceWith(input);
    input.focus();
    input.select();

    let done = false;
    async function commit() {
      if (done) return;
      done = true;
      const newName = input.value.trim();
      const result = await doRenameSession({
        session: s,
        newName,
        currentName,
        renameSessionFn: renameSession,
        sessionUrlFn: sessionUrl,
        refreshSessionsFn: refreshSessions,
        pollUntilFn: pollUntil,
        renderFn: render,
      });
      if (result.action === "showError") {
        $list.insertAdjacentHTML(
          "afterbegin",
          `<div class="cmd-empty">${escapeHtml(result.reason)}</div>`,
        );
      }
    }

    input.addEventListener("blur", commit);
    input.addEventListener("keydown", (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === "Enter") {
        e.preventDefault();
        input.blur();
      }
      if (e.key === "Escape") {
        done = true;
        render();
      }
    });
  }

  // ── New session ─────────────────────────────────────

  async function handleNew() {
    const prevCount = sessions.length;
    const result = await doNewSession({
      prevCount,
      newSessionFn: newSession,
      refreshSessionsFn: refreshSessions,
      pollUntilFn: pollUntil,
      renderFn: render,
    });
    if (result.action === "showError") {
      $list.innerHTML = `<div class="cmd-empty">${escapeHtml(result.reason)}</div>`;
    }
  }

  // ── Reload all ──────────────────────────────────────

  async function handleReloadAll() {
    await doReloadAll({
      sessions,
      confirmFn: (msg) => confirm(msg),
      reloadSessionFn: reloadSession,
      sessionUrlFn: sessionUrl,
      refreshSessionsFn: refreshSessions,
      pollUntilFn: pollUntil,
      renderFn: render,
      loadFn: load,
      reloadPageFn: () => window.location.reload(),
    });
  }

  // ── Close ───────────────────────────────────────────

  async function handleClose(s) {
    const result = await doCloseSession({
      sessions,
      session: s,
      confirmFn: (msg) => confirm(msg),
      killSessionFn: killSession,
      sessionUrlFn: sessionUrl,
      getCurrentPortFn: getCurrentPort,
      refreshSessionsFn: refreshSessions,
      pollUntilFn: pollUntil,
      renderFn: render,
      loadFn: load,
      redirectFn: (url) => { window.location.href = url; },
    });
    if (result.action === "showError") {
      $list.insertAdjacentHTML(
        "afterbegin",
        `<div class="cmd-empty">${escapeHtml(result.reason)}</div>`,
      );
    }
  }

  return { load, handleNew, handleReloadAll };
}
