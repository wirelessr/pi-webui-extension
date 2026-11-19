import assert from "node:assert/strict";
import * as realFs from "node:fs";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { buildCronRunArgv } from "@wirelessr/pi-webui-components/session-spawn.js";
import { createCronRunner, LOG_TAIL_BYTES, RUNS_HISTORY_LIMIT } from "../src/cron-runner.js";

const T0 = Date.parse("2026-01-05T00:00:00.000Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const job = (over = {}) => ({ id: "gmail", name: "Gmail", schedule: "0 9 * * *", prompt: "-load skill x", model: "m/x", cwd: "/work", enabled: true, ...over });

// Real temp filesystem; spawn, clock, pid liveness and session lookups are fakes.
const dirs = [];
let h;
function setup({ jobs = [job()], file, owner = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "cron-runner-"));
  dirs.push(dir);
  const cronDir = join(dir, "cron");
  mkdirSync(cronDir, { recursive: true });
  if (file !== null) writeFileSync(join(cronDir, "cron-jobs.json"), file ?? JSON.stringify({ timezone: "UTC", jobs }));
  const state = {
    t: T0,
    alive: new Set(),
    sessionFiles: new Set(),
    live: new Set(),
    spawns: [],
    spawnImpl: () => 999 + state.spawns.length, // first spawn gets pid 1000
    logs: [],
    fileScans: 0,
    hex: null, // forced randomHex4 values, consumed first
  };
  let n = 0;
  const makeRunner = (pid, fs = realFs) => createCronRunner({
    cronDir,
    bridgeDir: "/bridge",
    env: { HOME: "/home/u", PI_BRIDGE_DIR: "/wrong" },
    piBin: "/stub-pi",
    tickMs: MIN,
    systemTz: "Asia/Taipei",
    now: () => state.t,
    randomHex4: () => (state.hex?.length ? state.hex.shift() : (n++).toString(16).padStart(4, "0")),
    randomUUID: () => `uuid-${n}`,
    buildArgv: buildCronRunArgv,
    spawnDetached: (argv, opts) => {
      state.spawns.push({ argv, opts });
      return state.spawnImpl(argv, opts);
    },
    isPidAlive: (pid) => state.alive.has(pid),
    listSessionFileIds: () => {
      state.fileScans++;
      return state.sessionFiles;
    },
    liveSessionIds: () => state.live,
    log: (line) => state.logs.push(line),
    pid,
    fs,
  });
  const runner = makeRunner(4242);
  // Another hub on the same cron dir (shares the clock, pids and spawn log).
  const addRunner = (pid, fs) => makeRunner(pid, fs);
  h = { runner, state, cronDir, runsDir: join(cronDir, "runs"), lockFile: join(cronDir, "scheduler.lock"), addRunner };
  if (owner) {
    // First tick takes the lock, the second confirms it (no slot is due at T0).
    runner.tick();
    runner.tick();
    assert.equal(runner.isOwner(), true);
    state.logs.length = 0;
  }
  return h;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const runJson = (runId) => JSON.parse(readFileSync(join(h.runsDir, runId, "run.json"), "utf-8"));
const writeExit = (runId, code) => writeFileSync(join(h.runsDir, runId, "exit"), `${code}\n`);
const runsOf = () => h.runner.runsView("gmail").body.runs;

describe("trigger (Run now)", () => {
  beforeEach(() => setup());

  test("creates run.json, spawns the zsh wrapper in the job cwd, records the pid", () => {
    const r = h.runner.trigger("gmail");
    assert.equal(r.status, 200);
    const runId = r.body.run.runId;
    assert.equal(runId, "gmail-20260105T000000Z-0000");
    assert.deepEqual(runJson(runId), {
      runId,
      jobId: "gmail",
      sessionId: "uuid-1",
      name: "cron: Gmail 2026-01-05 00:00",
      scheduledFor: "2026-01-05T00:00:00.000Z",
      createdAt: "2026-01-05T00:00:00.000Z",
      trigger: "manual",
      state: "running",
      shellPid: 1000,
      startedAt: "2026-01-05T00:00:00.000Z",
      endedAt: null,
      exitCode: null,
    });
    const [{ argv, opts }] = h.state.spawns;
    assert.deepEqual(argv, buildCronRunArgv({ sessionId: "uuid-1", name: "cron: Gmail 2026-01-05 00:00", model: "m/x", prompt: "-load skill x", runDir: join(h.runsDir, runId), piBin: "/stub-pi" }));
    assert.equal(opts.cwd, "/work");
    assert.deepEqual(opts.env, { HOME: "/home/u", PI_BRIDGE_DIR: "/bridge" });
    assert.deepEqual(readdirSync(join(h.runsDir, runId)), ["run.json"]); // run.json.4242.tmp renamed away
  });

  test("works on a disabled job", () => {
    setup({ jobs: [job({ enabled: false })] });
    assert.equal(h.runner.trigger("gmail").status, 200);
  });

  test("409 while the job has an active run, and no record is written", () => {
    h.runner.trigger("gmail");
    h.state.alive.add(1000);
    const r = h.runner.trigger("gmail");
    assert.equal(r.status, 409);
    assert.equal(readdirSync(h.runsDir).length, 1);
  });

  test("unknown job 404, invalid job 400, unusable file 400", () => {
    assert.equal(h.runner.trigger("nope").status, 404);
    setup({ jobs: [job({ prompt: "@file" })] });
    assert.deepEqual(h.runner.trigger("gmail"), { status: 400, body: { error: "prompt must not start with @" } });
    setup({ file: "{" });
    assert.equal(h.runner.trigger("gmail").status, 400);
  });

  test("spawn failure: sync throw finalizes failed, the async error only adds its message", () => {
    let onError;
    h.state.spawnImpl = (_argv, opts) => {
      onError = opts.onError;
      throw new Error("spawn failed");
    };
    const r = h.runner.trigger("gmail");
    assert.equal(r.status, 200);
    const { runId } = r.body.run;
    assert.equal(runJson(runId).state, "failed");
    h.state.t += 5;
    onError(new Error("spawn zsh ENOENT"));
    const rec = runJson(runId);
    assert.equal(rec.state, "failed");
    assert.equal(rec.endedAt, "2026-01-05T00:00:00.000Z");
    assert.equal(rec.error, "spawn failed; spawn zsh ENOENT (cwd: /work)");
    assert.deepEqual(h.runner.runLog(runId).body, { log: null, truncated: false, error: rec.error, state: "failed" });
    assert.equal(runsOf()[0].action, "log");
  });

  test("an async error with an unreadable record is logged, not thrown", () => {
    let onError;
    h.state.spawnImpl = (_argv, opts) => {
      onError = opts.onError;
      return 1000;
    };
    const { runId } = h.runner.trigger("gmail").body.run;
    rmSync(join(h.runsDir, runId), { recursive: true });
    assert.doesNotThrow(() => onError(new Error("boom")));
    assert.match(h.state.logs[0], /spawn error boom \(cwd: \/work\); could not record it/);
  });
});

describe("reconcile through the views", () => {
  beforeEach(() => setup({ jobs: [job({ maxRuntimeMinutes: 60 })] }));

  test("ok: exit 0 finalizes; Open when the session file exists, select when live", () => {
    const { runId, sessionId } = h.runner.trigger("gmail").body.run;
    h.state.alive.add(1000);
    assert.equal(runsOf()[0].action, "wait");
    writeExit(runId, 0);
    h.state.sessionFiles.add(sessionId);
    const [run] = runsOf();
    assert.equal(run.state, "ok");
    assert.equal(run.exitCode, 0);
    assert.equal(run.hasExit, true);
    assert.equal(run.action, "open");
    h.state.live.add(sessionId);
    assert.equal(runsOf()[0].action, "select");
    assert.equal(runJson(runId).state, "ok");
  });

  test("failed: non-zero exit", () => {
    const { runId } = h.runner.trigger("gmail").body.run;
    writeExit(runId, 1);
    assert.equal(h.runner.jobsView().body.jobs[0].latestRun.state, "failed");
  });

  test("hung: past max runtime → unknown, blocks Run now until 2x max runtime", () => {
    h.runner.trigger("gmail");
    h.state.alive.add(1000);
    h.state.t = T0 + HOUR + 1;
    assert.equal(runsOf()[0].state, "unknown");
    assert.equal(h.runner.trigger("gmail").status, 409);
    h.state.t = T0 + 2 * HOUR + 1;
    assert.equal(runsOf()[0].action, "log");
    assert.equal(h.runner.trigger("gmail").status, 200);
  });

  test("a late exit upgrades unknown", () => {
    const { runId } = h.runner.trigger("gmail").body.run;
    h.runner.reconcile(); // shell 1000 not alive → unknown
    assert.equal(runJson(runId).state, "unknown");
    writeExit(runId, 0);
    h.runner.reconcile();
    assert.equal(runJson(runId).state, "ok");
  });

  test("a run with no recorded pid becomes unknown after two ticks", () => {
    mkdirSync(join(h.runsDir, "gmail-20260105T000000Z-ffff"), { recursive: true });
    writeFileSync(join(h.runsDir, "gmail-20260105T000000Z-ffff", "run.json"), JSON.stringify({ runId: "gmail-20260105T000000Z-ffff", jobId: "gmail", state: "running", createdAt: new Date(T0).toISOString(), shellPid: null }));
    h.state.t = T0 + 2 * MIN;
    h.runner.reconcile();
    assert.equal(runJson("gmail-20260105T000000Z-ffff").state, "running");
    h.state.t += 1;
    h.runner.reconcile();
    assert.equal(runJson("gmail-20260105T000000Z-ffff").state, "unknown");
  });

  test("runs of a job missing from the file use the default max runtime", () => {
    const { runId } = h.runner.trigger("gmail").body.run;
    h.state.alive.add(1000);
    writeFileSync(join(h.cronDir, "cron-jobs.json"), JSON.stringify({ jobs: [] }));
    h.state.t = T0 + 2 * HOUR;
    h.runner.reconcile();
    assert.equal(runJson(runId).state, "running");
  });
});

describe("views", () => {
  beforeEach(() => setup());

  test("jobsView: missing file → 200 with fileError and no jobs", () => {
    setup({ file: null });
    assert.deepEqual(h.runner.jobsView(), { status: 200, body: { timezone: "Asia/Taipei", fileError: "cron-jobs.json not found", owner: true, jobs: [] } });
  });

  test("jobsView: per-job error, next run, latest run", () => {
    setup({ jobs: [job(), job({ id: "bad", schedule: "nope" }), null] });
    h.runner.trigger("gmail");
    h.state.t += MIN;
    const second = h.runner.trigger("gmail").body.run;
    const { jobs } = h.runner.jobsView().body;
    assert.deepEqual(
      jobs.map((j) => [j.id, j.enabled, j.nextRunAt, j.error?.slice(0, 17) ?? null, j.latestRun?.runId ?? null]),
      [
        ["gmail", true, "2026-01-05T09:00:00.000Z", null, second.runId],
        ["bad", true, null, "schedule must hav", null],
        [null, false, null, "job must be an ob", null],
      ],
    );
  });

  test("runsView: newest first, bounded, only this job, skips junk entries", () => {
    for (let i = 0; i < RUNS_HISTORY_LIMIT + 2; i++) {
      h.state.t = T0 + i * MIN;
      writeExit(h.runner.trigger("gmail").body.run.runId, 0);
    }
    mkdirSync(join(h.runsDir, "not-a-run"));
    mkdirSync(join(h.runsDir, "other-20260105T000000Z-0000"));
    writeFileSync(join(h.runsDir, "other-20260105T000000Z-0000", "run.json"), "{half");
    const runs = runsOf();
    assert.equal(runs.length, RUNS_HISTORY_LIMIT);
    assert.equal(runs[0].createdAt, new Date(T0 + (RUNS_HISTORY_LIMIT + 1) * MIN).toISOString());
    assert.ok(runs.every((r) => r.jobId === "gmail"));
  });

  test("runsView with no runs dir", () => {
    setup({ owner: false });
    assert.deepEqual(h.runner.runsView("gmail"), { status: 200, body: { runs: [] } });
  });
});

describe("runLog", () => {
  beforeEach(() => setup());

  test("rejects malformed and traversal ids before touching the filesystem", () => {
    for (const id of ["../../etc/passwd", "gmail-20260105T000000Z-0000/../x", "x"]) {
      assert.equal(h.runner.runLog(id).status, 400, id);
    }
  });

  test("404 for a well-formed id that is not listed (also with no runs dir)", () => {
    assert.equal(setup({ owner: false }).runner.runLog("gmail-20260105T000000Z-9999").status, 404);
    setup();
    h.runner.trigger("gmail");
    assert.equal(h.runner.runLog("gmail-20260105T000000Z-9999").status, 404);
  });

  test("returns the whole small log", () => {
    const { runId } = h.runner.trigger("gmail").body.run;
    writeFileSync(join(h.runsDir, runId, "out.log"), "hello\n");
    assert.deepEqual(h.runner.runLog(runId).body, { log: "hello\n", truncated: false, error: null, state: "running" });
  });

  test("tails a large log to the last 256 KB", () => {
    const { runId } = h.runner.trigger("gmail").body.run;
    writeFileSync(join(h.runsDir, runId, "out.log"), `${"a".repeat(10)}${"b".repeat(LOG_TAIL_BYTES)}`);
    const body = h.runner.runLog(runId).body;
    assert.equal(body.truncated, true);
    assert.equal(body.log, "b".repeat(LOG_TAIL_BYTES));
  });

  test("serves the log even when run.json is missing or unparsable", () => {
    const id = "gmail-20260105T000000Z-abcd";
    mkdirSync(join(h.runsDir, id), { recursive: true });
    writeFileSync(join(h.runsDir, id, "out.log"), "x");
    assert.deepEqual(h.runner.runLog(id).body, { log: "x", truncated: false, error: null, state: null });
    writeFileSync(join(h.runsDir, id, "run.json"), "{half");
    assert.equal(h.runner.runLog(id).body.log, "x");
  });
});

describe("handle (routing)", () => {
  beforeEach(() => setup());

  test("paths outside /api/cron/ are not handled", () => assert.equal(h.runner.handle("GET", "/api/sessions"), null));

  const cases = [
    { method: "GET", path: "/api/cron/jobs", status: 200 },
    { method: "POST", path: "/api/cron/jobs", status: 405 },
    { method: "POST", path: "/api/cron/jobs/gmail/run", status: 200 },
    { method: "GET", path: "/api/cron/jobs/gmail/run", status: 405 },
    { method: "GET", path: "/api/cron/jobs/gmail/runs", status: 200 },
    { method: "POST", path: "/api/cron/jobs/gmail/runs", status: 405 },
    { method: "GET", path: "/api/cron/runs/gmail-20260105T000000Z-9999/log", status: 404 },
    { method: "GET", path: "/api/cron/runs/%2e%2e%2fx/log", status: 400 },
    { method: "GET", path: "/api/cron/jobs/%E0%A4%A/runs", status: 400 },
    { method: "GET", path: "/api/cron/other", status: 404 },
  ];
  for (const c of cases) test(`${c.method} ${c.path} → ${c.status}`, () => assert.equal(h.runner.handle(c.method, c.path).status, c.status));
});

describe("malformed run records", () => {
  beforeEach(() => setup({ jobs: [job(), job({ id: "other", name: "Other" })] }));

  const plant = (name, content) => {
    mkdirSync(join(h.runsDir, name), { recursive: true });
    writeFileSync(join(h.runsDir, name, "run.json"), content);
  };

  test("parseable but malformed records are ignored (logged once) and do not break jobs, runs or trigger", () => {
    const good = h.runner.trigger("gmail").body.run.runId;
    writeExit(good, 0);
    plant("other-20260105T000000Z-aaa1", "{}");
    plant("other-20260105T000000Z-aaa2", "null");
    plant("other-20260105T000000Z-aaa3", "[1]");
    plant("other-20260105T000000Z-aaa4", JSON.stringify({ runId: "gmail-20260105T000000Z-0000", jobId: "other", state: "running", shellPid: 1, createdAt: "2026-01-05T00:00:00.000Z" }));
    plant("other-20260105T000000Z-aaa5", '"just a string"');
    const jobsRes = h.runner.jobsView();
    assert.equal(jobsRes.status, 200);
    assert.deepEqual(jobsRes.body.jobs.map((j) => j.latestRun?.state ?? null), ["ok", null]);
    assert.equal(h.runner.runsView("other").body.runs.length, 0);
    assert.equal(runsOf().length, 1);
    assert.equal(h.runner.trigger("other").status, 200);
    h.runner.jobsView();
    assert.equal(h.state.logs.length, 5);
    assert.match(h.state.logs[0], /ignoring malformed run record other-20260105T000000Z-aaa\d\/run.json/);
    // the record whose runId points at another directory never redirected a write
    assert.equal(runJson(good).state, "ok");
    assert.equal(JSON.parse(readFileSync(join(h.runsDir, "other-20260105T000000Z-aaa4", "run.json"), "utf-8")).state, "running");
  });
});

describe("max runtime source", () => {
  test("a duplicate id cannot override the valid job's max runtime", () => {
    setup({ jobs: [job({ maxRuntimeMinutes: 600 }), job({ maxRuntimeMinutes: 1 })] });
    const { runId } = h.runner.trigger("gmail").body.run;
    h.state.alive.add(1000);
    h.state.t = T0 + 2 * HOUR;
    h.runner.reconcile();
    assert.equal(runJson(runId).state, "running");
  });

  test("an unusable jobs file skips the max-runtime rule instead of applying the 6 h default", () => {
    setup({ jobs: [job({ maxRuntimeMinutes: 1000 })] });
    const { runId } = h.runner.trigger("gmail").body.run;
    h.state.alive.add(1000);
    writeFileSync(join(h.cronDir, "cron-jobs.json"), "{broken");
    h.state.t = T0 + 7 * HOUR;
    h.runner.reconcile();
    assert.equal(runJson(runId).state, "running");
    h.state.alive.clear(); // other rules still apply
    h.runner.reconcile();
    assert.equal(runJson(runId).state, "unknown");
  });

  test("a job that is now errored skips the rule; a job absent from a valid file gets the default", () => {
    setup({ jobs: [job({ maxRuntimeMinutes: 1000 }), job({ id: "gone", name: "Gone", maxRuntimeMinutes: 1000 })] });
    h.state.alive.add(1000).add(1001);
    const a = h.runner.trigger("gmail").body.run.runId;
    const b = h.runner.trigger("gone").body.run.runId;
    writeFileSync(join(h.cronDir, "cron-jobs.json"), JSON.stringify({ jobs: [job({ prompt: "@now-invalid", maxRuntimeMinutes: 1000 })] }));
    h.state.t = T0 + 7 * HOUR;
    h.runner.reconcile();
    assert.equal(runJson(a).state, "running");
    assert.equal(runJson(b).state, "unknown");
  });
});

describe("run id allocation", () => {
  beforeEach(() => setup());

  test("a colliding run id is regenerated, never reused", () => {
    h.state.hex = ["beef"];
    const first = h.runner.trigger("gmail").body.run.runId;
    writeExit(first, 0);
    h.state.hex = ["beef", "cafe"];
    const second = h.runner.trigger("gmail").body.run.runId;
    assert.equal(first, "gmail-20260105T000000Z-beef");
    assert.equal(second, "gmail-20260105T000000Z-cafe");
    assert.equal(runJson(first).state, "ok");
  });

  test("500 after repeated collisions, existing record untouched", () => {
    h.state.hex = ["beef"];
    const first = h.runner.trigger("gmail").body.run.runId;
    writeExit(first, 0);
    h.state.hex = ["beef", "beef", "beef"];
    assert.deepEqual(h.runner.trigger("gmail"), { status: 500, body: { error: "could not allocate a run id for gmail" } });
    assert.equal(h.state.spawns.length, 1);
    assert.equal(runJson(first).state, "ok");
  });

  test("other mkdir errors propagate", () => {
    chmodSync(h.runsDir, 0o555);
    try {
      assert.throws(() => h.runner.trigger("gmail"), { code: "EACCES" });
    } finally {
      chmodSync(h.runsDir, 0o755);
    }
  });
});

describe("session-file scan", () => {
  beforeEach(() => setup());

  test("not scanned when every run is live or active; scanned once per request otherwise", () => {
    const live = h.runner.trigger("gmail").body.run;
    h.state.live.add(live.sessionId);
    writeExit(live.runId, 0);
    h.state.t += MIN;
    h.runner.trigger("gmail");
    h.state.alive.add(1001); // second run active
    const runs = runsOf();
    assert.deepEqual(runs.map((r) => [r.action, r.hasSessionFile]), [["wait", null], ["select", null]]);
    assert.equal(h.state.fileScans, 0);

    h.state.live.clear();
    h.state.alive.clear();
    h.state.sessionFiles.add(live.sessionId);
    h.state.t += MIN;
    assert.deepEqual(runsOf().map((r) => r.action), ["log", "open"]);
    assert.equal(h.state.fileScans, 1);
  });
});

const lockPid = () => JSON.parse(readFileSync(h.lockFile, "utf-8")).pid;
const runDirs = () => readdirSync(h.runsDir).sort();
const at = (isoString) => Date.parse(isoString);

describe("scheduler lock", () => {
  test("first tick takes the lock without acting; the next tick confirms and heartbeats", () => {
    setup({ owner: false });
    assert.deepEqual(h.runner.tick(), { owner: false });
    assert.equal(lockPid(), 4242);
    assert.equal(h.runner.isOwner(), false);
    assert.match(h.state.logs[0], /took the scheduler lock \(pid 4242\)/);
    h.state.t += MIN;
    assert.equal(h.runner.tick().owner, true);
    assert.equal(statSync(h.lockFile).mtimeMs, h.state.t); // heartbeat in the injected clock
  });

  test("a live, heartbeating lock of another hub is respected; the non-owner retries every tick", () => {
    setup({ owner: false });
    h.state.alive.add(77);
    writeFileSync(h.lockFile, JSON.stringify({ pid: 77, startedAt: "x" }));
    utimesSync(h.lockFile, T0 / 1000, T0 / 1000);
    for (let i = 0; i < 3; i++) {
      h.state.t = T0 + i * MIN;
      assert.equal(h.runner.tick().owner, false);
      assert.equal(lockPid(), 77);
    }
    h.state.alive.delete(77); // owner died
    h.runner.tick();
    assert.equal(lockPid(), 4242);
    assert.equal(h.runner.isOwner(), false);
    assert.equal(h.runner.tick().owner, true);
  });

  test("a live pid with a heartbeat older than 5 ticks is stale (pid reuse after reboot)", () => {
    setup({ owner: false });
    h.state.alive.add(77);
    writeFileSync(h.lockFile, JSON.stringify({ pid: 77 }));
    utimesSync(h.lockFile, T0 / 1000, T0 / 1000);
    h.state.t = T0 + 5 * MIN;
    h.runner.tick();
    assert.equal(lockPid(), 77);
    h.state.t += 1000;
    h.runner.tick();
    assert.equal(lockPid(), 4242);
  });

  test("an unparsable lock is stale", () => {
    setup({ owner: false });
    writeFileSync(h.lockFile, "");
    h.runner.tick();
    assert.equal(lockPid(), 4242);
  });

  test("Run now re-reads the lock: a taken-over owner answers 409 before its next tick", () => {
    setup();
    h.state.alive.add(88);
    writeFileSync(h.lockFile, JSON.stringify({ pid: 88 }));
    assert.deepEqual(h.runner.trigger("gmail"), { status: 409, body: { error: "not the scheduler owner" } });
    assert.equal(h.runner.isOwner(), false);
    assert.equal(h.runner.jobsView().body.owner, false);
    assert.equal(h.state.spawns.length, 0);
    rmSync(h.lockFile);
    assert.equal(h.runner.trigger("gmail").status, 409); // missing lock is not ours either
  });

  test("an owner whose lock was replaced by another pid stops acting (interleaved takeover)", () => {
    setup();
    h.state.alive.add(88);
    writeFileSync(h.lockFile, JSON.stringify({ pid: 88 }));
    utimesSync(h.lockFile, h.state.t / 1000, h.state.t / 1000);
    assert.equal(h.runner.tick().owner, false);
    assert.equal(h.runner.trigger("gmail").status, 409);
  });

  test("losing the exclusive create to another hub", () => {
    setup({ owner: false });
    h.state.alive.add(99);
    const racing = {
      ...realFs,
      writeFileSync: (path, data, opts) => {
        if (opts?.flag === "wx") {
          realFs.writeFileSync(path, JSON.stringify({ pid: 99 })); // the other hub won
          throw Object.assign(new Error("EEXIST"), { code: "EEXIST" });
        }
        return realFs.writeFileSync(path, data, opts);
      },
    };
    const r = h.addRunner(4242, racing);
    assert.equal(r.tick().owner, false);
    assert.equal(lockPid(), 99);
    assert.equal(r.tick().owner, false);
  });

  test("a failing heartbeat touch does not drop ownership", () => {
    setup({ owner: false });
    const r = h.addRunner(4242, { ...realFs, utimesSync: () => { throw new Error("gone"); } });
    r.tick();
    assert.equal(r.tick().owner, true);
  });

  test("release removes only a lock naming this pid", () => {
    setup();
    h.runner.release();
    assert.equal(existsSync(h.lockFile), false);
    assert.doesNotThrow(() => h.runner.release());
    writeFileSync(h.lockFile, JSON.stringify({ pid: 5 }));
    h.runner.release();
    assert.equal(lockPid(), 5);
    // runs in an exit handler: an unlink failure must not throw
    writeFileSync(h.lockFile, JSON.stringify({ pid: 4242 }));
    const r = h.addRunner(4242, { ...realFs, unlinkSync: () => { throw new Error("EPERM"); } });
    assert.doesNotThrow(() => r.release());
  });
});

describe("non-owner API", () => {
  test("Run now is 409, the views are pure reads with owner: false", () => {
    setup();
    const { runId } = h.runner.trigger("gmail").body.run; // shell 1000 not alive, no exit yet
    const before = readFileSync(join(h.runsDir, runId, "run.json"), "utf-8");
    writeExit(runId, 0);
    h.state.alive.add(4242);
    const other = h.addRunner(5151);
    other.tick();
    assert.equal(other.isOwner(), false);
    assert.deepEqual(other.trigger("gmail"), { status: 409, body: { error: "not the scheduler owner" } });
    const view = other.jobsView().body;
    assert.equal(view.owner, false);
    assert.equal(view.jobs[0].latestRun.state, "running"); // shown as is
    assert.equal(other.runsView("gmail").body.runs[0].state, "running");
    assert.equal(readFileSync(join(h.runsDir, runId, "run.json"), "utf-8"), before);
    assert.equal(h.runner.jobsView().body.jobs[0].latestRun.state, "ok"); // the owner reconciles
  });
});

describe("tick: decide and fire", () => {
  test("fires a due slot once, as a schedule run named for its slot", () => {
    setup();
    h.state.t = at("2026-01-05T08:59:00Z");
    assert.deepEqual(h.runner.tick().fired, []);
    h.state.t = at("2026-01-05T09:00:00Z");
    const { fired } = h.runner.tick();
    assert.equal(fired.length, 1);
    const run = runJson(fired[0].runId);
    assert.deepEqual([run.trigger, run.scheduledFor, run.state, run.shellPid, run.name], ["schedule", "2026-01-05T09:00:00.000Z", "running", 1000, "cron: Gmail 2026-01-05 09:00"]);
    h.state.t += MIN;
    assert.deepEqual(h.runner.tick().fired, []);
    assert.equal(h.state.spawns.length, 1);
  });

  test("catch-up inside grace after downtime; a slot past grace is dropped without a record", () => {
    setup();
    h.state.t = at("2026-01-05T20:59:00Z"); // 11:59 after the 09:00 slot, grace 12 h
    const { fired } = h.runner.tick();
    assert.equal(runJson(fired[0].runId).scheduledFor, "2026-01-05T09:00:00.000Z");
    writeExit(fired[0].runId, 0);
    h.state.t = at("2026-01-06T21:00:01Z");
    assert.deepEqual(h.runner.tick().fired, []);
    assert.equal(runDirs().length, 1);
  });

  test("an active run turns the slot into a skipped record, which consumes it", () => {
    setup({ jobs: [job({ maxRuntimeMinutes: 3000 })] });
    h.state.t = at("2026-01-05T09:00:00Z");
    h.runner.tick();
    h.state.alive.add(1000);
    h.state.t = at("2026-01-06T09:00:00Z");
    const { fired } = h.runner.tick();
    assert.deepEqual(fired.map((f) => f.action), ["skip"]);
    const skipped = runJson(fired[0].runId);
    assert.deepEqual([skipped.state, skipped.sessionId, skipped.shellPid, skipped.scheduledFor], ["skipped", null, null, "2026-01-06T09:00:00.000Z"]);
    assert.equal(h.state.spawns.length, 1);
    h.state.alive.clear();
    h.state.t += MIN;
    assert.deepEqual(h.runner.tick().fired, []);
    assert.equal(runsOf().find((r) => r.state === "skipped").action, "log");
  });

  test("a manual run consumes the pending slot", () => {
    setup();
    h.state.t = at("2026-01-05T09:00:00Z") - 1;
    h.runner.tick();
    h.state.t = at("2026-01-05T09:00:30Z");
    writeExit(h.runner.trigger("gmail").body.run.runId, 0);
    h.state.t = at("2026-01-05T09:01:00Z");
    assert.deepEqual(h.runner.tick().fired, []);
  });

  test("since is the baseline: the first owner tick catches up a slot after it", () => {
    setup({ jobs: [job({ since: "2026-01-04T00:00:00Z" })], owner: false });
    h.state.t = at("2026-01-05T10:00:00Z");
    h.runner.tick();
    const { fired } = h.runner.tick();
    assert.equal(runJson(fired[0].runId).scheduledFor, "2026-01-05T09:00:00.000Z");
  });

  test("disabled and invalid jobs are not evaluated; one failing job does not stop the others", () => {
    setup({ jobs: [job({ id: "off", enabled: false }), job({ id: "bad", prompt: "@x" }), job({ id: "boom" }), job()] });
    h.state.t = at("2026-01-05T09:00:00Z");
    mkdirSync(join(h.runsDir, "boom-20260105T090000Z-dead"));
    h.state.hex = ["dead", "dead", "dead"]; // boom cannot allocate a run id
    const { fired } = h.runner.tick();
    assert.deepEqual(fired.map((f) => f.jobId), ["gmail"]);
    assert.match(h.state.logs.find((l) => l.includes("boom")), /boom: tick failed: could not allocate a run id/);
    const view = h.runner.jobsView().body.jobs;
    assert.equal(view.find((j) => j.id === "boom").error, "tick failed: could not allocate a run id");
    assert.equal(view.find((j) => j.id === "gmail").error, null);
  });

  test("the tick-skipped reason is logged once per distinct reason and again after recovery", () => {
    setup({ file: null, owner: false });
    const skips = () => h.state.logs.filter((l) => l.includes("tick skipped"));
    for (let i = 0; i < 4; i++) h.runner.tick(); // the first only takes the lock
    assert.deepEqual(skips(), ["[hub] cron: tick skipped: cron-jobs.json not found"]);
    writeFileSync(join(h.cronDir, "cron-jobs.json"), "{");
    h.runner.tick();
    h.runner.tick();
    assert.equal(skips().length, 2);
    writeFileSync(join(h.cronDir, "cron-jobs.json"), JSON.stringify({ jobs: [] }));
    h.runner.tick();
    rmSync(join(h.cronDir, "cron-jobs.json"));
    h.runner.tick();
    h.runner.tick();
    assert.equal(skips().length, 3);
  });

  test("an unusable jobs file skips decide but keeps the heartbeat and reconcile", () => {
    setup();
    const { runId } = h.runner.trigger("gmail").body.run;
    writeExit(runId, 0);
    writeFileSync(join(h.cronDir, "cron-jobs.json"), "{");
    h.state.t = at("2026-01-05T09:00:00Z");
    const r = h.runner.tick();
    assert.equal(r.owner, true);
    assert.match(r.fileError, /not valid JSON/);
    assert.match(h.state.logs.at(-1), /tick skipped/);
    assert.equal(statSync(h.lockFile).mtimeMs, h.state.t);
    assert.equal(runJson(runId).state, "ok");
  });
});

describe("tick: ok / failed / hung through tick()", () => {
  test("each fired run is finalized by a later tick's reconcile", () => {
    setup({ jobs: [job({ id: "ok" }), job({ id: "fail" }), job({ id: "hung", maxRuntimeMinutes: 30 })] });
    h.state.t = at("2026-01-05T09:00:00Z");
    const ids = Object.fromEntries(h.runner.tick().fired.map((f) => [f.jobId, f.runId]));
    for (const id of Object.values(ids)) h.state.alive.add(runJson(id).shellPid);
    writeExit(ids.ok, 0);
    writeExit(ids.fail, 1);
    h.state.t += MIN;
    h.runner.tick();
    assert.deepEqual([runJson(ids.ok).state, runJson(ids.fail).state, runJson(ids.hung).state], ["ok", "failed", "running"]);
    h.state.t = at("2026-01-05T09:30:00Z") + 1;
    h.runner.tick();
    assert.equal(runJson(ids.hung).state, "unknown");
    assert.equal(runJson(ids.hung).note, "exceeded max runtime");
  });
});

describe("tick: retention", () => {
  test("keeps the newest 30 run directories per job and never an active run", () => {
    setup({ jobs: [job(), job({ id: "other", name: "Other" })] });
    // Planted records: an active run cannot coexist with Run now (409).
    const plant = (jobId, i, extra = {}) => {
      const runId = `${jobId}-20260105T00${String(i).padStart(2, "0")}00Z-0000`;
      mkdirSync(join(h.runsDir, runId));
      const createdAt = new Date(T0 + i * MIN).toISOString();
      writeFileSync(join(h.runsDir, runId, "run.json"), JSON.stringify({ runId, jobId, state: "ok", scheduledFor: createdAt, createdAt, startedAt: createdAt, shellPid: 2000 + i, ...extra }));
      return runId;
    };
    const active = plant("gmail", 0, { state: "running" });
    h.state.alive.add(2000);
    const pruned = [plant("gmail", 1), plant("gmail", 2)];
    for (let i = 3; i < 33; i++) plant("gmail", i);
    plant("other", 0);
    h.state.t = T0 + 40 * MIN;
    assert.deepEqual(h.runner.tick().pruned.sort(), pruned);
    const left = runDirs();
    assert.equal(left.filter((d) => d.startsWith("gmail-")).length, 31);
    assert.ok(left.includes(active));
    assert.equal(left.filter((d) => d.startsWith("other-")).length, 1);
  });

  test("an unknown run older than twice its max runtime is pruned regardless of count", () => {
    setup({ jobs: [job({ maxRuntimeMinutes: 10 })] });
    const { runId } = h.runner.trigger("gmail").body.run;
    h.state.alive.add(1000);
    h.state.t = T0 + 11 * MIN;
    h.runner.tick();
    assert.equal(runJson(runId).state, "unknown");
    h.state.t = T0 + 20 * MIN;
    assert.deepEqual(h.runner.tick().pruned, []);
    h.state.t = T0 + 20 * MIN + 1;
    assert.deepEqual(h.runner.tick().pruned, []); // still the job's newest scheduledFor (baseline)
    h.state.alive.clear();
    writeExit(h.runner.trigger("gmail").body.run.runId, 0); // a newer run takes over as baseline
    h.state.t += MIN;
    assert.deepEqual(h.runner.tick().pruned, [runId]);
    assert.equal(existsSync(join(h.runsDir, runId)), false);
  });

  test("weekly job: the baseline run survives as an expired unknown, so the slot does not fire again in grace", () => {
    // Monday 10:00 weekly: grace 3.5 days, max runtime 6 h (2x = 12 h).
    setup({ jobs: [job({ schedule: "0 10 * * 1" })] });
    // An older expired unknown from the previous week, not the baseline.
    const old = "gmail-20251229T100000Z-0001";
    mkdirSync(join(h.runsDir, old));
    writeFileSync(join(h.runsDir, old, "run.json"), JSON.stringify({ runId: old, jobId: "gmail", state: "unknown", scheduledFor: "2025-12-29T10:00:00.000Z", createdAt: "2025-12-29T10:00:00.000Z", startedAt: "2025-12-29T10:00:00.000Z", shellPid: 7 }));
    h.state.t = at("2026-01-05T10:00:00Z");
    const first = h.runner.tick();
    const { runId } = first.fired[0];
    // The old one was the baseline until this fire; now it is cleared as before.
    assert.deepEqual(first.pruned, [old]);
    h.state.alive.add(1000);
    h.state.t += MIN;
    h.runner.tick();
    h.state.alive.delete(1000); // wrapper killed (Reload all): no exit file
    h.state.t += MIN;
    h.runner.tick();
    assert.equal(runJson(runId).state, "unknown");
    h.state.t = at("2026-01-05T22:00:00Z") + 1; // past 2x max runtime, inside the 3.5-day grace
    const r = h.runner.tick();
    assert.deepEqual(r.pruned, []);
    assert.deepEqual(r.fired, []);
    assert.equal(existsSync(join(h.runsDir, runId)), true);
    h.state.t = at("2026-01-07T10:00:00Z");
    assert.deepEqual(h.runner.tick(), { owner: true, fired: [], pruned: [] });
  });
});

describe("two hubs on one cron dir", () => {
  test("only the owner ticks; after it dies the other takes over without refiring the slot", () => {
    setup({ owner: false });
    const a = h.runner; // pid 4242
    const b = h.addRunner(5151);
    h.state.alive.add(4242).add(5151);
    a.tick();
    b.tick();
    a.tick();
    b.tick();
    assert.deepEqual([a.isOwner(), b.isOwner()], [true, false]);
    h.state.t = at("2026-01-05T09:00:00Z");
    assert.equal(a.tick().fired.length, 1);
    assert.deepEqual(b.tick(), { owner: false });
    h.state.alive.delete(4242); // owner hub killed
    h.state.t += MIN;
    assert.deepEqual(b.tick(), { owner: false }); // takes the lock, does not act yet
    h.state.t += MIN;
    const r = b.tick();
    assert.equal(r.owner, true);
    assert.deepEqual(r.fired, []);
    assert.equal(h.state.spawns.length, 1);
  });

  test("hub restart mid-run: the new process reconciles the run the old one started", () => {
    setup();
    h.state.t = at("2026-01-05T09:00:00Z");
    const { runId } = h.runner.tick().fired[0];
    h.state.alive.add(1000); // the detached wrapper survives the hub
    const restarted = h.addRunner(6161); // old hub pid 4242 is not alive
    h.state.t += MIN;
    restarted.tick();
    writeExit(runId, 0); // the wrapper finishes while the new hub is taking over
    h.state.alive.delete(1000);
    h.state.t += MIN;
    assert.equal(restarted.tick().owner, true);
    assert.equal(runJson(runId).state, "ok");
    assert.equal(h.state.spawns.length, 1);
  });
});

describe("per-run failures do not stop the tick", () => {
  test("an unwritable run record is logged once and the other runs still reconcile", () => {
    setup({ owner: false });
    const blocked = new Set();
    const fs = {
      ...realFs,
      renameSync: (from, to) => {
        if ([...blocked].some((id) => to.includes(id))) throw new Error("EACCES");
        return realFs.renameSync(from, to);
      },
    };
    const r = h.addRunner(4242, fs);
    r.tick();
    r.tick();
    const a = r.trigger("gmail").body.run.runId;
    writeFileSync(join(h.cronDir, "cron-jobs.json"), JSON.stringify({ jobs: [job(), job({ id: "other", name: "Other" })] }));
    const b = r.trigger("other").body.run.runId;
    writeExit(a, 0);
    writeExit(b, 0);
    blocked.add(a);
    h.state.t += MIN;
    assert.equal(r.tick().owner, true);
    h.state.t += MIN;
    r.tick();
    assert.equal(runJson(a).state, "unknown"); // its exit could not be recorded
    assert.equal(runJson(b).state, "ok");
    assert.deepEqual(h.state.logs.filter((l) => l.includes("could not update")), [`[hub] cron: could not update ${a}: EACCES`]);
    blocked.clear();
    r.tick();
    assert.equal(runJson(a).state, "ok");
  });

  test("a run directory that cannot be removed is logged once; the others are pruned", () => {
    setup({ owner: false });
    const blocked = new Set();
    const fs = {
      ...realFs,
      rmSync: (path, opts) => {
        if ([...blocked].some((id) => path.endsWith(id))) throw new Error("EPERM");
        return realFs.rmSync(path, opts);
      },
    };
    const r = h.addRunner(4242, fs);
    r.tick();
    r.tick();
    const ids = [];
    for (let i = 0; i < 33; i++) {
      h.state.t = T0 + i * MIN;
      const { runId } = r.trigger("gmail").body.run;
      writeExit(runId, 0);
      ids.push(runId);
    }
    blocked.add(ids[0]);
    h.state.t += MIN;
    assert.deepEqual(r.tick().pruned, [ids[2], ids[1]]);
    assert.deepEqual(r.tick().pruned, []);
    assert.deepEqual(h.state.logs.filter((l) => l.includes("could not prune")), [`[hub] cron: could not prune ${ids[0]}: EPERM`]);
    assert.equal(existsSync(join(h.runsDir, ids[0])), true);
  });
});
