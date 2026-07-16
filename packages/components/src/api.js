/**
 * API client — thin wrappers over fetch for the HTTP bridge endpoints.
 *
 * Sessions run on separate ports. Use sessionUrl(s) to get a session's
 * base URL, then pass it to the cross-session API functions.
 *
 * All functions accept an optional `fetchFn` parameter (defaults to
 * global fetch) to enable unit testing without a browser.
 */

import { parseSseBuffer } from "./sse-parser.js";

// ── Helpers ───────────────────────────────────────────

export async function uploadImage(blob, fetchFn = fetch) {
  const res = await fetchFn("/api/upload", {
    method: "POST",
    headers: { "Content-Type": blob.type || "image/png" },
    body: blob,
  });
  if (!res.ok) await throwHttpError(res);
  return res.json();
}

/**
 * Get the base URL for a session object.
 *
 * This is the LAN-facing URL from the discovery file — use it for QR codes
 * (scanned from other devices). For navigation and cross-session API calls
 * from the current page, use navUrl() instead so the hostname the user
 * opened (e.g. localhost, which keeps the secure context for notifications)
 * is preserved.
 *
 * @param {{url?: string, port: number}} s
 * @returns {string} e.g. "http://192.168.1.130:7331"
 */
export function sessionUrl(s) {
  return s.url || `http://localhost:${s.port}`;
}

/**
 * Get the URL for a session using the hostname the current page was opened
 * with. All sessions run on the same machine and differ only by port, so
 * navigating between them must not switch origin class (localhost vs LAN IP).
 *
 * @param {{port: number}} s
 * @param {{protocol: string, hostname: string}} [loc] — injectable for tests
 * @returns {string} e.g. "http://localhost:7331"
 */
export function navUrl(s, loc = globalThis.location) {
  return `${loc.protocol}//${loc.hostname}:${s.port}`;
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

/**
 * Throw a typed error from a non-ok response.
 * @param {Response} res
 */
async function throwHttpError(res) {
  const err = await res.json().catch(() => ({ error: "Request failed" }));
  throw new Error(err.error || `HTTP ${res.status}`);
}

// ── Current session API ───────────────────────────────

export async function getStatus(fetchFn = fetch) {
  const res = await fetchFn("/api/status");
  return res.json();
}

export async function getSessions(fetchFn = fetch) {
  const res = await fetchFn("/api/sessions");
  return res.json();
}

export async function getCommands(fetchFn = fetch) {
  const res = await fetchFn("/api/commands");
  return res.json();
}

export async function getHistory(fetchFn = fetch) {
  const res = await fetchFn("/api/history");
  return res.json();
}

export async function getFile(path, fetchFn = fetch) {
  const res = await fetchFn(`/api/file?path=${encodeURIComponent(path)}`);
  if (!res.ok) throw new Error(`file ${res.status}`);
  return res.json();
}

export async function statFiles(paths, fetchFn = fetch) {
  const res = await fetchFn("/api/file/stat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ paths }),
  });
  if (!res.ok) return {};
  return (await res.json()).stats || {};
}

export async function abortAgent(fetchFn = fetch) {
  const res = await fetchFn("/api/abort", { method: "POST" });
  return res.json();
}

export async function executeCommand(command, fetchFn = fetch) {
  const res = await fetchFn("/api/command", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ command }),
  });
  if (!res.ok) await throwHttpError(res);
  return res.json();
}

// ── Session management (target current session) ───────

export async function newSession(cwd, fetchFn = fetch) {
  const res = await fetchFn("/api/new-session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(cwd ? { cwd } : {}),
  });
  if (!res.ok) await throwHttpError(res);
  return res.json();
}

export async function openSession(sessionId, name, fetchFn = fetch) {
  const res = await fetchFn("/api/open-session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, ...(name ? { name } : {}) }),
  });
  if (!res.ok) await throwHttpError(res);
  return res.json();
}

export async function killSession(pid, fetchFn = fetch) {
  const res = await fetchFn("/api/kill-session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pid }),
  });
  if (!res.ok) await throwHttpError(res);
  return res.json();
}

// ── Cross-session API (target any session by URL) ─────

export async function renameSession(name, baseUrl, fetchFn = fetch) {
  const res = await fetchFn(`${baseUrl}/api/rename-session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) await throwHttpError(res);
  return res.json();
}

export async function reloadSession(baseUrl, fetchFn = fetch) {
  const res = await fetchFn(`${baseUrl}/api/reload`, { method: "POST" });
  if (!res.ok) await throwHttpError(res);
  return res.json();
}

// ── Streaming ─────────────────────────────────────────

/**
 * Send a log entry to the server's bridge.log.
 * @param {string} level
 * @param {string} message
 * @param {any} [data]
 * @param {typeof fetch} [fetchFn]
 */
export async function clientLog(level, message, data, fetchFn = fetch) {
  // Also write to DevTools console for live debugging
  const consoleFn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  consoleFn(`[client] [${level}] ${message}`, data ?? "");
  try {
    await fetchFn("/api/client-log", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ level, message, data }),
    });
  } catch {
    // Best effort — don't let logging cause issues
  }
}

/**
 * Send a prompt and stream SSE events.
 * @param {string} message
 * @param {(event: object) => void} onEvent
 * @param {typeof fetch} [fetchFn]
 * @returns {Promise<void>} Resolves when stream ends.
 */
export async function sendPromptStream(message, onEvent, fetchFn = fetch) {
  await clientLog("info", "SSE: fetch starting", { messageLength: message.length }, fetchFn);
  let res;
  try {
    res = await fetchFn("/api/prompt", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify({ message }),
    });
  } catch (err) {
    await clientLog("error", "SSE: fetch failed", { error: err.message }, fetchFn);
    throw err;
  }

  if (!res.ok) {
    await clientLog("error", "SSE: non-ok response", { status: res.status }, fetchFn);
    return throwHttpError(res);
  }

  await clientLog("info", "SSE: response received, starting reader loop", undefined, fetchFn);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventCount = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        await clientLog("info", "SSE: reader done", { eventCount }, fetchFn);
        break;
      }

      buffer += decoder.decode(value, { stream: true });

      const { events, rest } = parseSseBuffer(buffer);
      buffer = rest;
      for (const event of events) {
        eventCount++;
        onEvent(event);
      }
    }
  } catch (err) {
    await clientLog("error", "SSE: reader loop error", { error: err.message, eventCount }, fetchFn);
    throw err;
  }
}

/**
 * Attach to an in-progress SSE stream (reconnect after page reload).
 * Returns true if a stream was found and reading started, false if 409.
 * @param {(event: object) => void} onEvent
 * @param {typeof fetch} [fetchFn]
 * @returns {Promise<boolean>}
 */
export async function attachStream(onEvent, fetchFn = fetch) {
  let res;
  try {
    res = await fetchFn("/api/stream/attach", {
      headers: { Accept: "text/event-stream" },
    });
  } catch (err) {
    await clientLog("error", "attach: fetch failed", { error: err.message }, fetchFn);
    return false;
  }
  if (!res.ok) {
    await clientLog("info", "attach: no active stream (409)", undefined, fetchFn);
    return false;
  }

  await clientLog("info", "attach: response received, starting reader loop", undefined, fetchFn);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventCount = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        await clientLog("info", "attach: reader done", { eventCount }, fetchFn);
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const { events, rest } = parseSseBuffer(buffer);
      buffer = rest;
      for (const event of events) {
        eventCount++;
        onEvent(event);
      }
    }
  } catch (err) {
    await clientLog("error", "attach: reader loop error", { error: err.message, eventCount }, fetchFn);
  }
  return true;
}
