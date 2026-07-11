/**
 * Tests for session-helpers.js — spawn command construction
 * and dedup logic extracted from index.ts.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buildReloadCommand, buildSpawnCommand, dedupSessions } from "../session-helpers.js";

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
        { label: "has stderr redirect with port prefix", re: /2>&1 1>\/dev\/null \| sed "s\/\^\/\[7331\] \/" >> "\/tmp\/log.stderr.log"/ },
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
        { label: "escaped log", re: /sed "s\/\^\/\[7331\] \/" >> "\/tmp\/\\"log\\".txt"/ },
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
    assert.match(cmd, /2>&1 1>\/dev\/null \| sed "s\/\^\/\[7333\] \/" >> "\/tmp\/bridge.log"/);
    assert.match(cmd, /tail -f \/dev\/null/);
  });

  test("without port uses [new] prefix", () => {
    const cmd = buildSpawnCommand({ logFile: "/tmp/bridge.log" });
    assert.match(cmd, /\[new\]/);
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
