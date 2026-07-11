/**
 * Input controller — textarea handling, keyboard shortcuts, auto-resize.
 */

import { decideKeyAction, decideMobileViewOnFilter, decideMobileViewOnSelect, decideSendClick, findCommandToken, shouldSend } from "./selection-state.js";

/**
 * Compute the result of inserting a command into the input text.
 * Pure function — no DOM dependency.
 * @param {string} text — current input value
 * @param {number} cursor — current cursor position
 * @param {{name: string}} cmd — command to insert
 * @returns {{value: string, cursor: number}} new input value and cursor position
 */
export function applyCommand(text, cursor, cmd) {
  // Find the / token at cursor position
  let start = cursor;
  while (start > 0 && !/\s/.test(text[start - 1])) start--;
  const token = text.slice(start, cursor);

  if (!token.startsWith("/")) {
    // No / token — replace entire input with the command
    return { value: `/${cmd.name} `, cursor: cmd.name.length + 2 };
  }

  const end = cursor;
  const suffix = text.slice(end).startsWith(" ") ? "" : " ";
  const value = text.slice(0, start) + "/" + cmd.name + suffix + text.slice(end);
  const newCursor = start + cmd.name.length + 1 + suffix.length;
  return { value, cursor: newCursor };
}

export function createInput({
  $input,
  $sendBtn,
  commandsView,
  mobileNav,
  onSend,
  onSelectCommand,
  onStop,
}) {
  let isStreaming = false;

  function autoResize() {
    $input.style.height = "auto";
    $input.style.height = Math.min($input.scrollHeight, 200) + "px";
  }

  function getCommandToken() {
    return findCommandToken($input.value, $input.selectionStart);
  }

  function filterCommands() {
    const ctx = getCommandToken();
    if (!ctx) {
      commandsView.filter(null);
      return;
    }
    commandsView.filter(ctx.token.slice(1));

    const mobileView = decideMobileViewOnFilter(mobileNav.isMobile(), commandsView.hasFilter());
    if (mobileView) mobileNav.switchView(mobileView);
  }

  function selectCommand(cmd) {
    const { value, cursor } = applyCommand($input.value, $input.selectionStart, cmd);
    $input.value = value;
    $input.setSelectionRange(cursor, cursor);
    $input.focus();
    autoResize();
    filterCommands();
    onSelectCommand();

    const mobileView = decideMobileViewOnSelect(mobileNav.isMobile());
    if (mobileView) mobileNav.switchView(mobileView);
  }

  // ── Event handlers ──

  $sendBtn.addEventListener("click", () => {
    const action = decideSendClick(isStreaming);
    if (action === "stop") onStop();
    else sendMessage();
  });

  $input.addEventListener("input", () => {
    autoResize();
    filterCommands();
  });

  let composing = false;
  $input.addEventListener("compositionstart", () => { composing = true; });
  $input.addEventListener("compositionend", () => { composing = false; });

  $input.addEventListener("keydown", (e) => {
    if (composing || e.isComposing) return;

    const hasFilter = commandsView.hasFilter() && getCommandToken();
    const action = decideKeyAction({
      key: e.key,
      shiftKey: e.shiftKey,
      hasFilter: !!hasFilter,
      selectedIndex: commandsView.getSelectedIndex(),
    });

    switch (action) {
      case "move:1": e.preventDefault(); commandsView.move(1); return;
      case "move:-1": e.preventDefault(); commandsView.move(-1); return;
      case "select": e.preventDefault(); commandsView.select(); return;
      case "escape": {
        e.preventDefault();
        const ctx = getCommandToken();
        if (ctx) {
          $input.value = $input.value.slice(0, ctx.start) + $input.value.slice(ctx.end);
          $input.setSelectionRange(ctx.start, ctx.start);
          filterCommands();
        }
        return;
      }
      case "send": e.preventDefault(); sendMessage(); return;
      default: return;
    }
  });

  function sendMessage() {
    const text = $input.value.trim();
    if (!shouldSend(text, isStreaming)) return;

    $input.value = "";
    autoResize();
    filterCommands();
    onSend(text);
  }

  function setStreaming(streaming) {
    isStreaming = streaming;
    $sendBtn.textContent = streaming ? "Stop" : "Send";
    $sendBtn.className = streaming ? "send-btn stop" : "send-btn";
  }

  function focus() {
    $input.focus();
  }

  return { setStreaming, focus, autoResize, filterCommands, selectCommand };
}
