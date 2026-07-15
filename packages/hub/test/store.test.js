import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createStore } from "../public/store.js";

describe("createStore", () => {
  test("get returns initial state; set merges a partial patch", () => {
    const s = createStore({ a: 1, b: 2 });
    assert.deepEqual(s.get(), { a: 1, b: 2 });
    s.set({ b: 3 });
    assert.deepEqual(s.get(), { a: 1, b: 3 });
  });

  test("set accepts an updater function of the previous state", () => {
    const s = createStore({ n: 1 });
    s.set((prev) => ({ n: prev.n + 1 }));
    assert.equal(s.get().n, 2);
  });

  test("set notifies every subscriber with the new state", () => {
    const s = createStore({ x: 0 });
    const seen = [];
    s.subscribe((st) => seen.push(["a", st.x]));
    s.subscribe((st) => seen.push(["b", st.x]));
    s.set({ x: 5 });
    assert.deepEqual(seen, [["a", 5], ["b", 5]]);
  });

  test("subscribe does not fire on register; unsubscribe stops notifications", () => {
    const s = createStore({ x: 0 });
    let calls = 0;
    const off = s.subscribe(() => calls++);
    assert.equal(calls, 0); // not called on register
    s.set({ x: 1 });
    assert.equal(calls, 1);
    off();
    s.set({ x: 2 });
    assert.equal(calls, 1); // no longer notified
  });

  test("a falsy/empty patch is a no-op and does not notify", () => {
    const s = createStore({ x: 1 });
    let calls = 0;
    s.subscribe(() => calls++);
    s.set(null);
    s.set((prev) => (prev.x > 0 ? null : { x: 9 }));
    assert.equal(calls, 0);
    assert.deepEqual(s.get(), { x: 1 });
  });

  test("state identity changes on set (new object, for cheap change checks)", () => {
    const s = createStore({ x: 1 });
    const before = s.get();
    s.set({ x: 2 });
    assert.notEqual(s.get(), before);
  });
});
