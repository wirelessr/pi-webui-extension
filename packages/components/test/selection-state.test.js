import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { filterCommands } from "../src/commands.js";
import {
  createSelectionState,
  decideKeyAction,
  decideMobileViewOnFilter,
  decideMobileViewOnSelect,
  decideSendClick,
  findCommandToken,
  shouldSend,
} from "../src/selection-state.js";

const COMMANDS = [
  { name: "skill:gh", description: "GitHub CLI", source: "skill" },
  { name: "skill:jira", description: "Jira tickets", source: "skill" },
  { name: "compact", description: "Compact conversation", source: "builtin" },
  { name: "reload", description: "Reload extensions", source: "builtin" },
];

// ── createSelectionState ─────────────────────────────

describe("createSelectionState", () => {
  function setup(commands = COMMANDS) {
    const selected = [];
    const state = createSelectionState((cmd) => selected.push(cmd));
    state.setCommands(commands);
    return { state, selected };
  }

  test("initial state: no filter, index -1", () => {
    const { state } = setup();
    assert.equal(state.hasFilter(), false);
    assert.equal(state.getSelectedIndex(), -1);
    assert.equal(state.getFiltered().length, COMMANDS.length);
  });

  test("filter with query resets index to -1", () => {
    const { state } = setup();
    state.move(1); // -1 + 1 = 0
    assert.equal(state.getSelectedIndex(), 0);
    state.filter("skill", filterCommands);
    assert.equal(state.getSelectedIndex(), -1);
  });

  test("filter(null) shows all commands", () => {
    const { state } = setup();
    state.filter("skill", filterCommands);
    assert.equal(state.getFiltered().length, 2);
    state.filter(null, filterCommands);
    assert.equal(state.getFiltered().length, COMMANDS.length);
    assert.equal(state.hasFilter(), false);
  });

  test("hasFilter is true only when query is not null", () => {
    const { state } = setup();
    assert.equal(state.hasFilter(), false);
    state.filter("skill", filterCommands);
    assert.equal(state.hasFilter(), true);
    state.filter(null, filterCommands);
    assert.equal(state.hasFilter(), false);
  });

  test("move wraps forward", () => {
    const { state } = setup();
    state.move(1); // -1 + 1 = 0
    assert.equal(state.getSelectedIndex(), 0);
    state.move(1); // 1
    state.move(1); // 2
    state.move(1); // 3
    state.move(1); // wraps to 0
    assert.equal(state.getSelectedIndex(), 0);
  });

  test("move wraps backward from -1", () => {
    const { state } = setup();
    state.move(-1); // -1 - 1 + 4 = 2 (wraps to index 2)
    assert.equal(state.getSelectedIndex(), 2);
  });

  test("move on empty filtered list is no-op", () => {
    const { state } = setup();
    state.filter("nonexistent", filterCommands);
    state.move(1);
    assert.equal(state.getSelectedIndex(), -1);
  });

  test("select with valid index calls onSelect", () => {
    const { state, selected } = setup();
    state.move(1); // index 0
    state.select();
    assert.equal(selected.length, 1);
    assert.equal(selected[0].name, "skill:gh");
  });

  test("select with index -1 does not call onSelect", () => {
    const { state, selected } = setup();
    state.select();
    assert.equal(selected.length, 0);
  });

  test("select with out-of-bounds index does not call onSelect", () => {
    const { state, selected } = setup();
    state.filter("skill", filterCommands);
    state.move(1);
    state.move(1);
    state.move(1); // wraps in filtered list (len 2)
    state.select();
    assert.equal(selected.length, 1);
  });

  test("setCommands resets state", () => {
    const { state } = setup();
    state.filter("skill", filterCommands);
    state.move(1);
    state.setCommands([{ name: "newcmd", description: "", source: "builtin" }]);
    assert.equal(state.hasFilter(), false);
    assert.equal(state.getSelectedIndex(), -1);
    assert.equal(state.getFiltered().length, 1);
  });

  test("getCommands returns all available commands", () => {
    const { state } = setup();
    assert.equal(state.getCommands().length, COMMANDS.length);
    state.filter("skill", filterCommands);
    assert.equal(state.getCommands().length, COMMANDS.length);
  });
});

// ── decideKeyAction ───────────────────────────────────

