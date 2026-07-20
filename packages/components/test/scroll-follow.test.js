import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createScrollFollow } from "../src/scroll-follow.js";

// ── Fakes ─────────────────────────────────────────────
//
// A fake scroll container + transcript whose geometry we control, a manual
// clock, a synchronous raf (runs the callback immediately so we can assert on
// results, not timers), and a manual observer whose callback we fire by hand.

function makeHarness({ scrollHeight = 1000, clientHeight = 500, threshold, autoScrollWindowMs } = {}) {
  const $chat = { scrollTop: 500, scrollHeight, clientHeight }; // gap = 0 → at bottom
  const $messages = {};
  const buttonClasses = new Set(["hidden"]);
  const $button = { classList: { toggle: (c, on) => (on ? buttonClasses.add(c) : buttonClasses.delete(c)) } };

  let clock = 1000;
  const now = () => clock;
  const advance = (ms) => { clock += ms; };

  // Synchronous raf: invoke immediately so scrollTop writes are observable now.
  const rafCalls = [];
  const raf = (cb) => { rafCalls.push(cb); cb(); };

  let observerCb = null;
  let disconnected = false;
  const observe = (_el, cb) => { observerCb = cb; return { disconnect: () => { disconnected = true; } }; };

  const sf = createScrollFollow({
    $chat, $messages, $button,
    ...(threshold != null ? { threshold } : {}),
    ...(autoScrollWindowMs != null ? { autoScrollWindowMs } : {}),
    now, raf, observe,
  });

  return {
    sf, $chat, $button,
    buttonHidden: () => buttonClasses.has("hidden"),
    advance,
    // simulate content growing taller (assistant streaming more text)
    grow: (px) => { $chat.scrollHeight += px; },
    // fire the DOM mutation observer callback (content changed)
    mutate: () => observerCb(),
    // set the current gap directly
    setGap: (g) => { $chat.scrollTop = $chat.scrollHeight - g - $chat.clientHeight; },
    isDisconnected: () => disconnected,
  };
}

describe("createScrollFollow — engagement defaults", () => {
  test("starts engaged (following) with the button hidden", () => {
    const h = makeHarness();
    assert.equal(h.sf.isEngaged(), true);
    assert.equal(h.buttonHidden(), true);
  });
});

describe("follow() — content growth while engaged", () => {
  test("engaged: growing content scrolls to the new bottom", () => {
    const h = makeHarness();
    h.grow(300); // transcript got taller; not yet scrolled
    h.mutate(); // observer fires
    assert.equal(h.$chat.scrollTop, h.$chat.scrollHeight); // pinned to bottom
  });

  test("disengaged: growing content does NOT scroll", () => {
    const h = makeHarness();
    // user scrolls up far from bottom, no recent auto-scroll → disengage
    h.setGap(400);
    h.advance(500);
    h.sf.handleScroll();
    assert.equal(h.sf.isEngaged(), false);
    const before = h.$chat.scrollTop;
    h.grow(300);
    h.mutate();
    assert.equal(h.$chat.scrollTop, before); // stayed put
  });

  test("manual follow() is a no-op when disengaged", () => {
    const h = makeHarness();
    h.setGap(400); h.advance(500); h.sf.handleScroll();
    const before = h.$chat.scrollTop;
    h.sf.follow("manual");
    assert.equal(h.$chat.scrollTop, before);
  });
});

describe("handleScroll — classification", () => {
  test("scrolling back to the bottom re-engages", () => {
    const h = makeHarness();
    h.setGap(400); h.advance(500); h.sf.handleScroll();
    assert.equal(h.sf.isEngaged(), false);
    h.setGap(0); h.sf.handleScroll();
    assert.equal(h.sf.isEngaged(), true);
    assert.equal(h.buttonHidden(), true);
  });

  test("away-from-bottom with a RECENT auto-scroll is ignored (our own scroll)", () => {
    const h = makeHarness();
    // auto-scroll happened just now (mutate → auto-scroll sets lastAutoScrollAt)
    h.grow(300); h.mutate();
    // content grew again; a scroll event fires reading a transient gap
    h.setGap(120);
    h.advance(50); // within the 150ms window
    h.sf.handleScroll();
    assert.equal(h.sf.isEngaged(), true); // not disengaged by our own scroll
  });

  test("touch drag away from bottom disengages even within the auto-scroll window", () => {
    const h = makeHarness();
    h.grow(100); h.mutate(); // recent auto-scroll
    h.sf.setTouch(true);
    h.setGap(120);
    h.advance(10); // within window, but touch is active
    h.sf.handleScroll();
    assert.equal(h.sf.isEngaged(), false);
  });

  test("scrollbar drag away from bottom disengages", () => {
    const h = makeHarness();
    h.grow(100); h.mutate();
    h.sf.setDrag(true);
    h.setGap(120); h.advance(10);
    h.sf.handleScroll();
    assert.equal(h.sf.isEngaged(), false);
  });

  test("custom threshold governs the at-bottom tolerance", () => {
    const h = makeHarness({ threshold: 200 });
    h.setGap(150); h.advance(500); h.sf.handleScroll();
    assert.equal(h.sf.isEngaged(), true); // 150 < 200 → still "at bottom"
  });
});

