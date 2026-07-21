/**
 * Shared session spawn / resolve primitives — the single source of truth used
 * by BOTH the in-process extension and the standalone hub. These were once
 * copy-pasted into each package, which let the same bug live in two places
 * (a filename-vs-id mismatch in findSessionCwd). Keep them here only.
 *
 * Node-safe: this module touches the filesystem and is imported in Node by the
 * extension and hub. It is never loaded by browser code.
 */

import { existsSync as fsExistsSync, readdirSync as fsReaddirSync, readFileSync as fsReadFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Build the sh command string for spawning a brand-new pi session.
 * @param {object} opts
 * @param {string} opts.logFile — shared stderr log file path
 * @param {number} [opts.port] — port for the default log prefix (`[<port>]`)
 * @param {string} [opts.prefix] — explicit log-line prefix, overrides port
 * @returns {string} sh command string
 */
export function buildSpawnCommand({ logFile, port, prefix }) {
  const escapedLog = logFile.replace(/"/g, '\\"');
  const p = prefix || (port != null ? `[${port}]` : "[new]");
  return `tail -f /dev/null | pi --mode rpc 2>&1 1>/dev/null | sed -u "s/^/${p} /" >> "${escapedLog}"`;
}

/**
 * Build the sh command string for opening (resuming) an existing session by
 * ID. The caller must spawn it from the session's original cwd (see
 * findSessionCwd) — pi refuses to resume from the wrong project directory.
 * @param {object} opts
 * @param {string} opts.sessionId — session UUID or path
 * @param {string} [opts.name] — optional display name
 * @param {string} opts.logFile — stderr log file path
 * @param {string} [opts.prefix] — log-line prefix (default `[new]`)
 * @returns {string} sh command string
 */
export function buildOpenSessionCommand({ sessionId, name, logFile, prefix = "[new]" }) {
  const escapedId = sessionId.replace(/"/g, '\\"');
  const escapedLog = logFile.replace(/"/g, '\\"');
  const nameArg = name ? ` --name "${name.replace(/"/g, '\\"')}"` : "";
  return `tail -f /dev/null | pi --mode rpc${nameArg} --session "${escapedId}" 2>&1 1>/dev/null | sed -u "s/^/${prefix} /" >> "${escapedLog}"`;
}

/**
 * Build the sh command string for cloning a session — pi's `--fork` copies the
 * session's history into a brand-new session with its own id. Like resume, the
 * caller must spawn it from the source session's original cwd (fork reads the
 * project-bound session file; pi rejects the wrong project directory).
 * @param {object} opts
 * @param {string} opts.sessionId — source session UUID or path to fork
 * @param {string} [opts.name] — optional display name for the clone
 * @param {string} opts.logFile — stderr log file path
 * @param {string} [opts.prefix] — log-line prefix (default `[new]`)
 * @returns {string} sh command string
 */
export function buildForkSessionCommand({ sessionId, name, logFile, prefix = "[new]" }) {
  const escapedId = sessionId.replace(/"/g, '\\"');
  const escapedLog = logFile.replace(/"/g, '\\"');
  const nameArg = name ? ` --name "${name.replace(/"/g, '\\"')}"` : "";
  return `tail -f /dev/null | pi --mode rpc${nameArg} --fork "${escapedId}" 2>&1 1>/dev/null | sed -u "s/^/${prefix} /" >> "${escapedLog}"`;
}

/**
 * Resolve an existing session's original working directory from its pi session
 * log. Essential for resume: pi refuses to resume a session launched from the
 * wrong directory ("Session found in different project"), so a bad cwd makes
 * open silently fail.
 *
 * pi's canonical session id is the first-line `"id"` field, which can DIFFER
 * from the uuid embedded in the filename for resumed/forked sessions. So the
 * cheap filename match is only a fast path; the authoritative match is on the
 * first-line id.
 *
 * @param {string} sessionId — the canonical session id (what pi/discovery use)
 * @param {object} [deps] — injectable fs + root for testing
 * @returns {string|undefined} the session's cwd, or undefined if not found
 */
export function findSessionCwd(sessionId, deps = {}) {
  const {
    sessionsRoot = join(homedir(), ".pi", "agent", "sessions"),
    existsSync = fsExistsSync,
    readdirSync = fsReaddirSync,
    readFileSync = fsReadFileSync,
  } = deps;

  if (!existsSync(sessionsRoot)) return undefined;

  const metaOf = (fp) => {
    try {
      return JSON.parse(readFileSync(fp, "utf-8").split("\n", 1)[0]);
    } catch {
      return null;
    }
  };

  const scan = [];
  try {
    for (const dir of readdirSync(sessionsRoot, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      const dirPath = join(sessionsRoot, dir.name);
      let files;
      try {
        files = readdirSync(dirPath);
      } catch {
        continue;
      }
      for (const f of files) {
        if (!f.endsWith(".jsonl")) continue;
        const fp = join(dirPath, f);
        // Fast path: the filename embeds the id (fresh sessions).
        if (f.includes(sessionId)) {
          const meta = metaOf(fp);
          if (meta?.cwd) return meta.cwd;
        } else {
          scan.push(fp);
        }
      }
    }
    // Authoritative pass: match the first-line session id (catches
    // resumed/forked sessions whose filename uuid differs from their id).
    for (const fp of scan) {
      const meta = metaOf(fp);
      if (meta?.id === sessionId && meta.cwd) return meta.cwd;
    }
  } catch {}
  return undefined;
}
