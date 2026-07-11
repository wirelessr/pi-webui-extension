import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { pollUntil, sessionUrl } from "../http-bridge-web/api.js";

describe("sessionUrl", () => {
  const cases = [
    { name: "uses s.url when present", session: { url: "http://192.168.1.130:7331", port: 7331 }, expected: "http://192.168.1.130:7331" },
    { name: "falls back to localhost when url missing", session: { port: 7332 }, expected: "http://localhost:7332" },
    { name: "falls back to localhost when url is empty string", session: { url: "", port: 7333 }, expected: "http://localhost:7333" },
    { name: "falls back to localhost when url is null", session: { url: null, port: 7334 }, expected: "http://localhost:7334" },
  ];
  for (const c of cases) {
    test(c.name, () => assert.equal(sessionUrl(c.session), c.expected));
  }
});

describe("pollUntil", () => {
  test("returns truthy result when condition met", async () => {
    let count = 0;
    const result = await pollUntil(async () => {
      count++;
      return count >= 3 ? "done" : false;
    }, 10, 10);
    assert.equal(result, "done");
    assert.equal(count, 3);
  });

  test("returns null when condition never met", async () => {
    const result = await pollUntil(async () => false, 10, 3);
    assert.equal(result, null);
  });

  test("swallows errors and keeps polling", async () => {
    let count = 0;
    const result = await pollUntil(async () => {
      count++;
      if (count < 2) throw new Error("transient");
      return "ok";
    }, 10, 5);
    assert.equal(result, "ok");
    assert.equal(count, 2);
  });

  test("returns null if all attempts throw", async () => {
    const result = await pollUntil(async () => {
      throw new Error("always fails");
    }, 10, 3);
    assert.equal(result, null);
  });

  test("respects maxAttempts", async () => {
    let count = 0;
    await pollUntil(async () => {
      count++;
      return false;
    }, 10, 4);
    assert.equal(count, 4);
  });

  test("zero maxAttempts returns null immediately", async () => {
    const result = await pollUntil(async () => true, 10, 0);
    assert.equal(result, null);
  });
});
