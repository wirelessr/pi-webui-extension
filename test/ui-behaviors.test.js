import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { clampMenuPosition, decideSessionClick, doCopy } from "../http-bridge-web/ui-behaviors.js";

// ── doCopy ────────────────────────────────────────────

describe("doCopy", () => {
  test("clipboard API available → uses clipboard method", async () => {
    let copiedText = null;
    const result = await doCopy({
      text: "hello world",
      writeTextFn: async (t) => { copiedText = t; },
      execCommandFn: () => {},
      createTextareaFn: () => { throw new Error("should not call"); },
      removeTextareaFn: () => {},
    });
    assert.equal(result.ok, true);
    assert.equal(result.method, "clipboard");
    assert.equal(copiedText, "hello world");
  });

  test("clipboard API missing → falls back to execCommand", async () => {
    let copied = false;
    const ta = { value: "", select: () => { copied = true; } };
    const result = await doCopy({
      text: "fallback text",
      writeTextFn: undefined,
      execCommandFn: () => {},
      createTextareaFn: () => ta,
      removeTextareaFn: () => {},
    });
    assert.equal(result.ok, true);
    assert.equal(result.method, "execCommand");
    assert.equal(copied, true);
    assert.equal(ta.value, "fallback text");
  });

  test("both APIs missing → ok=false", async () => {
    const result = await doCopy({
      text: "test",
      writeTextFn: undefined,
      execCommandFn: undefined,
      createTextareaFn: () => {},
      removeTextareaFn: () => {},
    });
    assert.equal(result.ok, false);
    assert.equal(result.method, null);
  });

  test("clipboard API throws → does NOT fall back to execCommand", async () => {
    let execCalled = false;
    const result = await doCopy({
      text: "test",
      writeTextFn: async () => { throw new Error("permission denied"); },
      execCommandFn: () => { execCalled = true; },
      createTextareaFn: () => {},
      removeTextareaFn: () => {},
    });
    assert.equal(result.ok, false);
    assert.equal(result.method, null);
    assert.equal(execCalled, false);
  });

  test("execCommand throws → swallowed, ok=false", async () => {
    const result = await doCopy({
      text: "test",
      writeTextFn: undefined,
      execCommandFn: () => { throw new Error("not supported"); },
      createTextareaFn: () => ({ value: "", select: () => {} }),
      removeTextareaFn: () => {},
    });
    assert.equal(result.ok, false);
  });

  test("empty text → still attempts copy (no special handling)", async () => {
    let copiedText = "unchanged";
    const result = await doCopy({
      text: "",
      writeTextFn: async (t) => { copiedText = t; },
      execCommandFn: () => {},
      createTextareaFn: () => {},
      removeTextareaFn: () => {},
    });
    assert.equal(result.ok, true);
    assert.equal(copiedText, "");
  });
});

// ── decideSessionClick ────────────────────────────────

describe("decideSessionClick", () => {
  const cases = [
    { name: "qr-btn → qr", targetClass: "qr-btn", expected: "qr" },
    { name: "close-btn → close", targetClass: "close-btn", expected: "close" },
    { name: "session-item → open", targetClass: "session-item", expected: "open" },
    { name: "item-name → open", targetClass: "item-name", expected: "open" },
    { name: "empty class → open", targetClass: "", expected: "open" },
    { name: "null class → open", targetClass: null, expected: "open" },
    { name: "multi-class with qr-btn → qr", targetClass: "btn qr-btn active", expected: "qr" },
    { name: "multi-class with close-btn → close", targetClass: "btn close-btn primary", expected: "close" },
  ];
  for (const c of cases) {
    test(c.name, () => {
      assert.equal(decideSessionClick({ targetClass: c.targetClass }), c.expected);
    });
  }
});

// ── clampMenuPosition ─────────────────────────────────

describe("clampMenuPosition", () => {
  const VW = 1920;
  const VH = 1080;

  test("no clamping needed when within viewport", () => {
    const pos = clampMenuPosition(100, 200, VW, VH);
    assert.equal(pos.left, 100);
    assert.equal(pos.top, 200);
  });

  test("clamps left when too close to right edge", () => {
    const pos = clampMenuPosition(1800, 200, VW, VH);
    assert.equal(pos.left, 1920 - 200);
    assert.equal(pos.top, 200);
  });

  test("clamps top when too close to bottom edge", () => {
    const pos = clampMenuPosition(100, 1000, VW, VH);
    assert.equal(pos.left, 100);
    assert.equal(pos.top, 1080 - 150);
  });

  test("clamps both when near bottom-right corner", () => {
    const pos = clampMenuPosition(1800, 1000, VW, VH);
    assert.equal(pos.left, 1720);
    assert.equal(pos.top, 930);
  });

  test("custom menu dimensions", () => {
    const pos = clampMenuPosition(900, 900, 1000, 1000, 300, 200);
    assert.equal(pos.left, 700);
    assert.equal(pos.top, 800);
  });

  test("exact edge position", () => {
    const pos = clampMenuPosition(VW - 200, VH - 150, VW, VH);
    assert.equal(pos.left, VW - 200);
    assert.equal(pos.top, VH - 150);
  });

  test("zero position", () => {
    const pos = clampMenuPosition(0, 0, VW, VH);
    assert.equal(pos.left, 0);
    assert.equal(pos.top, 0);
  });
});
