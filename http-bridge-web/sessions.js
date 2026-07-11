/**
 * Sessions view — left sidebar, lists all active pi bridge sessions.
 * Each session item has a QR button and a close button.
 * The header has an add button to spawn a new session.
 */

import { getSessions, killSession, newSession } from "./api.js";
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
            <div class="item-name">${escapeHtml(name)}</div>
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

      $list.appendChild(el);
    }
  }

  async function handleNew() {
    let created = false;
    try {
      const prevCount = sessions.length;
      await newSession();
      // Poll until new session's discovery file appears
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

  async function handleClose(s) {
    if (!confirm(`Close session "${s.sessionName || s.sessionId?.slice(0, 8)}"?`)) return;

    const isCurrent = s.port === getCurrentPort();

    try {
      await killSession(s.pid);
    } catch (err) {
      $list.innerHTML = `<div class="cmd-empty">Failed to close: ${escapeHtml(err.message)}</div>`;
      return;
    }

    // If closing the current session, redirect to another one immediately
    // — our own HTTP server is about to die, polling will fail
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

    // Closing a different session — poll until it disappears from discovery
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
    // Fallback: just reload
    await load();
  }

  return { load, handleNew };
}
