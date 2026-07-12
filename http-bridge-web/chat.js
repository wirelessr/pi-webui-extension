/**
 * Chat module — message rendering, streaming, tool/thinking blocks.
 *
 * Exports a factory that binds to DOM elements and returns
 * methods for the main app to drive.
 */

import { renderMarkdown } from "./markdown.js";
import { createStreamAccumulator } from "./stream-accumulator.js";
import { escapeHtml } from "./utils.js";

export function createChat({ $messages, $chat, $scrollBottom, isToolsExpanded }) {
  let currentAssistantEl = null;
  let currentTextEl = null;
  let currentThinkingEl = null;
  let currentThinkingContent = null;
  const currentToolMap = new Map();
  let cursorEl = null;
  let accumulator = null;

  // ── Scroll ──

  let userAtBottom = true;
  let programmaticScroll = false;

  function doScroll() {
    programmaticScroll = true;
    $chat.scrollTop = $chat.scrollHeight;
  }

  function scrollToBottom() {
    if (userAtBottom) requestAnimationFrame(doScroll);
  }

  function forceScrollToBottom() {
    userAtBottom = true;
    requestAnimationFrame(doScroll);
  }

  $chat.addEventListener("scroll", () => {
    if (programmaticScroll) {
      programmaticScroll = false;
      return;
    }
    const atBottom = $chat.scrollHeight - $chat.scrollTop - $chat.clientHeight < 60;
    userAtBottom = atBottom;
    $scrollBottom.classList.toggle("hidden", atBottom);
  });

  $scrollBottom.addEventListener("click", forceScrollToBottom);

  // ── Rendering ──

  function renderContent(role, text) {
    if (role === "user") return escapeHtml(text);
    return renderMarkdown(text);
  }

  function addMessage(role, text) {
    const el = document.createElement("div");
    el.className = `message ${role}`;
    el.innerHTML = renderContent(role, text);
    $messages.appendChild(el);
    if (role === "user") {
      forceScrollToBottom();
    } else {
      scrollToBottom();
    }
  }

  function startAssistantMessage() {
    currentAssistantEl = document.createElement("div");
    currentAssistantEl.className = "message assistant";
    currentTextEl = document.createElement("div");
    currentTextEl.className = "text";
    currentAssistantEl.appendChild(currentTextEl);
    $messages.appendChild(currentAssistantEl);

    accumulator = createStreamAccumulator();
    currentThinkingEl = null;
    currentToolMap.clear();
  }

  function finishAssistantMessage() {
    removeStreamingCursor();
    currentAssistantEl = null;
    currentTextEl = null;
    currentThinkingEl = null;
    currentThinkingContent = null;
    currentToolMap.clear();
    accumulator = null;
  }

  function ensureThinkingBlock() {
    if (currentThinkingEl) return;
    currentThinkingEl = document.createElement("div");
    currentThinkingEl.className = "thinking-block";
    if (isToolsExpanded?.()) currentThinkingEl.classList.add("expanded");

    const header = document.createElement("div");
    header.className = "thinking-header";
    header.textContent = "thinking";
    header.addEventListener("click", () => currentThinkingEl.classList.toggle("expanded"));

    currentThinkingContent = document.createElement("div");
    currentThinkingContent.className = "thinking-content";

    currentThinkingEl.appendChild(header);
    currentThinkingEl.appendChild(currentThinkingContent);
    currentAssistantEl.insertBefore(currentThinkingEl, currentTextEl);
  }

  function addToolBlock(toolCallId, toolName, args) {
    if (!currentAssistantEl) return;
    removeStreamingCursor();

    const block = document.createElement("div");
    block.className = "tool-block";
    if (isToolsExpanded?.()) block.classList.add("expanded");

    const header = document.createElement("div");
    header.className = "tool-header";

    const nameSpan = document.createElement("span");
    nameSpan.className = "tool-name";
    nameSpan.textContent = toolName;

    const statusSpan = document.createElement("span");
    statusSpan.className = "tool-status running";
    statusSpan.textContent = "running...";

    header.appendChild(nameSpan);
    header.appendChild(statusSpan);

    const argsEl = document.createElement("div");
    argsEl.className = "tool-args";
    argsEl.textContent = formatArgs(args);

    const resultEl = document.createElement("div");
    resultEl.className = "tool-result";

    header.addEventListener("click", () => block.classList.toggle("expanded"));
    block.appendChild(header);
    block.appendChild(argsEl);
    block.appendChild(resultEl);
    currentAssistantEl.insertBefore(block, currentTextEl);

    if (toolCallId) currentToolMap.set(toolCallId, { block, statusSpan, resultEl });
    scrollToBottom();
  }

  function updateToolBlock(toolCallId, isError) {
    if (!toolCallId) return;
    const entry = currentToolMap.get(toolCallId);
    if (!entry) return;
    entry.statusSpan.classList.remove("running");
    entry.statusSpan.classList.add(isError ? "error" : "done");
    entry.statusSpan.textContent = isError ? "error" : "done";
  }

  function updateToolResult(toolCallId, resultText, isPartial) {
    if (!toolCallId) return;
    const entry = currentToolMap.get(toolCallId);
    if (!entry?.resultEl) return;
    if (!resultText) return;
    entry.resultEl.textContent = resultText;
    entry.resultEl.classList.toggle("partial", isPartial);
    scrollToBottom();
  }

  function formatArgs(args) {
    if (!args) return "";
    try { return JSON.stringify(args, null, 2); }
    catch { return String(args); }
  }

  // ── Streaming cursor ──

  function addStreamingCursor() {
    if (cursorEl) return;
    cursorEl = document.createElement("span");
    cursorEl.className = "streaming-cursor";
    currentTextEl?.appendChild(cursorEl);
  }

  function removeStreamingCursor() {
    cursorEl?.remove();
    cursorEl = null;
  }

  // ── Error ──

  function showError(message) {
    removeStreamingCursor();
    const el = document.createElement("div");
    el.className = "error-banner";
    el.textContent = message;
    if (currentAssistantEl) currentAssistantEl.appendChild(el);
    else $messages.appendChild(el);
    scrollToBottom();
  }

  // ── Event dispatch ──

  function handleEvent(event) {
    if (!accumulator) return;
    accumulator.handleEvent(event);
    const state = accumulator.getState();

    switch (event.type) {
      case "agent_start": break;
      case "turn_start": break;
      case "turn_end": renderText(state); renderThinking(state); break;
      case "done": renderText(state); renderThinking(state); removeStreamingCursor(); break;
      case "error": showError(event.message); break;
      case "compact_start": {
        const statusEl = document.createElement("div");
        statusEl.className = "compact-status";
        statusEl.textContent = "Compacting...";
        if (currentAssistantEl) currentAssistantEl.appendChild(statusEl);
        else $messages.appendChild(statusEl);
        scrollToBottom();
        break;
      }
      case "text_start": break;
      case "text_delta": appendTextDelta(state); break;
      case "text_end": renderTextCommitted(state); break;
      case "thinking_start": ensureThinkingBlock(); break;
      case "thinking_delta": renderThinking(state); break;
      case "thinking_end": renderThinkingCommitted(state); break;
      case "toolcall_start": break;
      case "toolcall_end": break;
      case "tool_execution_start": addToolBlock(event.toolCallId, event.toolName, event.args); break;
      case "tool_execution_update": updateToolResult(event.toolCallId, state.tools.find((t) => t.toolCallId === event.toolCallId)?.resultText, true); break;
      case "tool_execution_end": {
        const tool = state.tools.find((t) => t.toolCallId === event.toolCallId);
        updateToolBlock(event.toolCallId, event.isError);
        if (tool?.resultText) updateToolResult(event.toolCallId, tool.resultText, false);
        break;
      }
      default: break;
    }
  }

  function renderText(state) {
    if (!currentTextEl) return;
    currentTextEl.innerHTML = renderContent("assistant", state.committedText + state.pendingText);
    addStreamingCursor();
    scrollToBottom();
  }

  function appendTextDelta(state) {
    if (!currentTextEl) return;
    // During streaming, use textContent for performance — avoid full
    // markdown re-parse on every delta. Markdown is rendered on text_end / done.
    currentTextEl.textContent = state.committedText + state.pendingText;
    addStreamingCursor();
    scrollToBottom();
  }

  function renderTextCommitted(state) {
    if (!currentTextEl) return;
    currentTextEl.innerHTML = renderContent("assistant", state.committedText);
  }

  function renderThinking(state) {
    if (!currentThinkingContent) return;
    currentThinkingContent.textContent = state.committedThinking + state.pendingThinking;
  }

  function renderThinkingCommitted(state) {
    if (!currentThinkingContent) return;
    currentThinkingContent.textContent = state.committedThinking;
  }

  // ── History rendering ──

  function loadHistory(history) {
    $messages.innerHTML = "";
    let lastAssistantEl = null;
    for (const entry of history) {
      if (entry.role === "user") {
        addMessage("user", entry.text);
      } else if (entry.role === "assistant") {
        const el = document.createElement("div");
        el.className = "message assistant";
        const textEl = document.createElement("div");
        textEl.className = "text";
        if (entry.thinking) {
          const thinkBlock = document.createElement("div");
          thinkBlock.className = "thinking-block";
          const thinkHeader = document.createElement("div");
          thinkHeader.className = "thinking-header";
          thinkHeader.textContent = "thinking";
          thinkHeader.addEventListener("click", () => thinkBlock.classList.toggle("expanded"));
          const thinkContent = document.createElement("div");
          thinkContent.className = "thinking-content";
          thinkContent.textContent = entry.thinking;
          thinkBlock.appendChild(thinkHeader);
          thinkBlock.appendChild(thinkContent);
          el.appendChild(thinkBlock);
        }
        if (entry.text) {
          textEl.innerHTML = renderMarkdown(entry.text);
          el.appendChild(textEl);
        }
        if (entry.toolCalls) {
          for (const tc of entry.toolCalls) {
            const block = document.createElement("div");
            block.className = "tool-block";
            const header = document.createElement("div");
            header.className = "tool-header";
            const nameSpan = document.createElement("span");
            nameSpan.className = "tool-name";
            nameSpan.textContent = tc.name;
            const statusSpan = document.createElement("span");
            statusSpan.className = "tool-status done";
            statusSpan.textContent = "done";
            header.appendChild(nameSpan);
            header.appendChild(statusSpan);
            const argsEl = document.createElement("div");
            argsEl.className = "tool-args";
            argsEl.textContent = formatArgs(tc.arguments);
            const resultEl = document.createElement("div");
            resultEl.className = "tool-result";
            resultEl.dataset.toolCallId = tc.id || "";
            header.addEventListener("click", () => block.classList.toggle("expanded"));
            block.appendChild(header);
            block.appendChild(argsEl);
            block.appendChild(resultEl);
            el.appendChild(block);
          }
        }
        if (el.children.length > 0) {
          $messages.appendChild(el);
          lastAssistantEl = el;
        }
      } else if (entry.role === "system") {
        addMessage("system", entry.text);
      } else if (entry.role === "toolResult") {
        if (entry.toolCallId && entry.text && lastAssistantEl) {
          const resultEl = lastAssistantEl.querySelector(`.tool-result[data-tool-call-id="${entry.toolCallId}"]`);
          if (resultEl) {
            resultEl.textContent = entry.text;
            resultEl.classList.toggle("error", entry.isError);
          }
        }
      }
    }
    scrollToBottom();
  }

  function expandAllTools() {
    $messages.querySelectorAll(".tool-block").forEach((el) => el.classList.add("expanded"));
    $messages.querySelectorAll(".thinking-block").forEach((el) => el.classList.add("expanded"));
  }

  function collapseAllTools() {
    $messages.querySelectorAll(".tool-block").forEach((el) => el.classList.remove("expanded"));
    $messages.querySelectorAll(".thinking-block").forEach((el) => el.classList.remove("expanded"));
  }

  return {
    addMessage,
    loadHistory,
    startAssistantMessage,
    finishAssistantMessage,
    handleEvent,
    showError,
    scrollToBottom,
    expandAllTools,
    collapseAllTools,
  };
}
