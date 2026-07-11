/**
 * Pure functions for session spawn/kill logic — extracted from index.ts
 * for testability. No side effects; filesystem and process operations
 * are injected.
 */

/**
 * Build the sh command string for reloading a session.
 *
 * Behavioral spec:
 * 1. Always includes `pi --mode rpc --session "<sessionPath>"`
 * 2. Includes `--name "<name>"` only when name is provided
 * 3. Includes `PI_HTTP_PORT=<port>` env var
 * 4. Includes `2>>"<logFile>"` stderr redirect
 * 5. Uses `sleep 1 && tail -f /dev/null |` as stdin keepalive
 * 6. Escapes double quotes in name and paths
 *
 * @param {object} opts
 * @param {number} opts.port
 * @param {string} opts.sessionPath
 * @param {string|undefined} opts.name — session display name
 * @param {string} opts.logFile — stderr log file path
 * @returns {string} sh command string
 */
export function buildReloadCommand({ port, sessionPath, name, logFile }) {
  const escapedPath = sessionPath.replace(/"/g, '\\"');
  const escapedLog = logFile.replace(/"/g, '\\"');
  const nameArg = name ? ` --name "${name.replace(/"/g, '\\"')}"` : "";
  return `sleep 1 && tail -f /dev/null | PI_HTTP_PORT=${port} pi --mode rpc${nameArg} --session "${escapedPath}" 2>>"${escapedLog}"`;
}

/**
 * Deduplicate sessions by sessionFile and clean up losers.
 *
 * Behavioral spec:
 * 1. Group sessions by sessionFile (or sessionId as fallback)
 * 2. Keep the newest session per group (by startedAt, highest wins)
 * 3. For losers: delete discovery file and kill process group
 * 4. Kill uses process group SIGTERM (-pid), falls back to direct kill
 * 5. Results sorted by port ascending
 * 6. All side effects (unlink, kill) are injected via opts
 *
 * @param {object} opts
 * @param {Array} opts.sessions — raw session objects from discovery files
 * @param {function} opts.unlinkFn — (path) => void, delete discovery file
 * @param {function} opts.killGroupFn — (pid) => boolean, kill process group
 * @param {function} opts.killFn — (pid) => boolean, kill single process
 * @param {function} opts.logFn — (msg) => void, diagnostic logging
 * @returns {Array} winning sessions sorted by port
 */
export function dedupSessions({ sessions, unlinkFn, killGroupFn, killFn, logFn }) {
  const bySessionFile = new Map();
  for (const s of sessions) {
    const key = s.sessionFile ?? s.sessionId;
    const existing = bySessionFile.get(key);
    if (!existing || (s.startedAt ?? 0) > (existing.startedAt ?? 0)) {
      bySessionFile.set(key, s);
    }
  }

  const winnerPids = new Set(Array.from(bySessionFile.values()).map((s) => s.pid));
  for (const s of sessions) {
    if (!winnerPids.has(s.pid)) {
      try { unlinkFn(`${s.sessionId}.json`); } catch {}
      try {
        if (!killGroupFn(s.pid)) {
          killFn(s.pid);
        }
      } catch {}
      logFn(`killed dedup loser pid=${s.pid} port=${s.port}`);
    }
  }

  return Array.from(bySessionFile.values()).sort((a, b) => a.port - b.port);
}
