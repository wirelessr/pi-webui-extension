import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buildActivePathIds, buildUserTree, userMessageText } from "../tree-logic.js";

/** Build a SessionTreeNode. */
function node(entry, children = []) {
  return { entry, children };
}
function user(id, text) {
  return { id, type: "message", message: { role: "user", content: text } };
}
function assistant(id) {
  return { id, type: "message", message: { role: "assistant", content: [{ type: "text", text: "answer" }] } };
}

describe("userMessageText", () => {
  const cases = [
    { desc: "string content", entry: user("1", "hello"), expected: "hello" },
    {
      desc: "array content joins text parts",
      entry: { type: "message", message: { role: "user", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] } },
      expected: "ab",
    },
    {
      desc: "image-only content",
      entry: { type: "message", message: { role: "user", content: [{ type: "image", data: "..." }] } },
      expected: "[image]",
    },
    { desc: "assistant message", entry: assistant("2"), expected: null },
    { desc: "non-message entry", entry: { id: "3", type: "model_change" }, expected: null },
    { desc: "undefined entry", entry: undefined, expected: null },
    { desc: "content of unexpected type", entry: { type: "message", message: { role: "user", content: 42 } }, expected: null },
  ];
  for (const c of cases) {
    test(c.desc, () => assert.equal(userMessageText(c.entry), c.expected));
  }
});

describe("buildActivePathIds", () => {
  test("collects ids from leaf to root", () => {
    const roots = [node(user("u1", "a"), [node(assistant("a1"), [node(user("u2", "b"), [node(assistant("a2"))])])])];
    const ids = buildActivePathIds(roots, "a2");
    assert.deepEqual([...ids].sort(), ["a1", "a2", "u1", "u2"]);
  });

  test("unknown leaf gives empty set", () => {
    const roots = [node(user("u1", "a"))];
    assert.equal(buildActivePathIds(roots, "nope").size, 0);
    assert.equal(buildActivePathIds(roots, null).size, 0);
  });
});

describe("buildUserTree", () => {
  test("linear chain: nested user nodes, navTarget is the turn end, deepest is current", () => {
    const roots = [node(user("u1", "first"), [node(assistant("a1"), [node(user("u2", "second"), [node(assistant("a2"))])])])];
    const { nodes, leafId } = buildUserTree(roots, "a2");
    assert.equal(leafId, "a2");
    assert.equal(nodes.length, 1);
    const n1 = nodes[0];
    assert.equal(n1.id, "u1");
    assert.equal(n1.navTargetId, "a1");
    assert.equal(n1.active, true);
    assert.equal(n1.current, false);
    const n2 = n1.children[0];
    assert.equal(n2.id, "u2");
    assert.equal(n2.navTargetId, "a2");
    assert.equal(n2.current, true);
  });

  test("branch point: both user children listed, only active branch marked", () => {
    const roots = [
      node(user("u1", "root"), [
        node(assistant("a1"), [
          node(user("u2", "branch one"), [node(assistant("a2"))]),
          node(user("u3", "branch two"), [node(assistant("a3"))]),
        ]),
      ]),
    ];
    const { nodes } = buildUserTree(roots, "a3");
    const n1 = nodes[0];
    assert.equal(n1.children.length, 2);
    const [n2, n3] = n1.children;
    assert.equal(n2.active, false);
    assert.equal(n2.current, false);
    assert.equal(n3.active, true);
    assert.equal(n3.current, true);
    assert.equal(n1.active, true);
    assert.equal(n1.current, false);
  });

  test("non-user roots are transparent: user descendants promoted to top level", () => {
    const roots = [node({ id: "m1", type: "model_change" }, [node(user("u1", "hi"), [node(assistant("a1"))])])];
    const { nodes } = buildUserTree(roots, "a1");
    assert.equal(nodes.length, 1);
    assert.equal(nodes[0].id, "u1");
  });

  test("navTarget prefers the active path at a non-user fork", () => {
    const roots = [
      node(user("u1", "q"), [
        node(assistant("a1"), [node(assistant("a1b"))]),
        node(assistant("a2"), [node(assistant("a2b"))]),
      ]),
    ];
    const { nodes } = buildUserTree(roots, "a2b");
    assert.equal(nodes[0].navTargetId, "a2b");
  });

  test("navTarget falls back to the first child off the active path", () => {
    const roots = [
      node(user("u1", "q"), [node(assistant("a1"), [node(user("u2", "next"))])]),
    ];
    const { nodes } = buildUserTree(roots, null);
    // No active path: u1's turn ends at a1 (stop before user child u2)
    assert.equal(nodes[0].navTargetId, "a1");
    assert.equal(nodes[0].children[0].navTargetId, "u2");
  });

  test("node text is truncated with an ellipsis", () => {
    const long = "x".repeat(150);
    const roots = [node(user("u1", long))];
    const { nodes } = buildUserTree(roots, null, 100);
    assert.equal(nodes[0].text.length, 101);
    assert.ok(nodes[0].text.endsWith("…"));
  });

  test("empty tree", () => {
    assert.deepEqual(buildUserTree([], null), { nodes: [], leafId: null });
  });
});
