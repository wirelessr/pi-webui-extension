import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import {
  buildCronRunArgv,
  buildForkSessionCommand,
  buildOpenSessionCommand,
  buildSpawnCommand,
  findSessionCwd,
  listSessionFileIds,
  sessionFileExists,
} from "../src/session-spawn.js";

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
    assert.match(cmd, /--name 'my sesh' --session "abc"/);
    assert.match(cmd, /sed -u "s\/\^\/\[hub-open\] \/"/);
  });
  test("escapes double quotes in id and log; name is single-quoted", () => {
    const cmd = buildOpenSessionCommand({ sessionId: 'a"b', name: 'n"m', logFile: '/tmp/"x".log' });
    assert.match(cmd, /--name 'n"m' --session "a\\"b"/);
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
    assert.match(cmd, /--name 'my sesh \(copy\)' --fork "abc"/);
    assert.match(cmd, /sed -u "s\/\^\/\[hub-clone\] \/"/);
  });
  test("escapes double quotes in id and log; name is single-quoted", () => {
    const cmd = buildForkSessionCommand({ sessionId: 'a"b', name: 'n"m', logFile: '/tmp/"x".log' });
    assert.match(cmd, /--name 'n"m' --fork "a\\"b"/);
    assert.match(cmd, />> "\/tmp\/\\"x\\".log"/);
  });
});

// The name reaches sh as source: evaluate the generated --name word with a real
// sh and check it comes back byte-for-byte, with nothing expanded or executed.
describe("open/fork --name is shell-safe", () => {
  const names = ["$(touch PWNED)", "`touch PWNED`", "trailing \\", "it's", "'", `a"b $HOME $${"{HOME}"} \\$x`, "cron: Gmail 2026-01-05 09:00"];
  const builders = { open: buildOpenSessionCommand, fork: buildForkSessionCommand };
  for (const [kind, build] of Object.entries(builders)) {
    for (const name of names) {
      test(`${kind}: ${name}`, () => {
        const dir = mkdtempSync(join(tmpdir(), "name-quote-"));
        try {
          const cmd = build({ sessionId: "abc", name, logFile: "/tmp/b.log" });
          const word = cmd.match(/ --name (.*) --(?:session|fork) "abc"/)[1];
          const r = spawnSync("sh", ["-c", `printf %s ${word}`], { cwd: dir, encoding: "utf-8" });
          assert.equal(r.status, 0);
          assert.equal(r.stdout, name);
          assert.equal(existsSync(join(dir, "PWNED")), false);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      });
    }
  }
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

describe("buildCronRunArgv", () => {
  test("zsh wrapper with every variable as a positional parameter, prompt after --", () => {
    const argv = buildCronRunArgv({ sessionId: "sid", name: "cron: x", model: "m/p", prompt: "-do it", runDir: "/r" });
    assert.equal(argv[0], "zsh");
    assert.equal(argv[1], "-c");
    assert.deepEqual(argv.slice(3), ["sh", "sid", "cron: x", "m/p", "-do it", "/r", "pi"]);
    assert.match(argv[2], /"\$6" -p --session-id "\$1" --name "\$2" --model "\$3" -- "\$4" > "\$5\/out.log" 2>&1/);
    assert.doesNotMatch(argv[2], /sid|cron: x|-do it/);
  });

  test("piBin overrides the executable", () => {
    assert.equal(buildCronRunArgv({ sessionId: "s", name: "n", model: "m", prompt: "p", runDir: "/r", piBin: "/stub" }).at(-1), "/stub");
  });

  // Runs the real wrapper with a stub pi. ZDOTDIR points at the temp dir so the
  // user's own ~/.zshenv is not sourced by the test.
  const hasZsh = spawnSync("zsh", ["-c", "true"]).status === 0;
  test("wrapper passes args verbatim, captures output, removes the discovery file, writes exit", { skip: !hasZsh && "zsh not installed" }, () => {
    const dir = mkdtempSync(join(tmpdir(), "cron-argv-"));
    try {
      const stub = join(dir, "stub-pi");
      writeFileSync(stub, '#!/bin/sh\nfor a in "$@"; do printf "[%s]\\n" "$a"; done\necho err >&2\nexit 3\n');
      chmodSync(stub, 0o755);
      writeFileSync(join(dir, "sid.json"), "{}");
      const prompt = `it's "$(touch ${dir}/pwned)" \`x\` $HOME`;
      const argv = buildCronRunArgv({ sessionId: "sid", name: "cron: n", model: "m", prompt, runDir: dir, piBin: stub });
      const r = spawnSync(argv[0], argv.slice(1), { env: { PATH: process.env.PATH, ZDOTDIR: dir, PI_BRIDGE_DIR: dir } });
      assert.equal(r.status, 0);
      assert.equal(readFileSync(join(dir, "out.log"), "utf-8"), `[-p]\n[--session-id]\n[sid]\n[--name]\n[cron: n]\n[--model]\n[m]\n[--]\n[${prompt}]\nerr\n`);
      assert.equal(readFileSync(join(dir, "exit"), "utf-8"), "3\n");
      assert.equal(existsSync(join(dir, "sid.json")), false);
      assert.equal(existsSync(join(dir, "exit.tmp")), false);
      assert.equal(existsSync(join(dir, "pwned")), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("sessionFileExists", () => {
  const ROOT = "/sessions";
  const deps = (tree, { throwRoot = false, throwDirs = [] } = {}) => ({
    sessionsRoot: ROOT,
    readdirSync: (p) => {
      if (p === ROOT) {
        if (throwRoot) throw new Error("no root");
        return Object.keys(tree).map((name) => ({ name, isDirectory: () => tree[name] !== null }));
      }
      const name = p.slice(ROOT.length + 1);
      if (throwDirs.includes(name)) throw new Error("dir boom");
      return tree[name];
    },
  });

  const cases = [
    { name: "matches the *_<id>.jsonl filename", tree: { p: ["2026-01-01T00-00-00-000Z_abc.jsonl"] }, id: "abc", want: true },
    { name: "id must be the whole suffix after _", tree: { p: ["2026_xabc.jsonl", "2026_abc.jsonl.bak"] }, id: "abc", want: false },
    { name: "skips files at the root and unreadable dirs", tree: { "f.jsonl": null, bad: [], q: ["t_abc.jsonl"] }, id: "abc", want: true, opts: { throwDirs: ["bad"] } },
    { name: "missing root is false", tree: {}, id: "abc", want: false, opts: { throwRoot: true } },
    { name: "no match is false", tree: { p: ["t_other.jsonl"] }, id: "abc", want: false },
  ];
  for (const c of cases) {
    test(c.name, () => assert.equal(sessionFileExists(c.id, deps(c.tree, c.opts)), c.want));
  }

  test("listSessionFileIds collects every id in one pass", () => {
    const tree = { p: ["2026_a.jsonl", "2026_b.jsonl", "notes.txt", "nounderscore.jsonl"], q: ["2026_c.jsonl"], "f.jsonl": null };
    assert.deepEqual([...listSessionFileIds(deps(tree))].sort(), ["a", "b", "c"]);
  });
});
