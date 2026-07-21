/**
 * Pure functions for session spawn/kill logic — extracted from index.ts
 * for testability. No side effects; filesystem and process operations
 * are injected.
 *
 * buildSpawnCommand / buildOpenSessionCommand / findSessionCwd live in the
 * shared @wirelessr/pi-webui-components/session-spawn.js (single source of
 * truth with the hub). index.ts imports those from there directly.
 */

/**
 *
 * Behavioral spec:
 * 1. Always includes `pi --mode rpc --session "<sessionPath>"`
 * 2. Includes `--name "<name>"` only when name is provided
 * 3. Includes `PI_HTTP_PORT=<port>` env var
 * 4. Stderr redirected to logFile with `[port] ` prefix per line via a wrapper function
 * 5. Uses `sleep 1 && tail -f /dev/null |` as stdin keepalive
 * 6. Escapes double quotes in name and paths
 *
 * @param {object} opts
 * @param {number} opts.port
 * @param {string} opts.sessionPath
 * @param {string|undefined} opts.name — session display name
 * @param {string} opts.logFile — stderr log file path (shared, appended)
 * @returns {string} sh command string
 */
export function buildReloadCommand({ port, sessionPath, name, logFile }) {
  const escapedPath = sessionPath.replace(/"/g, '\\"');
  const escapedLog = logFile.replace(/"/g, '\\"');
  const nameArg = name ? ` --name "${name.replace(/"/g, '\\"')}"` : "";
  return `sleep 1 && tail -f /dev/null | PI_HTTP_PORT=${port} pi --mode rpc${nameArg} --session "${escapedPath}" 2>&1 1>/dev/null | sed -u "s/^/[${port}] /" >> "${escapedLog}"`;
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
/**
 * Recover stale (dead-process) sessions from discovery files, respawning
 * each one exactly once even when several bridges start concurrently.
 *
 * The concurrency fix is `claimFn`: it must atomically claim a discovery
 * file (e.g. rename it) and return false if another process already claimed
 * it. Only the winner respawns, so a reload-all that restarts N bridges at
 * once no longer respawns the same stale session N times.
 *
 * All side effects are injected. Returns the list of recovered sessionIds.
 *
 * @param {object} opts
 * @param {function} opts.listDiscoveryFiles — () => string[] (basenames ending .json)
 * @param {function} opts.readDiscovery — (file) => object|null (parsed, null on error)
 * @param {function} opts.isPidAlive — (pid) => boolean
 * @param {string|undefined} opts.ownSessionId — our own session id (never recover ourselves)
 * @param {function} opts.sessionFileExists — (path) => boolean
 * @param {function} opts.claimFn — (file) => boolean, atomic claim; false if lost the race
 * @param {function} opts.releaseClaimFn — (file) => void, remove the claimed file after respawn
 * @param {function} opts.deleteDiscoveryFn — (file) => void, delete a non-recoverable discovery file
 * @param {function} opts.openSessionFn — (sessionId, name, cwd) => void
 * @param {function} opts.logFn — (msg) => void
 * @returns {string[]} recovered sessionIds
 */
export function recoverStaleSessions({
  listDiscoveryFiles,
  readDiscovery,
  isPidAlive,
  ownSessionId,
  sessionFileExists,
  claimFn,
  releaseClaimFn,
  deleteDiscoveryFn,
  openSessionFn,
  logFn,
}) {
  const recovered = [];
  for (const file of listDiscoveryFiles()) {
    const content = readDiscovery(file);
    if (!content || !content.pid || isPidAlive(content.pid)) continue;

    // Dead session. Drop (don't recover) if it's our own stale file, or its
    // underlying session file is gone.
    if (content.sessionId === ownSessionId || (content.sessionFile && !sessionFileExists(content.sessionFile))) {
      deleteDiscoveryFn(file);
      continue;
    }

    // Atomically claim before respawning — losers of the race skip.
    if (!claimFn(file)) continue;
    logFn(`recover: re-spawning stale session ${content.sessionId} (name=${content.sessionName ?? "?"}, cwd=${content.cwd ?? "auto"})`);
    try {
      openSessionFn(content.sessionId, content.sessionName, content.cwd);
      recovered.push(content.sessionId);
    } finally {
      releaseClaimFn(file);
    }
  }
  return recovered;
}

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
