/**
 * API client — thin wrappers over fetch for the HTTP bridge endpoints.
 *
 * Sessions run on separate ports. Use sessionUrl(s) to get a session's
 * base URL, then pass it to the cross-session API functions.
 */

import { parseSseBuffer } from "./sse-parser.js";

// ── Helpers ───────────────────────────────────────────

/**
 * Get the base URL for a session object.
 * @param {{url?: string, port: number}} s
 * @returns {string} e.g. "http://192.168.1.130:7331"
 */
export function sessionUrl(s) {
  return s.url || `http://localhost:${s.port}`;
}

/**
 * Poll a condition function until it returns truthy or max attempts reached.
 * Swallows errors — useful for waiting on discovery file updates.
 * @param {() => Promise<any>} fn — condition check, return truthy to stop
 * @param {number} intervalMs — delay between attempts
 * @param {number} maxAttempts — max poll attempts
 * @returns {Promise<any>} last truthy result, or null if timed out
 */
export async function pollUntil(fn, intervalMs = 500, maxAttempts = 10) {
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, intervalMs));
    try {
      const result = await fn();
      if (result) return result;
    } catch {
      // Keep polling
    }
  }
  return null;
}

// ── Current session API ───────────────────────────────

export async function getStatus() {
  const res = await fetch("/api/status");
  return res.json();
}

export async function getSessions() {
  const res = await fetch("/api/sessions");
  return res.json();
}

export async function getCommands() {
  const res = await fetch("/api/commands");
  return res.json();
}

export async function getHistory() {
  const res = await fetch("/api/history");
  return res.json();
}

export async function abortAgent() {
  const res = await fetch("/api/abort", { method: "POST" });
  return res.json();
}

export async function executeCommand(command) {
  const res = await fetch("/api/command", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ command }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Request failed" }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

// ── Session management (target current session) ───────

export async function newSession(cwd) {
  const res = await fetch("/api/new-session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(cwd ? { cwd } : {}),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Request failed" }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

export async function killSession(pid) {
  const res = await fetch("/api/kill-session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pid }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Request failed" }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

// ── Cross-session API (target any session by URL) ─────

export async function renameSession(name, baseUrl) {
  const res = await fetch(`${baseUrl}/api/rename-session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Request failed" }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

export async function reloadSession(baseUrl) {
  const res = await fetch(`${baseUrl}/api/reload`, { method: "POST" });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Request failed" }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

// ── Streaming ─────────────────────────────────────────

/**
 * Send a prompt and stream SSE events.
 * @param {string} message
 * @param {(event: object) => void} onEvent
 * @returns {Promise<void>} Resolves when stream ends.
 */
export async function sendPromptStream(message, onEvent) {
  const res = await fetch("/api/prompt", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "text/event-stream",
    },
    body: JSON.stringify({ message }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Request failed" }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    const { events, rest } = parseSseBuffer(buffer);
    buffer = rest;
    for (const event of events) {
      onEvent(event);
    }
  }
}
