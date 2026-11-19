/**
 * Pure cron logic for the hub: job validation, run records and their
 * transitions, reconcile decisions, the "active run" predicate, the
 * per-run Open decision, the per-tick fire decision, the scheduler lock
 * decision and retention. No IO; every time-dependent function takes `now`
 * (ms since epoch). cron-runner.js wires the filesystem and spawn around it.
 */

import { Cron } from "croner";

export const DEFAULT_MAX_RUNTIME_MINUTES = 360;
export const MAX_GRACE_MS = 7 * 24 * 60 * 60_000;
export const LOCK_STALE_TICKS = 5;
export const RETAIN_RUNS_PER_JOB = 30;
export const RUN_ID_RE = /^[A-Za-z0-9_-]+-\d{8}T\d{6}Z-[0-9a-f]{4}$/;
const JOB_ID_RE = /^[A-Za-z0-9_-]+$/;
const REQUIRED_FIELDS = ["id", "name", "schedule", "prompt", "model", "cwd"];
const LIVE_STATES = new Set(["running", "unknown"]);

const iso = (ms) => new Date(ms).toISOString();
const ms = (isoString) => Date.parse(isoString);

/** Max runtime of a job in ms (per-job `maxRuntimeMinutes`, default 6 h). */
export function maxRuntimeMs(job) {
  return (job?.maxRuntimeMinutes ?? DEFAULT_MAX_RUNTIME_MINUTES) * 60_000;
}

/**
 * Validate one job entry from cron-jobs.json.
 * @returns {string|null} error message, or null when valid
 */
export function validateJob(job, timezone) {
  if (!job || typeof job !== "object" || Array.isArray(job)) return "job must be an object";
  const missing = REQUIRED_FIELDS.filter((f) => typeof job[f] !== "string" || !job[f]);
  if (missing.length) return `missing field(s): ${missing.join(", ")}`;
  if (!JOB_ID_RE.test(job.id)) return "id may contain only letters, digits, _ and -";
  if (!job.cwd.startsWith("/")) return "cwd must be an absolute path";
  // pi reads a message starting with @ as a file argument, even after `--`.
  if (job.prompt.startsWith("@")) return "prompt must not start with @";
  for (const f of ["maxRuntimeMinutes", "graceMinutes"]) {
    if (job[f] !== undefined && !(typeof job[f] === "number" && job[f] > 0)) return `${f} must be a positive number`;
  }
  if (job.since !== undefined && !(typeof job.since === "string" && Number.isFinite(Date.parse(job.since)))) return "since must be an ISO date";
  if (job.schedule.trim().split(/\s+/).length !== 5) return "schedule must have exactly 5 fields (minute hour day month weekday)";
  try {
    new Cron(job.schedule, { timezone }).nextRun();
  } catch (err) {
    return `invalid schedule: ${err.message}`;
  }
  return null;
}

function validTimezone(tz) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Parse cron-jobs.json (`{ timezone?, jobs: [...] }`). Every job is validated
 * on its own, so one bad entry does not hide the others.
 * @param {string|null} text file content, null when the file is missing
 * @param {string} systemTz default timezone
 * @param {number} now
 * @returns {{ timezone: string, fileError: string|null, jobs: Array<{ job: object, error: string|null, nextRunAt: string|null }> }}
 */
export function parseJobsFile(text, systemTz, now) {
  const fail = (fileError) => ({ timezone: systemTz, fileError, jobs: [] });
  if (text == null) return fail("cron-jobs.json not found");
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    return fail(`cron-jobs.json is not valid JSON: ${err.message}`);
  }
  if (!data || typeof data !== "object" || !Array.isArray(data.jobs)) return fail("cron-jobs.json must be an object with a jobs array");
  const timezone = data.timezone ?? systemTz;
  if (typeof timezone !== "string" || !validTimezone(timezone)) return fail(`invalid timezone: ${timezone}`);
  const seen = new Set();
  const jobs = data.jobs.map((job) => {
    // validateJob never throws (it catches croner's errors), so one bad job
    // cannot stop the others.
    let error = validateJob(job, timezone);
    if (!error && seen.has(job.id)) error = `duplicate id: ${job.id}`;
    if (!error) seen.add(job.id);
    const next = error ? null : new Cron(job.schedule, { timezone }).nextRun(new Date(now));
    return { job, error, nextRunAt: next ? next.toISOString() : null };
  });
  return { timezone, fileError: null, jobs };
}

