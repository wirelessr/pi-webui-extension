/**
 * Misc UI behavior — injectable functions for clipboard, click routing,
 * and menu positioning. Extracted from context-menu.js and sessions.js.
 */

/**
 * Copy text to clipboard with fallback to execCommand.
 *
 * Behavioral spec:
 * 1. If clipboard API (writeTextFn) is available → use it
 * 2. Otherwise → use textarea + execCommand fallback
 * 3. If writeTextFn throws → does NOT fall back (current behavior)
 * 4. All errors are silently swallowed
 *
 * @param {object} opts
 * @param {string} opts.text — text to copy
 * @param {function} [opts.writeTextFn] — navigator.clipboard.writeText
 * @param {function} [opts.execCommandFn] — document.execCommand
 * @param {function} opts.createTextareaFn — () => element with value/select
 * @param {function} opts.removeTextareaFn — (el) => void
 * @returns {Promise<{ok: boolean, method: string|null}>}
 */
export async function doCopy(opts) {
  const { text, writeTextFn, execCommandFn, createTextareaFn, removeTextareaFn } = opts;
  try {
    if (writeTextFn) {
      await writeTextFn(text);
      return { ok: true, method: "clipboard" };
    }
    if (execCommandFn) {
      const ta = createTextareaFn();
      ta.value = text;
      ta.select();
      execCommandFn("copy");
      removeTextareaFn(ta);
      return { ok: true, method: "execCommand" };
    }
    return { ok: false, method: null };
  } catch {
    return { ok: false, method: null };
  }
}

/**
 * Decide which action to take when clicking a session item.
 *
 * @param {object} opts
 * @param {string} opts.targetClass — classList of clicked element
 * @param {string} [opts.targetTag] — tag name (not currently used but available)
 * @returns {"qr"|"close"|"open"|null}
 */
export function decideSessionClick(opts) {
  const { targetClass } = opts;
  if (targetClass?.includes("qr-btn")) return "qr";
  if (targetClass?.includes("close-btn")) return "close";
  return "open";
}

/**
 * Clamp menu position to stay within viewport.
 *
 * @param {number} clientX
 * @param {number} clientY
 * @param {number} viewportWidth
 * @param {number} viewportHeight
 * @param {number} [menuWidth=200]
 * @param {number} [menuHeight=150]
 * @returns {{left: number, top: number}}
 */
export function clampMenuPosition(clientX, clientY, viewportWidth, viewportHeight, menuWidth = 200, menuHeight = 150) {
  return {
    left: Math.min(clientX, viewportWidth - menuWidth),
    top: Math.min(clientY, viewportHeight - menuHeight),
  };
}

/**
 * Classify one scroll event of the chat pane for the auto-follow (sticky
 * scroll) state machine.
 *
 * Scroll events carry no origin, and the "flag one programmatic scroll,
 * swallow one event" trick desyncs both ways: a no-op scrollTop assignment
 * produces NO event (the flag then swallows a real user scroll), and a
 * programmatic scroll's event can arrive AFTER content grew again (its
 * geometry then reads as "user scrolled away" and kills the follow). So:
 *
 * - AT the bottom → always engage. Reaching the bottom by any means (user,
 *   auto-scroll, layout shrink) resumes following and hides the button.
 * - AWAY from the bottom → disengage only when the event is plausibly
 *   user-driven: a touch drag or scrollbar drag is in progress, or there has
 *   been no auto-scroll recently (an idle pane can't scroll by itself).
 *   During active following, away-from-bottom events are our own scrolls
 *   racing content growth — ignore them; the next frame catches up.
 *
 * @param {object} opts
 * @param {number} opts.gap — scrollHeight - scrollTop - clientHeight at event time
 * @param {number} opts.sinceAutoScrollMs — ms since the last programmatic scrollTop assignment
 * @param {boolean} [opts.touchActive] — a touch gesture is in progress
 * @param {boolean} [opts.dragActive] — a mouse button is down over the pane (scrollbar drag)
 * @param {number} [opts.threshold] — "at bottom" tolerance in px
 * @param {number} [opts.autoScrollWindowMs] — how recent an auto-scroll must be to claim the event
 * @returns {"engage"|"disengage"|"ignore"}
 */
export function classifyScrollEvent({ gap, sinceAutoScrollMs, touchActive = false, dragActive = false, threshold = 60, autoScrollWindowMs = 150 }) {
  if (gap < threshold) return "engage";
  if (touchActive || dragActive || sinceAutoScrollMs > autoScrollWindowMs) return "disengage";
  return "ignore";
}
