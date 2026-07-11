/**
 * Input controller — textarea handling, keyboard shortcuts, auto-resize.
 * Coordinates between the input box and the commands view.
 */

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
    const text = $input.value;
    const pos = $input.selectionStart;
    let start = pos;
    while (start > 0 && !/\s/.test(text[start - 1])) start--;
    const token = text.slice(start, pos);
    if (!token.startsWith("/")) return null;
    return { token, start, end: pos };
  }

  function filterCommands() {
    const ctx = getCommandToken();
    if (!ctx) {
      commandsView.filter(null);
      return;
    }
    commandsView.filter(ctx.token.slice(1));

    // On mobile, switch to commands view while typing /
    if (mobileNav.isMobile() && commandsView.hasFilter()) {
      mobileNav.switchView("commands");
    }
  }

  function selectCommand(cmd) {
    const ctx = getCommandToken();
    if (!ctx) {
      // No / token — replace entire input with the command
      $input.value = `/${cmd.name} `;
      const cursorPos = $input.value.length;
      $input.setSelectionRange(cursorPos, cursorPos);
      $input.focus();
      autoResize();
      filterCommands();
      onSelectCommand();
      if (mobileNav.isMobile()) {
        mobileNav.switchView("chat");
      }
      return;
    }

    const text = $input.value;
    const suffix = text.slice(ctx.end).startsWith(" ") ? "" : " ";
    $input.value = text.slice(0, ctx.start) + "/" + cmd.name + suffix + text.slice(ctx.end);
    const newCursorPos = ctx.start + cmd.name.length + 1 + suffix.length;
    $input.setSelectionRange(newCursorPos, newCursorPos);
    $input.focus();
    autoResize();
    filterCommands();
    onSelectCommand();

    // On mobile, switch back to chat after selecting
    if (mobileNav.isMobile()) {
      mobileNav.switchView("chat");
    }
  }

  // ── Event handlers ──

  $sendBtn.addEventListener("click", () => {
    if (isStreaming) {
      onStop();
    } else {
      sendMessage();
    }
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

    if (hasFilter) {
      if (e.key === "ArrowDown") { e.preventDefault(); commandsView.move(1); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); commandsView.move(-1); return; }
      if ((e.key === "Enter" || e.key === "Tab") && commandsView.getSelectedIndex() >= 0) {
        e.preventDefault();
        commandsView.select();
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        const ctx = getCommandToken();
        if (ctx) {
          $input.value = $input.value.slice(0, ctx.start) + $input.value.slice(ctx.end);
          $input.setSelectionRange(ctx.start, ctx.start);
          filterCommands();
        }
        return;
      }
    }

    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  function sendMessage() {
    const text = $input.value.trim();
    if (!text || isStreaming) return;

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
