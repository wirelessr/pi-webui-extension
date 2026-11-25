import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createOverlayManager } from "../src/overlay-manager.js";

function makeHarness() {
  const $chat = { scrollTop: 500 };
  const $messages = { style: { display: "" } };
  const mgr = createOverlayManager({ $chat, $messages });
  const makeView = (name) => {
    const view = { name, closeCalls: 0 };
    view.handle = {
      close: () => {
        view.closeCalls++;
        mgr.closed(view.handle);
      },
    };
    return view;
  };
  return { $chat, $messages, mgr, makeView };
}

describe("createOverlayManager", () => {
  test("open hides the transcript and saves scroll; closed restores both", () => {
    const { $chat, $messages, mgr, makeView } = makeHarness();
    const a = makeView("a");
    mgr.open(a.handle);
    assert.equal($messages.style.display, "none");
    assert.equal(mgr.getCurrent(), a.handle);
    $chat.scrollTop = 0; // view scrolled its own content
    mgr.closed(a.handle);
    assert.equal($messages.style.display, "");
    assert.equal($chat.scrollTop, 500);
    assert.equal(mgr.getCurrent(), null);
  });

  test("opening a second view closes the first", () => {
    const { $messages, mgr, makeView } = makeHarness();
    const a = makeView("a");
    const b = makeView("b");
    mgr.open(a.handle);
    mgr.open(b.handle);
    assert.equal(a.closeCalls, 1);
    assert.equal(mgr.getCurrent(), b.handle);
    assert.equal($messages.style.display, "none");
  });

  test("scroll position survives an overlay-to-overlay switch", () => {
    const { $chat, mgr, makeView } = makeHarness();
    const a = makeView("a");
    const b = makeView("b");
    mgr.open(a.handle);
    $chat.scrollTop = 0;
    mgr.open(b.handle); // a closes (restores 500), b saves 500
    $chat.scrollTop = 0;
    mgr.closed(b.handle);
    assert.equal($chat.scrollTop, 500);
  });

  test("re-opening the current view is a no-op", () => {
    const { mgr, makeView } = makeHarness();
    const a = makeView("a");
    mgr.open(a.handle);
    mgr.open(a.handle);
    assert.equal(a.closeCalls, 0);
    assert.equal(mgr.getCurrent(), a.handle);
  });

  test("closed() from a non-current view is ignored", () => {
    const { $messages, mgr, makeView } = makeHarness();
    const a = makeView("a");
    const b = makeView("b");
    mgr.open(a.handle);
    mgr.closed(b.handle);
    assert.equal($messages.style.display, "none");
    assert.equal(mgr.getCurrent(), a.handle);
  });

  test("closeAll closes the current view; no-op when nothing open", () => {
    const { $messages, mgr, makeView } = makeHarness();
    mgr.closeAll();
    const a = makeView("a");
    mgr.open(a.handle);
    mgr.closeAll();
    assert.equal(a.closeCalls, 1);
    assert.equal($messages.style.display, "");
    assert.equal(mgr.getCurrent(), null);
  });
});
