/**
 * Cron orchestration for the hub: the scheduler tick (lock, reconcile,
 * decide/fire, retention), Run now (create run.json, spawn, record the pid),
 * reconcile against the wrapper's `exit` file and process liveness, the read
 * views for the panel, and the log endpoint. Filesystem, spawn, clock,
 * pid liveness and the session-file check are injected; server.js only wires
 * the real ones and the HTTP routes, so tests never import server.js.
 *
 * Layout under `cronDir` (BRIDGE_DIR/cron, never top level, so discovery
 * scans do not see it): cron-jobs.json (read only), scheduler.lock and
 * runs/<runId>/{run.json,out.log,exit}.
 *
 * Only the scheduler owner writes: ticks, reconciles, fires, prunes and
 * accepts Run now. A non-owner serves the read views from the files as they
 * are and retries the lock every tick.
 */

import * as nodeFs from "node:fs";
import { join } from "node:path";
import {
  decideFire,
  isActiveRun,
  lockStatus,
  makeRunId,
  markSpawnError,
  markStarted,
  maxRuntimeMs,
  newRun,
  openAction,
  parseJobsFile,
  prunableRuns,
  RUN_ID_RE,
  reconcileRun,
  sortRunsNewestFirst,
} from "./cron.js";

export const LOG_TAIL_BYTES = 256 * 1024;
export const RUNS_HISTORY_LIMIT = 30;

const json = (status, body) => ({ status, body });

/**
 * @param {object} deps
 * @param {string} deps.cronDir
 * @param {string} deps.bridgeDir — PI_BRIDGE_DIR passed to runs
 * @param {object} deps.env — base env for runs (the hub's)
 * @param {string} [deps.piBin]
 * @param {number} deps.tickMs
 * @param {string} deps.systemTz
 * @param {() => number} deps.now
 * @param {() => string} deps.randomHex4
 * @param {() => string} deps.randomUUID
 * @param {(argv: string[], opts: object) => number} deps.spawnDetached
 * @param {(argv: object) => string[]} deps.buildArgv — buildCronRunArgv
 * @param {(pid: number) => boolean} deps.isPidAlive
 * @param {() => Set<string>} deps.listSessionFileIds — ids that have a session file
 * @param {() => Set<string>} deps.liveSessionIds
 * @param {object} [deps.fs]
 * @param {(line: string) => void} [deps.log]
 * @param {number} [deps.pid] — this hub's pid (scheduler lock, temp file names)
 */
