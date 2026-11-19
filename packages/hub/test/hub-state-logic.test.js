import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  addGroup,
  bucketByAge,
  decideStreamReconcile,
  displayLayout,
  EMPTY_STATE,
  moveToGroup,
  normalizeState,
  pruneState,
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

  describe("with lastActive", () => {
    const t = (o) => new Map(Object.entries(o));

    test("sessions and groups interleave by recency; a group counts as its newest member", () => {
      const s = normalizeState({ items: [sess("A"), grp("g1", ["m1", "m2"]), sess("B")] });
      const layout = displayLayout(s, ["A", "B", "m1", "m2"], t({ A: 10, B: 30, m1: 20, m2: 50 }));
      assert.deepEqual(layout.map((i) => i.id), ["g1", "B", "A"]);
    });

    test("members are ordered by their own recency", () => {
      const s = normalizeState({ items: [grp("g1", ["m1", "m2", "m3"])] });
      const [g] = displayLayout(s, ["m1", "m2", "m3"], t({ m1: 1, m2: 3, m3: 2 }));
      assert.deepEqual(g.members, ["m2", "m3", "m1"]);
    });

    test("empty groups sort first; sessions with no time sort last; ties keep state order", () => {
      const s = normalizeState({ items: [sess("A"), sess("B"), grp("e1", []), grp("e2", []), sess("C")] });
      const layout = displayLayout(s, ["A", "B", "C"], t({ C: 5 }));
      assert.deepEqual(layout.map((i) => i.id), ["e1", "e2", "C", "A", "B"]);
    });
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

describe("moveToGroup", () => {
  test("top-level session into a group appends to its members", () => {
    const s = normalizeState({ items: [sess("A"), grp("g1", ["m1"]), sess("B")] });
    const r = moveToGroup(s, "A", "g1");
    assert.deepEqual(r.items, [grp("g1", ["m1", "A"]), sess("B")]);
  });

  test("gid null ungroups a member back to top level (at end)", () => {
    const s = normalizeState({ items: [grp("g1", ["m1", "m2"]), sess("B")] });
    const r = moveToGroup(s, "m1", null);
    assert.deepEqual(r.items, [grp("g1", ["m2"]), sess("B"), sess("m1")]);
  });

  test("moves a member from one group to another", () => {
    const s = normalizeState({ items: [grp("g1", ["m1"]), grp("g2", [])] });
    const r = moveToGroup(s, "m1", "g2");
    assert.deepEqual(r.items, [grp("g1", []), grp("g2", ["m1"])]);
  });

  test("unknown gid falls back to top-level (session removed from old spot)", () => {
    const s = normalizeState({ items: [grp("g1", ["m1"]), sess("B")] });
    const r = moveToGroup(s, "m1", "nope");
    assert.deepEqual(r.items, [grp("g1", []), sess("B"), sess("m1")]);
  });
});

describe("decideStreamReconcile", () => {
  const cases = [
    // not streaming → mirror the bridge's busy onto the pill, ticks reset
    { name: "idle, bridge idle → sync idle", in: { activeStreaming: false, bridgeBusy: false, stuckTicks: 0 }, out: { action: "sync", busy: false, stuckTicks: 0 } },
    { name: "idle, bridge busy → sync busy", in: { activeStreaming: false, bridgeBusy: true, stuckTicks: 5 }, out: { action: "sync", busy: true, stuckTicks: 0 } },
    // healthy live stream: bridge busy while we stream → leave it, ticks reset
    { name: "streaming, bridge busy → none", in: { activeStreaming: true, bridgeBusy: true, stuckTicks: 1 }, out: { action: "none", stuckTicks: 0 } },
    // stuck stream: bridge idle while we still think we stream → arm, then heal
    { name: "streaming, bridge idle, first tick → arm", in: { activeStreaming: true, bridgeBusy: false, stuckTicks: 0 }, out: { action: "none", stuckTicks: 1 } },
    { name: "streaming, bridge idle, second tick → heal", in: { activeStreaming: true, bridgeBusy: false, stuckTicks: 1 }, out: { action: "heal", stuckTicks: 0 } },
    // unknown (bridge didn't answer): never idle, never a heal, ticks untouched
    { name: "not streaming, bridge unknown → none", in: { activeStreaming: false, bridgeBusy: null, stuckTicks: 0 }, out: { action: "none", stuckTicks: 0 } },
    { name: "streaming, bridge unknown → none, ticks kept", in: { activeStreaming: true, bridgeBusy: null, stuckTicks: 1 }, out: { action: "none", stuckTicks: 1 } },
    { name: "streaming, bridge unknown, never heals", in: { activeStreaming: true, bridgeBusy: null, stuckTicks: 5 }, out: { action: "none", stuckTicks: 5 } },
    { name: "stuckTicks defaults to 0", in: { activeStreaming: true, bridgeBusy: false }, out: { action: "none", stuckTicks: 1 } },
  ];
  for (const c of cases) {
    test(c.name, () => assert.deepEqual(decideStreamReconcile(c.in), c.out));
  }
});

describe("bucketByAge", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const now = 100 * DAY;
  const ago = (d) => now - d * DAY;
  const t = (o) => new Map(Object.entries(o));
  const keys = (secs) => secs.map((s) => [s.key, s.items.map((i) => i.id)]);

  test("splits at 2 and 7 days; boundaries belong to the older section", () => {
    const items = ["a", "b", "c", "d", "e"].map((id) => sess(id));
    const secs = bucketByAge(items, t({ a: ago(0), b: ago(1.9), c: ago(2), d: ago(6.9), e: ago(7) }), now);
    assert.deepEqual(keys(secs), [["recent", ["a", "b"]], ["week", ["c", "d"]], ["older", ["e"]]]);
  });

  test("omits empty sections and keeps incoming order within a section", () => {
    const secs = bucketByAge([sess("x"), sess("y")], t({ x: ago(10), y: ago(9) }), now);
    assert.deepEqual(keys(secs), [["older", ["x", "y"]]]);
  });

  test("a group sits in its newest member's section; an empty group is recent", () => {
    const items = [grp("g1", ["m1", "m2"]), grp("g2", ["m3"]), grp("e", [])];
    const secs = bucketByAge(items, t({ m1: ago(1), m2: ago(30), m3: ago(8) }), now);
    assert.deepEqual(keys(secs), [["recent", ["g1", "e"]], ["older", ["g2"]]]);
  });

  test("a session with no activity time is older", () => {
    assert.deepEqual(keys(bucketByAge([sess("z")], new Map(), now)), [["older", ["z"]]]);
  });

  test("returns the section labels", () => {
    const secs = bucketByAge([sess("a"), sess("b"), sess("c")], t({ a: ago(0), b: ago(3), c: ago(9) }), now);
    assert.deepEqual(secs.map((s) => s.label), ["Last 2 days", "Last 7 days", "Older"]);
  });
});
