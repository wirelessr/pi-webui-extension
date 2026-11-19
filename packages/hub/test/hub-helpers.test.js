import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buildSessionList, diffBusyTransitions, parseProxyPath, pickSession, updateUnread } from "../src/hub-helpers.js";

describe("parseProxyPath", () => {
  const cases = [
    { url: "/s/abc/api/status", expected: { sessionId: "abc", rest: "/api/status" } },
    { url: "/s/abc/api/prompt?x=1", expected: { sessionId: "abc", rest: "/api/prompt?x=1" } },
    { url: "/s/abc", expected: { sessionId: "abc", rest: "/" } },
    { url: "/s/abc/", expected: { sessionId: "abc", rest: "/" } },
    { url: "/s/019f-77%2Fweird/api", expected: { sessionId: "019f-77/weird", rest: "/api" } },
    { url: "/api/sessions", expected: null },
    { url: "/app.js", expected: null },
    { url: "/", expected: null },
  ];
  for (const c of cases) {
    test(c.url, () => assert.deepEqual(parseProxyPath(c.url), c.expected));
  }
});

describe("pickSession", () => {
  const sessions = [{ sessionId: "a" }, { sessionId: "b" }];
  test("finds by id", () => assert.equal(pickSession(sessions, "b").sessionId, "b"));
  test("null when absent", () => assert.equal(pickSession(sessions, "z"), null));
});

describe("buildSessionList", () => {
  const alive = (pid) => pid === 100 || pid === 101 || pid === 103;

  test("keeps only live pids", () => {
    const list = buildSessionList(
      [
        { sessionId: "a", pid: 100, port: 7331 },
        { sessionId: "b", pid: 999, port: 7332 }, // dead
      ],
      alive,
    );
    assert.deepEqual(list.map((s) => s.sessionId), ["a"]);
  });

  test("dedupes by sessionId keeping newest startedAt", () => {
    const list = buildSessionList(
      [
        { sessionId: "a", pid: 100, port: 7331, startedAt: 1, sessionName: "old" },
        { sessionId: "a", pid: 101, port: 7333, startedAt: 5, sessionName: "new" },
      ],
      alive,
    );
    assert.equal(list.length, 1);
    assert.equal(list[0].sessionName, "new");
    assert.equal(list[0].port, 7333);
  });

  test("sorts by last activity, newest first; port breaks ties", () => {
    const list = buildSessionList(
      [
        { sessionId: "a", pid: 103, port: 7335, sessionFile: "/a.jsonl" },
        { sessionId: "b", pid: 101, port: 7331, sessionFile: "/b.jsonl" },
        { sessionId: "c", pid: 100, port: 7333, sessionFile: "/c.jsonl" },
      ],
      alive,
      (f) => ({ "/a.jsonl": 900, "/b.jsonl": 100, "/c.jsonl": 100 })[f],
    );
    assert.deepEqual(list.map((s) => [s.sessionId, s.lastActiveAt]), [["a", 900], ["b", 100], ["c", 100]]);
  });

  test("lastActiveAt falls back to startedAt when there is no file or it is unreadable", () => {
    const list = buildSessionList(
      [
        { sessionId: "nofile", pid: 100, port: 7331, startedAt: 50 },
        { sessionId: "gone", pid: 101, port: 7332, startedAt: 70, sessionFile: "/x.jsonl" },
        { sessionId: "bare", pid: 103, port: 7333 },
      ],
      alive,
      () => null,
    );
    assert.deepEqual(list.map((s) => [s.sessionId, s.lastActiveAt]), [["gone", 70], ["nofile", 50], ["bare", 0]]);
  });

  test("liveness follows piPid, not pid — a dead pi under a live shell is a ghost", () => {
    // `pi -p`/manual run: pid is the user's long-lived interactive shell (alive),
    // piPid is the pi process (dead). Must be dropped, not shown as alive.
    const list = buildSessionList(
      [
        { sessionId: "ghost", pid: 100, piPid: 999, port: 7335 }, // shell alive, pi dead
        { sessionId: "real", pid: 100, piPid: 101, port: 7331 }, // both alive
      ],
      alive,
    );
    assert.deepEqual(list.map((s) => s.sessionId), ["real"]);
  });

  test("piPid alive keeps the session even when the recorded pid is dead", () => {
    const list = buildSessionList([{ sessionId: "a", pid: 999, piPid: 101, port: 7331 }], alive);
    assert.deepEqual(list.map((s) => s.sessionId), ["a"]);
  });

  test("skips malformed entries", () => {
    const list = buildSessionList([null, {}, { sessionId: "a" }, { sessionId: "a", pid: 100, port: 7331 }], alive);
    assert.deepEqual(list.map((s) => s.sessionId), ["a"]);
  });

  test("projects only the browser-facing fields", () => {
    const list = buildSessionList([{ sessionId: "a", pid: 100, port: 7331, sessionName: "x", cwd: "/c", secret: "nope" }], alive);
    assert.deepEqual(list[0], { sessionId: "a", sessionName: "x", port: 7331, pid: 100, cwd: "/c", lastActiveAt: 0 });
  });
});