describe("noteWheel", () => {
  test("wheel-up disengages immediately", () => {
    const h = makeHarness();
    h.sf.noteWheel(-120);
    assert.equal(h.sf.isEngaged(), false);
  });
  test("wheel-down does not disengage", () => {
    const h = makeHarness();
    h.sf.noteWheel(120);
    assert.equal(h.sf.isEngaged(), true);
  });
});

describe("jumpToBottom — user intent to see newest", () => {
  test("re-engages and scrolls even from disengaged", () => {
    const h = makeHarness();
    h.sf.noteWheel(-120); // disengage
    assert.equal(h.sf.isEngaged(), false);
    h.sf.jumpToBottom("send");
    assert.equal(h.sf.isEngaged(), true);
    assert.equal(h.$chat.scrollTop, h.$chat.scrollHeight);
  });
});

describe("setActive — overlay covering the transcript", () => {
  test("inactive: content growth does not scroll the hidden transcript", () => {
    const h = makeHarness();
    h.sf.setActive(false);
    const before = h.$chat.scrollTop;
    h.grow(300); h.mutate();
    assert.equal(h.$chat.scrollTop, before);
  });
  test("reactivating and growing resumes following", () => {
    const h = makeHarness();
    h.sf.setActive(false);
    h.sf.setActive(true);
    h.grow(300); h.mutate();
    assert.equal(h.$chat.scrollTop, h.$chat.scrollHeight);
  });
  test("jumpToBottom while inactive re-engages but does not scroll", () => {
    const h = makeHarness();
    h.sf.setActive(false);
    const before = h.$chat.scrollTop;
    h.sf.jumpToBottom("x");
    assert.equal(h.sf.isEngaged(), true);
    assert.equal(h.$chat.scrollTop, before);
  });
});

describe("reset — session switch / history reload", () => {
  test("clears disengage + drag/touch and returns to engaged", () => {
    const h = makeHarness();
    h.sf.noteWheel(-120);
    h.sf.setTouch(true);
    h.sf.setDrag(true);
    h.sf.reset();
    assert.equal(h.sf.isEngaged(), true);
    // touch/drag cleared: an away scroll long after reset disengages normally
    h.setGap(400); h.advance(500); h.sf.handleScroll();
    assert.equal(h.sf.isEngaged(), false);
  });
});

// ── The reported bug as a regression test ──
// User scrolls up mid-turn (disengage), scrolls back to the bottom before the
// queued turn dispatches (re-engage), then the queued turn streams content.
// The queued turn's growth must be followed — this is exactly the path that
// used to break because the attach/replay render never called scrollToBottom.
describe("regression: scroll-up → back-to-bottom → queued turn follows", () => {
  test("queued-turn growth is tracked after returning to the bottom", () => {
    const h = makeHarness();
    // turn1 streaming; user scrolls up to read
    h.setGap(500); h.advance(500); h.sf.handleScroll();
    assert.equal(h.sf.isEngaged(), false);
    // user scrolls back down to the end of turn1
    h.setGap(0); h.sf.handleScroll();
    assert.equal(h.sf.isEngaged(), true);
    // queued turn2 dispatches and streams: content grows repeatedly
    for (let i = 0; i < 5; i++) { h.grow(200); h.mutate(); }
    assert.equal(h.$chat.scrollTop, h.$chat.scrollHeight); // followed all the way
    assert.equal(h.buttonHidden(), true);
  });
});

