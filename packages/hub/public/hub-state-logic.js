/**
 * Pure hub-state logic — the single source of truth for the sidebar's
 * persisted layout: a flat, ordered sequence of items where each item is
 * either a session or a group. Groups and ungrouped sessions live at the SAME
 * level and reorder together, so you can arrange e.g. "session A, group X,
 * session B". Browser-safe (no Node APIs): imported both by the hub server
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
 */
export function displayLayout(state, liveIds) {
  const pruned = pruneState(state, liveIds).items;
  const known = new Set();
  for (const it of pruned) {
    if (it.type === "group") for (const id of it.members) known.add(id);
    else known.add(it.id);
  }
  const appended = liveIds.filter((id) => !known.has(id)).map((id) => ({ type: "session", id }));
  return [...pruned, ...appended];
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
 * Rebuild items from a DOM-derived layout (after a drag). `layout` is the new
 * top-level sequence: [{type:"session",id} | {type:"group",id,members:[...]}].
 * Group name/collapsed are preserved from the current state by id.
 */
export function rebuildItems(state, layout) {
  const groupMeta = new Map(state.items.filter((it) => it.type === "group").map((g) => [g.id, g]));
  const items = layout.map((it) => {
    if (it.type === "group") {
      const prev = groupMeta.get(it.id);
      return { type: "group", id: it.id, name: prev ? prev.name : "group", collapsed: prev ? prev.collapsed : false, members: [...it.members] };
    }
    return { type: "session", id: it.id };
  });
  return { items };
}
