/**
 * Chat module — message rendering, streaming, tool/thinking blocks.
 *
 * Exports a factory that binds to DOM elements and returns
 * methods for the main app to drive.
 */

import { extractFilePaths, fileName, isMarkdownPath } from "./artifacts.js";
import { diffLines } from "./diff.js";
import { renderMarkdown } from "./markdown.js";
import { createOverlayManager } from "./overlay-manager.js";
import { extractSubagentViews, isSkillRead, parseSkillBlock, parseSkillFrontmatter, parseSubagentMessages } from "./parsers.js";
import { createScrollFollow } from "./scroll-follow.js";
import { createStreamAccumulator } from "./stream-accumulator.js";
import { doCopy } from "./ui-behaviors.js";
import { escapeHtml, formatTokens } from "./utils.js";

export function createChat({ $messages, $chat, $scrollBottom, isToolsExpanded, isNodeExpanded = null, logFn = () => {}, getFileContentFn = null, statFilesFn = null, overlays = null }) {
  // Overlay exclusivity + transcript hide/restore live in the manager. Apps
  // pass the shared instance (so tree/model panels join the same exclusivity
  // group); standalone use gets a private one.
  const overlayMgr = overlays || createOverlayManager({ $chat, $messages });
  // Whether a node (tool by name, or "thinking") should start expanded. Per-type
  // preference when isNodeExpanded is provided; else the old global flag.
  const nodeOpen = (type) => (isNodeExpanded ? !!isNodeExpanded(type) : !!isToolsExpanded?.());
  let currentAssistantEl = null;
  let currentTextEl = null;
  let currentThinkingEl = null;
  let currentThinkingContent = null;
  const currentToolMap = new Map();
  let cursorEl = null;
  let accumulator = null;
  let turnFilePaths = []; // write/edit targets this live turn, for end-of-turn chips

  // ── Subagent view state ──
  const subagentViews = new Map();
  let activeSubagentId = null;
  // The subagent view is a sibling that overlays the chat: opening it hides
  // $messages (never destroys/re-serializes it), so the main chat's DOM and the
  // live incremental-render pointers into it survive open/close intact.
  const $subagentView = document.createElement("div");
  $subagentView.className = "subagent-view";
  $subagentView.style.display = "none";
  $chat.appendChild($subagentView);
  const subagentHandle = { close: () => closeSubagentView() };

  // ── File view state ──
  // Chips list the files a message wrote/edited (paths come from the
  // transcript); the content is fetched from disk on click, so a file later
  // changed via sed/python still shows its true current state. The file view is
  // a sibling overlay, same hide/show pattern as the subagent view above.
  //
  // Opening a file "watches" it: we remember its mtime, and at each turn end
  // re-stat the watched set. A file changed by ANY means (sed/shell/write) has
  // a new mtime, so it re-surfaces as a chip on that turn's message — covering
  // edits the write/edit tools never see. Lifetime = while viewing this session
  // (cleared on loadHistory).
  const watched = new Map(); // path → last-seen mtime
  const $fileView = document.createElement("div");
  $fileView.className = "file-view";
  $fileView.style.display = "none";
  $chat.appendChild($fileView);
  const fileHandle = { close: () => closeFileView() };

  // ── Scroll (auto-follow / sticky scroll) ──
  //
  // Owned entirely by scroll-follow.js (observer-driven): a MutationObserver on
  // $messages tracks content growth from ANY render path, so render code never
  // calls "scroll to bottom" — forgetting to, on a new path, can't break
  // follow (this was the queued-turn bug). This module only feeds it raw
  // scroll/gesture events and issues jumpToBottom() at genuine user-initiated
  // jumps: a fresh send/user bubble, opening a view, the button, a full
  // transcript reload.
  const scroll = createScrollFollow({ $chat, $messages, $button: $scrollBottom, logFn });
  function forceScrollToBottom() { scroll.jumpToBottom(); }

  $chat.addEventListener("scroll", () => scroll.handleScroll());
  $chat.addEventListener("wheel", (e) => scroll.noteWheel(e.deltaY), { passive: true });
  $chat.addEventListener("touchstart", () => scroll.setTouch(true), { passive: true });
  $chat.addEventListener("touchend", () => scroll.setTouch(false), { passive: true });
  $chat.addEventListener("touchcancel", () => scroll.setTouch(false), { passive: true });
  $chat.addEventListener("mousedown", () => scroll.setDrag(true));
  window.addEventListener("mouseup", () => scroll.setDrag(false));

  $scrollBottom.addEventListener("click", forceScrollToBottom);

  // ── Rendering ──

  // The raw text of the last user bubble added (live send, history reload, or
  // a replayed user_message) — the user_message dedup compares against this
  // rather than DOM textContent, which diverges for skill-block invocations.
  let lastUserText = null;

  function renderContent(role, text) {
    if (role === "user") return escapeHtml(text);
    return renderMarkdown(text);
  }

  // Syntax-highlight code blocks in place, if the highlighter loaded (global
  // hljs from highlight-lib.js, non-module script). Uses the block's
  // language-* class when present, else hljs auto-detects. Guarded so a
  // missing lib just leaves plain (already-readable) code.
  function highlightCode(container) {
    if (!window.hljs) return;
    for (const code of container.querySelectorAll("pre code")) {
      if (code.dataset.highlighted) continue;
      // If the fence names a language hljs doesn't ship, drop the class so it
      // auto-detects instead of leaving the block unhighlighted.
      const cls = [...code.classList].find((c) => c.startsWith("language-"));
      if (cls && !window.hljs.getLanguage(cls.slice(9))) code.classList.remove(cls);
      try { window.hljs.highlightElement(code); } catch {}
    }
  }

  function attachCopyButtons(container) {
    highlightCode(container);
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
      lastUserText = text;
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
    // A user message is a fresh send: jump to it (re-engage follow even if the
    // user had scrolled up). Assistant/system content is followed by the
    // observer if engaged — no explicit scroll here.
    if (role === "user") forceScrollToBottom();
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
    overlayMgr.open(subagentHandle);
    activeSubagentId = id;
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
      const parts = entryParts(entry);
      if (parts.length === 0) return;
      const el = document.createElement("div");
      el.className = "message assistant";
      for (const part of parts) appendPart(el, part, subagentToolResultMap);
      $subagentView.appendChild(el);
      _lastSubagentAssistantEl = el;
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
    // $messages was only hidden, never rebuilt — its open-button listeners and
    // the live incremental-render pointers are still intact. No re-bind needed.
    overlayMgr.closed(subagentHandle);
  }

  // ── Agent-authored file chips + read-only file view ──

  // Build a row of clickable chips for the files a message wrote/edited. The
  // path is all a chip needs — content is read from disk when it's opened.
  function buildFileChips(paths) {
    const row = document.createElement("div");
    row.className = "file-chips";
    for (const path of paths) {
      const chip = document.createElement("button");
      chip.className = "file-chip";
      chip.textContent = fileName(path);
      chip.title = path;
      chip.addEventListener("click", (e) => {
        e.stopPropagation();
        openFileView(path);
      });
      row.appendChild(chip);
    }
    return row;
  }

  // Map a file path to a highlight.js language hint (empty → let hljs
  // auto-detect). Covers the languages agents commonly write.
  const HLJS_EXT = {
    py: "python", js: "javascript", mjs: "javascript", cjs: "javascript",
    ts: "typescript", tsx: "typescript", jsx: "javascript", sh: "bash",
    bash: "bash", zsh: "bash", json: "json", yaml: "yaml", yml: "yaml",
    sql: "sql", go: "go", rb: "ruby", rs: "rust", java: "java", kt: "kotlin",
    c: "c", h: "c", cpp: "cpp", cc: "cpp", hpp: "cpp", cs: "csharp",
    php: "php", html: "xml", htm: "xml", xml: "xml", css: "css", scss: "scss",
    toml: "ini", ini: "ini", cfg: "ini", diff: "diff", patch: "diff",
  };
  function hljsLangForPath(path) {
    const name = fileName(path);
    if (/^dockerfile$/i.test(name)) return "dockerfile";
    if (/^makefile$/i.test(name)) return "makefile";
    const ext = name.includes(".") ? name.split(".").pop().toLowerCase() : "";
    return HLJS_EXT[ext] || "";
  }

  // Render one file body (markdown rendered, anything else as a code block).
  function renderFileBody(path, content) {
    const body = document.createElement("div");
    if (isMarkdownPath(path)) {
      body.className = "file-view-body markdown";
      body.innerHTML = renderMarkdown(content || "");
    } else {
      body.className = "file-view-body code";
      const pre = document.createElement("pre");
      const code = document.createElement("code");
      const lang = hljsLangForPath(path);
      if (lang) code.className = `language-${lang}`;
      code.textContent = content || "";
      pre.appendChild(code);
      body.appendChild(pre);
    }
    attachCopyButtons(body);
    return body;
  }

  async function openFileView(path) {
    overlayMgr.open(fileHandle);
    $fileView.style.display = "";
    $fileView.innerHTML = "";

    const header = document.createElement("div");
    header.className = "file-view-header";
    const backBtn = document.createElement("button");
    backBtn.className = "file-back-btn";
    backBtn.textContent = "← back to main session";
    backBtn.addEventListener("click", closeFileView);
    const title = document.createElement("div");
    title.className = "file-view-title";
    title.textContent = path;
    header.appendChild(backBtn);
    header.appendChild(title);
    $fileView.appendChild(header);

    const status = document.createElement("div");
    status.className = "file-view-body";
    status.textContent = "Loading…";
    $fileView.appendChild(status);
    $chat.scrollTop = 0;

    // A late fetch must not paint over a view the user already navigated away
    // from (back or a different chip).
    const token = {};
    openFileView._token = token;
    try {
      if (!getFileContentFn) throw new Error("file viewing not available");
      const { content, mtime } = await getFileContentFn(path);
      if (openFileView._token !== token) return;
      // Watch from the version you actually looked at, so only later changes
      // re-surface.
      if (typeof mtime === "number") watched.set(path, mtime);
      status.replaceWith(renderFileBody(path, content));
    } catch (err) {
      if (openFileView._token !== token) return;
      status.className = "file-view-body error";
      status.textContent = `Could not read ${path}: ${err.message}`;
    }
  }

  function closeFileView() {
    openFileView._token = null;
    $fileView.style.display = "none";
    $fileView.innerHTML = "";
    overlayMgr.closed(fileHandle);
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
    if (nodeOpen("thinking")) block.classList.add("expanded");
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
    block.dataset.toolName = tc.name || "";
    if (nodeOpen(tc.name)) block.classList.add("expanded");
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
    if (isEditArgs(tc.name, tc.arguments)) argsEl.appendChild(buildEditDiff(tc.arguments));
    else argsEl.textContent = formatArgs(tc.arguments);
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
    $messages.appendChild(currentAssistantEl);

    accumulator = createStreamAccumulator();
    currentTextEl = null;
    currentThinkingEl = null;
    currentThinkingContent = null;
    currentToolMap.clear();
    turnFilePaths = [];
  }

  // Live streaming appends thinking / text / tool blocks to the bubble in event
  // order. A text "segment" is one run of text_delta events; a fresh one starts
  // whenever a thinking or tool block interrupts the flow, so the transcript
  // reads in the order the agent produced it (talk, tool, talk) instead of every
  // tool stacked above one merged block of text.
  function ensureTextSegment() {
    if (currentTextEl) return;
    currentThinkingEl = null;
    currentThinkingContent = null;
    currentTextEl = document.createElement("div");
    currentTextEl.className = "text";
    currentAssistantEl.appendChild(currentTextEl);
  }

  // Close the open text segment: render its raw text (already in the element from
  // the deltas) as markdown, or drop it if empty. Called on text_end AND whenever
  // a tool/thinking block interrupts, since the stream doesn't guarantee a
  // text_end before a tool starts.
  function finalizeTextSegment() {
    if (!currentTextEl) return;
    removeStreamingCursor();
    const raw = currentTextEl.textContent;
    if (raw) {
      currentTextEl.innerHTML = renderContent("assistant", raw);
      attachCopyButtons(currentTextEl);
    } else {
      currentTextEl.remove();
    }
    currentTextEl = null;
  }

  function finishAssistantMessage() {
    removeStreamingCursor();
    // Surface file chips for what THIS turn wrote/edited. loadHistory does this
    // on reload, but a turn you send in this tab and let finish normally never
    // reloads (see flow.js), so without this you'd only see chips after switching
    // away or refreshing. Dedupe against chips already shown.
    if (currentAssistantEl && turnFilePaths.length > 0) {
      const shown = new Set([...currentAssistantEl.querySelectorAll(".file-chip")].map((c) => c.title));
      const fresh = turnFilePaths.filter((p) => !shown.has(p));
      if (fresh.length > 0) {
        currentAssistantEl.appendChild(buildFileChips(fresh));
      }
    }
    turnFilePaths = [];
    currentAssistantEl = null;
    currentTextEl = null;
    currentThinkingEl = null;
    currentThinkingContent = null;
    currentToolMap.clear();
    accumulator = null;
    // Every turn-end path calls this (live send, attach stream, standalone),
    // whereas loadHistory only runs on some — so this is the reliable hook for
    // re-checking watched files. Idempotent, so running again after a history
    // reload is harmless.
    surfaceWatchedChanges();
  }

  // Re-stat the watched files and, for any whose mtime differs from the version
  // you last opened, add a chip to the latest message — so a file edited by ANY
  // means (sed/shell/write) re-surfaces. The baseline is updated only when you
  // open the file (see openFileView), NOT here, so this is idempotent: a turn
  // can trigger several history reloads and the chip is added once (deduped),
  // and it keeps showing until you actually look at the new version.
  async function surfaceWatchedChanges() {
    if (!statFilesFn || watched.size === 0) return;
    let stats;
    try {
      stats = await statFilesFn([...watched.keys()]);
    } catch {
      return;
    }
    const changed = [];
    for (const [p, seen] of watched) {
      const now = stats[p];
      if (now != null && now !== seen) changed.push(p);
    }
    if (changed.length === 0) return;
    const assistants = $messages.querySelectorAll(".message.assistant");
    const last = assistants[assistants.length - 1];
    if (!last) return;
    // Don't duplicate a chip already shown (e.g. the turn also write/edit'd it,
    // or an earlier reload this turn already added it).
    const shown = new Set([...last.querySelectorAll(".file-chip")].map((c) => c.title));
    const fresh = changed.filter((p) => !shown.has(p));
    if (fresh.length > 0) last.appendChild(buildFileChips(fresh));
  }

  function ensureThinkingBlock() {
    if (currentThinkingEl) return;
    finalizeTextSegment(); // close the open text segment so thinking appends below it
    // Bind the click handler to a stable local, not currentThinkingEl — that
    // var is nulled when the segment closes, so the closure would go stale.
    const block = document.createElement("div");
    block.className = "thinking-block";
    if (nodeOpen("thinking")) block.classList.add("expanded");

    const header = document.createElement("div");
    header.className = "thinking-header";
    header.textContent = "thinking";
    header.addEventListener("click", () => block.classList.toggle("expanded"));

    const content = document.createElement("div");
    content.className = "thinking-content";

    block.appendChild(header);
    block.appendChild(content);
    currentAssistantEl.appendChild(block);

    currentThinkingEl = block;
    currentThinkingContent = content;
  }

  function addToolBlock(toolCallId, toolName, args) {
    if (!currentAssistantEl) return;
    removeStreamingCursor();
    // Close open text/thinking segments so the tool block appends below them,
    // preserving the agent's talk→tool→talk order.
    finalizeTextSegment();
    currentThinkingEl = null;
    currentThinkingContent = null;

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
      currentAssistantEl.appendChild(block);
      if (toolCallId) currentToolMap.set(toolCallId, { block, statusSpan: null, resultEl: null });
      return;
    }

    const block = document.createElement("div");
    block.className = "tool-block";
    block.dataset.toolName = toolName || "";
    if (nodeOpen(toolName)) block.classList.add("expanded");

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
    if (isEditArgs(toolName, args)) argsEl.appendChild(buildEditDiff(args));
    else argsEl.textContent = formatArgs(args);

    const resultEl = document.createElement("div");
    resultEl.className = "tool-result";

    header.addEventListener("click", () => block.classList.toggle("expanded"));
    block.appendChild(header);
    block.appendChild(argsEl);
    block.appendChild(resultEl);
    if (isSkillRead(toolName, args)) block.dataset.skillRead = "true";
    currentAssistantEl.appendChild(block);

    for (const p of extractFilePaths([{ name: toolName, arguments: args }])) {
      if (!turnFilePaths.includes(p)) turnFilePaths.push(p);
    }
    if (toolCallId) currentToolMap.set(toolCallId, { block, statusSpan, resultEl });
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
        return;
      }
    }

    entry.resultEl.textContent = resultText;
    entry.resultEl.classList.toggle("partial", isPartial);
  }

  function formatArgs(args) {
    if (!args) return "";
    try { return JSON.stringify(args, null, 2); }
    catch { return String(args); }
  }

  // An `edit` tool call carries {path, edits:[{oldText,newText}]}. Render the
  // edits as a read-only line diff (─ path header, then +/- hunks) instead of
  // raw JSON, so it's clear what changed.
  function isEditArgs(name, args) {
    return name === "edit" && Array.isArray(args?.edits);
  }
  function buildEditDiff(args) {
    const wrap = document.createElement("div");
    wrap.className = "diff-view";
    const path = args.path || args.file_path;
    if (path) {
      const head = document.createElement("div");
      head.className = "diff-path";
      head.textContent = path;
      wrap.appendChild(head);
    }
    args.edits.forEach((e, idx) => {
      if (idx > 0) {
        const sep = document.createElement("div");
        sep.className = "diff-sep";
        wrap.appendChild(sep);
      }
      for (const line of diffLines(e.oldText ?? e.old_string ?? "", e.newText ?? e.new_string ?? "")) {
        const el = document.createElement("div");
        el.className = `diff-line diff-${line.type}`;
        const mark = line.type === "add" ? "+" : line.type === "remove" ? "-" : " ";
        el.textContent = mark + line.text;
        wrap.appendChild(el);
      }
    });
    return wrap;
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
  }

  // ── Event dispatch ──

  function handleEvent(event) {
    // The prompt text of a turn this client didn't send (queued dispatch,
    // another tab's send), replayed BEFORE agent_start — i.e. before the
    // assistant bubble and its accumulator exist — so it's handled ahead of
    // the accumulator guard below. Deduped against the last user bubble:
    // switchTo loads history (which already contains the in-progress turn's
    // user message) right before attaching.
    if (event.type === "user_message") {
      if (typeof event.text === "string" && lastUserText !== event.text) addMessage("user", event.text);
      return;
    }
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
        break;
      }
      case "text_start": break;
      case "text_delta": appendTextDelta(state); break;
      case "text_end": renderTextCommitted(); break;
      case "thinking_start": ensureThinkingBlock(); break;
      case "thinking_delta": renderThinking(state); break;
      case "thinking_end": renderThinkingCommitted(); break;
      case "toolcall_start": break;
      case "toolcall_end": break;
      case "tool_execution_start": addToolBlock(event.toolCallId, event.toolName, event.args); break;
      case "tool_execution_update": {
        if (event.toolName === "subagent" || state.subagentDetails[event.toolCallId]) {
          const details = state.subagentDetails[event.toolCallId];
          if (details) updateSubagentViews(event.toolCallId, details);
        }
        updateToolResult(event.toolCallId, accumulator.getTool(event.toolCallId)?.resultText, true);
        break;
      }
      case "tool_execution_end": {
        const tool = accumulator.getTool(event.toolCallId);
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
    // Only the uncommitted tail — committed segments are already rendered and
    // frozen in their own elements. Don't spawn an empty segment on a flush.
    if (!state.pendingText) return;
    ensureTextSegment();
    currentTextEl.innerHTML = renderContent("assistant", state.pendingText);
    attachCopyButtons(currentTextEl);
    addStreamingCursor();
  }

  function appendTextDelta(state) {
    ensureTextSegment();
    // During streaming, use textContent for performance — avoid full markdown
    // re-parse on every delta. pendingText is just the current segment (reset on
    // text_start), so each segment renders its own text. Markdown on text_end.
    currentTextEl.textContent = state.pendingText;
    addStreamingCursor();
  }

  function renderTextCommitted() {
    // The segment's raw text is already in the element (from the deltas); render
    // it as markdown and close it so the next text_start opens a fresh element.
    finalizeTextSegment();
  }

  function renderThinking(state) {
    if (!currentThinkingContent) return;
    // pendingThinking is the current thinking segment (reset on thinking_start).
    currentThinkingContent.textContent = state.pendingThinking;
  }

  function renderThinkingCommitted() {
    // The text already shown (from the last thinking_delta) is this segment's
    // full content. Close the block so a later thinking_start opens a new one.
    currentThinkingEl = null;
    currentThinkingContent = null;
  }

  // ── History rendering ──

  // The ordered-parts contract shared by the live and reload paths. A message is
  // a sequence of thinking / text / toolCall parts in the order the agent
  // produced them. The server may one day send `entry.parts` directly; until
  // then we reconstruct it from the normalized buckets — an assistant message's
  // parts are always thinking → text → toolCalls (a tool_use ends the API turn,
  // so no text ever follows a tool call within one message).
  function entryParts(entry) {
    if (Array.isArray(entry.parts)) return entry.parts;
    const parts = [];
    if (entry.thinking) parts.push({ type: "thinking", text: entry.thinking });
    if (entry.text) parts.push({ type: "text", text: entry.text });
    if (entry.toolCalls) for (const tc of entry.toolCalls) parts.push({ type: "toolCall", tc });
    return parts;
  }

  // Append one part's static block to a bubble. Used by both reload (loadHistory)
  // and the subagent transcript, so a reloaded turn looks identical to the live
  // one: one bubble, blocks in event order. `toolMap` (optional) receives the
  // tool-result element keyed by tool call id, for callers that fill results by
  // id rather than by DOM query.
  function appendPart(bubbleEl, part, toolMap) {
    if (part.type === "thinking") {
      bubbleEl.appendChild(buildThinkingBlock(part.text));
    } else if (part.type === "text") {
      const textEl = document.createElement("div");
      textEl.className = "text";
      textEl.innerHTML = renderMarkdown(part.text);
      attachCopyButtons(textEl);
      bubbleEl.appendChild(textEl);
    } else if (part.type === "toolCall") {
      const { block, resultEl } = buildStaticToolBlock(part.tc);
      bubbleEl.appendChild(block);
      if (toolMap && part.tc?.id) toolMap.set(part.tc.id, resultEl);
    }
  }

  function loadHistory(history) {
    overlayMgr.closeAll(); // transcript is being replaced — no overlay may outlive it
    $messages.innerHTML = "";
    // Group each turn's assistant messages + tool results into ONE bubble, so
    // reload matches the live view (one bubble per turn, blocks interleaved).
    let turnEl = null;
    let turnPaths = null;

    const closeTurn = () => {
      if (turnEl && turnPaths.length > 0) turnEl.appendChild(buildFileChips(turnPaths));
      turnEl = null;
      turnPaths = null;
    };
    const ensureTurn = () => {
      if (turnEl) return turnEl;
      turnEl = document.createElement("div");
      turnEl.className = "message assistant";
      turnPaths = [];
      $messages.appendChild(turnEl);
      return turnEl;
    };

    for (const entry of history) {
      if (entry.role === "user") {
        closeTurn();
        addMessage("user", entry.text);
      } else if (entry.role === "assistant") {
        const parts = entryParts(entry);
        if (parts.length === 0) continue;
        const el = ensureTurn();
        for (const part of parts) appendPart(el, part);
        if (entry.toolCalls) {
          for (const p of extractFilePaths(entry.toolCalls)) {
            if (!turnPaths.includes(p)) turnPaths.push(p);
          }
        }
      } else if (entry.role === "system") {
        closeTurn();
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
            if (turnEl) {
              // Replace the corresponding tool block if it exists
              const toolBlock = turnEl.querySelector(`.tool-block [data-tool-call-id="${toolCallId}"]`)?.closest(".tool-block");
              if (toolBlock) {
                toolBlock.parentElement.replaceChild(saBlock, toolBlock);
              } else {
                turnEl.appendChild(saBlock);
              }
            } else {
              $messages.appendChild(saBlock);
            }
          }
        } else if (entry.toolCallId && entry.text && turnEl) {
          const resultEl = turnEl.querySelector(`.tool-result[data-tool-call-id="${entry.toolCallId}"]`);
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
    closeTurn();
    // The transcript was fully rebuilt — land at the bottom and re-engage
    // follow regardless of any prior scroll position.
    forceScrollToBottom();
    surfaceWatchedChanges(); // fire-and-forget: re-flag any watched file changed since last view
  }

  function expandAllTools() {
    $messages.querySelectorAll(".tool-block").forEach((el) => el.classList.add("expanded"));
    $messages.querySelectorAll(".thinking-block").forEach((el) => el.classList.add("expanded"));
  }

  function collapseAllTools() {
    $messages.querySelectorAll(".tool-block").forEach((el) => el.classList.remove("expanded"));
    $messages.querySelectorAll(".thinking-block").forEach((el) => el.classList.remove("expanded"));
  }

  // Distinct node types present in the transcript (tool names + "thinking"),
  // for building a per-type preference UI.
  function getPresentNodeTypes() {
    const tools = new Set();
    for (const b of $messages.querySelectorAll(".tool-block")) {
      if (b.dataset.toolName) tools.add(b.dataset.toolName);
    }
    const types = [...tools].sort();
    if ($messages.querySelector(".thinking-block")) types.push("thinking");
    return types;
  }

  // Expand/collapse every block of one type (apply a changed per-type default).
  function setTypeExpanded(type, open) {
    const sel = type === "thinking" ? ".thinking-block" : `.tool-block[data-tool-name="${CSS.escape(type)}"]`;
    for (const el of $messages.querySelectorAll(sel)) el.classList.toggle("expanded", open);
  }

  return {
    addMessage,
    loadHistory,
    startAssistantMessage,
    finishAssistantMessage,
    hasActiveMessage: () => accumulator !== null,
    handleEvent,
    showError,
    expandAllTools,
    collapseAllTools,
    getPresentNodeTypes,
    setTypeExpanded,
    closeSubagentView,
    closeFileView,
    clearWatched: () => watched.clear(),
  };
}
