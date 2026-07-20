/**
 * Tree panel rendering logic — pure functions for the session-tree overlay.
 *
 * Flattens the bridge's user-message tree (GET /api/tree) into display rows.
 * Chains stay at the same depth (no indent creep on linear history); only
 * branch points push their children one level deeper, with ├/└ connectors.
 */

/**
 * @param {Array<{id, navTargetId, text, active, current, children}>} nodes
 * @returns {Array<{id, navTargetId, text, depth, connector, active, current}>}
 */
export function flattenUserTree(nodes) {
  const rows = [];
  const walk = (node, depth, connector) => {
    rows.push({
      id: node.id,
      navTargetId: node.navTargetId,
      text: node.text,
      depth,
      connector,
      active: node.active,
      current: node.current,
    });
    const children = node.children || [];
    if (children.length === 1) {
      walk(children[0], depth, "");
    } else {
      children.forEach((child, i) => {
        walk(child, depth + 1, i === children.length - 1 ? "└" : "├");
      });
    }
  };
  for (const root of nodes) walk(root, 0, "");
  return rows;
}
