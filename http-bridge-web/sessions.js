/**
 * Sessions view — left sidebar, lists all active pi bridge sessions.
 * Each session item has a QR button and a close button.
 * The header has an add button to spawn a new session.
 * Double-click a session name to rename it.
 */

import { getSessions, killSession, newSession, reloadSession, renameSession } from "./api.js";
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
      const url = s.url || `http://localhost:${s.port}`;
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
        await renameSession(newName, s.url || `http://localhost:${s.port}`);
        // Poll for discovery file update
        for (let i = 0; i < 5; i++) {
          await new Promise((r) => setTimeout(r, 300));
          try {
            const data = await getSessions();
            sessions = data.sessions || [];
            const updated = sessions.find((x) => x.pid === s.pid);
            if (updated && updated.sessionName === newName) {
              render();
              return;
            }
          } catch {
            // Keep polling
          }
        }
        render();
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

  async function handleNew() {
    let created = false;
    try {
      const prevCount = sessions.length;
      await newSession();
      for (let i = 0; i < 10; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        try {
          const data = await getSessions();
          sessions = data.sessions || [];
          if (sessions.length > prevCount) {
            created = true;
            render();
            break;
          }
        } catch {
          // Server might be temporarily unavailable during reload — keep polling
        }
      }
      if (!created) {
        $list.innerHTML = '<div class="cmd-empty">New session not detected — try refresh</div>';
      }
    } catch (err) {
      $list.innerHTML = `<div class="cmd-empty">Failed to create: ${escapeHtml(err.message)}</div>`;
    }
  }

  async function handleReloadAll() {
    if (sessions.length === 0) return;
    if (!confirm(`Reload all ${sessions.length} session(s)?`)) return;

    const prevPids = new Set(sessions.map((s) => s.pid));

    // Send reload to all sessions concurrently
    const results = await Promise.allSettled(
      sessions.map((s) => reloadSession(s.url || `http://localhost:${s.port}`)),
    );

    const failed = results.filter((r) => r.status === "rejected").length;
    if (failed > 0) {
      $list.insertAdjacentHTML(
        "afterbegin",
        `<div class="cmd-empty">${failed} session(s) failed to reload</div>`,
      );
    }

    // Poll until all old sessions are replaced with new ones
    for (let i = 0; i < 15; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      try {
        const data = await getSessions();
        sessions = data.sessions || [];
        // All old PIDs gone means all have respawned
        if (sessions.every((s) => !prevPids.has(s.pid))) {
          render();
          return;
        }
      } catch {
        // Keep polling
      }
    }
    await load();
  }

  async function handleClose(s) {
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
        const url = other.url || `http://localhost:${other.port}`;
        window.location.href = url;
        return;
      }
      $list.innerHTML = '<div class="cmd-empty">Session closed</div>';
      return;
    }

    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 500));
      try {
        const data = await getSessions();
        sessions = data.sessions || [];
        if (!sessions.some((x) => x.pid === s.pid)) {
          render();
          return;
        }
      } catch {
        // Keep polling
      }
    }
    await load();
  }

  return { load, handleNew, handleReloadAll };
}
