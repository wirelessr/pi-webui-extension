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

// Single-quote a value for sh: nothing inside '...' is expanded ($, `, \ are
// literal), and an embedded ' is closed, escaped and reopened. Display names
// can come from hand-edited files (cron job names), so they must not reach the
// shell as double-quoted source.
function shQuote(value) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

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
  const nameArg = name ? ` --name ${shQuote(name)}` : "";
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
  const nameArg = name ? ` --name ${shQuote(name)}` : "";
  return `tail -f /dev/null | pi --mode rpc${nameArg} --fork "${escapedId}" 2>&1 1>/dev/null | sed -u "s/^/${prefix} /" >> "${escapedLog}"`;
}

// zsh (not sh) so every run reads ~/.zshenv and gets credentials fresh from the
// user's env file instead of the hub's pm2 env snapshot. Everything variable is
// a positional parameter, never shell source. The wrapper removes the session's
// discovery file itself after pi exits (while the wrapper is still alive, so the
// extension's recoverStaleSessions never sees it as stale), then writes the
// exit code atomically.
const CRON_RUN_SCRIPT =
  '"$6" -p --session-id "$1" --name "$2" --model "$3" -- "$4" > "$5/out.log" 2>&1; rc=$?; rm -f "$PI_BRIDGE_DIR/$1.json"; echo $rc > "$5/exit.tmp" && mv "$5/exit.tmp" "$5/exit"';

/**
 * Build the argv for one cron run: `pi -p` under a zsh wrapper. Spawn it with
 * PI_BRIDGE_DIR in the env and the job's cwd. The prompt goes after `--` so a
 * leading `-` is a message; a leading `@` is still a file argument to pi, so
 * callers must reject such prompts.
 * @param {object} opts
 * @param {string} opts.sessionId — fresh session id (an existing id would be reopened)
 * @param {string} opts.name — session display name
 * @param {string} opts.model — pi `--model` pattern
 * @param {string} opts.prompt
 * @param {string} opts.runDir — receives out.log and exit
 * @param {string} [opts.piBin] — pi executable (default `pi`)
 * @returns {string[]} argv, executable first
 */
export function buildCronRunArgv({ sessionId, name, model, prompt, runDir, piBin = "pi" }) {
  return ["zsh", "-c", CRON_RUN_SCRIPT, "sh", sessionId, name, model, prompt, runDir, piBin];
}

/**
 * Whether a session file `*_<sessionId>.jsonl` exists under the sessions root.
 * Filename-only (readdir, no file reads): valid for sessions created with a
 * fresh `--session-id`, whose filename id is the canonical id. Unlike
 * findSessionCwd its miss path does not read every session file.
 * @param {string} sessionId
 * @param {object} [deps] — injectable fs + root for testing
 * @returns {boolean}
 */
export function sessionFileExists(sessionId, deps = {}) {
  return listSessionFileIds(deps).has(sessionId);
}

/**
 * Ids of every session file (`<timestamp>_<id>.jsonl`, id = text after the last
 * `_`) under the sessions root, from one readdir pass. Use it to answer many
 * sessionFileExists questions in a single request.
 * @param {object} [deps] — injectable fs + root for testing
 * @returns {Set<string>}
 */
export function listSessionFileIds(deps = {}) {
  const { sessionsRoot = join(homedir(), ".pi", "agent", "sessions"), readdirSync = fsReaddirSync } = deps;
  const ids = new Set();
  let dirs;
  try {
    dirs = readdirSync(sessionsRoot, { withFileTypes: true });
  } catch {
    return ids;
  }
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    let files;
    try {
      files = readdirSync(join(sessionsRoot, dir.name));
    } catch {
      continue;
    }
    for (const f of files) {
      const sep = f.lastIndexOf("_");
      if (sep >= 0 && f.endsWith(".jsonl")) ids.add(f.slice(sep + 1, -".jsonl".length));
    }
  }
  return ids;
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
