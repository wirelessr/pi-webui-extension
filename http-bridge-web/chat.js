/**
 * Chat module — message rendering, streaming, tool/thinking blocks.
 *
 * Exports a factory that binds to DOM elements and returns
 * methods for the main app to drive.
 */

import { renderMarkdown } from "./markdown.js";
import { createStreamAccumulator } from "./stream-accumulator.js";
import { escapeHtml } from "./utils.js";

export function createChat({ $messages, $chat, $autoScroll, $scrollBottom }) {
  let currentAssistantEl = null;
  let currentTextEl = null;
  let currentThinkingEl = null;
  let currentThinkingContent = null;
  const currentToolMap = new Map();
  let cursorEl = null;
  let accumulator = null;

  // ── Scroll ──

  function scrollToBottom() {
    if ($autoScroll.checked) {
      $chat.scrollTop = $chat.scrollHeight;
    }
  }

  $chat.addEventListener("scroll", () => {
    const atBottom = $chat.scrollHeight - $chat.scrollTop - $chat.clientHeight < 60;
    $scrollBottom.classList.toggle("hidden", atBottom);
  });

  $scrollBottom.addEventListener("click", scrollToBottom);

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
    scrollToBottom();
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
    flushText();
    removeStreamingCursor();

    const block = document.createElement("div");
    block.className = "tool-block";

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

    header.addEventListener("click", () => block.classList.toggle("expanded"));
    block.appendChild(header);
    block.appendChild(argsEl);
    currentAssistantEl.insertBefore(block, currentTextEl);

    if (toolCallId) currentToolMap.set(toolCallId, { block, statusSpan });
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
      case "text_start": break;
      case "text_delta": renderText(state); break;
      case "text_end": renderTextCommitted(state); break;
      case "thinking_start": ensureThinkingBlock(); break;
      case "thinking_delta": renderThinking(state); break;
      case "thinking_end": renderThinkingCommitted(state); break;
      case "toolcall_start": break;
      case "toolcall_end": break;
      case "tool_execution_start": addToolBlock(event.toolCallId, event.toolName, event.args); break;
      case "tool_execution_end": updateToolBlock(event.toolCallId, event.isError); break;
      default: break;
    }
  }

  function renderText(state) {
    if (!currentTextEl) return;
    currentTextEl.innerHTML = renderContent("assistant", state.committedText + state.pendingText);
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
          thinkBlock.className = "thinking-block expanded";
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
            header.addEventListener("click", () => block.classList.toggle("expanded"));
            block.appendChild(header);
            block.appendChild(argsEl);
            el.appendChild(block);
          }
        }
        if (el.children.length > 0) {
          $messages.appendChild(el);
        }
      } else if (entry.role === "toolResult") {
        // Tool results are rendered inline under the preceding assistant message
        // Skip — tool result content is already reflected in the agent's text
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
