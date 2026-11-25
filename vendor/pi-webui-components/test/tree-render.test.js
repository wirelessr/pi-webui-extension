import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { flattenUserTree } from "../src/tree-render.js";

function n(id, text, opts = {}) {
  return { id, navTargetId: opts.nav || `${id}-end`, text, active: opts.active || false, current: opts.current || false, children: opts.children || [] };
}

describe("flattenUserTree", () => {
  test("linear chain stays at depth 0 with no connectors", () => {
    const nodes = [n("u1", "first", { active: true, children: [n("u2", "second", { active: true, current: true })] })];
    const rows = flattenUserTree(nodes);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((r) => [r.id, r.depth, r.connector]), [["u1", 0, ""], ["u2", 0, ""]]);
    assert.equal(rows[1].current, true);
    assert.equal(rows[0].navTargetId, "u1-end");
  });

  test("branch point indents children with connectors, chains continue flat", () => {
    const nodes = [
      n("u1", "root", {
        children: [
          n("u2", "branch one", { children: [n("u4", "deeper")] }),
          n("u3", "branch two"),
        ],
      }),
    ];
    const rows = flattenUserTree(nodes);
    assert.deepEqual(
      rows.map((r) => [r.id, r.depth, r.connector]),
      [["u1", 0, ""], ["u2", 1, "├"], ["u4", 1, ""], ["u3", 1, "└"]],
    );
  });

  test("nested branch points indent again", () => {
    const nodes = [
      n("u1", "root", {
        children: [
          n("u2", "a", { children: [n("u3", "a1"), n("u4", "a2")] }),
          n("u5", "b"),
        ],
      }),
    ];
    const rows = flattenUserTree(nodes);
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    assert.equal(byId.u2.depth, 1);
    assert.equal(byId.u3.depth, 2);
    assert.equal(byId.u3.connector, "├");
    assert.equal(byId.u4.connector, "└");
    assert.equal(byId.u5.depth, 1);
    assert.equal(byId.u5.connector, "└");
  });

  test("multiple roots all start at depth 0", () => {
    const rows = flattenUserTree([n("u1", "a"), n("u2", "b")]);
    assert.deepEqual(rows.map((r) => [r.id, r.depth]), [["u1", 0], ["u2", 0]]);
  });

  test("empty tree gives no rows", () => {
    assert.deepEqual(flattenUserTree([]), []);
  });

  test("missing children field is tolerated", () => {
    const rows = flattenUserTree([{ id: "u1", navTargetId: "x", text: "t", active: false, current: false }]);
    assert.equal(rows.length, 1);
  });
});
