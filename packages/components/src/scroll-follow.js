/**
 * Sticky auto-follow for a scrolling transcript pane — the single owner of
 * "should the viewport track new content, and when".
 *
 * WHY OBSERVER-DRIVEN, NOT CALL-SITE-DRIVEN:
 * The old design scattered ~15 scrollToBottom() calls across every render path
 * (text delta, tool block, thinking, file chips, history load, subagent view).
 * Any path that forgot to call it silently broke auto-follow — the queued-turn
 * attach/replay path did exactly that, and each missed path is its own latent
 * bug. Here a MutationObserver watches the transcript element: ANY content
 * growth, from ANY path (live send, queued dispatch, attach replay, subagent,
 * markdown reflow), triggers the same follow decision. Render code no longer
 * touches scrolling at all, so "forgot to scroll" is structurally impossible.
 *
 * ENGAGEMENT MODEL (unchanged from classifyScrollEvent, now centralized):
 * - At the bottom → engaged (follow content, hide the jump button).
 * - The user scrolls away (wheel-up, drag, or a scroll with no recent
 *   auto-scroll to explain it) → disengaged (stop following, show the button).
 * - Reaching the bottom again by any means → re-engaged.
 * A programmatic scroll we just performed must NOT be misread as the user
 * scrolling away, so away-from-bottom events within autoScrollWindowMs of our
 * last auto-scroll are ignored (they're our own scroll racing content growth).
 *
 * TESTABILITY: all browser primitives (MutationObserver, requestAnimationFrame,
 * performance.now) are injected, so unit tests drive the state machine with
 * fakes and assert on awaited results — no real timers, no flake.
 *
 * @param {object} opts
 * @param {HTMLElement} opts.$chat — the scroll container (has scrollTop/scrollHeight/clientHeight)
 * @param {HTMLElement} opts.$messages — the transcript element whose growth drives follow
 * @param {HTMLElement} [opts.$button] — the "scroll to bottom" button (hidden while engaged)
 * @param {number} [opts.threshold=60] — "at bottom" tolerance in px
 * @param {number} [opts.autoScrollWindowMs=150] — how recent our auto-scroll must be to own an event
 * @param {number} [opts.logSize=200] — ring-buffer capacity for the diagnostic log
 * @param {() => number} [opts.now] — injected clock (default performance.now)
 * @param {(cb: Function) => any} [opts.raf] — injected frame scheduler (default requestAnimationFrame)
 * @param {(el: HTMLElement, cb: Function) => {disconnect: Function}} [opts.observe] — injected DOM-mutation observer
 */
export function createScrollFollow({
  $chat,
  $messages,
  $button = null,
  threshold = 60,
  autoScrollWindowMs = 150,
  logSize = 200,
  now = () => performance.now(),
  raf = (cb) => requestAnimationFrame(cb),
  observe = defaultObserve,
}) {
  let engaged = true; // following the bottom
  let lastAutoScrollAt = -Infinity; // now() of our last programmatic scrollTop write
  let touchActive = false; // finger down (touch scroll)
  let dragActive = false; // mouse button down (scrollbar drag)
  let active = true; // false while an overlay covers the transcript
  let scrollPending = false; // a scroll is already scheduled for the next frame

  // Ring-buffer diagnostic log. Every state transition and follow decision is
  // recorded with the geometry that drove it — dump via getLog() when an
  // auto-scroll anomaly needs explaining, instead of guessing.
  const logBuf = [];
  function record(event, extra) {
    logBuf.push({ t: Math.round(now()), event, engaged, ...extra });
    if (logBuf.length > logSize) logBuf.shift();
  }

  function gap() {
    return $chat.scrollHeight - $chat.scrollTop - $chat.clientHeight;
  }

  function setEngaged(v, reason) {
    if (engaged !== v) {
      engaged = v;
      record(v ? "engage" : "disengage", { reason });
    }
    // The button mirrors ENGAGEMENT, not instantaneous geometry — while
    // following, the gap is transiently non-zero between content growth and the
    // next frame's scroll, and the button must not flicker.
    if ($button) $button.classList.toggle("hidden", engaged);
  }

  // Perform the scroll on the next frame. Re-check engagement at fire time: a
  // wheel-up may have disengaged between scheduling and running, and scrolling
  // then would yank the user back down and re-engage off our own event.
  // Deduped: many content mutations in one frame (streaming deltas) coalesce
  // into a single scroll, so the high-frequency render path never schedules a
  // storm of redundant frames.
  function scheduleScroll(reason) {
    if (scrollPending) return;
    scrollPending = true;
    raf(() => {
      scrollPending = false;
      if (!engaged || !active) {
        record("skip-scroll", { reason, why: !active ? "inactive" : "disengaged" });
        return;
      }
      lastAutoScrollAt = now();
      $chat.scrollTop = $chat.scrollHeight;
      record("auto-scroll", { reason });
    });
  }

  // ── Public API ──

  // Content-growth hook (observer + manual nudge): follow only if engaged.
  function follow(reason = "mutation") {
    if (!engaged || !active) return;
    scheduleScroll(reason);
  }

  // Force the viewport to the bottom and re-engage — for genuinely
  // user-initiated jumps (the user sent a message, opened a view, clicked the
  // jump button) where "take me to the newest content" is the intent.
  function jumpToBottom(reason = "jump") {
    setEngaged(true, reason);
    scheduleScroll(reason);
  }

  // A raw scroll event on the pane. Classifies into engage / disengage / ignore
  // using the same rules the old classifyScrollEvent encoded.
  function handleScroll() {
    const g = gap();
    if (g < threshold) {
      setEngaged(true, "at-bottom");
      return;
    }
    if (touchActive || dragActive || now() - lastAutoScrollAt > autoScrollWindowMs) {
      setEngaged(false, "user-scroll-away");
      return;
    }
    record("ignore-scroll", { gap: Math.round(g) }); // our own scroll racing growth
  }

  function noteWheel(deltaY) {
    // Wheel-up is an unambiguous user gesture; its scroll event alone can't be
    // told apart from ours mid-stream, so disengage immediately.
    if (deltaY < 0) setEngaged(false, "wheel-up");
  }

  function setTouch(v) { touchActive = v; }
  function setDrag(v) { dragActive = v; }

  // Overlay covered / uncovered the transcript. While inactive, content growth
  // must not scroll the (hidden) transcript; on uncover we don't auto-jump —
  // the overlay manager restores the prior scrollTop.
  function setActive(v) {
    active = v;
    record(v ? "activate" : "deactivate");
  }

  // Session switch / history reload: reset to the default (engaged at bottom).
  function reset(reason = "reset") {
    touchActive = false;
    dragActive = false;
    active = true;
    lastAutoScrollAt = -Infinity;
    setEngaged(true, reason);
  }

  // Wire the observer once. Every childList/character/subtree mutation of the
  // transcript is a content change → follow() decides whether to track it.
  const observer = observe($messages, () => follow("mutation"));

  return {
    follow,
    jumpToBottom,
    handleScroll,
    noteWheel,
    setTouch,
    setDrag,
    setActive,
    reset,
    isEngaged: () => engaged,
    getLog: () => logBuf.slice(),
    disconnect: () => observer.disconnect(),
  };
}

// Default MutationObserver wiring, batched by the platform into a microtask.
function defaultObserve(el, cb) {
  const mo = new MutationObserver(cb);
  mo.observe(el, { childList: true, subtree: true, characterData: true });
  return mo;
}