describe("decideKeyAction", () => {
  const cases = [
    // Command picker mode (hasFilter=true)
    { name: "ArrowDown with filter → move:1", opts: { key: "ArrowDown", shiftKey: false, hasFilter: true, selectedIndex: 0 }, expected: "move:1" },
    { name: "ArrowUp with filter → move:-1", opts: { key: "ArrowUp", shiftKey: false, hasFilter: true, selectedIndex: 0 }, expected: "move:-1" },
    { name: "Enter with filter + selected → select", opts: { key: "Enter", shiftKey: false, hasFilter: true, selectedIndex: 0 }, expected: "select" },
    { name: "Tab with filter + selected → select", opts: { key: "Tab", shiftKey: false, hasFilter: true, selectedIndex: 0 }, expected: "select" },
    { name: "Enter with filter but no selection → send", opts: { key: "Enter", shiftKey: false, hasFilter: true, selectedIndex: -1 }, expected: "send" },
    { name: "Escape with filter → escape", opts: { key: "Escape", shiftKey: false, hasFilter: true, selectedIndex: -1 }, expected: "escape" },
    // Normal mode (hasFilter=false)
    { name: "Enter without filter → send", opts: { key: "Enter", shiftKey: false, hasFilter: false, selectedIndex: -1 }, expected: "send" },
    { name: "Enter+Shift without filter → passthrough", opts: { key: "Enter", shiftKey: true, hasFilter: false, selectedIndex: -1 }, expected: "passthrough" },
    { name: "Random key without filter → passthrough", opts: { key: "a", shiftKey: false, hasFilter: false, selectedIndex: -1 }, expected: "passthrough" },
    // Filter active but key is not a picker key
    { name: "a with filter → passthrough", opts: { key: "a", shiftKey: false, hasFilter: true, selectedIndex: -1 }, expected: "passthrough" },
    { name: "Enter+Shift with filter → passthrough", opts: { key: "Enter", shiftKey: true, hasFilter: true, selectedIndex: 0 }, expected: "passthrough" },
  ];
  for (const c of cases) {
    test(c.name, () => {
      assert.equal(decideKeyAction(c.opts), c.expected);
    });
  }
});

// ── decideMobileView ──────────────────────────────────

describe("decideMobileViewOnFilter", () => {
  const cases = [
    { name: "mobile + has token → commands", isMobile: true, hasToken: true, expected: "commands" },
    { name: "mobile + no token → null", isMobile: true, hasToken: false, expected: null },
    { name: "desktop + has token → null", isMobile: false, hasToken: true, expected: null },
    { name: "desktop + no token → null", isMobile: false, hasToken: false, expected: null },
  ];
  for (const c of cases) {
    test(c.name, () => {
      assert.equal(decideMobileViewOnFilter(c.isMobile, c.hasToken), c.expected);
    });
  }
});

describe("decideMobileViewOnSelect", () => {
  test("mobile → chat", () => {
    assert.equal(decideMobileViewOnSelect(true), "chat");
  });
  test("desktop → null", () => {
    assert.equal(decideMobileViewOnSelect(false), null);
  });
});

// ── decideSendClick ───────────────────────────────────

describe("decideSendClick", () => {
  test("streaming → stop", () => {
    assert.equal(decideSendClick(true), "stop");
  });
  test("not streaming → send", () => {
    assert.equal(decideSendClick(false), "send");
  });
});

// ── shouldSend ────────────────────────────────────────

describe("shouldSend", () => {
  const cases = [
    { name: "non-empty text, not streaming → true", text: "hello", isStreaming: false, expected: true },
    { name: "empty text → false", text: "", isStreaming: false, expected: false },
    { name: "whitespace text → false", text: "   ", isStreaming: false, expected: false },
    { name: "streaming → false", text: "hello", isStreaming: true, expected: false },
    { name: "empty + streaming → false", text: "", isStreaming: true, expected: false },
    { name: "streaming + allowWhileStreaming → true", text: "hello", isStreaming: true, allow: true, expected: true },
    { name: "empty + streaming + allowWhileStreaming → false", text: "  ", isStreaming: true, allow: true, expected: false },
  ];
  for (const c of cases) {
    test(c.name, () => {
      assert.equal(shouldSend(c.text, c.isStreaming, c.allow), c.expected);
    });
  }
});

// ── findCommandToken ─────────────────────────────────

describe("findCommandToken", () => {
  const cases = [
    { name: "/ at start → match", text: "/gh", cursor: 3, expected: { token: "/gh", start: 0, end: 3 } },
    { name: "/ at start, cursor mid-token → match", text: "/gh", cursor: 2, expected: { token: "/g", start: 0, end: 2 } },
    { name: "/ not at start → null", text: "hello /gh", cursor: 9, expected: null },
    { name: "no / at all → null", text: "hello", cursor: 5, expected: null },
    { name: "empty input → null", text: "", cursor: 0, expected: null },
    { name: "/ after newline → null", text: "hello\n/gh", cursor: 9, expected: null },
    { name: "bare / at start → match", text: "/", cursor: 1, expected: { token: "/", start: 0, end: 1 } },
    { name: "/ with space after → null", text: "/ hello", cursor: 7, expected: null },
  ];
  for (const c of cases) {
    test(c.name, () => {
      assert.deepEqual(findCommandToken(c.text, c.cursor), c.expected);
    });
  }
});
