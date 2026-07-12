import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  clampSidebarWidth,
  computeResizeWidth,
  loadSidebarWidth,
  MAX_SIDEBAR_W,
  MIN_SIDEBAR_W,
  saveSidebarWidth,
} from "../http-bridge-web/resize.js";

describe("clampSidebarWidth", () => {
  const cases = [
    { input: 300, expected: 300 },
    { input: 160, expected: 160 },
    { input: 150, expected: 160 },
    { input: 100, expected: 160 },
    { input: 500, expected: 500 },
    { input: 600, expected: 500 },
    { input: 220, expected: 220 },
  ];
  for (const { input, expected } of cases) {
    test(`clamps ${input} → ${expected}`, () => {
      assert.equal(clampSidebarWidth(input), expected);
    });
  }

  test("returns default for NaN", () => {
    assert.equal(clampSidebarWidth(NaN), 220);
  });

  test("returns default for non-number", () => {
    assert.equal(clampSidebarWidth("abc"), 220);
    assert.equal(clampSidebarWidth(undefined), 220);
    assert.equal(clampSidebarWidth(null), 220);
  });
});

describe("computeResizeWidth", () => {
  test("adds positive delta", () => {
    assert.equal(computeResizeWidth(100, 220, 150), 270);
  });

  test("subtracts negative delta", () => {
    assert.equal(computeResizeWidth(100, 220, 50), 170);
  });

  test("clamps to min", () => {
    assert.equal(computeResizeWidth(100, 220, -200), 160);
  });

  test("clamps to max", () => {
    assert.equal(computeResizeWidth(100, 220, 400), 500);
  });

  test("zero delta returns same width", () => {
    assert.equal(computeResizeWidth(100, 220, 100), 220);
  });
});

describe("loadSidebarWidth", () => {
  test("returns saved value within range", () => {
    assert.equal(loadSidebarWidth(() => "300"), 300);
  });

  test("clamps saved value below min", () => {
    assert.equal(loadSidebarWidth(() => "50"), 160);
  });

  test("clamps saved value above max", () => {
    assert.equal(loadSidebarWidth(() => "999"), 500);
  });

  test("returns default when no saved value", () => {
    assert.equal(loadSidebarWidth(() => null), 220);
    assert.equal(loadSidebarWidth(() => undefined), 220);
  });

  test("returns default for non-numeric saved value", () => {
    assert.equal(loadSidebarWidth(() => "abc"), 220);
  });

  test("returns default when getItem is undefined", () => {
    assert.equal(loadSidebarWidth(undefined), 220);
  });
});

describe("saveSidebarWidth", () => {
  test("saves clamped value as string", () => {
    let saved = null;
    saveSidebarWidth(300, (k, v) => { saved = { key: k, value: v }; });
    assert.equal(saved.key, "pi-webui-sidebar-w");
    assert.equal(saved.value, "300");
  });

  test("clamps before saving", () => {
    let saved = null;
    saveSidebarWidth(50, (_k, v) => { saved = v; });
    assert.equal(saved, "160");
  });

  test("does nothing when setItem is undefined", () => {
    saveSidebarWidth(300, undefined);
    // no throw
  });
});

describe("constants", () => {
  test("MIN and MAX are sensible", () => {
    assert.equal(MIN_SIDEBAR_W, 160);
    assert.equal(MAX_SIDEBAR_W, 500);
    assert.ok(MIN_SIDEBAR_W < MAX_SIDEBAR_W);
  });
});
