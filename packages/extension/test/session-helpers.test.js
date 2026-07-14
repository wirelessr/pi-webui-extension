/**
 * Tests for session-helpers.js — spawn command construction
 * and dedup logic extracted from index.ts.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buildOpenSessionCommand, buildReloadCommand, buildSpawnCommand, dedupSessions, recoverStaleSessions } from "../session-helpers.js";

// ── buildReloadCommand ─────────────────────────────────

describe("buildReloadCommand", () => {
  const baseOpts = { port: 7331, sessionPath: "/tmp/session.jsonl", logFile: "/tmp/log.stderr.log" };

  const cases = [
    {
      desc: "with name includes --name flag",
      opts: { ...baseOpts, name: "my-session" },
      checks: [
        { label: "has --name", re: /--name "my-session"/ },
        { label: "has --session", re: /--session "\/tmp\/session.jsonl"/ },
        { label: "has port env", re: /PI_HTTP_PORT=7331/ },
        { label: "has stderr redirect with port prefix", re: /2>&1 1>\/dev\/null \| sed -u "s\/\^\/\[7331\] \/" >> "\/tmp\/log.stderr.log"/ },
        { label: "has tail keepalive", re: /tail -f \/dev\/null/ },
      ],
    },
    {
      desc: "without name omits --name flag",
      opts: { ...baseOpts, name: undefined },
      checks: [
        { label: "no --name", re: /^((?!--name).)*$/s },
        { label: "has --session", re: /--session "\/tmp\/session.jsonl"/ },
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
      desc: "name with double quotes is escaped",
      opts: { ...baseOpts, name: 'he said "hi"' },
      checks: [
        { label: "escaped quotes", re: /--name "he said \\"hi\\""/ },
      ],
    },
    {
      desc: "sessionPath with double quotes is escaped",
      opts: { ...baseOpts, name: undefined, sessionPath: '/tmp/"weird".jsonl' },
      checks: [
        { label: "escaped path", re: /--session "\/tmp\/\\"weird\\".jsonl"/ },
      ],
    },
    {
      desc: "logFile with double quotes is escaped",
      opts: { ...baseOpts, name: undefined, logFile: '/tmp/"log".txt' },
      checks: [
        { label: "escaped log", re: /sed -u "s\/\^\/\[7331\] \/" >> "\/tmp\/\\"log\\".txt"/ },
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

describe("buildSpawnCommand", () => {
  test("includes pi --mode rpc and stderr redirect with prefix", () => {
    const cmd = buildSpawnCommand({ logFile: "/tmp/bridge.log", port: 7333 });
    assert.match(cmd, /pi --mode rpc/);
    assert.match(cmd, /2>&1 1>\/dev\/null \| sed -u "s\/\^\/\[7333\] \/" >> "\/tmp\/bridge.log"/);
    assert.match(cmd, /tail -f \/dev\/null/);
  });

  test("without port uses [new] prefix", () => {
    const cmd = buildSpawnCommand({ logFile: "/tmp/bridge.log" });
    assert.match(cmd, /\[new\]/);
  });
});

// ── buildOpenSessionCommand ──────────────────────────

describe("buildOpenSessionCommand", () => {
  test("includes pi --mode rpc --session with ID", () => {
    const cmd = buildOpenSessionCommand({ sessionId: "019f5aad-7e4d-7c78-b0b9-831ae740d081", logFile: "/tmp/bridge.log" });
    assert.match(cmd, /pi --mode rpc/);
    assert.match(cmd, /--session "019f5aad-7e4d-7c78-b0b9-831ae740d081"/);
    assert.match(cmd, /tail -f \/dev\/null/);
    assert.match(cmd, /\[new\]/);
  });

  test("includes --name when name is provided", () => {
    const cmd = buildOpenSessionCommand({ sessionId: "abc-123", name: "my session", logFile: "/tmp/bridge.log" });
    assert.match(cmd, /--name "my session"/);
  });

  test("omits --name when name is not provided", () => {
    const cmd = buildOpenSessionCommand({ sessionId: "abc-123", logFile: "/tmp/bridge.log" });
    assert.doesNotMatch(cmd, /--name/);
  });

  test("escapes double quotes in sessionId", () => {
    const cmd = buildOpenSessionCommand({ sessionId: 'test"quote', logFile: "/tmp/bridge.log" });
    assert.match(cmd, /--session "test\\"quote"/);
  });

  test("escapes double quotes in name", () => {
    const cmd = buildOpenSessionCommand({ sessionId: "abc", name: 'name"quote', logFile: "/tmp/bridge.log" });
    assert.match(cmd, /--name "name\\"quote"/);
  });
});

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
