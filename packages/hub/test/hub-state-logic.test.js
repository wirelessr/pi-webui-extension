import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  addGroup,
  displayLayout,
  EMPTY_STATE,
  normalizeState,
  pruneState,
  rebuildItems,
  removeGroup,
  renameGroup,
  setGroupCollapsed,
} from "../public/hub-state-logic.js";

const sess = (id) => ({ type: "session", id });
const grp = (id, members, extra = {}) => ({ type: "group", id, name: "group", collapsed: false, members, ...extra });

describe("normalizeState", () => {
  test("non-object → empty state", () => {
    assert.deepEqual(normalizeState(null), EMPTY_STATE);
    assert.deepEqual(normalizeState("nope"), EMPTY_STATE);
  });

  test("keeps a valid interleaved items array", () => {
    const s = normalizeState({
      items: [sess("A"), grp("g1", ["m1", "m2"], { name: "Work", collapsed: true }), sess("B")],
    });
    assert.deepEqual(s.items, [
      { type: "session", id: "A" },
      { type: "group", id: "g1", name: "Work", collapsed: true, members: ["m1", "m2"] },
      { type: "session", id: "B" },
    ]);
  });

  test("drops malformed items and defaults group name/collapsed", () => {
    const s = normalizeState({ items: [{ type: "group", id: "g1" }, { type: "session" }, 5, null, { type: "x", id: "z" }] });
    assert.deepEqual(s.items, [{ type: "group", id: "g1", name: "group", collapsed: false, members: [] }]);
  });

  test("dedupes a session id appearing twice (top-level + member)", () => {
    const s = normalizeState({ items: [sess("A"), grp("g1", ["A", "B"])] });
    // A already placed top-level → not repeated as a member
    assert.deepEqual(s.items[1].members, ["B"]);
  });

  test("tolerates missing/!array items", () => {
    assert.deepEqual(normalizeState({}), EMPTY_STATE);
    assert.deepEqual(normalizeState({ items: "bad" }), EMPTY_STATE);
  });
});

describe("pruneState", () => {
  test("removes dead top-level sessions and dead group members", () => {
    const s = normalizeState({ items: [sess("A"), grp("g1", ["m1", "m2"]), sess("B")] });
    const p = pruneState(s, ["A", "m2"]);
    assert.deepEqual(p.items, [
      { type: "session", id: "A" },
      { type: "group", id: "g1", name: "group", collapsed: false, members: ["m2"] },
    ]);
  });
});

describe("displayLayout", () => {
  test("prunes dead + appends new live sessions as top-level", () => {
    const s = normalizeState({ items: [sess("A"), grp("g1", ["m1"])] });
    const layout = displayLayout(s, ["A", "m1", "NEW"]);
    assert.deepEqual(layout, [
      { type: "session", id: "A" },
      { type: "group", id: "g1", name: "group", collapsed: false, members: ["m1"] },
      { type: "session", id: "NEW" },
    ]);
  });

  test("empty state → all live sessions top-level in incoming order", () => {
    assert.deepEqual(displayLayout(EMPTY_STATE, ["x", "y"]), [sess("x"), sess("y")]);
  });
});

describe("group mutations", () => {
  test("addGroup appends an empty collapsed:false group", () => {
    const s = addGroup(EMPTY_STATE, { id: "g1", name: "Work" });
    assert.deepEqual(s.items, [{ type: "group", id: "g1", name: "Work", collapsed: false, members: [] }]);
  });

  test("renameGroup / setGroupCollapsed target only the matching group", () => {
    let s = normalizeState({ items: [grp("g1", []), grp("g2", [])] });
    s = renameGroup(s, "g2", "BB");
    assert.deepEqual(s.items.map((g) => g.name), ["group", "BB"]);
    s = setGroupCollapsed(s, "g1", true);
    assert.deepEqual(s.items.map((g) => g.collapsed), [true, false]);
  });

  test("removeGroup inlines members as top-level sessions at its position", () => {
    const s = normalizeState({ items: [sess("A"), grp("g1", ["m1", "m2"]), sess("B")] });
    const r = removeGroup(s, "g1");
    assert.deepEqual(r.items, [sess("A"), sess("m1"), sess("m2"), sess("B")]);
  });
});

describe("rebuildItems", () => {
  test("rebuilds order + membership from a DOM layout, preserving name/collapsed", () => {
    const state = normalizeState({ items: [grp("g1", ["m1"], { name: "Work", collapsed: true }), sess("A")] });
    // DOM after drag: session A moved above the group, m1 stayed; new member m2 added
    const layout = [sess("A"), { type: "group", id: "g1", members: ["m1", "m2"] }];
    const r = rebuildItems(state, layout);
    assert.deepEqual(r.items, [
      { type: "session", id: "A" },
      { type: "group", id: "g1", name: "Work", collapsed: true, members: ["m1", "m2"] },
    ]);
  });

  test("unknown group id in layout falls back to defaults", () => {
    const r = rebuildItems(EMPTY_STATE, [{ type: "group", id: "gX", members: [] }]);
    assert.deepEqual(r.items, [{ type: "group", id: "gX", name: "group", collapsed: false, members: [] }]);
  });
});
