/**
 * Sessions view — left sidebar, lists all active pi bridge sessions.
 * Each session item has a QR button to show a scannable QR code of its URL.
 */

import { getSessions } from "./api.js";
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
      `;

      el.addEventListener("click", (e) => {
        if (e.target.classList.contains("qr-btn")) {
          e.stopPropagation();
          qr.show(url);
          return;
        }
        onOpen(s);
      });

      $list.appendChild(el);
    }
  }

  return { load };
}
