/**
 * Turn lifecycle state machine — pure logic for the bridge's turn tracking:
 * is a web-initiated turn active, is the agent busy, when does the turn
 * finalize, and what's in the replay buffer.
 *
 * Extracted from index.ts so the multi-loop/orphaned-turn class of bugs
 * (斷更 / stuck busy) is unit-testable. index.ts stays a thin adapter that
 * feeds pi events in and delivers the done event out via onFinalize.
 *
 * Background: a single user prompt can span MULTIPLE agent loops (pi's
 * _runAgentPrompt runs `while (_handlePostAgentRun()) agent.continue()`):
 * auto-retry, auto-compaction, or queued messages. Each loop fires its own
 * agent_start/agent_end, and agent_end's willRetry does NOT reliably flag
 * them. Extensions can't see auto_retry_start / compaction_start, so the
 * ONLY continuation signal is the next agent_start — which for a retry lands
 * only after pi's exponential backoff. So the turn finalizes only after a
 * grace window with no continuation: long enough to cover the retry backoff
 * when a loop ended on a retryable error, short otherwise. Any agent_start
 * cancels a pending finalize (and re-asserts the turn if one already fired).
 */

/**
 * Whether an agent loop ended on a retryable error: the last assistant
 * message's stopReason is "error".
 * @param {any[]} messages — agent_end event messages
 * @returns {boolean}
 */
export function lastAssistantEndedOnError(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "assistant") {
      return messages[i]?.stopReason === "error";
    }
  }
  return false;
}

/**
 * Create the turn lifecycle state machine.
 *
 * @param {object} opts
 * @param {number} [opts.graceMs] — finalize grace after a clean loop end
 *   (only a fast queued-message continuation is possible, so short).
 * @param {number} [opts.errorGraceMs] — finalize grace after a loop ended on
 *   a retryable error (pi may auto-retry after exponential backoff; defaults
 *   maxRetries=3, baseDelayMs=2000 → 2s/4s/8s — cover the worst-case gap).
 * @param {(event: any, wasActive: boolean) => void} [opts.onFinalize] —
 *   called when the grace window expires with no continuation. wasActive is
 *   whether the turn was still ours (the caller emits the done event only
 *   then; idle waiters resolve either way).
 * @param {typeof setTimeout} [opts.setTimeoutFn]
 * @param {typeof clearTimeout} [opts.clearTimeoutFn]
 */
export function createTurnLifecycle(opts = {}) {
  const {
    graceMs = 1000,
    errorGraceMs = 15000,
    onFinalize = () => {},
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
  } = opts;

  let turnActive = false;
  let busy = false;
  let finalizeTimer = null;
  let buffer = [];
  let abortRequested = false;

  function cancelPendingFinalize() {
    if (finalizeTimer) {
      clearTimeoutFn(finalizeTimer);
      finalizeTimer = null;
    }
  }

  function finalize(event) {
    finalizeTimer = null;
    busy = false;
    const wasActive = turnActive;
    turnActive = false;
    onFinalize(event, wasActive);
  }

  return {
    isTurnActive: () => turnActive,
    isBusy: () => busy,
    hasPendingFinalize: () => finalizeTimer !== null,

    /** The user's prompt was accepted by pi (input event) — the turn is ours. */
    beginTurn() {
      turnActive = true;
    },

    /**
     * Watchdog/timeout paths: the turn is no longer ours. Busy tracking is
     * left alone — an abort still fires agent_end, whose finalize clears it.
     */
    abandonTurn() {
      turnActive = false;
    },

    /**
     * A (re)start of the current turn's work — a fresh prompt, or a
     * continuation loop (retry after backoff, post-compaction, or a queued
     * message). Cancels a pending finalize so the turn isn't closed out from
     * under the continuation, and resets the replay buffer.
     * @returns {{reasserted: boolean}} reasserted=true when this start is an
     *   orphaned continuation (finalize already fired and cleared the turn)
     *   that re-claims it — a genuine new prompt claims the turn via
     *   beginTurn() before its agent_start.
     */
    /**
     * The user explicitly aborted (/api/abort). The next agent_end finalizes
     * immediately instead of waiting out the grace window — no retry or
     * continuation follows a manual abort, and the lingering busy=true was
     * letting clients reattach mid-grace and replay the whole stopped turn.
     * One-shot: cleared by the next agent_start (covers abort-while-idle).
     */
    noteAbortRequested() {
      abortRequested = true;
    },

    agentStart() {
      cancelPendingFinalize();
      busy = true;
      abortRequested = false;
      let reasserted = false;
      if (!turnActive) {
        turnActive = true;
        reasserted = true;
      }
      buffer = [];
      return { reasserted };
    },

    /**
     * An agent loop ended. willRetry=true is a definite "another loop is
     * coming" — keep the turn fully alive, no finalize scheduled. Otherwise
     * schedule the finalize after the grace window.
     * @returns {{scheduled: boolean, graceMs: number}}
     */
    agentEnd(event, { willRetry = false, endedOnError = false } = {}) {
      if (abortRequested) {
        // Manual abort ends the turn for good — finalize synchronously so
        // busy drops before any client can reattach and trigger a replay.
        abortRequested = false;
        cancelPendingFinalize();
        finalize(event);
        return { scheduled: true, graceMs: 0 };
      }
      if (willRetry) return { scheduled: false, graceMs: 0 };
      const grace = endedOnError ? errorGraceMs : graceMs;
      cancelPendingFinalize();
      finalizeTimer = setTimeoutFn(() => finalize(event), grace);
      return { scheduled: true, graceMs: grace };
    },

    cancelPendingFinalize,

    /** Session shutdown: drop everything, no finalize emitted. */
    shutdown() {
      turnActive = false;
      busy = false;
      abortRequested = false;
      cancelPendingFinalize();
      buffer = [];
    },

    /**
     * Record a turn event into the replay buffer. Consecutive text/thinking
     * deltas are coalesced so a long turn replays as a handful of events
     * instead of thousands — replay-only; live SSE forwarding is the
     * caller's job and stays per-delta. Segment boundaries are preserved
     * naturally: any other event type (text_start/text_end, thinking_*,
     * tool_*) breaks the run.
     * @returns {boolean} false when no turn is active (event must be dropped)
     */
    recordEvent(data) {
      if (!turnActive) return false;
      const last = buffer[buffer.length - 1];
      if (
        last &&
        (data.type === "text_delta" || data.type === "thinking_delta") &&
        last.type === data.type &&
        typeof last.delta === "string" &&
        typeof data.delta === "string"
      ) {
        buffer[buffer.length - 1] = { ...last, delta: last.delta + data.delta };
      } else {
        buffer.push(data);
      }
      return true;
    },

    /** Snapshot of the replay buffer (coalesced). */
    bufferedEvents: () => buffer.slice(),
    bufferedCount: () => buffer.length,
  };
}
