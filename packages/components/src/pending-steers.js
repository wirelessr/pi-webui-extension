/**
 * Optimistic pending-message list shared by the hub and standalone shells.
 *
 * pi exposes no readable steering/follow-up queue to extensions, so each shell
 * tracks what it sent mid-turn as `{ text, kind }` entries (kind: "steer" |
 * "followUp") and drains one entry per user_message echo from the bridge.
 */

/**
 * Index of the entry a user_message echo drains, or -1 if the list is empty.
 * Exact text match first (steers before follow-ups). Otherwise the oldest
 * steer, then the oldest follow-up: the bridge injects expandInput(message)
 * (skill/template expansion), so the echo can differ from the stored text, and
 * pi injects every queued steer before any follow-up.
 * @param {{text: string, kind: string}[]} list
 * @param {string} text — the echoed user_message text
 * @returns {number}
 */
export function pendingDrainIndex(list, text) {
  if (list.length === 0) return -1;
  for (const kind of ["steer", "followUp"]) {
    const i = list.findIndex((p) => p.kind === kind && p.text === text);
    if (i !== -1) return i;
  }
  const steer = list.findIndex((p) => p.kind === "steer");
  return steer !== -1 ? steer : 0;
}

/**
 * Header caption for the pending list, e.g. "2 steers + 1 follow-up waiting to inject".
 * @param {{kind: string}[]} list — non-empty
 * @returns {string}
 */
export function pendingCaption(list) {
  const steers = list.filter((p) => p.kind === "steer").length;
  const followUps = list.length - steers;
  const parts = [];
  if (steers) parts.push(`${steers} steer${steers > 1 ? "s" : ""}`);
  if (followUps) parts.push(`${followUps} follow-up${followUps > 1 ? "s" : ""}`);
  return `${parts.join(" + ")} waiting to inject`;
}
