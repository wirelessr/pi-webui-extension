/**
 * Command selection state machine — pure logic extracted from commands.js.
 *
 * Encodes the behavioral spec for keyboard-driven command selection:
 * - move wraps around the list
 * - filter resets selection to -1
 * - select is a no-op when index is out of bounds
 * - hasFilter returns true only when an active query is set
 *   (not when showing all commands)
 */

/**
 * Create a selection state controller.
 * @param {function} onSelectFn — called when a command is selected
 * @returns {{setCommands: Function, getCommands: Function, move: Function,
 *   select: Function, filter: Function, hasFilter: Function,
 *   getSelectedIndex: Function, getFiltered: Function}}
 */
export function createSelectionState(onSelectFn) {
  let availableCommands = [];
  let filteredCommands = [];
  let selectedIndex = -1;
  let activeQuery = null;

  function setCommands(commands) {
    availableCommands = commands;
    filteredCommands = commands;
    selectedIndex = -1;
    activeQuery = null;
  }

  function getCommands() {
    return availableCommands;
  }

  function move(delta) {
    if (filteredCommands.length === 0) return;
    selectedIndex = (selectedIndex + delta + filteredCommands.length) % filteredCommands.length;
  }

  function select() {
    if (selectedIndex < 0 || selectedIndex >= filteredCommands.length) return;
    onSelectFn(filteredCommands[selectedIndex]);
  }

  function filter(query, filterFn) {
    activeQuery = query;
    if (query === null) {
      filteredCommands = availableCommands;
    } else {
      filteredCommands = filterFn(availableCommands, query);
    }
    selectedIndex = -1;
  }

  function hasFilter() {
    return activeQuery !== null;
  }

  function getSelectedIndex() {
    return selectedIndex;
  }

  function getFiltered() {
    return filteredCommands;
  }

  return { setCommands, getCommands, move, select, filter, hasFilter, getSelectedIndex, getFiltered };
}

/**
 * Decide what action to take for a keydown event in the input box
 * when a command filter is active.
 *
 * @param {object} opts
 * @param {string} opts.key
 * @param {boolean} opts.shiftKey
 * @param {boolean} opts.hasFilter — commandsView.hasFilter() AND a / token exists
 * @param {number} opts.selectedIndex — current selection index (-1 if none)
 * @returns {"move:1"|"move:-1"|"select"|"escape"|"send"|"passthrough"}
 */
export function decideKeyAction(opts) {
  const { key, shiftKey, hasFilter, selectedIndex } = opts;

  if (hasFilter) {
    if (key === "ArrowDown") return "move:1";
    if (key === "ArrowUp") return "move:-1";
    if ((key === "Enter" && !shiftKey || key === "Tab") && selectedIndex >= 0) return "select";
    if (key === "Escape") return "escape";
  }

  if (key === "Enter" && !shiftKey) return "send";

  return "passthrough";
}

/**
 * Decide mobile view when filtering commands.
 * @param {boolean} isMobile
 * @param {boolean} hasToken — whether a / token exists in input
 * @returns {"commands"|null}
 */
export function decideMobileViewOnFilter(isMobile, hasToken) {
  if (isMobile && hasToken) return "commands";
  return null;
}

/**
 * Decide mobile view after selecting a command.
 * @param {boolean} isMobile
 * @returns {"chat"|null}
 */
export function decideMobileViewOnSelect(isMobile) {
  if (isMobile) return "chat";
  return null;
}

/**
 * Decide what happens when send button is clicked.
 * @param {boolean} isStreaming
 * @returns {"send"|"stop"}
 */
export function decideSendClick(isStreaming) {
  return isStreaming ? "stop" : "send";
}

/**
 * Check whether a message should be sent.
 * @param {string} text
 * @param {boolean} isStreaming
 * @param {boolean} [allowWhileStreaming] — when true, a non-empty message is
 *   allowed to submit even while a turn streams (the hub queues it); the send
 *   button still acts as Stop on click (see decideSendClick).
 * @returns {boolean}
 */
export function shouldSend(text, isStreaming, allowWhileStreaming = false) {
  if (!text?.trim()) return false;
  if (isStreaming && !allowWhileStreaming) return false;
  return true;
}

/**
 * Find a command token at the cursor position.
 * Only matches when / is at the beginning of the input (position 0).
 * @param {string} text
 * @param {number} cursor
 * @returns {{token: string, start: number, end: number} | null}
 */
export function findCommandToken(text, cursor) {
  let start = cursor;
  while (start > 0 && !/\s/.test(text[start - 1])) start--;
  const token = text.slice(start, cursor);
  if (!token.startsWith("/")) return null;
  if (start !== 0) return null;
  return { token, start, end: cursor };
}
