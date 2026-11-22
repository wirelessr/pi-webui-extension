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
 * newest (highest startedAt), sorts most-recently-active first (port breaks
 * ties). Activity = time of the session's last conversation entry (see
 * lastMessageTimestamp), falling back to startedAt for a session with no file.
 *
 * @param {Array<object>} discoveries — parsed discovery file objects
 * @param {(pid: number) => boolean} isPidAlive
 * @param {(file: string) => number|null} [fileMtimeMs] — last activity in ms, null if unreadable
 * @returns {Array<{sessionId, sessionName, port, pid, cwd, lastActiveAt}>}
 */
export function buildSessionList(discoveries, isPidAlive, fileMtimeMs = () => null) {
  const byId = new Map();
  for (const d of discoveries) {
    // Liveness = the PI process (piPid) is alive, NOT the recorded `pid`. For a
    // hub-spawned session `pid` is the `sh -c` group leader; for a manually-run
    // `pi -p`/`pi` session `pid` is the user's long-lived interactive shell,
    // which outlives pi and would keep a dead session looking alive (a ghost the
    // hub then fails to proxy). Prefer piPid; fall back to pid for legacy files
    // written before piPid existed.
    const livenessPid = d?.piPid ?? d?.pid;
    if (!d?.sessionId || !livenessPid || !isPidAlive(livenessPid)) continue;
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
      lastActiveAt: (d.sessionFile ? fileMtimeMs(d.sessionFile) : null) ?? d.startedAt ?? 0,
    }))
    .sort((a, b) => b.lastActiveAt - a.lastActiveAt || a.port - b.port);
}

// Session spawn/resume command builders + findSessionCwd live in the shared
// @wirelessr/pi-webui-components/session-spawn.js (single source of truth for
// both hub and extension). server.js imports them from there directly.

/**
 * Detect busy→idle transitions between polls (a session "finishing").
 *
 * A null `busy` means the poll couldn't tell (status timed out): the last known
 * value is carried over and no transition is reported, so a briefly unresponsive
 * session neither flips to idle nor loses its busy history.
 *
 * @param {Map<string, boolean>} prevBusy — sessionId → busy at the last poll
 * @param {Array<{sessionId: string, sessionName?: string|null, busy: boolean|null}>} current
 * @returns {{done: Array<{sessionId: string, sessionName: string|null}>, nextBusy: Map<string, boolean>}}
 */
export function diffBusyTransitions(prevBusy, current) {
  const done = [];
  const nextBusy = new Map();
  for (const s of current) {
    if (s.busy == null) {
      if (prevBusy.has(s.sessionId)) nextBusy.set(s.sessionId, prevBusy.get(s.sessionId));
      continue;
    }
    nextBusy.set(s.sessionId, s.busy);
    // Only fire when we have a prior "busy" observation flipping to idle —
    // never on first sight (avoids a spurious notification on hub startup).
    if (prevBusy.get(s.sessionId) === true && s.busy === false) {
      done.push({ sessionId: s.sessionId, sessionName: s.sessionName ?? null });
    }
  }
  return { done, nextBusy };
}

/**
 * Time (ms) of the last conversation entry in a chunk of session JSONL, or
 * null if the chunk has none. The file's mtime is NOT usable for this: pi also
 * appends session_info / model_change / custom entries on resume, rename and
 * reload, which would make an idle session look freshly active.
 *
 * @param {string} text — JSONL text, possibly the tail of a larger file
 * @param {boolean} startsAtFileStart — false when `text` begins mid-file, so
 *   its first (partial) line is dropped
 * @returns {number|null}
 */
export function lastMessageTimestamp(text, startsAtFileStart) {
  const lines = text.split("\n");
  if (!startsAtFileStart) lines.shift();
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i]) continue;
    let entry;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (entry?.type !== "message") continue;
    const t = Date.parse(entry.timestamp);
    if (!Number.isNaN(t)) return t;
  }
  return null;
}

/**
 * Sessions that finished a turn and haven't been looked at yet. A completed
 * turn marks its session unread; dead sessions are dropped. Clearing happens
 * elsewhere (the viewing client reports it), so this only ever adds.
 *
 * @param {Set<string>} unread — current unread session ids
 * @param {Array<{sessionId: string}>} done — from diffBusyTransitions
 * @param {Iterable<string>} liveIds
 * @returns {Set<string>}
 */
export function updateUnread(unread, done, liveIds) {
  const live = new Set(liveIds);
  const next = new Set();
  for (const id of [...unread, ...done.map((d) => d.sessionId)]) {
    if (live.has(id)) next.add(id);
  }
  return next;
}