/** `<jobId>-<UTC compact timestamp>-<4 hex>`, e.g. `gmail-20260101T090000Z-a1b2`. */
export function makeRunId(jobId, now, hex4) {
  const stamp = iso(now).replace(/\.\d{3}Z$/, "Z").replace(/[-:]/g, "");
  return `${jobId}-${stamp}-${hex4}`;
}

/** A fresh run record in state `running`, before spawn (no pid yet). */
export function newRun({ runId, jobId, sessionId, name, trigger, scheduledFor, now, state = "running" }) {
  return {
    runId,
    jobId,
    sessionId,
    name,
    scheduledFor: iso(scheduledFor ?? now),
    createdAt: iso(now),
    trigger,
    state,
    shellPid: null,
    startedAt: null,
    endedAt: null,
    exitCode: null,
  };
}

/** Spawn returned a pid. */
export function markStarted(run, pid, now) {
  return { ...run, shellPid: pid, startedAt: iso(now) };
}

/**
 * Spawn failed (sync throw or async `error`). Both can fire for one failed
 * spawn: the first finalizes a running run as `failed`, a later one only adds
 * its message.
 */
export function markSpawnError(run, message, now) {
  if (run.state === "running") return { ...run, state: "failed", endedAt: iso(now), error: message };
  return { ...run, error: run.error ? `${run.error}; ${message}` : message };
}

const startOf = (run) => ms(run.startedAt ?? run.createdAt);

/**
 * The single "active run" definition (decide, manual trigger, Open, retention).
 * @param {object} probe `{ hasExit, shellAlive }` computed by the server
 */
export function isActiveRun(run, probe, now, maxMs) {
  if (probe.hasExit || !probe.shellAlive) return false;
  if (run.state === "running") return true;
  return run.state === "unknown" && now - startOf(run) <= 2 * maxMs;
}

/**
 * Reconcile one run against the filesystem/process probe.
 * @param {object} probe `{ hasExit, exitCode, shellAlive }`
 * @param {object} opts `{ maxMs, tickMs }`
 * @returns {object|null} the updated run, or null when nothing changes
 */
export function reconcileRun(run, probe, now, { maxMs, tickMs }) {
  if (!LIVE_STATES.has(run.state)) return null;
  if (probe.hasExit) {
    return { ...run, state: probe.exitCode === 0 ? "ok" : "failed", exitCode: Number.isInteger(probe.exitCode) ? probe.exitCode : null, endedAt: iso(now) };
  }
  if (run.state !== "running") return null;
  if (run.shellPid != null && !probe.shellAlive) return { ...run, state: "unknown", note: "wrapper ended without writing an exit code" };
  if (run.shellPid == null && now - ms(run.createdAt) > 2 * tickMs) return { ...run, state: "unknown", note: "no pid recorded" };
  if (now - startOf(run) > maxMs) return { ...run, state: "unknown", note: "exceeded max runtime" };
  return null;
}

/**
 * Per-run action for the panel, decided by live state, not run state.
 * @param {object} probe `{ sessionLive, hasExit, shellAlive, hasSessionFile }`
 * @returns {"select"|"wait"|"open"|"log"}
 */
export function openAction(run, probe, now, maxMs) {
  if (probe.sessionLive) return "select";
  if (isActiveRun(run, probe, now, maxMs)) return "wait";
  if (probe.hasSessionFile) return "open";
  return "log";
}

/** Newest first by createdAt. */
export function sortRunsNewestFirst(runs) {
  return [...runs].sort((a, b) => ms(b.createdAt) - ms(a.createdAt));
}

/**
 * Grace window for a slot: per-job `graceMinutes`, else half the gap to the
 * following slot, capped at 7 days.
 */
export function graceMs(job, slotMs, timezone) {
  if (job.graceMinutes !== undefined) return job.graceMinutes * 60_000;
  const next = new Cron(job.schedule, { timezone }).nextRun(new Date(slotMs));
  return next ? Math.min((next.getTime() - slotMs) / 2, MAX_GRACE_MS) : MAX_GRACE_MS;
}

