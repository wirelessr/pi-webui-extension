/**
 * Pure helpers for the hub — no IO, unit-tested. The server wires real
 * filesystem / http around these.
 */

/**
 * Parse a reverse-proxy path of the form `/s/<sessionId>/<rest>`.
 * @param {string} url — request url (may include query string)
 * @returns {{sessionId: string, rest: string} | null} null if not a /s/ path
 */
export function parseProxyPath(url) {
  const m = url.match(/^\/s\/([^/?#]+)(.*)$/);
  if (!m) return null;
  const sessionId = decodeURIComponent(m[1]);
  let rest = m[2] || "/";
  if (!rest.startsWith("/")) rest = `/${rest}`;
  return { sessionId, rest };
}

/**
 * Pick a session by id from a discovery list.
 * @param {Array<{sessionId: string}>} sessions
 * @param {string} id
 * @returns {object | null}
 */
export function pickSession(sessions, id) {
  return sessions.find((s) => s.sessionId === id) || null;
}

/**
 * Build the browser-facing session list from raw discovery-file contents.
 * Keeps only live sessions (pid alive), dedupes by sessionId keeping the
 * newest (highest startedAt), sorts by port.
 *
 * @param {Array<object>} discoveries — parsed discovery file objects
 * @param {(pid: number) => boolean} isPidAlive
 * @returns {Array<{sessionId, sessionName, port, pid, cwd}>}
 */
export function buildSessionList(discoveries, isPidAlive) {
  const byId = new Map();
  for (const d of discoveries) {
    if (!d || !d.sessionId || !d.pid || !isPidAlive(d.pid)) continue;
    const existing = byId.get(d.sessionId);
    if (!existing || (d.startedAt ?? 0) > (existing.startedAt ?? 0)) {
      byId.set(d.sessionId, d);
    }
  }
  return Array.from(byId.values())
    .map((d) => ({
      sessionId: d.sessionId,
      sessionName: d.sessionName ?? null,
      port: d.port,
      pid: d.pid,
      cwd: d.cwd ?? null,
    }))
    .sort((a, b) => a.port - b.port);
}

/**
 * Build the sh command the hub uses to spawn a brand-new pi session.
 * (The hub sets PI_BRIDGE_DIR via the spawn env, not in this string, so the
 * new session writes its discovery file where the hub is watching.)
 * @param {object} opts
 * @param {string} opts.logFile — shared stderr log file path
 * @returns {string} sh command string
 */
export function buildSpawnCommand({ logFile }) {
  const escapedLog = logFile.replace(/"/g, '\\"');
  return `tail -f /dev/null | pi --mode rpc 2>&1 1>/dev/null | sed -u "s/^/[hub-new] /" >> "${escapedLog}"`;
}

/**
 * Detect busy→idle transitions between polls (a session "finishing").
 *
 * @param {Map<string, boolean>} prevBusy — sessionId → busy at the last poll
 * @param {Array<{sessionId: string, sessionName?: string|null, busy: boolean}>} current
 * @returns {{done: Array<{sessionId: string, sessionName: string|null}>, nextBusy: Map<string, boolean>}}
 */
export function diffBusyTransitions(prevBusy, current) {
  const done = [];
  const nextBusy = new Map();
  for (const s of current) {
    nextBusy.set(s.sessionId, s.busy);
    // Only fire when we have a prior "busy" observation flipping to idle —
    // never on first sight (avoids a spurious notification on hub startup).
    if (prevBusy.get(s.sessionId) === true && s.busy === false) {
      done.push({ sessionId: s.sessionId, sessionName: s.sessionName ?? null });
    }
  }
  return { done, nextBusy };
}
