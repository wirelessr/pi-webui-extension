/**
 * Minimal reactive store for the hub shell — the single source of truth for
 * view state (sessions, active session, sidebar layout, busy). Replaces the
 * "mutate a module var, then remember to call renderX()" pattern: mutate via
 * `set`, subscribers re-render their region from `get()`.
 *
 * Deliberately tiny (no deps, no build step): notify is synchronous and fires
 * every subscriber on any change — renders must be cheap + idempotent. Control
 * handles (AbortControllers, drag/menu DOM) stay out of here; they aren't
 * declarative view state. High-frequency streaming (chat) is NOT driven by this
 * — only turn-boundary/busy flags flow in.
 *
 * Browser + Node safe (pure); unit-tested.
 */

export function createStore(initialState = {}) {
  let state = { ...initialState };
  const subscribers = new Set();

  function get() {
    return state;
  }

  // patch is a partial state object, or a function (prev) => partial.
  function set(patch) {
    const delta = typeof patch === "function" ? patch(state) : patch;
    if (!delta) return state;
    state = { ...state, ...delta };
    for (const fn of subscribers) fn(state);
    return state;
  }

  // Register a subscriber; returns an unsubscribe fn. Not called on register —
  // the caller does its initial render explicitly.
  function subscribe(fn) {
    subscribers.add(fn);
    return () => subscribers.delete(fn);
  }

  return { get, set, subscribe };
}