/**
 * Per-tick decision for one enabled, valid job. At most one slot per call:
 * missed slots collapse to the most recent one.
 * @param {object} job
 * @param {Array<object>} runs this job's runs, each carrying server-computed `hasExit` and `shellAlive`
 * @param {number} now
 * @param {string} timezone
 * @param {number} firstTickAt baseline when the job has no runs and no `since`
 * @returns {{ action: "fire"|"skip", scheduledFor: number } | { action: "none", reason: "no-slot"|"consumed"|"expired" }}
 */
export function decideFire(job, runs, now, timezone, firstTickAt) {
  // previousRuns is strictly before its reference: +1 ms includes a slot at `now`.
  const slot = new Cron(job.schedule, { timezone }).previousRuns(1, new Date(now + 1))[0];
  if (!slot) return { action: "none", reason: "no-slot" };
  const slotMs = slot.getTime();
  const scheduled = runs.map((r) => ms(r.scheduledFor)).filter(Number.isFinite);
  const baseline = scheduled.length ? Math.max(...scheduled) : job.since !== undefined ? ms(job.since) : firstTickAt;
  if (slotMs <= baseline) return { action: "none", reason: "consumed" };
  if (now - slotMs > graceMs(job, slotMs, timezone)) return { action: "none", reason: "expired" };
  const maxMs = maxRuntimeMs(job);
  return { action: runs.some((r) => isActiveRun(r, r, now, maxMs)) ? "skip" : "fire", scheduledFor: slotMs };
}

/**
 * Scheduler lock decision from what this hub just read.
 * @param {object} read
 * @param {string|null} read.content lock file content, null when missing
 * @param {number} read.mtimeMs heartbeat (lock file mtime)
 * @returns {"own"|"take"|"other"} own: this hub's lock (touch it, act);
 *   take: missing or stale (unlink + exclusive create, do not act this tick);
 *   other: held by a live, heartbeating hub
 */
export function lockStatus({ content, mtimeMs, now, tickMs, myPid, isPidAlive }) {
  if (content == null) return "take";
  let lock;
  try {
    lock = JSON.parse(content);
  } catch {
    return "take"; // unparsable, e.g. read between the exclusive create and the write
  }
  if (!lock || typeof lock.pid !== "number") return "take";
  if (lock.pid === myPid) return "own";
  if (!isPidAlive(lock.pid) || now - mtimeMs > LOCK_STALE_TICKS * tickMs) return "take";
  return "other";
}

/**
 * Run ids retention may delete: per job, beyond the newest 30 by createdAt,
 * plus `unknown` runs older than twice their max runtime regardless of count.
 * Never returned: active runs, and per job the run with the greatest
 * scheduledFor (it is the decideFire baseline; deleting it would let the same
 * slot fire again inside grace). Both still count toward the 30.
 * @param {Array<object>} runs each carrying `hasExit` and `shellAlive`
 * @param {(jobId: string) => number} maxFor max runtime in ms per job id
 */
export function prunableRuns(runs, now, maxFor) {
  const byJob = new Map();
  for (const run of sortRunsNewestFirst(runs)) {
    if (!byJob.has(run.jobId)) byJob.set(run.jobId, []);
    byJob.get(run.jobId).push(run);
  }
  const out = [];
  for (const list of byJob.values()) {
    let baselineRun = null;
    for (const run of list) if (Number.isFinite(ms(run.scheduledFor)) && (!baselineRun || ms(run.scheduledFor) > ms(baselineRun.scheduledFor))) baselineRun = run;
    let kept = 0; // runs that stay, so an expired unknown does not use up one of the 30
    for (const run of list) {
      const maxMs = maxFor(run.jobId);
      const expiredUnknown = run.state === "unknown" && now - startOf(run) > 2 * maxMs;
      if (run === baselineRun || isActiveRun(run, run, now, maxMs)) kept++;
      else if (expiredUnknown || kept >= RETAIN_RUNS_PER_JOB) out.push(run.runId);
      else kept++;
    }
  }
  return out;
}
