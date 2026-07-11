import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { allPidsReplaced, doCloseSession, doNewSession, doReloadAll, doRenameSession, pickRedirectTarget, reloadAllOutcome } from "../http-bridge-web/sessions.js";

const SESSIONS = [
  { pid: 100, port: 7331, url: "http://192.168.1.130:7331" },
  { pid: 200, port: 7332, url: "http://192.168.1.130:7332" },
  { pid: 300, port: 7333, url: "http://192.168.1.130:7333" },
];

describe("pickRedirectTarget", () => {
  const cases = [
    { name: "returns first session when closing a non-first session", sessions: SESSIONS, closedPid: 200, expectedPid: 100 },
    { name: "returns first session when closing the first session", sessions: SESSIONS, closedPid: 100, expectedPid: 200 },
    { name: "returns first remaining when closing middle session", sessions: SESSIONS, closedPid: 300, expectedPid: 100 },
    { name: "returns null when closing the only session", sessions: [{ pid: 100, port: 7331 }], closedPid: 100, expectedPid: null },
    { name: "returns null when no sessions exist", sessions: [], closedPid: 100, expectedPid: null },
    { name: "returns null when pid not in list and list is empty", sessions: [], closedPid: 999, expectedPid: null },
    {
      name: "returns the only other session when two exist",
      sessions: [
        { pid: 100, port: 7331 },
        { pid: 200, port: 7332 },
      ],
      closedPid: 100,
      expectedPid: 200,
    },
  ];
  for (const c of cases) {
    test(c.name, () => {
      const target = pickRedirectTarget(c.sessions, c.closedPid);
      assert.equal(target?.pid ?? null, c.expectedPid);
    });
  }
});

describe("allPidsReplaced", () => {
  const cases = [
    {
      name: "returns true when all current PIDs differ from prevPids",
      current: [
        { pid: 101, port: 7331 },
        { pid: 201, port: 7332 },
        { pid: 301, port: 7333 },
      ],
      prevPids: new Set([100, 200, 300]),
      expected: true,
    },
    {
      name: "returns false when any current PID matches a prevPid",
      current: [
        { pid: 101, port: 7331 },
        { pid: 200, port: 7332 },
        { pid: 301, port: 7333 },
      ],
      prevPids: new Set([100, 200, 300]),
      expected: false,
    },
    {
      name: "returns false when current session list is empty",
      current: [],
      prevPids: new Set([100]),
      expected: false,
    },
    {
      name: "returns true when prevPids is empty and current has sessions",
      current: [{ pid: 100, port: 7331 }],
      prevPids: new Set(),
      expected: true,
    },
    {
      name: "handles single session replacement (new PID)",
      current: [{ pid: 101, port: 7331 }],
      prevPids: new Set([100]),
      expected: true,
    },
    {
      name: "handles single session replacement (same PID)",
      current: [{ pid: 100, port: 7331 }],
      prevPids: new Set([100]),
      expected: false,
    },
    {
      name: "handles partial replacement (some old PIDs remain)",
      current: [
        { pid: 101, port: 7331 },
        { pid: 200, port: 7332 },
      ],
      prevPids: new Set([100, 200, 300]),
      expected: false,
    },
  ];
  for (const c of cases) {
    test(c.name, () => {
      assert.equal(allPidsReplaced(c.current, c.prevPids), c.expected);
    });
  }
});

