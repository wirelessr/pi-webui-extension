/**
 * Pure hub-state logic — the single source of truth for the sidebar's
 * persisted layout: items that are either a session or a group. Groups and
 * ungrouped sessions live at the SAME level; what is persisted is membership
 * and group name/collapsed, while display order is derived from activity time
 * (see displayLayout). Browser-safe (no Node APIs): imported both by the hub server
 * (normalize/prune before writing hub-state.json) and by the browser SPA
 * (render + mutate). Keep it pure.
 *
 * State shape:
 *   {
 *     items: [
 *       { type: "session", id: "<sessionId>" },
 *       { type: "group", id: "<groupId>", name, collapsed, members: ["<sessionId>", ...] },
 *       ...
 *     ]
 *   }
 * A given session id appears exactly once — either as a top-level session item
 * or inside one group's members.
 */

export const EMPTY_STATE = { items: [] };

function normGroup(raw, seen) {
  const members = [];
  if (Array.isArray(raw.members)) {
    for (const id of raw.members) {
      if (typeof id === "string" && !seen.has(id)) {
        seen.add(id);
        members.push(id);
      }
    }
  }
  return { type: "group", id: raw.id, name: typeof raw.name === "string" ? raw.name : "group", collapsed: !!raw.collapsed, members };
}

/** Coerce an arbitrary parsed blob into the canonical shape, dropping garbage. */
export function normalizeState(raw) {
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.items)) return { items: [] };
  const items = [];
  const seen = new Set(); // session ids already placed (dedupe across the tree)
  for (const it of raw.items) {
    if (!it || typeof it !== "object") continue;
    if (it.type === "group" && typeof it.id === "string") {
      items.push(normGroup(it, seen));
    } else if (it.type === "session" && typeof it.id === "string" && !seen.has(it.id)) {
      seen.add(it.id);
      items.push({ type: "session", id: it.id });
    }
  }
  return { items };
}

/** Drop dead sessions from top-level items and from group members. */
export function pruneState(state, liveIds) {
  const live = new Set(liveIds);
  const items = [];
  for (const it of state.items) {
    if (it.type === "group") {
      items.push({ ...it, members: it.members.filter((id) => live.has(id)) });
    } else if (live.has(it.id)) {
      items.push(it);
    }
  }
  return { items };
}

/**
 * The render list: state items with dead sessions removed, plus any new live
 * sessions (not present anywhere in state) appended as top-level sessions.
 *
 * With `lastActive` (Map sessionId -> ms) the list is ordered most recent
 * first: group members by their own time, top-level items (sessions and
 * groups mixed) by their time, where a group counts as its newest member. An
 * empty group sorts first so a freshly created group is easy to find and drop
 * sessions onto. Ties keep state order. Without it, state order is kept.
 */
export function displayLayout(state, liveIds, lastActive) {
  const pruned = pruneState(state, liveIds).items;
  const known = new Set();
  for (const it of pruned) {
    if (it.type === "group") for (const id of it.members) known.add(id);
    else known.add(it.id);
  }
  const appended = liveIds.filter((id) => !known.has(id)).map((id) => ({ type: "session", id }));
  const items = [...pruned, ...appended];
  if (!lastActive) return items;
  const at = (id) => lastActive.get(id) ?? 0;
  const byRecent = (a, b) => b.t - a.t;
  const ranked = items.map((it) => {
    if (it.type !== "group") return { it, t: at(it.id) };
    const members = it.members.map((id) => ({ it: id, t: at(id) })).sort(byRecent).map((m) => m.it);
    return { it: { ...it, members }, t: members.length ? Math.max(...members.map(at)) : Infinity };
  });
  // Infinity - Infinity is NaN, which would make the comparator inconsistent.
  return ranked.sort((a, b) => (a.t === b.t ? 0 : b.t - a.t)).map((r) => r.it);
}

export function addGroup(state, group) {
  return { items: [...state.items, { type: "group", id: group.id, name: group.name, collapsed: false, members: [] }] };
}

export function renameGroup(state, id, name) {
  return { items: state.items.map((it) => (it.type === "group" && it.id === id ? { ...it, name } : it)) };
}

export function setGroupCollapsed(state, id, collapsed) {
  return { items: state.items.map((it) => (it.type === "group" && it.id === id ? { ...it, collapsed } : it)) };
}

// Remove a group; its members become top-level sessions inline at its position
// (sessions are never deleted, just ungrouped).
export function removeGroup(state, id) {
  const items = [];
  for (const it of state.items) {
    if (it.type === "group" && it.id === id) {
      for (const sid of it.members) items.push({ type: "session", id: sid });
    } else {
      items.push(it);
    }
  }
  return { items };
}

/**
 * Move a session into a group (gid) or back to the top level (gid null).
 * The session is first removed from wherever it currently sits (top-level or
 * any group's members), preserving the single-appearance invariant. When gid
 * names an existing group the session is appended to that group's members;
 * otherwise it becomes a top-level session at the end of the list.
 */
export function moveToGroup(state, sid, gid) {
  let target = null;
  const items = [];
  for (const it of state.items) {
    if (it.type === "group") {
      const g = { ...it, members: it.members.filter((id) => id !== sid) };
      if (g.id === gid) target = g;
      items.push(g);
    } else if (it.id !== sid) {
      items.push(it);
    }
  }
  if (target) target.members.push(sid);
  else items.push({ type: "session", id: sid });
  return { items };
}

/**
 * Decide how to reconcile the active session's busy pill against the bridge's
 * authoritative busy state on each poll tick.
 *
 * The pill is normally owned by the live SSE stream (activeStreaming). But if
 * the bridge reports the turn has ended while we still think we're streaming,
 * our SSE is stuck — the agent disconnected mid-turn and no terminal event
 * (done/error) ever arrived, so activeStreaming never cleared and the pill is
 * frozen on "busy". Two consecutive idle ticks trigger a heal; requiring two
 * avoids tripping on the sliver between a healthy agent_end (bridge clears
 * busy) and the `done` reaching our stream a moment later.
 *
 * @param {object} opts
 * @param {boolean} opts.activeStreaming — hub believes a live stream owns the pill
 * @param {boolean|null} opts.bridgeBusy — authoritative busy from the latest poll;
 *   null = unknown (the bridge didn't answer in time, e.g. blocked replaying a
 *   huge turn buffer). Unknown is not idle: change nothing.
 * @param {number} [opts.stuckTicks] — consecutive prior ticks of streaming-but-idle
 * @returns {{action: "sync"|"heal"|"none", busy?: boolean, stuckTicks: number}}
 */
export function decideStreamReconcile({ activeStreaming, bridgeBusy, stuckTicks = 0 }) {
  if (bridgeBusy == null) return { action: "none", stuckTicks };
  if (!activeStreaming) return { action: "sync", busy: bridgeBusy, stuckTicks: 0 };
  if (bridgeBusy) return { action: "none", stuckTicks: 0 };
  const next = stuckTicks + 1;
  if (next >= 2) return { action: "heal", stuckTicks: 0 };
  return { action: "none", stuckTicks: next };
}
