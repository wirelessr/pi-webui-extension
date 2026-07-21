import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { collectWrittenPaths, extractFilePaths, fileName, isMarkdownPath } from "../src/artifacts.js";

describe("extractFilePaths", () => {
  test("returns write/edit target paths in first-touch order, deduped", () => {
    const toolCalls = [
      { name: "write", arguments: { path: "/a/root.md", content: "x" } },
      { name: "bash", arguments: { command: "ls" } },
      { name: "edit", arguments: { path: "/a/next.md", edits: [] } },
      { name: "edit", arguments: { path: "/a/root.md", edits: [] } }, // dup
    ];
    assert.deepEqual(extractFilePaths(toolCalls), ["/a/root.md", "/a/next.md"]);
  });

  test("accepts file_path as an alias for path", () => {
    assert.deepEqual(extractFilePaths([{ name: "write", arguments: { file_path: "/a/x.md", content: "" } }]), ["/a/x.md"]);
  });

  test("ignores non-file tools, missing paths, and bad arguments", () => {
    const toolCalls = [
      { name: "read", arguments: { path: "/a/read.md" } }, // not write/edit
      { name: "write", arguments: { content: "no path" } },
      { name: "write" }, // no arguments
      { name: "edit", arguments: "not-an-object" },
      null,
    ];
    assert.deepEqual(extractFilePaths(toolCalls), []);
  });

  test("returns [] for a non-array", () => {
    assert.deepEqual(extractFilePaths(undefined), []);
  });
});

describe("collectWrittenPaths", () => {
  test("unions write/edit paths across assistant entries only", () => {
    const entries = [
      { role: "user", text: "hi" },
      { role: "assistant", toolCalls: [{ name: "write", arguments: { path: "/a/1.md", content: "" } }] },
      { role: "assistant", toolCalls: [{ name: "edit", arguments: { path: "/a/2.md", edits: [] } }, { name: "write", arguments: { path: "/a/1.md", content: "" } }] },
      { role: "toolResult", toolCalls: [{ name: "write", arguments: { path: "/ignored.md", content: "" } }] },
    ];
    assert.deepEqual([...collectWrittenPaths(entries)].sort(), ["/a/1.md", "/a/2.md"]);
  });

  test("returns an empty set for a non-array", () => {
    assert.equal(collectWrittenPaths(null).size, 0);
  });
});

describe("fileName", () => {
  test("returns the basename", () => {
    assert.equal(fileName("/a/b/root-cause.md"), "root-cause.md");
  });
  test("falls back to the whole string when there is no slash", () => {
    assert.equal(fileName("solo.md"), "solo.md");
  });
});

describe("isMarkdownPath", () => {
  test("true for .md and .markdown (any case)", () => {
    assert.equal(isMarkdownPath("/a/x.md"), true);
    assert.equal(isMarkdownPath("/a/x.MARKDOWN"), true);
  });
  test("false otherwise", () => {
    assert.equal(isMarkdownPath("/a/x.py"), false);
  });
});
