import { spawn as nodeSpawn } from "node:child_process";

function logSpawnError(err) {
  console.error(`[hub] spawn error: ${err.message}`);
}

/**
 * Spawn a detached, fully unref'd child (it outlives the hub) and return its pid.
 * The `error` listener is attached before the pid check: a spawn that fails
 * (e.g. a nonexistent cwd) returns no pid and emits `error` asynchronously,
 * which would otherwise be an uncaught exception that kills the hub.
 * @param {string[]} argv executable followed by its arguments
 * @param {object} opts
 * @param {string} opts.cwd
 * @param {object} opts.env
 * @param {(err: Error) => void} [opts.onError] async spawn error handler (default: log)
 * @param {typeof nodeSpawn} [opts.spawn] injected for tests
 * @returns {number} child pid
 */
export function spawnDetached(argv, { cwd, env, onError = logSpawnError, spawn = nodeSpawn }) {
  const child = spawn(argv[0], argv.slice(1), { cwd, detached: true, stdio: "ignore", env });
  child.on("error", onError);
  child.unref();
  if (!child.pid) throw new Error("spawn failed");
  return child.pid;
}
