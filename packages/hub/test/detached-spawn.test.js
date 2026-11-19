import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, test } from "node:test";
import { spawnDetached } from "../src/detached-spawn.js";

// Fake spawn: records the call and returns an EventEmitter child with the given pid.
function fakeSpawn(pid) {
  const calls = [];
  const child = new EventEmitter();
  child.pid = pid;
  child.unrefCalls = 0;
  child.unref = () => {
    child.unrefCalls++;
  };
  const spawn = (file, args, opts) => {
    calls.push({ file, args, opts });
    return child;
  };
  return { spawn, calls, child };
}

describe("spawnDetached", () => {
  test("spawns argv[0] with the remaining args, detached and ignored stdio, and returns the pid", () => {
    const { spawn, calls, child } = fakeSpawn(4242);
    const env = { PI_BRIDGE_DIR: "/iso" };
    const pid = spawnDetached(["zsh", "-c", "script", "sh", "a b"], { cwd: "/work", env, spawn });
    assert.equal(pid, 4242);
    assert.deepEqual(calls, [
      { file: "zsh", args: ["-c", "script", "sh", "a b"], opts: { cwd: "/work", detached: true, stdio: "ignore", env } },
    ]);
    assert.equal(child.unrefCalls, 1);
  });

  test("throws synchronously when the child got no pid, with the error listener already attached", () => {
    const { spawn, child } = fakeSpawn(undefined);
    const seen = [];
    assert.throws(() => spawnDetached(["sh", "-c", "x"], { cwd: "/missing", env: {}, spawn, onError: (e) => seen.push(e) }), /spawn failed/);
    assert.equal(child.listenerCount("error"), 1);
    const err = new Error("spawn sh ENOENT");
    child.emit("error", err);
    assert.deepEqual(seen, [err]);
  });

  test("default onError logs instead of throwing, so an async spawn error cannot crash the hub", (t) => {
    const logged = t.mock.method(console, "error", () => {});
    const { spawn, child } = fakeSpawn(undefined);
    assert.throws(() => spawnDetached(["sh", "-c", "x"], { cwd: "/missing", env: {}, spawn }), /spawn failed/);
    assert.doesNotThrow(() => child.emit("error", new Error("spawn sh ENOENT")));
    assert.deepEqual(
      logged.mock.calls.map((c) => c.arguments),
      [["[hub] spawn error: spawn sh ENOENT"]],
    );
  });
});
