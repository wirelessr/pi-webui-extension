import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buildSessionList, buildSpawnCommand, diffBusyTransitions, parseProxyPath, pickSession } from "../src/hub-helpers.js";

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

  test("sorts by port ascending", () => {
    const list = buildSessionList(
      [
        { sessionId: "a", pid: 103, port: 7335 },
        { sessionId: "b", pid: 101, port: 7331 },
      ],
      alive,
    );
    assert.deepEqual(list.map((s) => s.port), [7331, 7335]);
  });

  test("skips malformed entries", () => {
    const list = buildSessionList([null, {}, { sessionId: "a" }, { sessionId: "a", pid: 100, port: 7331 }], alive);
    assert.deepEqual(list.map((s) => s.sessionId), ["a"]);
  });

  test("projects only the browser-facing fields", () => {
    const list = buildSessionList([{ sessionId: "a", pid: 100, port: 7331, sessionName: "x", cwd: "/c", secret: "nope" }], alive);
    assert.deepEqual(list[0], { sessionId: "a", sessionName: "x", port: 7331, pid: 100, cwd: "/c" });
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

describe("buildSpawnCommand", () => {
  test("includes pi --mode rpc and the log redirect", () => {
    const cmd = buildSpawnCommand({ logFile: "/tmp/hub.log" });
    assert.match(cmd, /pi --mode rpc/);
    assert.match(cmd, /tail -f \/dev\/null/);
    assert.match(cmd, /sed -u "s\/\^\/\[hub-new\] \/" >> "\/tmp\/hub.log"/);
  });
  test("escapes double quotes in the log path", () => {
    const cmd = buildSpawnCommand({ logFile: '/tmp/"x".log' });
    assert.match(cmd, />> "\/tmp\/\\"x\\".log"/);
  });
});