export function createCronRunner(deps) {
  const { cronDir, bridgeDir, env, piBin = "pi", tickMs, systemTz, now, fs = nodeFs, log = console.error, pid = process.pid } = deps;
  const runsDir = join(cronDir, "runs");
  const jobsFile = join(cronDir, "cron-jobs.json");
  const lockFile = join(cronDir, "scheduler.lock");
  let owner = false; // confirmed owner as of the last tick
  let firstTickAt = null;
  let tickErrors = new Map(); // job id -> unexpected error from the last tick

  function readText(path) {
    try {
      return fs.readFileSync(path, "utf-8");
    } catch {
      return null;
    }
  }

  function loadJobs() {
    return parseJobsFile(readText(jobsFile), systemTz, now());
  }

  function readRuns() {
    let names;
    try {
      names = fs.readdirSync(runsDir);
    } catch {
      return [];
    }
    const runs = [];
    for (const name of names) {
      if (!RUN_ID_RE.test(name)) continue;
      let run;
      try {
        run = JSON.parse(fs.readFileSync(join(runsDir, name, "run.json"), "utf-8"));
      } catch {
        continue; // unreadable / half-written record
      }
      // The directory name is authoritative: it decides where writes go, so a
      // record whose content disagrees with it (or is not a record) is ignored.
      if (run && typeof run === "object" && run.runId === name) runs.push(run);
      else warnOnce(name, `[hub] cron: ignoring malformed run record ${name}/run.json`);
    }
    return runs;
  }

  const warned = new Set();
  function warnOnce(key, line) {
    if (warned.has(key)) return;
    warned.add(key);
    log(line);
  }
  let tickSkipKey = null; // warnOnce key of the current "tick skipped" reason

  function writeRun(run) {
    const dir = join(runsDir, run.runId);
    const tmp = join(dir, `run.json.${pid}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(run, null, 2));
    fs.renameSync(tmp, join(dir, "run.json"));
  }

  function probe(run) {
    const exitText = readText(join(runsDir, run.runId, "exit"));
    return {
      hasExit: exitText != null,
      exitCode: exitText == null ? null : Number.parseInt(exitText.trim(), 10),
      shellAlive: run.shellPid != null && deps.isPidAlive(run.shellPid),
    };
  }

  // Max runtime per job id, from valid jobs only (a duplicate id is an errored
  // entry, so it cannot override the first, valid one). When the job's config
  // cannot be trusted (unusable file, or the id only appears as an errored
  // entry) the max-runtime rule is skipped rather than applying the 6 h
  // default; a job absent from a valid file gets the default.
  function maxMsByJob({ jobs, fileError }) {
    if (fileError) return () => Number.POSITIVE_INFINITY;
    const valid = new Map();
    const errored = new Set();
    for (const { job, error } of jobs) {
      if (!error) valid.set(job.id, maxRuntimeMs(job));
      else if (typeof job?.id === "string") errored.add(job.id);
    }
    return (jobId) => valid.get(jobId) ?? (errored.has(jobId) ? Number.POSITIVE_INFINITY : maxRuntimeMs(null));
  }

  const withProbe = (run) => {
    const { hasExit, shellAlive } = probe(run);
    return { ...run, hasExit, shellAlive };
  };

  // Finalize/downgrade runs from the wrapper's exit file and pid liveness.
  // Owner only: before every decision (tick, Run now) and in the read views.
  function reconcile(loaded) {
    const maxFor = maxMsByJob(loaded);
    const t = now();
    return readRuns().map((run) => {
      const next = reconcileRun(run, probe(run), t, { maxMs: maxFor(run.jobId), tickMs });
      if (!next) return run;
      // One unwritable run must not stop the tick; the record on disk stays
      // authoritative and the next tick retries.
      try {
        writeRun(next);
        return next;
      } catch (err) {
        warnOnce(`write:${run.runId}`, `[hub] cron: could not update ${run.runId}: ${err.message}`);
        return run;
      }
    });
  }

  function formatLocal(t, timezone) {
    return new Intl.DateTimeFormat("sv-SE", { timeZone: timezone, dateStyle: "short", timeStyle: "short" }).format(new Date(t));
  }

  // Runs from the child's async `error` event: a throw here would be an
  // uncaught exception in the hub, so failures are only logged.
  function onSpawnError(runId, message) {
    try {
      const current = JSON.parse(fs.readFileSync(join(runsDir, runId, "run.json"), "utf-8"));
      writeRun(markSpawnError(current, message, now()));
    } catch (err) {
      log(`[hub] cron ${runId}: spawn error ${message}; could not record it: ${err.message}`);
    }
  }

  // Create a run directory and its first record. The leaf mkdir is exclusive:
  // a runId collision must never reuse (and overwrite) an existing run's
  // directory. Returns null when no id could be allocated.
  function createRun(job, timezone, { trigger, scheduledFor, state, t }) {
    fs.mkdirSync(runsDir, { recursive: true });
    let runId;
    for (let attempt = 0; !runId; attempt++) {
      const candidate = makeRunId(job.id, t, deps.randomHex4());
      try {
        fs.mkdirSync(join(runsDir, candidate));
        runId = candidate;
      } catch (err) {
        if (err.code !== "EEXIST") throw err;
        if (attempt >= 2) return null;
      }
    }
    const sessionId = state === "skipped" ? null : deps.randomUUID();
    const run = newRun({ runId, jobId: job.id, sessionId, name: `cron: ${job.name} ${formatLocal(scheduledFor, timezone)}`, trigger, scheduledFor, state, now: t });
    writeRun(run);
    return run;
  }

  // Create run.json (running, no pid), spawn, then record the pid. If the hub
  // dies in between, reconcile finalizes the record and the slot stays consumed.
  function startRun(job, timezone, { trigger, scheduledFor, t }) {
    let run = createRun(job, timezone, { trigger, scheduledFor, t });
    if (!run) return null;
    const { runId } = run;
    const runDir = join(runsDir, runId);
    const argv = deps.buildArgv({ sessionId: run.sessionId, name: run.name, model: job.model, prompt: job.prompt, runDir, piBin });
    try {
      const shellPid = deps.spawnDetached(argv, {
        cwd: job.cwd,
        env: { ...env, PI_BRIDGE_DIR: bridgeDir },
        onError: (err) => onSpawnError(runId, `${err.message} (cwd: ${job.cwd})`),
      });
      run = markStarted(run, shellPid, now());
    } catch (err) {
      run = markSpawnError(run, err.message, now());
    }
    writeRun(run);
    return run;
  }

  // Synchronous from reconcile to run.json creation (sync fs), so two
  // concurrent requests cannot both pass the active-run check.
  function trigger(jobId) {
    // Re-read the lock: a hub taken over since its last tick must not accept
    // Run now until that tick notices.
    if (owner && readLockPid() !== pid) owner = false;
    if (!owner) return json(409, { error: "not the scheduler owner" });
    const loaded = loadJobs();
    const { jobs, timezone, fileError } = loaded;
    if (fileError) return json(400, { error: fileError });
    const entry = jobs.find((e) => e.job?.id === jobId);
    if (!entry) return json(404, { error: `unknown job ${jobId}` });
    if (entry.error) return json(400, { error: entry.error });
    const { job } = entry;
    const runs = reconcile(loaded).filter((r) => r.jobId === jobId);
    const t = now();
    const maxMs = maxRuntimeMs(job);
    if (runs.some((r) => isActiveRun(r, probe(r), t, maxMs))) return json(409, { error: `job ${jobId} already has an active run` });
    // scheduledFor = now: a manual run also consumes a pending, unfired slot.
    const run = startRun(job, timezone, { trigger: "manual", scheduledFor: t, t });
    if (!run) return json(500, { error: `could not allocate a run id for ${jobId}` });
    return json(200, { run });
  }

  // ── Scheduler lock ──
  // Taking a missing/stale lock never makes this hub the owner in the same
  // tick: contenders can interleave (A unlink, A create, B unlink, B create),
  // so the next tick re-reads the lock and only a lock naming this pid counts.
  function updateLock(t) {
    let content = null;
    let mtimeMs = 0;
    try {
      content = fs.readFileSync(lockFile, "utf-8");
      mtimeMs = fs.statSync(lockFile).mtimeMs;
    } catch {
      // missing (or removed between read and stat: treated as stale)
    }
    const status = lockStatus({ content, mtimeMs, now: t, tickMs, myPid: pid, isPidAlive: deps.isPidAlive });
    if (status === "own") {
      touchLock(t);
      return true;
    }
    if (status === "take") {
      try {
        fs.unlinkSync(lockFile);
      } catch {
        // already gone
      }
      try {
        fs.writeFileSync(lockFile, JSON.stringify({ pid, startedAt: new Date(t).toISOString() }), { flag: "wx" });
        touchLock(t);
        log(`[hub] cron: took the scheduler lock (pid ${pid}); acting from the next tick if it still names this pid`);
      } catch {
        // another hub created it first
      }
    }
    return false;
  }

  // Heartbeat in the injected clock, so staleness compares like with like.
  function touchLock(t) {
    try {
      fs.utimesSync(lockFile, t / 1000, t / 1000);
    } catch {
      // removed meanwhile: the next tick re-evaluates
    }
  }

  function readLockPid() {
    try {
      return JSON.parse(fs.readFileSync(lockFile, "utf-8"))?.pid ?? null;
    } catch {
      return null;
    }
  }

  /** Best-effort release on exit: only a lock that still names this pid. */
  function release() {
    try {
      if (readLockPid() === pid) fs.unlinkSync(lockFile);
    } catch {
      // already gone
    }
  }

  // ── Tick ──
  // Lock first (heartbeat must not depend on the jobs file), then, as owner:
  // reconcile, decide/fire per enabled job (each isolated), retention.
  function tick() {
    const t = now();
    firstTickAt ??= t;
    fs.mkdirSync(runsDir, { recursive: true });
    owner = updateLock(t);
    if (!owner) return { owner: false };
    const loaded = loadJobs();
    const runs = reconcile(loaded).map(withProbe);
    if (loaded.fileError) {
      // Logged once per distinct reason, not every tick.
      const key = `tick-skipped:${loaded.fileError}`;
      if (tickSkipKey !== key) warned.delete(tickSkipKey);
      tickSkipKey = key;
      warnOnce(key, `[hub] cron: tick skipped: ${loaded.fileError}`);
      return { owner: true, fileError: loaded.fileError };
    }
    warned.delete(tickSkipKey);
    tickSkipKey = null;
    const fired = [];
    tickErrors = new Map();
    for (const { job, error } of loaded.jobs) {
      if (error || job.enabled !== true) continue;
      try {
        const mine = runs.filter((r) => r.jobId === job.id);
        const d = decideFire(job, mine, t, loaded.timezone, firstTickAt);
        if (d.action === "none") continue;
        const opts = { trigger: "schedule", scheduledFor: d.scheduledFor, t };
        const run = d.action === "fire" ? startRun(job, loaded.timezone, opts) : createRun(job, loaded.timezone, { ...opts, state: "skipped" });
        if (!run) throw new Error("could not allocate a run id");
        fired.push({ jobId: job.id, action: d.action, runId: run.runId });
        log(`[hub] cron: ${d.action === "fire" ? "fired" : "skipped (active run)"} ${job.id} for ${run.scheduledFor} as ${run.runId}`);
      } catch (err) {
        tickErrors.set(job.id, `tick failed: ${err.message}`);
        log(`[hub] cron: ${job.id}: tick failed: ${err.message}`);
      }
    }
    const pruned = prune(loaded);
    return { owner: true, fired, pruned };
  }

  // Retention: only run directories; session files are never deleted.
  function prune(loaded) {
    const maxFor = maxMsByJob(loaded);
    const ids = prunableRuns(readRuns().map(withProbe), now(), maxFor);
    const pruned = [];
    for (const runId of ids) {
      // runId equals its validated directory name (readRuns), so this stays in runs/.
      try {
        fs.rmSync(join(runsDir, runId), { recursive: true, force: true });
        pruned.push(runId);
      } catch (err) {
        warnOnce(`prune:${runId}`, `[hub] cron: could not prune ${runId}: ${err.message}`);
      }
    }
    return pruned;
  }

  // Owner: reconciled (and written). Non-owner: the files as they are.
  const viewRuns = (loaded) => (owner ? reconcile(loaded) : readRuns());

  function jobsView() {
    const loaded = loadJobs();
    const { jobs, timezone, fileError } = loaded;
    const latest = new Map();
    for (const run of sortRunsNewestFirst(viewRuns(loaded))) if (!latest.has(run.jobId)) latest.set(run.jobId, run);
    return json(200, {
      timezone,
      fileError,
      owner,
      jobs: jobs.map(({ job, error, nextRunAt }) => ({
        id: job?.id ?? null,
        name: job?.name ?? null,
        schedule: job?.schedule ?? null,
        model: job?.model ?? null,
        enabled: job?.enabled === true,
        error: error ?? tickErrors.get(job?.id) ?? null,
        nextRunAt,
        latestRun: latest.get(job?.id) ?? null,
      })),
    });
  }

  function runsView(jobId) {
    const loaded = loadJobs();
    const maxFor = maxMsByJob(loaded);
    const live = deps.liveSessionIds();
    const t = now();
    // The session-file scan is only needed for runs that are neither live nor
    // active (openAction steps 3/4), and then once per request, not per run.
    let fileIds = null;
    const runs = sortRunsNewestFirst(viewRuns(loaded).filter((r) => r.jobId === jobId))
      .slice(0, RUNS_HISTORY_LIMIT)
      .map((run) => {
        const maxMs = maxFor(run.jobId);
        const p = { ...probe(run), sessionLive: live.has(run.sessionId), hasSessionFile: null };
        if (!p.sessionLive && !isActiveRun(run, p, t, maxMs)) {
          fileIds ??= deps.listSessionFileIds();
          p.hasSessionFile = fileIds.has(run.sessionId);
        }
        return { ...run, hasExit: p.hasExit, shellAlive: p.shellAlive, hasSessionFile: p.hasSessionFile, sessionLive: p.sessionLive, action: openAction(run, p, t, maxMs) };
      });
    return json(200, { runs });
  }

  // runId is the path-traversal boundary: validated by format, then looked up
  // by listing runs/, never joined into a path from raw input.
  function runLog(runId) {
    if (!RUN_ID_RE.test(runId)) return json(400, { error: "invalid run id" });
    let names;
    try {
      names = fs.readdirSync(runsDir);
    } catch {
      names = [];
    }
    const name = names.find((n) => n === runId);
    if (!name) return json(404, { error: `unknown run ${runId}` });
    const dir = join(runsDir, name);
    let run = {};
    try {
      run = JSON.parse(readText(join(dir, "run.json"))) ?? {};
    } catch {
      // half-written or missing record: serve the log alone
    }
    const logPath = join(dir, "out.log");
    let size;
    try {
      size = fs.statSync(logPath).size;
    } catch {
      return json(200, { log: null, truncated: false, error: run.error ?? null, state: run.state ?? null });
    }
    const len = Math.min(size, LOG_TAIL_BYTES);
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(logPath, "r");
    try {
      fs.readSync(fd, buf, 0, len, size - len);
    } finally {
      fs.closeSync(fd);
    }
    return json(200, { log: buf.toString("utf-8"), truncated: size > len, error: run.error ?? null, state: run.state ?? null });
  }

  /**
   * Route a request under /api/cron/. Returns null for paths outside it.
   * @returns {{status: number, body: object}|null}
   */
  function handle(method, path) {
    if (!path.startsWith("/api/cron/")) return null;
    if (path === "/api/cron/jobs") return method === "GET" ? jobsView() : json(405, { error: "method not allowed" });
    const m = path.match(/^\/api\/cron\/(?:jobs\/([^/]+)\/(runs|run)|runs\/([^/]+)\/log)$/);
    if (!m) return json(404, { error: "not found" });
    let id;
    try {
      id = decodeURIComponent(m[1] ?? m[3]);
    } catch {
      return json(400, { error: "malformed id" });
    }
    const route = m[2] ?? "log";
    const wanted = route === "run" ? "POST" : "GET";
    if (method !== wanted) return json(405, { error: "method not allowed" });
    if (route === "run") return trigger(id);
    if (route === "runs") return runsView(id);
    return runLog(id);
  }

  return { handle, tick, release, trigger, reconcile: () => reconcile(loadJobs()), jobsView, runsView, runLog, isOwner: () => owner };
}
