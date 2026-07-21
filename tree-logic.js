/**
 * Session tree logic — compacts pi's full session tree (every entry: user
 * messages, assistant messages, tool results, model changes...) into a
 * user-message-only tree for the WebUI tree panel.
 *
 * Each kept node is a user message. Non-user entries are transparent: their
 * user-message descendants attach to the nearest kept ancestor. Every node
 * carries a `navTargetId` — the entry to navigate to when the user clicks it:
 * the END of that message's turn (deepest entry reachable without crossing
 * another user message, preferring the active path at forks). Navigating
 * there means "continue right after this message's answer", which covers both
 * re-asking (click the previous message, then type) and resuming a branch
 * (click its last message).
 */

/** Extract display text from a session entry, or null if not a user message. */
export function userMessageText(entry) {
  if (entry?.type !== "message" || entry.message?.role !== "user") return null;
  const content = entry.message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const text = content
      .filter((part) => part.type === "text" && part.text)
      .map((part) => part.text)
      .join("");
    return text || "[image]";
  }
  return null;
}

/** Build the set of entry ids on the path from root to leafId. */
export function buildActivePathIds(roots, leafId) {
  const parents = new Map();
  const walk = (node, parentId) => {
    parents.set(node.entry.id, parentId);
    for (const child of node.children) walk(child, node.entry.id);
  };
  for (const root of roots) walk(root, null);
  const ids = new Set();
  let cur = leafId;
  while (cur != null && parents.has(cur)) {
    ids.add(cur);
    cur = parents.get(cur);
  }
  return ids;
}

/**
 * Compact the full tree into a user-message tree.
 *
 * @param {Array} roots — SessionTreeNode[] from sessionManager.getTree()
 * @param {string|null} leafId — current leaf entry id
 * @param {number} [maxTextLen] — truncate node text to this length
 * @returns {{nodes: Array, leafId: string|null}} nodes: [{id, navTargetId,
 *   text, active, current, children}]
 */
export function buildUserTree(roots, leafId, maxTextLen = 100) {
  const activeIds = buildActivePathIds(roots, leafId);

  // The turn's end: walk down through non-user entries, preferring the
  // active-path child at forks, stopping before any user message.
  const navTarget = (node) => {
    let cur = node;
    for (;;) {
      const nonUser = cur.children.filter((c) => userMessageText(c.entry) === null);
      if (nonUser.length === 0) return cur.entry.id;
      const next = nonUser.find((c) => activeIds.has(c.entry.id)) ?? nonUser[0];
      cur = next;
    }
  };

  // Collect user-message descendants reachable without crossing a user message.
  const userChildren = (node) => {
    const found = [];
    const walk = (n) => {
      for (const child of n.children) {
        if (userMessageText(child.entry) !== null) found.push(child);
        else walk(child);
      }
    };
    walk(node);
    return found;
  };

  const toNode = (node) => {
    const fullText = userMessageText(node.entry) ?? "";
    const text = fullText.length > maxTextLen ? `${fullText.slice(0, maxTextLen)}…` : fullText;
    return {
      id: node.entry.id,
      navTargetId: navTarget(node),
      text,
      active: activeIds.has(node.entry.id),
      current: false,
      children: userChildren(node).map(toNode),
    };
  };

  const nodes = [];
  for (const root of roots) {
    if (userMessageText(root.entry) !== null) nodes.push(toNode(root));
    else nodes.push(...userChildren(root).map(toNode));
  }

  // Mark the deepest active user node as current (where the leaf lives).
  let current = null;
  const findCurrent = (list) => {
    for (const n of list) {
      if (n.active) current = n;
      findCurrent(n.children);
    }
  };
  findCurrent(nodes);
  if (current) current.current = true;

  return { nodes, leafId };
}
