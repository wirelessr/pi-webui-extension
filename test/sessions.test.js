import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { pickRedirectTarget } from "../http-bridge-web/sessions.js";

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