describe("reloadAllOutcome", () => {
  const cases = [
    { name: "returns reloadPage when poll succeeded", input: true, expected: "reloadPage" },
    { name: "returns loadList when poll failed (timeout)", input: false, expected: "loadList" },
  ];
  for (const c of cases) {
    test(c.name, () => {
      assert.equal(reloadAllOutcome(c.input), c.expected);
    });
  }
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

// ── doNewSession ──────────────────────────────────────

describe("doNewSession", () => {
  const makeOpts = (overrides = {}) => ({
    prevCount: 1,
    newSessionFn: async () => {},
    refreshSessionsFn: async () => SESSIONS,
    pollUntilFn: async (fn) => fn(),
    renderFn: () => {},
    ...overrides,
  });

  test("new session detected → rendered", async () => {
    let rendered = false;
    const opts = makeOpts({
      prevCount: 2,
      refreshSessionsFn: async () => SESSIONS, // 3 sessions > prevCount 2
      renderFn: () => { rendered = true; },
    });
    const result = await doNewSession(opts);
    assert.equal(result.action, "rendered");
    assert.equal(rendered, true);
  });

  test("poll timeout → showError", async () => {
    const opts = makeOpts({
      prevCount: 3, // same as SESSIONS.length, no growth
      pollUntilFn: async () => false,
    });
    const result = await doNewSession(opts);
    assert.equal(result.action, "showError");
    assert.match(result.reason, /not detected/);
  });

  test("newSessionFn throws → showError with message", async () => {
    const opts = makeOpts({
      newSessionFn: async () => { throw new Error("spawn failed"); },
    });
    const result = await doNewSession(opts);
    assert.equal(result.action, "showError");
    assert.match(result.reason, /spawn failed/);
  });
});

// ── doCloseSession ────────────────────────────────────

describe("doCloseSession", () => {
  const TARGET_SESSION = SESSIONS[1]; // pid 200

  const makeOpts = (overrides = {}) => ({
    sessions: SESSIONS,
    session: TARGET_SESSION,
    confirmFn: () => true,
    killSessionFn: async () => {},
    sessionUrlFn: (s) => s.url,
    getCurrentPortFn: () => 7331, // not the target session's port
    refreshSessionsFn: async () => SESSIONS.filter((s) => s.pid !== 200),
    pollUntilFn: async (fn) => fn(),
    renderFn: () => {},
    loadFn: async () => {},
    redirectFn: () => {},
    ...overrides,
  });

  test("user cancels confirm → noop", async () => {
    const opts = makeOpts({ confirmFn: () => false });
    const result = await doCloseSession(opts);
    assert.equal(result.action, "noop");
  });

  test("only one session → showError", async () => {
    const opts = makeOpts({
      sessions: [{ pid: 100, port: 7331 }],
      session: { pid: 100, port: 7331 },
    });
    const result = await doCloseSession(opts);
    assert.equal(result.action, "showError");
    assert.match(result.reason, /last session/);
  });

  test("close non-current → poll until gone → rendered", async () => {
    let rendered = false;
    const opts = makeOpts({
      renderFn: () => { rendered = true; },
    });
    const result = await doCloseSession(opts);
    assert.equal(result.action, "rendered");
    assert.equal(rendered, true);
  });

  test("close current session → redirect to other", async () => {
    let redirectUrl = null;
    const opts = makeOpts({
      session: SESSIONS[0], // pid 100, port 7331
      getCurrentPortFn: () => 7331,
      redirectFn: (url) => { redirectUrl = url; },
    });
    const result = await doCloseSession(opts);
    assert.equal(result.action, "redirect");
    assert.equal(redirectUrl, "http://192.168.1.130:7332");
  });

  test("close current session, no other available → showError", async () => {
    const opts = makeOpts({
      sessions: [{ pid: 100, port: 7331 }],
      session: { pid: 100, port: 7331 },
      getCurrentPortFn: () => 7331,
    });
    const result = await doCloseSession(opts);
    assert.equal(result.action, "showError");
  });

  test("killSessionFn throws → showError", async () => {
    const opts = makeOpts({
      killSessionFn: async () => { throw new Error("kill failed"); },
    });
    const result = await doCloseSession(opts);
    assert.equal(result.action, "showError");
    assert.match(result.reason, /kill failed/);
  });

  test("poll timeout → loadList", async () => {
    let loaded = false;
    const opts = makeOpts({
      refreshSessionsFn: async () => SESSIONS, // session still there
      pollUntilFn: async () => false,
      loadFn: async () => { loaded = true; },
    });
    const result = await doCloseSession(opts);
    assert.equal(result.action, "loadList");
    assert.equal(loaded, true);
  });
});

// ── doRenameSession ───────────────────────────────────

describe("doRenameSession", () => {
  const SESSION = { pid: 100, port: 7331, url: "http://localhost:7331", sessionName: "old-name", sessionId: "abc123" };

  const makeOpts = (overrides = {}) => ({
    session: SESSION,
    newName: "new-name",
    currentName: "old-name",
    renameSessionFn: async () => {},
    sessionUrlFn: (s) => s.url,
    refreshSessionsFn: async () => [{ ...SESSION, sessionName: "new-name" }],
    pollUntilFn: async (fn) => fn(),
    renderFn: () => {},
    ...overrides,
  });

  test("name unchanged → rendered (no API call)", async () => {
    let called = false;
    const opts = makeOpts({
      newName: "old-name",
      renameSessionFn: async () => { called = true; },
    });
    const result = await doRenameSession(opts);
    assert.equal(result.action, "rendered");
    assert.equal(result.reason, "no change");
    assert.equal(called, false);
  });

  test("empty name → rendered (no API call)", async () => {
    let called = false;
    const opts = makeOpts({
      newName: "",
      renameSessionFn: async () => { called = true; },
    });
    const result = await doRenameSession(opts);
    assert.equal(result.action, "rendered");
    assert.equal(called, false);
  });

  test("rename succeeds → name updated", async () => {
    let rendered = false;
    const opts = makeOpts({
      renderFn: () => { rendered = true; },
    });
    const result = await doRenameSession(opts);
    assert.equal(result.action, "rendered");
    assert.equal(result.reason, "name updated");
    assert.equal(rendered, true);
  });

  test("poll timeout → still renders", async () => {
    let rendered = false;
    const opts = makeOpts({
      pollUntilFn: async () => false,
      renderFn: () => { rendered = true; },
    });
    const result = await doRenameSession(opts);
    assert.equal(result.action, "rendered");
    assert.match(result.reason, /timed out/);
    assert.equal(rendered, true);
  });

  test("renameSessionFn throws → showError", async () => {
    const opts = makeOpts({
      renameSessionFn: async () => { throw new Error("name too long"); },
    });
    const result = await doRenameSession(opts);
    assert.equal(result.action, "showError");
    assert.match(result.reason, /name too long/);
  });
});
