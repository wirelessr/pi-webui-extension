import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  DEFAULT_MAX_RUNTIME_MINUTES,
  decideFire,
  graceMs,
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
  validateJob,
} from "../src/cron.js";

const TZ = "Asia/Taipei";
const T0 = Date.parse("2026-01-05T00:00:00.000Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const job = (over = {}) => ({ id: "gmail", name: "Gmail", schedule: "0 9 * * *", prompt: "do it", model: "m/x", cwd: "/work", enabled: true, ...over });

describe("maxRuntimeMs", () => {
  test("defaults to 6 h", () => assert.equal(maxRuntimeMs(null), DEFAULT_MAX_RUNTIME_MINUTES * MIN));
  test("per-job override", () => assert.equal(maxRuntimeMs({ maxRuntimeMinutes: 5 }), 5 * MIN));
});

describe("validateJob", () => {
  const cases = [
    { name: "valid", job: job(), want: null },
    { name: "null", job: null, want: /must be an object/ },
    { name: "array", job: [], want: /must be an object/ },
    { name: "missing and empty fields", job: { id: "a", name: "", prompt: 1 }, want: /missing field\(s\): name, schedule, prompt, model, cwd/ },
    { name: "id with a slash", job: job({ id: "../x" }), want: /id may contain/ },
    { name: "relative cwd", job: job({ cwd: "~/x" }), want: /absolute/ },
    { name: "prompt starting with @", job: job({ prompt: "@file" }), want: /must not start with @/ },
    { name: "non-positive maxRuntimeMinutes", job: job({ maxRuntimeMinutes: 0 }), want: /maxRuntimeMinutes/ },
    { name: "string maxRuntimeMinutes", job: job({ maxRuntimeMinutes: "5" }), want: /maxRuntimeMinutes/ },
    { name: "valid maxRuntimeMinutes", job: job({ maxRuntimeMinutes: 5 }), want: null },
    { name: "non-positive graceMinutes", job: job({ graceMinutes: -1 }), want: /graceMinutes must be a positive number/ },
    { name: "valid graceMinutes", job: job({ graceMinutes: 30 }), want: null },
    { name: "since not a date", job: job({ since: "yesterday" }), want: /since must be an ISO date/ },
    { name: "since not a string", job: job({ since: 0 }), want: /since must be an ISO date/ },
    { name: "valid since", job: job({ since: "2026-01-01T00:00:00Z" }), want: null },
    { name: "invalid 5-field schedule", job: job({ schedule: "99 9 * * *" }), want: /invalid schedule/ },
    { name: "6-field schedule (seconds)", job: job({ schedule: "0 0 9 * * *" }), want: /exactly 5 fields/ },
    { name: "7-field schedule", job: job({ schedule: "0 0 9 * * * 2026" }), want: /exactly 5 fields/ },
    { name: "@alias", job: job({ schedule: "@daily" }), want: /exactly 5 fields/ },
    { name: "free text", job: job({ schedule: "every day" }), want: /exactly 5 fields/ },
    { name: "5 fields with extra whitespace", job: job({ schedule: " 0  9 * * 1-5 " }), want: null },
  ];
  for (const c of cases) {
    test(c.name, () => {
      const got = validateJob(c.job, TZ);
      if (c.want === null) assert.equal(got, null);
      else assert.match(got, c.want);
    });
  }
});

describe("parseJobsFile", () => {
  test("missing file", () => assert.deepEqual(parseJobsFile(null, TZ, T0), { timezone: TZ, fileError: "cron-jobs.json not found", jobs: [] }));
  test("invalid JSON", () => assert.match(parseJobsFile("{", TZ, T0).fileError, /not valid JSON/));
  test("no jobs array", () => assert.match(parseJobsFile('{"jobs":{}}', TZ, T0).fileError, /jobs array/));
  test("null document", () => assert.match(parseJobsFile("null", TZ, T0).fileError, /jobs array/));
  test("invalid timezone", () => {
    const r = parseJobsFile(JSON.stringify({ timezone: "Not/AZone", jobs: [] }), TZ, T0);
    assert.deepEqual(r.jobs, []);
    assert.match(r.fileError, /invalid timezone/);
  });
  test("non-string timezone", () => assert.match(parseJobsFile(JSON.stringify({ timezone: 8, jobs: [] }), TZ, T0).fileError, /invalid timezone/));

  test("per-job errors do not hide valid jobs; next run in the file's timezone", () => {
    const text = JSON.stringify({ timezone: "UTC", jobs: [job(), job({ id: "bad", prompt: "@x" }), job({ name: "dup" })] });
    const r = parseJobsFile(text, TZ, T0);
    assert.equal(r.timezone, "UTC");
    assert.equal(r.fileError, null);
    assert.deepEqual(
      r.jobs.map((j) => [j.job.id, j.error, j.nextRunAt]),
      [
        ["gmail", null, "2026-01-05T09:00:00.000Z"],
        ["bad", "prompt must not start with @", null],
        ["gmail", "duplicate id: gmail", null],
      ],
    );
  });

  test("defaults to the system timezone", () => {
    const r = parseJobsFile(JSON.stringify({ jobs: [job()] }), TZ, T0);
    assert.equal(r.timezone, TZ);
    assert.equal(r.jobs[0].nextRunAt, "2026-01-05T01:00:00.000Z"); // 09:00 Taipei
  });
});

describe("run records", () => {
  test("makeRunId is UTC compact and matches RUN_ID_RE", () => {
    const id = makeRunId("gmail", Date.parse("2026-01-05T09:00:07.123Z"), "a1b2");
    assert.equal(id, "gmail-20260105T090007Z-a1b2");
    assert.ok(RUN_ID_RE.test(id));
  });

  test("RUN_ID_RE rejects traversal and malformed ids", () => {
    for (const bad of ["../x-20260105T090007Z-a1b2", "gmail-20260105T090007Z-A1B2", "gmail-2026-a1b2", "gmail-20260105T090007Z-a1b2/..", ""]) {
      assert.equal(RUN_ID_RE.test(bad), false, bad);
    }
  });

  test("newRun is running without a pid; manual scheduledFor = now", () => {
    assert.deepEqual(newRun({ runId: "r", jobId: "j", sessionId: "s", name: "n", trigger: "manual", now: T0 }), {
      runId: "r",
      jobId: "j",
      sessionId: "s",
      name: "n",
      scheduledFor: "2026-01-05T00:00:00.000Z",
      createdAt: "2026-01-05T00:00:00.000Z",
      trigger: "manual",
      state: "running",
      shellPid: null,
      startedAt: null,
      endedAt: null,
      exitCode: null,
    });
    assert.equal(newRun({ runId: "r", jobId: "j", sessionId: "s", name: "n", trigger: "schedule", scheduledFor: T0 - HOUR, now: T0 }).scheduledFor, "2026-01-04T23:00:00.000Z");
  });

  test("markStarted records pid and startedAt", () => {
    const r = markStarted({ state: "running" }, 42, T0);
    assert.deepEqual(r, { state: "running", shellPid: 42, startedAt: "2026-01-05T00:00:00.000Z" });
  });

  test("markSpawnError: first report fails a running run, later reports only add the message", () => {
    const failed = markSpawnError({ state: "running" }, "spawn failed", T0);
    assert.deepEqual(failed, { state: "failed", endedAt: "2026-01-05T00:00:00.000Z", error: "spawn failed" });
    const again = markSpawnError({ ...failed, endedAt: "x" }, "spawn zsh ENOENT", T0 + MIN);
    assert.deepEqual(again, { state: "failed", endedAt: "x", error: "spawn failed; spawn zsh ENOENT" });
    assert.deepEqual(markSpawnError({ state: "ok" }, "late", T0), { state: "ok", error: "late" });
  });

  test("sortRunsNewestFirst by createdAt, without mutating the input", () => {
    const runs = [{ createdAt: "2026-01-01T00:00:00Z" }, { createdAt: "2026-01-03T00:00:00Z" }, { createdAt: "2026-01-02T00:00:00Z" }];
    assert.deepEqual(sortRunsNewestFirst(runs).map((r) => r.createdAt[9]), ["3", "2", "1"]);
    assert.equal(runs[0].createdAt[9], "1");
  });
});

const MAX = 6 * HOUR;
const at = (offset) => new Date(T0 + offset).toISOString();

describe("isActiveRun", () => {
  const running = { state: "running", createdAt: at(0), startedAt: at(0) };
  const unknown = { state: "unknown", createdAt: at(0), startedAt: at(0) };
  const cases = [
    { name: "running, alive, no exit", run: running, probe: { hasExit: false, shellAlive: true }, now: T0 + HOUR, want: true },
    { name: "running but exit exists", run: running, probe: { hasExit: true, shellAlive: true }, now: T0, want: false },
    { name: "running but shell dead", run: running, probe: { hasExit: false, shellAlive: false }, now: T0, want: false },
    { name: "unknown, alive, within 2x max", run: unknown, probe: { hasExit: false, shellAlive: true }, now: T0 + 2 * MAX, want: true },
    { name: "unknown, alive, past 2x max", run: unknown, probe: { hasExit: false, shellAlive: true }, now: T0 + 2 * MAX + 1, want: false },
    { name: "unknown without startedAt uses createdAt", run: { state: "unknown", createdAt: at(0) }, probe: { hasExit: false, shellAlive: true }, now: T0 + 2 * MAX + 1, want: false },
    { name: "final state", run: { state: "ok", createdAt: at(0) }, probe: { hasExit: false, shellAlive: true }, now: T0, want: false },
  ];
  for (const c of cases) test(c.name, () => assert.equal(isActiveRun(c.run, c.probe, c.now, MAX), c.want));
});

describe("reconcileRun", () => {
  const opts = { maxMs: MAX, tickMs: MIN };
  const running = { state: "running", createdAt: at(0), startedAt: at(0), shellPid: 7 };
  const cases = [
    { name: "final state untouched", run: { state: "ok" }, probe: { hasExit: true, exitCode: 1 }, now: T0, want: null },
    { name: "exit 0 → ok regardless of pid", run: running, probe: { hasExit: true, exitCode: 0, shellAlive: true }, now: T0 + MIN, want: { ...running, state: "ok", exitCode: 0, endedAt: at(MIN) } },
    { name: "exit non-zero → failed", run: running, probe: { hasExit: true, exitCode: 143, shellAlive: false }, now: T0, want: { ...running, state: "failed", exitCode: 143, endedAt: at(0) } },
    { name: "unparsable exit → failed with null code", run: running, probe: { hasExit: true, exitCode: Number.NaN }, now: T0, want: { ...running, state: "failed", exitCode: null, endedAt: at(0) } },
    { name: "late exit upgrades unknown", run: { ...running, state: "unknown" }, probe: { hasExit: true, exitCode: 0 }, now: T0, want: { ...running, state: "ok", exitCode: 0, endedAt: at(0) } },
    { name: "unknown without exit stays", run: { ...running, state: "unknown" }, probe: { hasExit: false, shellAlive: false }, now: T0, want: null },
    { name: "shell dead → unknown", run: running, probe: { hasExit: false, shellAlive: false }, now: T0, want: { ...running, state: "unknown", note: "wrapper ended without writing an exit code" } },
    { name: "alive within max runtime → no change", run: running, probe: { hasExit: false, shellAlive: true }, now: T0 + MAX, want: null },
    { name: "alive past max runtime → unknown", run: running, probe: { hasExit: false, shellAlive: true }, now: T0 + MAX + 1, want: { ...running, state: "unknown", note: "exceeded max runtime" } },
    { name: "no pid, within two ticks → no change", run: { state: "running", createdAt: at(0), shellPid: null }, probe: { hasExit: false, shellAlive: false }, now: T0 + 2 * MIN, want: null },
    { name: "no pid, older than two ticks → unknown", run: { state: "running", createdAt: at(0), shellPid: null }, probe: { hasExit: false, shellAlive: false }, now: T0 + 2 * MIN + 1, want: { state: "unknown", createdAt: at(0), shellPid: null, note: "no pid recorded" } },
  ];
  for (const c of cases) test(c.name, () => assert.deepEqual(reconcileRun(c.run, c.probe, c.now, opts), c.want));
});

describe("openAction", () => {
  const running = { state: "running", createdAt: at(0), startedAt: at(0) };
  const done = { state: "ok", createdAt: at(0) };
  const cases = [
    { name: "live session → select (even while active)", run: running, probe: { sessionLive: true, hasExit: false, shellAlive: true, hasSessionFile: true }, want: "select" },
    { name: "active run → wait", run: running, probe: { sessionLive: false, hasExit: false, shellAlive: true, hasSessionFile: true }, want: "wait" },
    { name: "finished with a session file → open", run: done, probe: { sessionLive: false, hasExit: true, shellAlive: false, hasSessionFile: true }, want: "open" },
    { name: "exit present beats a reused live pid → open", run: running, probe: { sessionLive: false, hasExit: true, shellAlive: true, hasSessionFile: true }, want: "open" },
    { name: "no session file → log", run: done, probe: { sessionLive: false, hasExit: true, shellAlive: false, hasSessionFile: false }, want: "log" },
  ];
  for (const c of cases) test(c.name, () => assert.equal(openAction(c.run, c.probe, T0, MAX), c.want));
});

const U = (isoString) => Date.parse(isoString);
const done = (scheduledFor, extra = {}) => ({ jobId: "gmail", state: "ok", scheduledFor, createdAt: scheduledFor, hasExit: true, shellAlive: false, ...extra });

describe("graceMs", () => {
  const cases = [
    { name: "daily: half of 24 h", job: job(), slot: "2026-01-05T09:00:00Z", want: 12 * HOUR },
    { name: "weekday-only Friday slot: half of the 3-day gap", job: job({ schedule: "0 9 * * 1-5" }), slot: "2026-01-09T09:00:00Z", want: 36 * HOUR },
    { name: "weekday-only Monday slot: half of 1 day", job: job({ schedule: "0 9 * * 1-5" }), slot: "2026-01-05T09:00:00Z", want: 12 * HOUR },
    { name: "monthly: capped at 7 days", job: job({ schedule: "0 10 1 * *" }), slot: "2026-02-01T10:00:00Z", want: 7 * 24 * HOUR },
    { name: "graceMinutes overrides", job: job({ graceMinutes: 30 }), slot: "2026-01-05T09:00:00Z", want: 30 * MIN },
  ];
  for (const c of cases) test(c.name, () => assert.equal(graceMs(c.job, U(c.slot), "UTC"), c.want));
});

describe("decideFire", () => {
  const SLOT = "2026-01-05T09:00:00.000Z";
  const firstTick = U("2026-01-05T08:00:00Z");
  const cases = [
    { name: "slot exactly at now fires (previousRuns + 1 ms)", job: job(), runs: [], now: U(SLOT), want: { action: "fire", scheduledFor: U(SLOT) } },
    { name: "1 ms before the slot: previous slot is before the first tick", job: job(), runs: [], now: U(SLOT) - 1, want: { action: "none", reason: "consumed" } },
    { name: "no runs, no since: first tick after the slot does not catch up", job: job(), runs: [], now: U("2026-01-05T09:31:00Z"), first: U("2026-01-05T09:30:00Z"), want: { action: "none", reason: "consumed" } },
    { name: "since is the baseline for a job with no runs", job: job({ since: "2026-01-04T00:00:00Z" }), runs: [], now: U("2026-01-05T10:00:00Z"), first: U("2026-01-05T10:00:00Z"), want: { action: "fire", scheduledFor: U(SLOT) } },
    { name: "since after the slot consumes it", job: job({ since: "2026-01-05T09:30:00Z" }), runs: [], now: U("2026-01-05T10:00:00Z"), want: { action: "none", reason: "consumed" } },
    { name: "newest run scheduledFor beats since", job: job({ since: "2026-01-01T00:00:00Z" }), runs: [done(SLOT)], now: U("2026-01-05T10:00:00Z"), want: { action: "none", reason: "consumed" } },
    { name: "a skipped record consumes its slot", job: job(), runs: [done(SLOT, { state: "skipped", hasExit: false })], now: U("2026-01-05T10:00:00Z"), want: { action: "none", reason: "consumed" } },
    { name: "a manual run consumes a pending slot", job: job(), runs: [done("2026-01-05T09:00:30.000Z", { trigger: "manual" })], now: U("2026-01-05T09:01:00Z"), want: { action: "none", reason: "consumed" } },
    { name: "missed slots collapse to the most recent one", job: job(), runs: [done("2026-01-01T09:00:00.000Z")], now: U("2026-01-05T09:05:00Z"), want: { action: "fire", scheduledFor: U(SLOT) } },
    { name: "inside default grace (12 h)", job: job(), runs: [done("2026-01-04T09:00:00.000Z")], now: U(SLOT) + 12 * HOUR, want: { action: "fire", scheduledFor: U(SLOT) } },
    { name: "past default grace: dropped", job: job(), runs: [done("2026-01-04T09:00:00.000Z")], now: U(SLOT) + 12 * HOUR + 1, want: { action: "none", reason: "expired" } },
    { name: "past graceMinutes: dropped", job: job({ graceMinutes: 30 }), runs: [done("2026-01-04T09:00:00.000Z")], now: U(SLOT) + 31 * MIN, want: { action: "none", reason: "expired" } },
    { name: "active run: skip", job: job(), runs: [done("2026-01-04T09:00:00.000Z", { state: "running", startedAt: "2026-01-05T08:00:00.000Z", hasExit: false, shellAlive: true })], now: U(SLOT), want: { action: "skip", scheduledFor: U(SLOT) } },
    { name: "finished run is not active: fire", job: job(), runs: [done("2026-01-04T09:00:00.000Z", { state: "running", hasExit: true, shellAlive: true })], now: U(SLOT), want: { action: "fire", scheduledFor: U(SLOT) } },
    { name: "weekday-only: Saturday evening inside the Friday grace", job: job({ schedule: "0 9 * * 1-5" }), runs: [done("2026-01-08T09:00:00.000Z")], now: U("2026-01-10T21:00:00Z"), want: { action: "fire", scheduledFor: U("2026-01-09T09:00:00Z") } },
    { name: "weekday-only: past the Friday grace", job: job({ schedule: "0 9 * * 1-5" }), runs: [done("2026-01-08T09:00:00.000Z")], now: U("2026-01-10T21:00:00Z") + 1, want: { action: "none", reason: "expired" } },
    { name: "weekday-only: past the Monday grace", job: job({ schedule: "0 9 * * 1-5" }), runs: [done("2026-01-02T09:00:00.000Z")], now: U("2026-01-05T21:00:00Z") + 1, want: { action: "none", reason: "expired" } },
    { name: "monthly: 7 days after the slot", job: job({ schedule: "0 10 1 * *" }), runs: [done("2026-01-01T10:00:00.000Z")], now: U("2026-02-08T10:00:00Z"), want: { action: "fire", scheduledFor: U("2026-02-01T10:00:00Z") } },
    { name: "monthly: past the 7-day cap", job: job({ schedule: "0 10 1 * *" }), runs: [done("2026-01-01T10:00:00.000Z")], now: U("2026-02-08T10:00:00Z") + 1, want: { action: "none", reason: "expired" } },
  ];
  for (const c of cases) test(c.name, () => assert.deepEqual(decideFire(c.job, c.runs, c.now, "UTC", c.first ?? firstTick), c.want));

  test("timezone is applied to the schedule", () => {
    assert.deepEqual(decideFire(job(), [], U("2026-01-05T01:00:00Z"), TZ, U("2026-01-05T00:00:00Z")), { action: "fire", scheduledFor: U("2026-01-05T01:00:00Z") });
  });

  // Tick every 5 minutes across a DST change, recording each fire as a
  // finished run, and count the fires on that local day.
  function simulate(schedule, tz, fromIso, toIso) {
    const j = job({ schedule });
    const runs = [];
    const from = U(fromIso);
    for (let t = from; t <= U(toIso); t += 5 * MIN) {
      const d = decideFire(j, runs, t, tz, from);
      assert.notEqual(d.action, "skip");
      if (d.action === "fire") runs.push(done(new Date(d.scheduledFor).toISOString()));
    }
    return runs.map((r) => r.scheduledFor);
  }

  test("DST spring-forward: a nonexistent local time fires once, shifted", () => {
    assert.deepEqual(simulate("30 2 * * *", "America/New_York", "2026-03-07T12:00:00Z", "2026-03-09T12:00:00Z"), [
      "2026-03-08T07:00:00.000Z", // 03:00 EDT, the 02:30 that did not exist
      "2026-03-09T06:30:00.000Z",
    ]);
  });

  test("DST fall-back: a repeated local time fires once (first pass)", () => {
    assert.deepEqual(simulate("30 1 * * *", "America/New_York", "2026-10-31T12:00:00Z", "2026-11-02T12:00:00Z"), [
      "2026-11-01T05:30:00.000Z", // 01:30 EDT; 01:30 EST (06:30Z) does not fire again
      "2026-11-02T06:30:00.000Z",
    ]);
  });
});

describe("lockStatus", () => {
  const base = { mtimeMs: T0, now: T0, tickMs: MIN, myPid: 10, isPidAlive: (p) => p === 20 || p === 10 };
  const cases = [
    { name: "missing → take", content: null, want: "take" },
    { name: "empty (read between create and write) → take", content: "", want: "take" },
    { name: "not JSON → take", content: "{pid", want: "take" },
    { name: "null → take", content: "null", want: "take" },
    { name: "no numeric pid → take", content: '{"pid":"20"}', want: "take" },
    { name: "own pid → own", content: '{"pid":10}', want: "own" },
    { name: "own pid even with a lapsed heartbeat → own", content: '{"pid":10}', now: T0 + 60 * MIN, want: "own" },
    { name: "live other, fresh heartbeat → other", content: '{"pid":20}', want: "other" },
    { name: "live other, heartbeat exactly 5 ticks old → other", content: '{"pid":20}', now: T0 + 5 * MIN, want: "other" },
    { name: "live other, heartbeat older than 5 ticks (pid reuse) → take", content: '{"pid":20}', now: T0 + 5 * MIN + 1, want: "take" },
    { name: "dead other → take", content: '{"pid":30}', want: "take" },
  ];
  for (const c of cases) test(c.name, () => assert.equal(lockStatus({ ...base, content: c.content, now: c.now ?? base.now }), c.want));
});

describe("prunableRuns", () => {
  const max = () => MAX;
  const finished = (jobId, i) => ({ jobId, runId: `${jobId}-${i}`, state: "ok", createdAt: at(i * MIN), hasExit: true, shellAlive: false });

  test("keeps the newest 30 per job, counted per job", () => {
    const runs = [...Array.from({ length: 32 }, (_, i) => finished("a", i)), ...Array.from({ length: 30 }, (_, i) => finished("b", i))];
    assert.deepEqual(prunableRuns(runs, T0 + HOUR, max).sort(), ["a-0", "a-1"]);
  });

  test("never an active run, even beyond 30", () => {
    const runs = Array.from({ length: 31 }, (_, i) => finished("a", i));
    runs[0] = { ...runs[0], state: "running", startedAt: at(0), hasExit: false, shellAlive: true };
    assert.deepEqual(prunableRuns(runs, T0 + HOUR, max), []);
  });

  test("unknown older than 2x max runtime regardless of count; younger or alive ones stay", () => {
    const unknown = (i, extra) => ({ ...finished("a", i), state: "unknown", startedAt: at(i * MIN), hasExit: false, ...extra });
    const runs = [unknown(0, { shellAlive: true }), unknown(1, { shellAlive: false }), unknown(200, { shellAlive: false })];
    const now = T0 + 2 * MAX + 2 * MIN; // past 2x for runs 0 and 1, not for 200
    assert.deepEqual(prunableRuns(runs, now, max).sort(), ["a-0", "a-1"]);
  });

  test("the run with the greatest scheduledFor is kept even as an expired unknown, and counts toward the 30", () => {
    const withSlot = (r, i) => ({ ...r, scheduledFor: at(i * MIN) });
    const runs = Array.from({ length: 30 }, (_, i) => withSlot(finished("a", i), i));
    const expired = (id, slot) => withSlot({ jobId: "a", runId: id, state: "unknown", createdAt: at(slot * MIN), startedAt: at(0), hasExit: false, shellAlive: false }, slot);
    runs.push(expired("a-baseline", 100), expired("a-older", 50));
    const pruned = prunableRuns(runs, T0 + 2 * MAX + 1, max).sort();
    assert.deepEqual(pruned, ["a-0", "a-older"]); // baseline kept and takes a slot: the oldest ok goes
  });

  test("a pruned expired unknown does not use up one of the 30", () => {
    const runs = Array.from({ length: 30 }, (_, i) => finished("a", i));
    runs.push({ jobId: "a", runId: "a-new", state: "unknown", createdAt: at(100 * MIN), startedAt: at(0), hasExit: false, shellAlive: false });
    assert.deepEqual(prunableRuns(runs, T0 + 2 * MAX + 1, max), ["a-new"]);
  });
});
