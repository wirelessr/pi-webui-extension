/**
 * Chat module — message rendering, streaming, tool/thinking blocks.
 *
 * Exports a factory that binds to DOM elements and returns
 * methods for the main app to drive.
 */

import { renderMarkdown } from "./markdown.js";
import { extractSubagentViews, isSkillRead, parseSkillBlock, parseSkillFrontmatter, parseSubagentMessages } from "./parsers.js";
import { createStreamAccumulator } from "./stream-accumulator.js";
import { doCopy } from "./ui-behaviors.js";
import { escapeHtml, formatTokens } from "./utils.js";

export function createChat({ $messages, $chat, $scrollBottom, isToolsExpanded, logFn = () => {} }) {
  let currentAssistantEl = null;
  let currentTextEl = null;
  let currentThinkingEl = null;
  let currentThinkingContent = null;
  const currentToolMap = new Map();
  let cursorEl = null;
  let accumulator = null;

  // ── Subagent view state ──
  const subagentViews = new Map();
  let activeSubagentId = null;
  let parentScrollTop = 0;
  // The subagent view is a sibling that overlays the chat: opening it hides
  // $messages (never destroys/re-serializes it), so the main chat's DOM and the
  // live incremental-render pointers into it survive open/close intact.
  const $subagentView = document.createElement("div");
  $subagentView.className = "subagent-view";
  $subagentView.style.display = "none";
  $chat.appendChild($subagentView);

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

  function attachCopyButtons(container) {
    const pres = container.querySelectorAll("pre");
    for (const pre of pres) {
      if (pre.querySelector(".copy-code-btn")) continue;
      const btn = document.createElement("button");
      btn.className = "copy-code-btn";
      btn.textContent = "copy";
      btn.addEventListener("click", async () => {
        const code = pre.querySelector("code");
        const text = code ? code.textContent : pre.textContent;
        await doCopy({
          text,
          writeTextFn: navigator.clipboard?.writeText?.bind(navigator.clipboard),
          execCommandFn: document.execCommand?.bind(document),
          createTextareaFn: () => {
            const ta = document.createElement("textarea");
            ta.style.position = "fixed";
            ta.style.opacity = "0";
            document.body.appendChild(ta);
            return ta;
          },
          removeTextareaFn: (ta) => document.body.removeChild(ta),
        });
        btn.textContent = "copied";
        setTimeout(() => { btn.textContent = "copy"; }, 1500);
      });
      pre.appendChild(btn);
    }
  }

  function addMessage(role, text) {
    if (role === "user") {
      const skill = parseSkillBlock(text);
      if (skill) {
        // Skill block: neutral full-width, like compaction marker
        const skillEl = document.createElement("div");
        skillEl.className = "message skill-invocation";
        skillEl.appendChild(createCollapsibleBlock("skill", skill.name, skill.content));
        $messages.appendChild(skillEl);
        // User args: separate right-aligned user bubble
        if (skill.userMessage) {
          const userEl = document.createElement("div");
          userEl.className = "message user";
          userEl.innerHTML = renderContent("user", skill.userMessage);
          $messages.appendChild(userEl);
        }
        forceScrollToBottom();
        return;
      }
    }
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

  function formatUsage(usage) {
    const parts = [];
    if (usage.turns) parts.push(`${usage.turns} turns`);
    if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
    if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
    if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
    return parts.join("  ");
  }

  function statusIcon(status) {
    if (status === "running") return "⏳";
    if (status === "error") return "✗";
    return "✓";
  }

  function createSubagentBlock(view) {
    const block = document.createElement("div");
    block.className = "subagent-block";
    block.dataset.subagentId = view.id;

    const header = document.createElement("div");
    header.className = "subagent-header";

    const iconSpan = document.createElement("span");
    iconSpan.className = "subagent-icon";
    iconSpan.textContent = statusIcon(view.status);

    const nameSpan = document.createElement("span");
    nameSpan.className = "subagent-name";
    nameSpan.textContent = `subagent ${view.agent}`;

    const statsSpan = document.createElement("span");
    statsSpan.className = "subagent-stats";
    const stats = formatUsage(view.usage);
    if (stats) statsSpan.textContent = stats;

    const openBtn = document.createElement("button");
    openBtn.className = "subagent-open-btn";
    openBtn.textContent = "open";
    openBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      openSubagentView(view.id);
    });

    header.appendChild(iconSpan);
    header.appendChild(nameSpan);
    header.appendChild(statsSpan);
    header.appendChild(openBtn);
    block.appendChild(header);
    return block;
  }

  function updateSubagentBlock(block, view) {
    const icon = block.querySelector(".subagent-icon");
    const stats = block.querySelector(".subagent-stats");
    if (icon) icon.textContent = statusIcon(view.status);
    if (stats) stats.textContent = formatUsage(view.usage);
  }

  function openSubagentView(id) {
    const view = subagentViews.get(id);
    if (!view) return;
    activeSubagentId = id;
    parentScrollTop = $chat.scrollTop;
    $messages.style.display = "none";
    $subagentView.style.display = "";
    renderSubagentView(view);
    forceScrollToBottom();
  }

  // Render (or re-render) the active subagent's transcript into $subagentView.
  // Only $subagentView is cleared — $messages is left untouched.
  function renderSubagentView(view) {
    $subagentView.innerHTML = "";
    const header = document.createElement("div");
    header.className = "subagent-view-header";
    const backBtn = document.createElement("button");
    backBtn.className = "subagent-back-btn";
    backBtn.textContent = "← back to main session";
    backBtn.addEventListener("click", closeSubagentView);
    const title = document.createElement("div");
    title.className = "subagent-view-title";
    title.textContent = `${statusIcon(view.status)} subagent: ${view.agent}  ${formatUsage(view.usage)}`;
    if (view.model) {
      const modelSpan = document.createElement("span");
      modelSpan.className = "subagent-view-model";
      modelSpan.textContent = view.model;
      title.appendChild(modelSpan);
    }
    const taskEl = document.createElement("div");
    taskEl.className = "subagent-view-task";
    taskEl.textContent = view.task.length > 200 ? `${view.task.slice(0, 200)}...` : view.task;
    header.appendChild(backBtn);
    header.appendChild(title);
    header.appendChild(taskEl);
    $subagentView.appendChild(header);

    const entries = parseSubagentMessages(view.messages);
    _lastSubagentAssistantEl = null;
    subagentToolResultMap.clear();
    for (const entry of entries) {
      renderSubagentEntry(entry);
    }
  }

  let _lastSubagentAssistantEl = null;
  const subagentToolResultMap = new Map();

  function renderSubagentEntry(entry) {
    if (entry.role === "user") {
      const el = document.createElement("div");
      el.className = "message user";
      el.innerHTML = escapeHtml(entry.text || "");
      $subagentView.appendChild(el);
      _lastSubagentAssistantEl = null;
    } else if (entry.role === "assistant") {
      const el = document.createElement("div");
      el.className = "message assistant";
      const textEl = document.createElement("div");
      textEl.className = "text";
      if (entry.thinking) {
        el.appendChild(buildThinkingBlock(entry.thinking));
      }
      if (entry.text) {
        textEl.innerHTML = renderMarkdown(entry.text);
        attachCopyButtons(textEl);
        el.appendChild(textEl);
      }
      if (entry.toolCalls) {
        for (const tc of entry.toolCalls) {
          const { block, resultEl } = buildStaticToolBlock(tc);
          el.appendChild(block);
          if (tc.id) subagentToolResultMap.set(tc.id, resultEl);
        }
      }
      if (el.children.length > 0) {
        $subagentView.appendChild(el);
        _lastSubagentAssistantEl = el;
      }
    } else if (entry.role === "toolResult") {
      if (entry.toolCallId && subagentToolResultMap.has(entry.toolCallId)) {
        const resultEl = subagentToolResultMap.get(entry.toolCallId);
        resultEl.textContent = entry.text || "";
        if (entry.isError) resultEl.classList.add("error");
      } else if (entry.text) {
        const el = document.createElement("div");
        el.className = "message assistant";
        const resultEl = document.createElement("div");
        resultEl.className = "tool-result";
        resultEl.textContent = entry.text;
        if (entry.isError) resultEl.classList.add("error");
        el.appendChild(resultEl);
        $subagentView.appendChild(el);
      }
    }
  }

  function closeSubagentView() {
    activeSubagentId = null;
    $subagentView.style.display = "none";
    $subagentView.innerHTML = "";
    $messages.style.display = "";
    $chat.scrollTop = parentScrollTop;
    // $messages was only hidden, never rebuilt — its open-button listeners and
    // the live incremental-render pointers are still intact. No re-bind needed.
  }

  function updateSubagentViews(toolCallId, details) {
    const views = extractSubagentViews(toolCallId, details);
    for (const view of views) {
      subagentViews.set(view.id, view);
      if (activeSubagentId === view.id) {
        // Live re-render the open subagent view ($subagentView only; $messages
        // is untouched behind the overlay).
        renderSubagentView(view);
        forceScrollToBottom();
      } else {
        // Update the subagent block in parent view
        const block = $messages.querySelector(`.subagent-block[data-subagent-id="${view.id}"]`);
        if (block) updateSubagentBlock(block, view);
      }
    }
  }

  function createCollapsibleBlock(label, name, content) {
    const block = document.createElement("div");
    block.className = `${label}-block`;
    const header = document.createElement("div");
    header.className = `${label}-header`;
    header.textContent = `[${label}] ${name}`;
    header.addEventListener("click", () => block.classList.toggle("expanded"));
    const contentEl = document.createElement("div");
    contentEl.className = `${label}-content`;
    contentEl.innerHTML = renderMarkdown(content);
    block.appendChild(header);
    block.appendChild(contentEl);
    return block;
  }

  // ── Static block builders (history + subagent rendering) ──
  // Completed, non-streaming blocks. The streaming path (ensureThinkingBlock,
  // addToolBlock) builds live blocks separately.

  function buildThinkingBlock(text) {
    const block = document.createElement("div");
    block.className = "thinking-block";
    const header = document.createElement("div");
    header.className = "thinking-header";
    header.textContent = "thinking";
    header.addEventListener("click", () => block.classList.toggle("expanded"));
    const content = document.createElement("div");
    content.className = "thinking-content";
    content.textContent = text;
    block.appendChild(header);
    block.appendChild(content);
    return block;
  }

  function buildStaticToolBlock(tc) {
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
    if (isSkillRead(tc.name, tc.arguments)) block.dataset.skillRead = "true";
    return { block, resultEl };
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

    // Subagent tools get a special block with open button
    if (toolName === "subagent") {
      const block = document.createElement("div");
      block.className = "subagent-container";
      block.dataset.toolCallId = toolCallId || "";
      // Create placeholder block, updated when details arrive
      const placeholderView = {
        id: `${toolCallId}-0`,
        agent: args?.agent || "...",
        task: args?.task || "",
        status: "running",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
        model: "",
        messages: [],
      };
      subagentViews.set(placeholderView.id, placeholderView);
      const saBlock = createSubagentBlock(placeholderView);
      block.appendChild(saBlock);
      currentAssistantEl.insertBefore(block, currentTextEl);
      if (toolCallId) currentToolMap.set(toolCallId, { block, statusSpan: null, resultEl: null });
      scrollToBottom();
      return;
    }

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
    if (isSkillRead(toolName, args)) block.dataset.skillRead = "true";
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

    if (!isPartial && entry.block.dataset.skillRead === "true") {
      const skill = parseSkillFrontmatter(resultText);
      if (skill) {
        const skillBlock = createCollapsibleBlock("skill", skill.name, skill.content);
        entry.block.parentElement.replaceChild(skillBlock, entry.block);
        currentToolMap.delete(toolCallId);
        scrollToBottom();
        return;
      }
    }

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
    try {
      accumulator.handleEvent(event);
    } catch (err) {
      logFn("error", "handleEvent: accumulator error", { type: event.type, error: err.message, stack: err.stack?.split("\n")[0] });
    }
    const state = accumulator.getState();

    try {
      _handleEventInner(event, state);
    } catch (err) {
      logFn("error", "handleEvent: render error", { type: event.type, error: err.message, stack: err.stack?.split("\n")[0] });
    }
  }

  function _handleEventInner(event, state) {

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
      case "tool_execution_update": {
        if (event.toolName === "subagent" || state.subagentDetails[event.toolCallId]) {
          const details = state.subagentDetails[event.toolCallId];
          if (details) updateSubagentViews(event.toolCallId, details);
        }
        updateToolResult(event.toolCallId, state.tools.find((t) => t.toolCallId === event.toolCallId)?.resultText, true);
        break;
      }
      case "tool_execution_end": {
        const tool = state.tools.find((t) => t.toolCallId === event.toolCallId);
        if (event.toolName === "subagent" || state.subagentDetails[event.toolCallId]) {
          const details = state.subagentDetails[event.toolCallId];
          if (details) updateSubagentViews(event.toolCallId, details);
        } else {
          updateToolBlock(event.toolCallId, event.isError);
          if (tool?.resultText) updateToolResult(event.toolCallId, tool.resultText, false);
        }
        break;
      }
      default: break;
    }
  }

  function renderText(state) {
    if (!currentTextEl) return;
    currentTextEl.innerHTML = renderContent("assistant", state.committedText + state.pendingText);
    attachCopyButtons(currentTextEl);
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
    attachCopyButtons(currentTextEl);
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
          el.appendChild(buildThinkingBlock(entry.thinking));
        }
        if (entry.text) {
          textEl.innerHTML = renderMarkdown(entry.text);
          attachCopyButtons(textEl);
          el.appendChild(textEl);
        }
        if (entry.toolCalls) {
          for (const tc of entry.toolCalls) {
            const { block } = buildStaticToolBlock(tc);
            el.appendChild(block);
          }
        }
        if (el.children.length > 0) {
          $messages.appendChild(el);
          lastAssistantEl = el;
        }
      } else if (entry.role === "system") {
        if (entry.text?.startsWith("--- Compacted")) {
          const block = document.createElement("div");
          block.className = "compaction-block";
          const header = document.createElement("div");
          header.className = "compaction-header";
          header.textContent = entry.text.split("\n")[0];
          header.addEventListener("click", () => block.classList.toggle("expanded"));
          const content = document.createElement("div");
          content.className = "compaction-content";
          content.innerHTML = renderMarkdown(entry.text.split("\n").slice(1).join("\n").trim());
          block.appendChild(header);
          block.appendChild(content);
          $messages.appendChild(block);
        } else {
          addMessage("system", entry.text);
        }
      } else if (entry.role === "toolResult") {
        if (entry.subagentDetails) {
          // Subagent tool result — render as subagent block(s)
          const toolCallId = entry.toolCallId || "";
          const views = extractSubagentViews(toolCallId, entry.subagentDetails);
          for (const view of views) {
            subagentViews.set(view.id, view);
            const saBlock = createSubagentBlock(view);
            if (lastAssistantEl) {
              // Replace the corresponding tool block if it exists
              const toolBlock = lastAssistantEl.querySelector(`.tool-block [data-tool-call-id="${toolCallId}"]`)?.closest(".tool-block");
              if (toolBlock) {
                toolBlock.parentElement.replaceChild(saBlock, toolBlock);
              } else {
                lastAssistantEl.appendChild(saBlock);
              }
            } else {
              $messages.appendChild(saBlock);
            }
          }
        } else if (entry.toolCallId && entry.text && lastAssistantEl) {
          const resultEl = lastAssistantEl.querySelector(`.tool-result[data-tool-call-id="${entry.toolCallId}"]`);
          if (resultEl) {
            const toolBlock = resultEl.closest(".tool-block");
            if (toolBlock?.dataset.skillRead === "true") {
              const skill = parseSkillFrontmatter(entry.text);
              if (skill) {
                const skillBlock = createCollapsibleBlock("skill", skill.name, skill.content);
                toolBlock.parentElement.replaceChild(skillBlock, toolBlock);
                continue;
              }
            }
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
    hasActiveMessage: () => accumulator !== null,
    handleEvent,
    showError,
    scrollToBottom,
    expandAllTools,
    collapseAllTools,
    closeSubagentView,
  };
}
