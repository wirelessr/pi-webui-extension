import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { allPidsReplaced, pickRedirectTarget } from "../http-bridge-web/sessions.js";

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
