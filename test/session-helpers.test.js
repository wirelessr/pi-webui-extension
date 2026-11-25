/**
 * Tests for session-helpers.js — spawn command construction
 * and dedup logic extracted from index.ts.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { sessionShellArgv } from "@wirelessr/pi-webui-components/session-spawn.js";
import { buildReloadCommand, dedupSessions, recoverStaleSessions } from "../session-helpers.js";

// ── buildReloadCommand ─────────────────────────────────

describe("buildReloadCommand", () => {
  const baseOpts = { port: 7331, sessionPath: "/tmp/session.jsonl", logFile: "/tmp/log.stderr.log" };

  const cases = [
    {
      desc: "with name includes --name flag",
      opts: { ...baseOpts, name: "my-session" },
      checks: [
        { label: "has --name", re: /--name 'my-session'/ },
        { label: "has --session", re: /--session '\/tmp\/session.jsonl'/ },
        { label: "has port env", re: /PI_HTTP_PORT=7331/ },
        { label: "has stderr redirect with port prefix", re: /2>&1 1>\/dev\/null \| sed -u "s\/\^\/\[7331\] \/" >> '\/tmp\/log.stderr.log'/ },
        { label: "has tail keepalive", re: /tail -f \/dev\/null/ },
      ],
    },
    {
      desc: "without name omits --name flag",
      opts: { ...baseOpts, name: undefined },
      checks: [
        { label: "no --name", re: /^((?!--name).)*$/s },
        { label: "has --session", re: /--session '\/tmp\/session.jsonl'/ },
      ],
    },
    {
      desc: "empty string name omits --name flag",
      opts: { ...baseOpts, name: "" },
      checks: [
        { label: "no --name", re: /^((?!--name).)*$/s },
      ],
    },
    {
      desc: "name with double quotes is single-quoted verbatim",
      opts: { ...baseOpts, name: 'he said "hi"' },
      checks: [
        { label: "single-quoted", re: /--name 'he said "hi"'/ },
      ],
    },
    {
      desc: "sessionPath with double quotes is single-quoted verbatim",
      opts: { ...baseOpts, name: undefined, sessionPath: '/tmp/"weird".jsonl' },
      checks: [
        { label: "verbatim path", re: /--session '\/tmp\/"weird".jsonl'/ },
      ],
    },
    {
      desc: "logFile with double quotes is single-quoted verbatim",
      opts: { ...baseOpts, name: undefined, logFile: '/tmp/"log".txt' },
      checks: [
        { label: "verbatim log", re: /sed -u "s\/\^\/\[7331\] \/" >> '\/tmp\/"log".txt'/ },
      ],
    },
    {
      desc: "a single quote in the path or log is closed, escaped and reopened",
      opts: { ...baseOpts, name: undefined, sessionPath: "/tmp/it's.jsonl", logFile: "/tmp/it's.log" },
      checks: [
        { label: "path", re: /--session '\/tmp\/it'\\''s.jsonl'/ },
        { label: "log", re: />> '\/tmp\/it'\\''s.log'/ },
      ],
    },
  ];

  for (const { desc, opts, checks } of cases) {
    test(desc, () => {
      const cmd = buildReloadCommand(opts);
      for (const { label, re } of checks) {
        assert.match(cmd, re, `${label} failed in: ${cmd}`);
      }
    });
  }
});

// ── buildSpawnCommand ─────────────────────────────────

// buildSpawnCommand / buildOpenSessionCommand moved to the shared
// @wirelessr/pi-webui-components/session-spawn.js and are tested there.

// ── dedupSessions ──────────────────────────────────────

describe("dedupSessions", () => {
  function makeSession(port, pid, sessionFile, startedAt, sessionId) {
    return { port, pid, sessionFile, startedAt, sessionId: sessionId || `sid-${pid}` };
  }

  function mockDeps() {
    const calls = { unlink: [], killGroup: [], kill: [], log: [] };
    return {
      calls,
      unlinkFn: (name) => calls.unlink.push(name),
      killGroupFn: (pid) => { calls.killGroup.push(pid); return true; },
      killFn: (pid) => { calls.kill.push(pid); },
      logFn: (msg) => calls.log.push(msg),
    };
  }

  test("no duplicates returns all sorted by port", () => {
    const sessions = [
      makeSession(7335, 200, "/tmp/b.jsonl", 2),
      makeSession(7333, 100, "/tmp/a.jsonl", 1),
    ];
    const deps = mockDeps();
    const result = dedupSessions({ sessions, ...deps });
    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0].port, 7333);
    assert.strictEqual(result[1].port, 7335);
    assert.strictEqual(deps.calls.unlink.length, 0);
    assert.strictEqual(deps.calls.killGroup.length, 0);
  });

  test("duplicates by sessionFile keep newest", () => {
    const sessions = [
      makeSession(7333, 100, "/tmp/a.jsonl", 1),
      makeSession(7334, 101, "/tmp/a.jsonl", 2), // newer, same file
    ];
    const deps = mockDeps();
    const result = dedupSessions({ sessions, ...deps });
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].pid, 101);
    assert.strictEqual(deps.calls.unlink.length, 1);
    assert.strictEqual(deps.calls.unlink[0], "sid-100.json");
    assert.strictEqual(deps.calls.killGroup.length, 1);
    assert.strictEqual(deps.calls.killGroup[0], 100);
    assert.strictEqual(deps.calls.kill.length, 0);
  });

  test("loser kill falls back to direct kill when group kill fails", () => {
    const sessions = [
      makeSession(7333, 100, "/tmp/a.jsonl", 2),
      makeSession(7334, 101, "/tmp/a.jsonl", 1), // older, loser
    ];
    const deps = mockDeps();
    deps.killGroupFn = (pid) => { calls.killGroup.push(pid); return false; };
    const { calls } = deps;
    const result = dedupSessions({ sessions, ...deps });
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].pid, 100);
    assert.strictEqual(calls.killGroup.length, 1);
    assert.strictEqual(calls.killGroup[0], 101);
    assert.strictEqual(calls.kill.length, 1);
    assert.strictEqual(calls.kill[0], 101);
  });

  test("dedup by sessionId when sessionFile is null", () => {
    const sessions = [
      { port: 7333, pid: 100, sessionFile: null, sessionId: "sid-x", startedAt: 1 },
      { port: 7334, pid: 101, sessionFile: null, sessionId: "sid-x", startedAt: 2 },
    ];
    const deps = mockDeps();
    const result = dedupSessions({ sessions, ...deps });
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].pid, 101);
  });

  test("startedAt 0 vs undefined: 0 wins", () => {
    const sessions = [
      makeSession(7333, 100, "/tmp/a.jsonl", 0),
      makeSession(7334, 101, "/tmp/a.jsonl", undefined),
    ];
    const deps = mockDeps();
    const result = dedupSessions({ sessions, ...deps });
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].pid, 100);
  });

  test("empty sessions returns empty array", () => {
    const deps = mockDeps();
    const result = dedupSessions({ sessions: [], ...deps });
    assert.strictEqual(result.length, 0);
    assert.strictEqual(deps.calls.unlink.length, 0);
  });

  test("logs each loser kill", () => {
    const sessions = [
      makeSession(7333, 100, "/tmp/a.jsonl", 3),
      makeSession(7334, 101, "/tmp/a.jsonl", 1),
      makeSession(7335, 102, "/tmp/a.jsonl", 2),
    ];
    const deps = mockDeps();
    const result = dedupSessions({ sessions, ...deps });
    assert.strictEqual(result.length, 1);
    assert.strictEqual(deps.calls.log.length, 2);
    assert.ok(deps.calls.log[0].includes("pid=101"));
    assert.ok(deps.calls.log[1].includes("pid=102"));
  });
});

// ── recoverStaleSessions ──────────────────────────────

describe("recoverStaleSessions", () => {
  // Build injected deps over an in-memory discovery-file store.
  function mockDeps(store, { alivePids = [], ownSessionId, existingSessionFiles, claimWinner = () => true } = {}) {
    const calls = { opened: [], deleted: [], released: [], claimed: [], log: [] };
    const claimed = new Set();
    return {
      calls,
      listDiscoveryFiles: () => Object.keys(store),
      readDiscovery: (file) => store[file] ?? null,
      isPidAlive: (pid) => alivePids.includes(pid),
      ownSessionId,
      // Default: every referenced session file exists unless a set is given.
      sessionFileExists: (p) => (existingSessionFiles ? existingSessionFiles.includes(p) : true),
      claimFn: (file) => {
        calls.claimed.push(file);
        if (claimed.has(file) || !claimWinner(file)) return false;
        claimed.add(file);
        return true;
      },
      releaseClaimFn: (file) => calls.released.push(file),
      deleteDiscoveryFn: (file) => calls.deleted.push(file),
      openSessionFn: (sid, name, cwd) => calls.opened.push({ sid, name, cwd }),
      logFn: (msg) => calls.log.push(msg),
    };
  }

  test("recovers a stale session whose process is dead", () => {
    const store = {
      "s1.json": { pid: 100, sessionId: "s1", sessionName: "one", cwd: "/a", sessionFile: "/f1" },
    };
    const deps = mockDeps(store, { alivePids: [] });
    const recovered = recoverStaleSessions(deps);
    assert.deepEqual(recovered, ["s1"]);
    assert.deepEqual(deps.calls.opened, [{ sid: "s1", name: "one", cwd: "/a" }]);
    assert.deepEqual(deps.calls.released, ["s1.json"]);
    assert.equal(deps.calls.deleted.length, 0);
  });

  test("skips sessions whose process is still alive", () => {
    const store = { "s1.json": { pid: 100, sessionId: "s1", sessionFile: "/f1" } };
    const deps = mockDeps(store, { alivePids: [100] });
    const recovered = recoverStaleSessions(deps);
    assert.deepEqual(recovered, []);
    assert.equal(deps.calls.opened.length, 0);
    assert.equal(deps.calls.claimed.length, 0);
  });

  test("deletes own stale discovery file without recovering", () => {
    const store = { "self.json": { pid: 100, sessionId: "me", sessionFile: "/f1" } };
    const deps = mockDeps(store, { alivePids: [], ownSessionId: "me" });
    const recovered = recoverStaleSessions(deps);
    assert.deepEqual(recovered, []);
    assert.deepEqual(deps.calls.deleted, ["self.json"]);
    assert.equal(deps.calls.opened.length, 0);
  });

  test("deletes stale file when its session file no longer exists", () => {
    const store = { "s1.json": { pid: 100, sessionId: "s1", sessionFile: "/gone" } };
    const deps = mockDeps(store, { alivePids: [], existingSessionFiles: [] });
    const recovered = recoverStaleSessions(deps);
    assert.deepEqual(recovered, []);
    assert.deepEqual(deps.calls.deleted, ["s1.json"]);
    assert.equal(deps.calls.opened.length, 0);
  });

  test("does not recover when the claim is lost (race)", () => {
    const store = { "s1.json": { pid: 100, sessionId: "s1", sessionFile: "/f1" } };
    const deps = mockDeps(store, { alivePids: [], claimWinner: () => false });
    const recovered = recoverStaleSessions(deps);
    assert.deepEqual(recovered, []);
    assert.deepEqual(deps.calls.claimed, ["s1.json"]);
    assert.equal(deps.calls.opened.length, 0);
    assert.equal(deps.calls.released.length, 0);
  });

  test("ignores unreadable/corrupt discovery files", () => {
    const store = { "bad.json": null, "s2.json": { pid: 100, sessionId: "s2", sessionFile: "/f2" } };
    const deps = mockDeps(store, { alivePids: [] });
    const recovered = recoverStaleSessions(deps);
    assert.deepEqual(recovered, ["s2"]);
  });

  test("processes multiple stale sessions", () => {
    const store = {
      "s1.json": { pid: 100, sessionId: "s1", sessionFile: "/f1" },
      "s2.json": { pid: 101, sessionId: "s2", sessionFile: "/f2" },
    };
    const deps = mockDeps(store, { alivePids: [] });
    const recovered = recoverStaleSessions(deps);
    assert.deepEqual(recovered.sort(), ["s1", "s2"]);
    assert.equal(deps.calls.opened.length, 2);
  });
});

// Run a session command string for real through the shell sessionShellArgv
// picks, with stubs for `tail` (exits at once instead of blocking), `sleep`
// and `pi` (one line to stdout, one to stderr) first on PATH and an isolated
// ZDOTDIR (the user's own ~/.zshenv is never read). The command routes pi's
// stderr to the log and must discard its stdout (the RPC event stream).
// logDir is a directory name created under the temp dir to hold the log (any
// name, e.g. hostile ones); inspect(dir) runs before the temp dir is deleted
// and, when given, the result is { log, inspected }.
function runSessionCommand(build, { shell, zshenv = "", piBody = "echo STDOUT-EVENT-STREAM; echo STDERR-LINE >&2", logDir, inspect }) {
  const dir = mkdtempSync(join(tmpdir(), "session-cmd-"));
  try {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    for (const [name, body] of [["tail", "exit 0"], ["sleep", "exit 0"], ["pi", piBody]]) {
      writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
      chmodSync(join(bin, name), 0o755);
    }
    writeFileSync(join(dir, ".zshenv"), zshenv);
    if (logDir) mkdirSync(join(dir, logDir));
    const logFile = join(dir, logDir ?? "", "session.log");
    const deps = shell === "sh" ? { isExecutable: () => false } : {};
    const argv = sessionShellArgv(build(logFile), deps);
    assert.equal(argv[0], shell);
    const r = spawnSync(argv[0], argv.slice(1), { cwd: dir, env: { PATH: `${bin}:${process.env.PATH}`, ZDOTDIR: dir, HOME: dir }, encoding: "utf-8", timeout: 15000 });
    assert.equal(r.status, 0, r.stderr);
    const log = readFileSync(logFile, "utf-8");
    return inspect ? { log, inspected: inspect(dir) } : log;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const HAS_ZSH = spawnSync("zsh", ["-c", "true"]).status === 0;

describe("buildReloadCommand under the chosen shell: pi's stdout never reaches the log", () => {
  const build = (logFile) => buildReloadCommand({ port: 7999, sessionPath: "/s.jsonl", name: "n", logFile });
  const shells = [
    { shell: "sh", label: "sh" },
    { shell: "zsh", label: "zsh (MULTIOS on by default)" },
    { shell: "zsh", label: "zsh with setopt multios in .zshenv", zshenv: "setopt multios\n" },
    { shell: "zsh", label: "zsh with setopt noclobber in .zshenv, log not created yet", zshenv: "setopt noclobber\n" },
  ];
  for (const c of shells) {
    const skip = c.shell === "zsh" && !HAS_ZSH && "zsh not installed";
    test(`reload via ${c.label}`, { skip }, () => {
      assert.equal(runSessionCommand(build, c), "[7999] STDERR-LINE\n");
    });
  }
});

describe("buildReloadCommand --name reaches pi verbatim (no shell expansion)", () => {
  // the stub pi echoes its --name argument to stderr, which the command logs
  const piBody = 'while [ $# -gt 0 ]; do [ "$1" = --name ] && printf "%s\\n" "$2" >&2; shift; done';
  const names = ["a $(echo EXPANDED) b", "back `echo EXPANDED` tick", "it's here", "trailing\\", `mixed '"$HOME"' \\ end`];
  for (const shell of ["sh", "zsh"]) {
    for (const name of names) {
      const skip = shell === "zsh" && !HAS_ZSH && "zsh not installed";
      test(`${shell}: ${JSON.stringify(name)}`, { skip }, () => {
        const log = runSessionCommand((logFile) => buildReloadCommand({ port: 7999, sessionPath: "/s.jsonl", name, logFile }), { shell, piBody });
        assert.equal(log, `[7999] ${name}\n`);
      });
    }
  }
});

// The session path and the log path reach the shell as source: the stub pi
// prints the path it received and nothing in either value may be expanded or run.
describe("buildReloadCommand --session and the log path are shell-safe", () => {
  const values = [
    "a $(echo EXPANDED) b",
    "back `echo EXPANDED` tick",
    "$HOME",
    `mixed '"$HOME"' \\ end`,
    "trailing\\",
    'a\\"b',
    "it's here",
    'with "double" quotes',
    "two  spaces",
    "/plain/path.jsonl",
  ];
  const logDir = "h $(touch M1) `touch M2` it's \"q\"";
  const piBody = 'while [ $# -gt 0 ]; do [ "$1" = --session ] && printf "%s\\n" "$2" >&2; shift; done';
  for (const shell of ["sh", "zsh"]) {
    const skip = shell === "zsh" && !HAS_ZSH && "zsh not installed";
    for (const sessionPath of values) {
      test(`${shell} path: ${JSON.stringify(sessionPath)}`, { skip }, () => {
        const log = runSessionCommand((logFile) => buildReloadCommand({ port: 7999, sessionPath, name: "n", logFile }), { shell, piBody });
        assert.equal(log, `[7999] ${sessionPath}\n`);
      });
    }
    test(`${shell} log path: hostile directory name`, { skip }, () => {
      const { log, inspected } = runSessionCommand((logFile) => buildReloadCommand({ port: 7999, sessionPath: "/s.jsonl", name: "n", logFile }), {
        shell,
        piBody,
        logDir,
        inspect: (dir) => ["M1", "M2"].filter((m) => existsSync(join(dir, m))),
      });
      assert.equal(log, "[7999] /s.jsonl\n");
      assert.deepEqual(inspected, []);
    });
  }
});
