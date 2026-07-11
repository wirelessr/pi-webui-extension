import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { allPidsReplaced, doReloadAll, pickRedirectTarget, reloadAllOutcome } from "../http-bridge-web/sessions.js";

const SESSIONS = [
  { pid: 100, port: 7331, url: "http://192.168.1.130:7331" },
  { pid: 200, port: 7332, url: "http://192.168.1.130:7332" },
  { pid: 300, port: 7333, url: "http://192.168.1.130:7333" },
];

describe("pickRedirectTarget", () => {
  test("returns first session when closing a non-first session", () => {
    const target = pickRedirectTarget(SESSIONS, 200);
    assert.equal(target.pid, 100);
  });

  test("returns first session when closing the first session", () => {
    const target = pickRedirectTarget(SESSIONS, 100);
    assert.equal(target.pid, 200);
  });

  test("returns first remaining when closing middle session", () => {
    const target = pickRedirectTarget(SESSIONS, 300);
    assert.equal(target.pid, 100);
  });

  test("returns null when closing the only session", () => {
    const target = pickRedirectTarget([{ pid: 100, port: 7331 }], 100);
    assert.equal(target, null);
  });

  test("returns null when no sessions exist", () => {
    const target = pickRedirectTarget([], 100);
    assert.equal(target, null);
  });

  test("returns null when pid not in list and list is empty", () => {
    const target = pickRedirectTarget([], 999);
    assert.equal(target, null);
  });

  test("returns the only other session when two exist", () => {
    const target = pickRedirectTarget(
      [
        { pid: 100, port: 7331 },
        { pid: 200, port: 7332 },
      ],
      100,
    );
    assert.equal(target.pid, 200);
  });
});

describe("allPidsReplaced", () => {
  test("returns true when all current PIDs differ from prevPids", () => {
    const prevPids = new Set([100, 200, 300]);
    const current = [
      { pid: 101, port: 7331 },
      { pid: 201, port: 7332 },
      { pid: 301, port: 7333 },
    ];
    assert.equal(allPidsReplaced(current, prevPids), true);
  });

  test("returns false when any current PID matches a prevPid", () => {
    const prevPids = new Set([100, 200, 300]);
    const current = [
      { pid: 101, port: 7331 },
      { pid: 200, port: 7332 },
      { pid: 301, port: 7333 },
    ];
    assert.equal(allPidsReplaced(current, prevPids), false);
  });

  test("returns false when current session list is empty", () => {
    const prevPids = new Set([100]);
    assert.equal(allPidsReplaced([], prevPids), false);
  });

  test("returns true when prevPids is empty and current has sessions", () => {
    const prevPids = new Set();
    const current = [{ pid: 100, port: 7331 }];
    assert.equal(allPidsReplaced(current, prevPids), true);
  });

  test("handles single session replacement", () => {
    const prevPids = new Set([100]);
    assert.equal(allPidsReplaced([{ pid: 101, port: 7331 }], prevPids), true);
    assert.equal(allPidsReplaced([{ pid: 100, port: 7331 }], prevPids), false);
  });

  test("handles partial replacement (some old PIDs remain)", () => {
    const prevPids = new Set([100, 200, 300]);
    const current = [
      { pid: 101, port: 7331 },
      { pid: 200, port: 7332 },
    ];
    assert.equal(allPidsReplaced(current, prevPids), false);
  });
});

describe("reloadAllOutcome", () => {
  test("returns reloadPage when poll succeeded", () => {
    assert.equal(reloadAllOutcome(true), "reloadPage");
  });

  test("returns loadList when poll failed (timeout)", () => {
    assert.equal(reloadAllOutcome(false), "loadList");
  });
});

describe("doReloadAll", () => {
  const makeSessions = (pids) => pids.map((pid, i) => ({ pid, port: 7331 + i, url: `http://localhost:${7331 + i}` }));

  const makeOpts = (overrides = {}) => ({
    sessions: makeSessions([100, 200]),
    confirmFn: () => true,
    reloadSessionFn: async () => {},
    sessionUrlFn: (s) => s.url,
    refreshSessionsFn: async () => makeSessions([101, 201]),
    pollUntilFn: async (fn) => fn(),
    renderFn: () => {},
    loadFn: async () => {},
    reloadPageFn: () => {},
    ...overrides,
  });

  test("no sessions → noop", async () => {
    const opts = makeOpts({ sessions: [] });
    const result = await doReloadAll(opts);
    assert.equal(result.action, "noop");
    assert.equal(result.reason, "no sessions");
  });

  test("user cancels confirm → noop", async () => {
    const opts = makeOpts({ confirmFn: () => false });
    const result = await doReloadAll(opts);
    assert.equal(result.action, "noop");
    assert.equal(result.reason, "user cancelled");
  });

  test("all PIDs replaced → reloadPage", async () => {
    let reloaded = false;
    const opts = makeOpts({
      reloadPageFn: () => { reloaded = true; },
    });
    const result = await doReloadAll(opts);
    assert.equal(result.action, "reloadPage");
    assert.equal(result.reason, "all PIDs replaced");
    assert.equal(reloaded, true);
  });

  test("poll times out (PIDs not replaced) → loadList", async () => {
    let loaded = false;
    const opts = makeOpts({
      refreshSessionsFn: async () => makeSessions([100, 200]), // same PIDs
      pollUntilFn: async () => false, // poll always fails
      loadFn: async () => { loaded = true; },
    });
    const result = await doReloadAll(opts);
    assert.equal(result.action, "loadList");
    assert.equal(result.reason, "poll timed out");
    assert.equal(loaded, true);
  });

  test("calls reloadSessionFn for each session", async () => {
    const reloadedUrls = [];
    const opts = makeOpts({
      reloadSessionFn: async (url) => { reloadedUrls.push(url); },
    });
    await doReloadAll(opts);
    assert.deepEqual(reloadedUrls, ["http://localhost:7331", "http://localhost:7332"]);
  });

  test("partial PID replacement → loadList (poll fails)", async () => {
    const opts = makeOpts({
      refreshSessionsFn: async () => makeSessions([101, 200]), // one replaced, one not
      pollUntilFn: async (fn) => fn(), // run once, returns false
    });
    const result = await doReloadAll(opts);
    assert.equal(result.action, "loadList");
  });

  test("render called when poll succeeds", async () => {
    let rendered = false;
    const opts = makeOpts({
      renderFn: () => { rendered = true; },
    });
    await doReloadAll(opts);
    assert.equal(rendered, true);
  });

  test("reloadSessionFn errors are swallowed (allSettled)", async () => {
    const opts = makeOpts({
      reloadSessionFn: async () => { throw new Error("connection refused"); },
    });
    const result = await doReloadAll(opts);
    // Should not throw — allSettled catches errors
    assert.equal(result.action, "reloadPage");
  });
});
