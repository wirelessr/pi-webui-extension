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
            <div class="item-name" title="Double-click to rename">${escapeHtml(name)}</div>
          </div>
          <button class="qr-btn" title="Show QR code" data-url="${escapeHtml(url)}">&#9641;</button>
          <button class="close-btn" title="Close session" data-pid="${s.pid}">&times;</button>
        </div>
        <div class="item-meta">${escapeHtml(url)}</div>
      `;

      el.addEventListener("click", (e) => {
        if (e.target.classList.contains("qr-btn")) {
          e.stopPropagation();
          qr.show(url);
          return;
        }
        if (e.target.classList.contains("close-btn")) {
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

    $sessionMenu.style.left = `${Math.min(e.clientX, window.innerWidth - 200)}px`;
    $sessionMenu.style.top = `${Math.min(e.clientY, window.innerHeight - 150)}px`;
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
      if (!newName || newName === currentName) {
        render();
        return;
      }
      try {
        await renameSession(newName, sessionUrl(s));
        // Poll until discovery file reflects the new name
        const result = await pollUntil(async () => {
          const all = await refreshSessions();
          const updated = all.find((x) => x.pid === s.pid);
          if (updated && updated.sessionName === newName) {
            render();
            return true;
          }
          return false;
        }, 300, 5);
        if (!result) render();
      } catch (err) {
        render();
        $list.insertAdjacentHTML(
          "afterbegin",
          `<div class="cmd-empty">Rename failed: ${escapeHtml(err.message)}</div>`,
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
    try {
      const prevCount = sessions.length;
      await newSession();
      const result = await pollUntil(async () => {
        const all = await refreshSessions();
        if (all.length > prevCount) {
          render();
          return true;
        }
        return false;
      }, 1000, 10);
      if (!result) {
        $list.innerHTML = '<div class="cmd-empty">New session not detected — try refresh</div>';
      }
    } catch (err) {
      $list.innerHTML = `<div class="cmd-empty">Failed to create: ${escapeHtml(err.message)}</div>`;
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
    if (sessions.length <= 1) {
      $list.insertAdjacentHTML(
        "afterbegin",
        '<div class="cmd-empty">Cannot close the last session</div>',
      );
      return;
    }
    if (!confirm(`Close session "${s.sessionName || s.sessionId?.slice(0, 8)}"?`)) return;

    const isCurrent = s.port === getCurrentPort();

    try {
      await killSession(s.pid);
    } catch (err) {
      $list.innerHTML = `<div class="cmd-empty">Failed to close: ${escapeHtml(err.message)}</div>`;
      return;
    }

    if (isCurrent) {
      const other = pickRedirectTarget(sessions, s.pid);
      if (other) {
        window.location.href = sessionUrl(other);
        return;
      }
      $list.innerHTML = '<div class="cmd-empty">Session closed</div>';
      return;
    }

    // Poll until the session disappears from discovery
    const result = await pollUntil(async () => {
      const all = await refreshSessions();
      if (!all.some((x) => x.pid === s.pid)) {
        render();
        return true;
      }
      return false;
    }, 500, 5);
    if (!result) await load();
  }

  return { load, handleNew, handleReloadAll };
}