describe("getLog — diagnostics", () => {
  test("records transitions and auto-scrolls", () => {
    const h = makeHarness();
    h.grow(100); h.mutate(); // auto-scroll
    h.sf.noteWheel(-120); // disengage
    const log = h.sf.getLog();
    assert.ok(log.some((e) => e.event === "auto-scroll"));
    assert.ok(log.some((e) => e.event === "disengage" && e.reason === "wheel-up"));
  });

  test("ring buffer is capped at logSize", () => {
    const h = makeHarness();
    // logSize default 200; generate > 200 events (each mutate = 1 auto-scroll record)
    for (let i = 0; i < 250; i++) { h.grow(1); h.mutate(); }
    assert.ok(h.sf.getLog().length <= 200);
  });

  test("logFn receives state TRANSITIONS but not per-frame auto-scrolls", () => {
    const sent = [];
    const $chat = { scrollTop: 500, scrollHeight: 1000, clientHeight: 500 };
    const sf = createScrollFollow({
      $chat, $messages: {},
      logFn: (level, message, data) => sent.push({ level, message, data }),
      now: () => 0, raf: (cb) => cb(), observe: () => ({ disconnect() {} }),
    });
    $chat.scrollHeight = 1400; sf.follow("mutation"); // an auto-scroll (high-frequency)
    sf.noteWheel(-120); // disengage — a transition
    sf.setActive(false); // deactivate — a transition
    const messages = sent.map((s) => s.message);
    assert.ok(messages.includes("scroll: disengage"), "transition forwarded");
    assert.ok(messages.includes("scroll: deactivate"), "transition forwarded");
    assert.ok(!messages.includes("scroll: auto-scroll"), "per-frame auto-scroll NOT forwarded");
  });

  test("skip-scroll is recorded when a scheduled scroll fires while disengaged", () => {
    // raf here is deferred so we can disengage between schedule and fire.
    const $chat = { scrollTop: 500, scrollHeight: 1000, clientHeight: 500 };
    let pending = null;
    const sf = createScrollFollow({
      $chat, $messages: {},
      now: () => 1000,
      raf: (cb) => { pending = cb; },
      observe: () => ({ disconnect() {} }),
    });
    sf.follow("x"); // schedules (engaged) but doesn't run yet
    sf.noteWheel(-120); // disengage before the frame fires
    pending(); // frame runs → should skip
    assert.ok(sf.getLog().some((e) => e.event === "skip-scroll" && e.why === "disengaged"));
  });

  test("skip-scroll records inactive when overlay covered the transcript mid-frame", () => {
    const $chat = { scrollTop: 500, scrollHeight: 1000, clientHeight: 500 };
    let pending = null;
    const sf = createScrollFollow({
      $chat, $messages: {},
      now: () => 1000,
      raf: (cb) => { pending = cb; },
      observe: () => ({ disconnect() {} }),
    });
    sf.jumpToBottom("x"); // engaged + schedules
    sf.setActive(false); // overlay covers before the frame fires
    pending();
    assert.ok(sf.getLog().some((e) => e.event === "skip-scroll" && e.why === "inactive"));
  });
});

describe("raf dedupe — high-frequency streaming", () => {
  test("many mutations in one frame coalesce into a single scroll", () => {
    const $chat = { scrollTop: 500, scrollHeight: 1000, clientHeight: 500 };
    const frames = [];
    const sf = createScrollFollow({
      $chat, $messages: {},
      now: () => 0,
      raf: (cb) => { frames.push(cb); }, // deferred: collect, don't run
      observe: () => ({ disconnect() {} }),
    });
    // simulate 10 content mutations before the frame runs
    for (let i = 0; i < 10; i++) sf.follow("mutation");
    assert.equal(frames.length, 1, "only one frame scheduled for the burst");
    $chat.scrollHeight = 2000;
    frames[0]();
    assert.equal($chat.scrollTop, 2000);
    // a new mutation after the frame fired schedules a fresh frame
    sf.follow("mutation");
    assert.equal(frames.length, 2);
  });
});

describe("disconnect", () => {
  test("tears down the observer", () => {
    const h = makeHarness();
    h.sf.disconnect();
    assert.equal(h.isDisconnected(), true);
  });
});

describe("no button provided", () => {
  test("engagement toggles without a button element", () => {
    const sf = createScrollFollow({
      $chat: { scrollTop: 500, scrollHeight: 1000, clientHeight: 500 },
      $messages: {},
      now: () => 1000, raf: (cb) => cb(), observe: () => ({ disconnect() {} }),
    });
    sf.noteWheel(-120);
    assert.equal(sf.isEngaged(), false);
    sf.jumpToBottom();
    assert.equal(sf.isEngaged(), true);
  });
});

describe("defaultObserve — real MutationObserver wiring", () => {
  // node has no MutationObserver; stub the global so the default (non-injected)
  // observe path actually runs, driving its content-change callback.
  test("wires a MutationObserver that fires follow() on mutation", () => {
    const observed = [];
    let firedCb = null;
    globalThis.MutationObserver = class {
      constructor(cb) { firedCb = cb; }
      observe(el, opts) { observed.push({ el, opts }); }
      disconnect() { observed.push("disconnect"); }
    };
    try {
      const $chat = { scrollTop: 500, scrollHeight: 1000, clientHeight: 500 };
      const $messages = {};
      const sf = createScrollFollow({ $chat, $messages, now: () => 0, raf: (cb) => cb() });
      // observe() was called with subtree/childList/characterData
      assert.equal(observed[0].opts.childList, true);
      assert.equal(observed[0].opts.subtree, true);
      assert.equal(observed[0].opts.characterData, true);
      // firing the observer callback follows content to the bottom
      $chat.scrollHeight = 1400;
      firedCb();
      assert.equal($chat.scrollTop, 1400);
      sf.disconnect();
      assert.ok(observed.includes("disconnect"));
    } finally {
      delete globalThis.MutationObserver;
    }
  });
});
