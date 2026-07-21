/**
 * Tests for sse-broadcast.js — the fan-out client set: add/remove, broadcast,
 * per-client eviction on write failure, shared heartbeat lifecycle.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createSseBroadcast } from "../sse-broadcast.js";

/** An SSE res stub that records writes and can be made to throw. */
function makeRes() {
  const res = {
    written: [],
    ended: false,
    failWrites: false,
    write(chunk) {
      if (res.failWrites) throw new Error("boom");
      res.written.push(chunk);
    },
    end() {
      res.ended = true;
    },
  };
  return res;
}

function makeTimers() {
  let nextId = 1;
  const intervals = new Map();
  return {
    setIntervalFn: (fn, ms) => {
      const id = nextId++;
      intervals.set(id, { fn, ms });
      return id;
    },
    clearIntervalFn: (id) => {
      intervals.delete(id);
    },
    tick: () => {
      for (const { fn } of [...intervals.values()]) fn();
    },
    count: () => intervals.size,
  };
}

function makeBroadcast(overrides = {}) {
  const timers = makeTimers();
  const evicted = [];
  const bc = createSseBroadcast({
    heartbeatMs: 15000,
    onEvict: (client, reason) => evicted.push({ origin: client.origin, reason }),
    setIntervalFn: timers.setIntervalFn,
    clearIntervalFn: timers.clearIntervalFn,
    ...overrides,
  });
  return { bc, timers, evicted };
}

describe("sse-broadcast", () => {
  test("broadcast reaches every client as an SSE data frame", () => {
    const { bc } = makeBroadcast();
    const a = makeRes();
    const b = makeRes();
    bc.add(a, "prompt");
    bc.add(b, "attach");
    bc.broadcast({ type: "text_delta", delta: "x" });
    const frame = 'data: {"type":"text_delta","delta":"x"}\n\n';
    assert.deepEqual(a.written, [frame]);
    assert.deepEqual(b.written, [frame]);
  });

  test("writeTo targets one client only", () => {
    const { bc } = makeBroadcast();
    const a = makeRes();
    const b = makeRes();
    const ca = bc.add(a, "attach");
    bc.add(b, "attach");
    assert.equal(bc.writeTo(ca, { type: "done" }), true);
    assert.equal(a.written.length, 1);
    assert.equal(b.written.length, 0);
  });

  test("writeTo evicts the client when its write throws", () => {
    const { bc, evicted } = makeBroadcast();
    const bad = makeRes();
    bad.failWrites = true;
    const c = bc.add(bad, "prompt");
    assert.equal(bc.writeTo(c, { type: "done" }), false);
    assert.equal(bc.size(), 0);
    assert.equal(bad.ended, true);
    assert.deepEqual(evicted, [{ origin: "prompt", reason: "write failed" }]);
  });

  test("writeTo on an unregistered client is a no-op returning false", () => {
    const { bc } = makeBroadcast();
    const a = makeRes();
    const ca = bc.add(a, "attach");
    bc.remove(ca);
    assert.equal(bc.writeTo(ca, { type: "done" }), false);
    assert.equal(a.written.length, 0);
  });

  test("a failing client is evicted, others keep receiving", () => {
    const { bc, evicted } = makeBroadcast();
    const bad = makeRes();
    const good = makeRes();
    bad.failWrites = true;
    bc.add(bad, "attach");
    bc.add(good, "attach");
    bc.broadcast({ type: "text_delta", delta: "1" });
    bc.broadcast({ type: "text_delta", delta: "2" });
    assert.equal(bc.size(), 1);
    assert.equal(good.written.length, 2);
    assert.equal(bad.ended, true);
    assert.deepEqual(evicted, [{ origin: "attach", reason: "write failed" }]);
  });

  test("eviction survives a res whose end() also throws", () => {
    const { bc } = makeBroadcast();
    const bad = makeRes();
    bad.failWrites = true;
    bad.end = () => {
      throw new Error("end boom");
    };
    const c = bc.add(bad, "attach");
    bc.broadcast({ type: "x" });
    assert.equal(bc.has(c), false);
    assert.equal(bc.size(), 0);
  });

  test("closeAll ends every stream and clears the set without onEvict", () => {
    const { bc, evicted } = makeBroadcast();
    const a = makeRes();
    const b = makeRes();
    bc.add(a, "prompt");
    bc.add(b, "attach");
    bc.closeAll();
    assert.equal(bc.size(), 0);
    assert.equal(a.ended, true);
    assert.equal(b.ended, true);
    assert.equal(evicted.length, 0);
  });

  test("remove drops bookkeeping without ending the stream", () => {
    const { bc } = makeBroadcast();
    const a = makeRes();
    const c = bc.add(a, "attach");
    bc.remove(c);
    assert.equal(bc.size(), 0);
    assert.equal(a.ended, false);
  });

  test("heartbeat starts with the first client and stops with the last", () => {
    const { bc, timers } = makeBroadcast();
    assert.equal(timers.count(), 0);
    const c1 = bc.add(makeRes(), "attach");
    assert.equal(timers.count(), 1);
    const c2 = bc.add(makeRes(), "attach");
    assert.equal(timers.count(), 1); // shared, not per-client
    bc.remove(c1);
    assert.equal(timers.count(), 1);
    bc.remove(c2);
    assert.equal(timers.count(), 0);
  });

  test("heartbeat writes a comment frame to all clients", () => {
    const { bc, timers } = makeBroadcast();
    const a = makeRes();
    const b = makeRes();
    bc.add(a, "attach");
    bc.add(b, "prompt");
    timers.tick();
    assert.deepEqual(a.written, [": heartbeat\n\n"]);
    assert.deepEqual(b.written, [": heartbeat\n\n"]);
  });

  test("heartbeat failure evicts only the dead client", () => {
    const { bc, timers, evicted } = makeBroadcast();
    const bad = makeRes();
    const good = makeRes();
    bad.failWrites = true;
    bc.add(bad, "attach");
    bc.add(good, "attach");
    timers.tick();
    assert.equal(bc.size(), 1);
    assert.deepEqual(evicted, [{ origin: "attach", reason: "heartbeat write failed" }]);
    assert.equal(timers.count(), 1); // good client keeps it alive
    bc.closeAll();
    assert.equal(timers.count(), 0);
  });

  test("defaults work without injected options", () => {
    const bc = createSseBroadcast();
    const a = makeRes();
    const bad = makeRes();
    bad.failWrites = true;
    bc.add(a, "attach");
    bc.add(bad, "attach");
    bc.broadcast({ type: "x" }); // default onEvict must not throw
    assert.equal(bc.size(), 1);
    bc.closeAll();
  });
});
