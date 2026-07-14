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
