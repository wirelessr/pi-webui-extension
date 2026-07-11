/**
 * Sessions view — left sidebar, lists all active pi bridge sessions.
 * Each session item has a QR button and a close button.
 * The header has an add button to spawn a new session.
 */

import { getSessions, killSession, newSession } from "./api.js";
import { createQrCode } from "./qr.js";
import { escapeHtml } from "./utils.js";

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
        <div class="session-item-info">
          <div class="item-name">${escapeHtml(name)}</div>
          <div class="item-meta">${escapeHtml(url)}</div>
        </div>
        <button class="qr-btn" title="Show QR code" data-url="${escapeHtml(url)}">&#9641;</button>
        <button class="close-btn" title="Close session" data-pid="${s.pid}">&times;</button>
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
    try {
      await newSession();
      // Poll a few times — new session needs time to start and write discovery file
      for (let i = 0; i < 5; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        await load();
        // Check if a new session appeared
        const data = await getSessions();
        const newCount = (data.sessions || []).length;
        if (newCount > sessions.length) break;
      }
    } catch (err) {
      // Show error in list
      $list.innerHTML = `<div class="cmd-empty">Failed to create: ${escapeHtml(err.message)}</div>`;
    }
  }

  async function handleClose(s) {
    if (!confirm(`Close session "${s.sessionName || s.sessionId?.slice(0, 8)}"?`)) return;
    try {
      await killSession(s.pid);
      // Wait for discovery file cleanup, then refresh
      await new Promise((r) => setTimeout(r, 500));
      await load();
    } catch (err) {
      $list.innerHTML = `<div class="cmd-empty">Failed to close: ${escapeHtml(err.message)}</div>`;
    }
  }

  return { load, handleNew };
}
