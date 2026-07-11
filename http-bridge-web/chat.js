/**
 * Chat module — message rendering, streaming, tool/thinking blocks.
 *
 * Exports a factory that binds to DOM elements and returns
 * methods for the main app to drive.
 */

import { renderMarkdown } from "./markdown.js";
import { escapeHtml } from "./utils.js";

export function createChat({ $messages, $chat, $autoScroll, $scrollBottom }) {
  let currentAssistantEl = null;
  let currentTextEl = null;
  let currentThinkingEl = null;
  let currentThinkingContent = null;
  let currentToolMap = new Map();
  let textBuffer = "";
  let committedText = "";
  let thinkingBuffer = "";
  let cursorEl = null;

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

    textBuffer = "";
    committedText = "";
    thinkingBuffer = "";
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
  }

  function updateText() {
    if (!currentTextEl) return;
    currentTextEl.innerHTML = renderContent("assistant", committedText + textBuffer);
    addStreamingCursor();
    scrollToBottom();
  }

  function flushText() {
    if (!currentTextEl || textBuffer.length === 0) return;
    committedText += textBuffer;
    currentTextEl.innerHTML = renderContent("assistant", committedText);
    textBuffer = "";
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

  function updateThinking() {
    if (!currentThinkingContent) return;
    currentThinkingContent.textContent = thinkingBuffer;
  }

  function flushThinking() {
    if (!currentThinkingContent || thinkingBuffer.length === 0) return;
    currentThinkingContent.textContent = thinkingBuffer;
    thinkingBuffer = "";
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
    switch (event.type) {
      case "agent_start": break;
      case "turn_start": break;
      case "turn_end": flushText(); flushThinking(); break;
      case "done": flushText(); flushThinking(); removeStreamingCursor(); break;
      case "error": showError(event.message); break;
      case "text_start": textBuffer = ""; break;
      case "text_delta": textBuffer += event.delta; updateText(); break;
      case "text_end": flushText(); break;
      case "thinking_start": thinkingBuffer = ""; ensureThinkingBlock(); break;
      case "thinking_delta": thinkingBuffer += event.delta; updateThinking(); break;
      case "thinking_end": flushThinking(); break;
      case "toolcall_start": break;
      case "toolcall_end": break;
      case "tool_execution_start": addToolBlock(event.toolCallId, event.toolName, event.args); break;
      case "tool_execution_end": updateToolBlock(event.toolCallId, event.isError); break;
      default: break;
    }
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

  return {
    addMessage,
    loadHistory,
    startAssistantMessage,
    finishAssistantMessage,
    handleEvent,
    showError,
    scrollToBottom,
  };
}