describe("diffBusyTransitions", () => {
  test("fires done on busy -> idle", () => {
    const prev = new Map([["a", true]]);
    const { done, nextBusy } = diffBusyTransitions(prev, [{ sessionId: "a", sessionName: "A", busy: false }]);
    assert.deepEqual(done, [{ sessionId: "a", sessionName: "A" }]);
    assert.equal(nextBusy.get("a"), false);
  });

  test("does not fire on first sight (idle)", () => {
    const { done } = diffBusyTransitions(new Map(), [{ sessionId: "a", busy: false }]);
    assert.deepEqual(done, []);
  });

  test("does not fire on first sight (busy)", () => {
    const { done, nextBusy } = diffBusyTransitions(new Map(), [{ sessionId: "a", busy: true }]);
    assert.deepEqual(done, []);
    assert.equal(nextBusy.get("a"), true);
  });

  test("does not fire while still busy", () => {
    const { done } = diffBusyTransitions(new Map([["a", true]]), [{ sessionId: "a", busy: true }]);
    assert.deepEqual(done, []);
  });

  test("does not fire on idle -> busy", () => {
    const { done } = diffBusyTransitions(new Map([["a", false]]), [{ sessionId: "a", busy: true }]);
    assert.deepEqual(done, []);
  });

  test("unknown (null) keeps the last value and reports no transition", () => {
    const { done, nextBusy } = diffBusyTransitions(new Map([["a", true]]), [{ sessionId: "a", busy: null }]);
    assert.deepEqual(done, []);
    assert.equal(nextBusy.get("a"), true);
  });

  test("busy -> unknown -> idle still fires done once", () => {
    let busy = new Map([["a", true]]);
    busy = diffBusyTransitions(busy, [{ sessionId: "a", busy: null }]).nextBusy;
    const { done } = diffBusyTransitions(busy, [{ sessionId: "a", sessionName: "A", busy: false }]);
    assert.deepEqual(done, [{ sessionId: "a", sessionName: "A" }]);
  });

  test("unknown with no prior value is not recorded", () => {
    const { done, nextBusy } = diffBusyTransitions(new Map(), [{ sessionId: "a", busy: null }]);
    assert.deepEqual(done, []);
    assert.equal(nextBusy.has("a"), false);
  });

  test("null sessionName defaults to null", () => {
    const { done } = diffBusyTransitions(new Map([["a", true]]), [{ sessionId: "a", busy: false }]);
    assert.equal(done[0].sessionName, null);
  });

  test("handles multiple sessions independently", () => {
    const prev = new Map([["a", true], ["b", true]]);
    const { done } = diffBusyTransitions(prev, [
      { sessionId: "a", sessionName: "A", busy: false },
      { sessionId: "b", sessionName: "B", busy: true },
    ]);
    assert.deepEqual(done, [{ sessionId: "a", sessionName: "A" }]);
  });
});

// buildSpawnCommand / buildOpenSessionCommand now live in the shared
// @wirelessr/pi-webui-components/session-spawn.js and are tested there.

describe("updateUnread", () => {
  test("a finished turn marks its session unread, keeping earlier ones", () => {
    const next = updateUnread(new Set(["a"]), [{ sessionId: "b" }], ["a", "b", "c"]);
    assert.deepEqual([...next].sort(), ["a", "b"]);
  });
  test("drops sessions that are no longer live", () => {
    const next = updateUnread(new Set(["a", "gone"]), [{ sessionId: "dead" }], ["a"]);
    assert.deepEqual([...next], ["a"]);
  });
  test("does not mutate the previous set", () => {
    const prev = new Set(["a"]);
    updateUnread(prev, [{ sessionId: "b" }], ["a", "b"]);
    assert.deepEqual([...prev], ["a"]);
  });
});
