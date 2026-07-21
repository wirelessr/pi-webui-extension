import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buildForkSessionCommand, buildOpenSessionCommand, buildSpawnCommand, findSessionCwd } from "../src/session-spawn.js";

describe("buildSpawnCommand", () => {
  test("default prefix is [new]", () => {
    const cmd = buildSpawnCommand({ logFile: "/tmp/b.log" });
    assert.match(cmd, /pi --mode rpc /);
    assert.match(cmd, /sed -u "s\/\^\/\[new\] \/" >> "\/tmp\/b.log"/);
  });
  test("port drives the prefix when no explicit prefix", () => {
    const cmd = buildSpawnCommand({ logFile: "/tmp/b.log", port: 7331 });
    assert.match(cmd, /sed -u "s\/\^\/\[7331\] \/"/);
  });
  test("explicit prefix overrides port", () => {
    const cmd = buildSpawnCommand({ logFile: "/tmp/b.log", port: 7331, prefix: "[hub-new]" });
    assert.match(cmd, /sed -u "s\/\^\/\[hub-new\] \/"/);
  });
  test("escapes double quotes in the log path", () => {
    const cmd = buildSpawnCommand({ logFile: '/tmp/"x".log' });
    assert.match(cmd, />> "\/tmp\/\\"x\\".log"/);
  });
});

describe("buildOpenSessionCommand", () => {
  test("default prefix [new], includes --session, no --name", () => {
    const cmd = buildOpenSessionCommand({ sessionId: "abc", logFile: "/tmp/b.log" });
    assert.match(cmd, /pi --mode rpc --session "abc"/);
    assert.match(cmd, /sed -u "s\/\^\/\[new\] \/"/);
    assert.doesNotMatch(cmd, /--name/);
  });
  test("custom prefix and name (name before --session)", () => {
    const cmd = buildOpenSessionCommand({ sessionId: "abc", name: "my sesh", logFile: "/tmp/b.log", prefix: "[hub-open]" });
    assert.match(cmd, /--name "my sesh" --session "abc"/);
    assert.match(cmd, /sed -u "s\/\^\/\[hub-open\] \/"/);
  });
  test("escapes double quotes in id, name, and log", () => {
    const cmd = buildOpenSessionCommand({ sessionId: 'a"b', name: 'n"m', logFile: '/tmp/"x".log' });
    assert.match(cmd, /--name "n\\"m" --session "a\\"b"/);
    assert.match(cmd, />> "\/tmp\/\\"x\\".log"/);
  });
});

describe("buildForkSessionCommand", () => {
  test("default prefix [new], includes --fork, no --name", () => {
    const cmd = buildForkSessionCommand({ sessionId: "abc", logFile: "/tmp/b.log" });
    assert.match(cmd, /pi --mode rpc --fork "abc"/);
    assert.match(cmd, /sed -u "s\/\^\/\[new\] \/"/);
    assert.doesNotMatch(cmd, /--name/);
  });
  test("custom prefix and name (name before --fork)", () => {
    const cmd = buildForkSessionCommand({ sessionId: "abc", name: "my sesh (copy)", logFile: "/tmp/b.log", prefix: "[hub-clone]" });
    assert.match(cmd, /--name "my sesh \(copy\)" --fork "abc"/);
    assert.match(cmd, /sed -u "s\/\^\/\[hub-clone\] \/"/);
  });
  test("escapes double quotes in id, name, and log", () => {
    const cmd = buildForkSessionCommand({ sessionId: 'a"b', name: 'n"m', logFile: '/tmp/"x".log' });
    assert.match(cmd, /--name "n\\"m" --fork "a\\"b"/);
    assert.match(cmd, />> "\/tmp\/\\"x\\".log"/);
  });
});

// In-memory fs for findSessionCwd. `tree` maps dirName -> { fileName: content }.
// Special content sentinels: a THROW_READ file throws on read; a dir listed in
// throwDirs throws on readdirSync.
function fakeDeps(tree, { rootExists = true, throwRoot = false, throwDirs = [] } = {}) {
  const ROOT = "/sessions";
  return {
    sessionsRoot: ROOT,
    existsSync: (p) => (p === ROOT ? rootExists : true),
    readdirSync: (p, opts) => {
      if (p === ROOT) {
        if (throwRoot) throw new Error("root boom");
        return Object.keys(tree).map((name) => ({ name, isDirectory: () => tree[name] !== null }));
      }
      const dirName = p.slice(ROOT.length + 1);
      if (throwDirs.includes(dirName)) throw new Error("dir boom");
      return Object.keys(tree[dirName] || {});
    },
    readFileSync: (fp) => {
      const parts = fp.split("/");
      const file = parts.pop();
      const dirName = parts.pop();
      const content = tree[dirName]?.[file];
      if (content === "THROW_READ") throw new Error("read boom");
      return content;
    },
  };
}

const line = (obj) => `${JSON.stringify(obj)}\nmore\n`;

describe("findSessionCwd", () => {
  test("returns undefined when the sessions root is absent", () => {
    assert.equal(findSessionCwd("x", fakeDeps({}, { rootExists: false })), undefined);
  });

  test("fast path: filename embeds the id → returns meta.cwd", () => {
    const deps = fakeDeps({
      "proj-a": { "2026_abc123.jsonl": line({ id: "abc123", cwd: "/work/a" }) },
    });
    assert.equal(findSessionCwd("abc123", deps), "/work/a");
  });

  test("authoritative path: filename uuid differs from the first-line id", () => {
    const deps = fakeDeps({
      "proj-b": { "2026_FILEUUID.jsonl": line({ id: "realid-999", cwd: "/work/b" }) },
    });
    assert.equal(findSessionCwd("realid-999", deps), "/work/b");
  });

  test("returns undefined when nothing matches", () => {
    const deps = fakeDeps({
      "proj-b": { "2026_x.jsonl": line({ id: "other", cwd: "/work/x" }) },
    });
    assert.equal(findSessionCwd("nope", deps), undefined);
  });

  test("skips non-directory entries, non-.jsonl files, and unreadable dirs", () => {
    const deps = fakeDeps(
      {
        "a-file": null, // not a directory
        "bad-dir": { "2026_zzz.jsonl": line({ id: "zzz", cwd: "/nope" }) },
        "proj": { "notes.txt": "ignore me", "2026_target.jsonl": line({ id: "target", cwd: "/work/ok" }) },
      },
      { throwDirs: ["bad-dir"] },
    );
    assert.equal(findSessionCwd("target", deps), "/work/ok");
  });

  test("fast-path filename match but no cwd in meta → not returned", () => {
    const deps = fakeDeps({
      "proj": { "2026_hasid.jsonl": line({ id: "hasid" }) }, // no cwd
    });
    assert.equal(findSessionCwd("hasid", deps), undefined);
  });

  test("unparseable / unreadable session files are skipped in both passes", () => {
    const deps = fakeDeps({
      "proj": {
        "2026_broken.jsonl": "{not json", // filename doesn't match query → scanned, parse fails
        "2026_throw.jsonl": "THROW_READ", // read throws
        "2026_good.jsonl": line({ id: "want", cwd: "/work/found" }),
      },
    });
    assert.equal(findSessionCwd("want", deps), "/work/found");
  });

  test("outer readdir failure is swallowed → undefined", () => {
    assert.equal(findSessionCwd("x", fakeDeps({}, { throwRoot: true })), undefined);
  });
});
