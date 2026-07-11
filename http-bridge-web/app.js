/**
 * pi bridge — main entry point
 *
 * Wires together all modules:
 *   - api:     HTTP fetch wrappers
 *   - sse:     SSE stream reading (inside api.sendPromptStream)
 *   - chat:    message rendering, streaming, tool/thinking blocks
 *   - sessions: left sidebar session list
 *   - commands: right sidebar command list + filtering
 *   - input:   textarea handling, keyboard, auto-resize
 *   - mobile-nav: bottom tab bar for mobile
 */

import { abortAgent, executeCommand, getHistory, getStatus, sendPromptStream } from "./api.js";
import { createChat } from "./chat.js";
import { createCommandsView } from "./commands.js";
import { createContextMenu } from "./context-menu.js";
import { createInput } from "./input.js";
import { createMobileNav } from "./mobile-nav.js";
import { createSessionsView } from "./sessions.js";

(function () {

  // ── DOM refs ──────────────────────────────────────

  const $app = document.getElementById("app");
  const $messages = document.getElementById("messages");
  const $chat = document.getElementById("chat");
  const $autoScroll = document.getElementById("auto-scroll");
  const $scrollBottom = document.getElementById("scroll-bottom");
  const $input = document.getElementById("message-input");
  const $sendBtn = document.getElementById("send-btn");
  const $busyIndicator = document.getElementById("busy-indicator");
  const $portDisplay = document.getElementById("port-display");
  const $sessionName = document.getElementById("session-name");
  const $statsDisplay = document.getElementById("stats-display");
  const $sessionsList = document.getElementById("sessions-list");
  const $refreshSessions = document.getElementById("refresh-sessions");
  const $newSession = document.getElementById("new-session");
  const $reloadAll = document.getElementById("reload-all");
  const $commandsList = document.getElementById("commands-list");
  const $commandsCount = document.getElementById("commands-count");
  const $commandsTitle = document.getElementById("commands-title");

  // ── State ─────────────────────────────────────────

  let currentPort = null;

  // ── Module instances ──────────────────────────────

  const chat = createChat({ $messages, $chat, $autoScroll, $scrollBottom });

  const mobileNav = createMobileNav({ $app });

  const sessionsView = createSessionsView({
    $list: $sessionsList,
    getCurrentPort: () => currentPort,
    onOpen: (s) => {
      const url = s.url || `http://localhost:${s.port}`;
      window.location.href = url;
    },
  });

  const commandsView = createCommandsView({
    $list: $commandsList,
    $count: $commandsCount,
    $title: $commandsTitle,
    onSelect: (cmd) => input.selectCommand(cmd),
  });

  const input = createInput({
    $input,
    $sendBtn,
    commandsView,
    mobileNav,
    onSend: handleSend,
    onSelectCommand: handleSelectCommand,
    onStop: handleStop,
  });

  createContextMenu({ $messages });

  // ── Session refresh ───────────────────────────────

  $refreshSessions?.addEventListener("click", () => sessionsView.load());
  $newSession?.addEventListener("click", () => sessionsView.handleNew());
  $reloadAll?.addEventListener("click", () => sessionsView.handleReloadAll());

  // ── Command selection ──

  async function handleSelectCommand(cmd) {
    // Executable builtins (compact, reload) are triggered via API
    if (cmd.source === "builtin" && cmd.executable) {
      try {
        await executeCommand(cmd.name);
        chat.addMessage("system", `/${cmd.name} triggered`);
      } catch (err) {
        chat.showError(err.message || `Failed to execute /${cmd.name}`);
      }
      return;
    }
    // Non-executable builtins: just insert the text (will be ignored by agent)
    // Skills and prompts: insert into input for normal send flow
    input.selectCommand(cmd);
  }

  // ── Stop flow ──────────────────────────────────────

  async function handleStop() {
    try {
      await abortAgent();
    } catch (err) {
      chat.showError(err.message || "Failed to abort");
    }
  }

  // ── Send flow ─────────────────────────────────────

  async function handleSend(text) {
    chat.addMessage("user", text);
    input.setStreaming(true);
    setBusy(true);
    chat.startAssistantMessage();

    let streamComplete = false;
    try {
      await sendPromptStream(text, (event) => {
        if (event.type === "done") streamComplete = true;
        chat.handleEvent(event);
      });
    } catch (err) {
      chat.showError(err.message || "Connection failed");
    } finally {
      chat.finishAssistantMessage();
      input.setStreaming(false);
      setBusy(false);
      // Only reload if SSE ended abnormally (no done event = connection dropped)
      if (!streamComplete) {
        try {
          const data = await getHistory();
          if (data.history && data.history.length > 0) {
            chat.loadHistory(data.history);
          }
        } catch {
          // Best effort
        }
      }
      try {
        const status = await getStatus();
        updateStats(status);
      } catch {
        // Best effort
      }
    }
  }

  // ── Busy indicator ────────────────────────────────

  function setBusy(busy) {
    $busyIndicator.textContent = busy ? "busy" : "idle";
    $busyIndicator.className = `status ${busy ? "busy" : "idle"}`;
  }

  // ── Stats formatting ───────────────────────────────

  function formatTokens(n) {
    if (n < 1000) return String(n);
    if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
    if (n < 1000000) return `${Math.round(n / 1000)}k`;
    if (n < 10000000) return `${(n / 1000000).toFixed(1)}M`;
    return `${Math.round(n / 1000000)}M`;
  }

  function updateStats(data) {
    if (!data.usage || !data.context) return;
    const u = data.usage;
    const ctx = data.context;
    const parts = [];
    if (u.inputTokens) parts.push(`↑${formatTokens(u.inputTokens)}`);
    if (u.outputTokens) parts.push(`↓${formatTokens(u.outputTokens)}`);
    if (u.cacheReadTokens) parts.push(`R${formatTokens(u.cacheReadTokens)}`);
    if (u.cacheWriteTokens) parts.push(`W${formatTokens(u.cacheWriteTokens)}`);
    if (u.cacheHitRate !== null) parts.push(`CH${u.cacheHitRate.toFixed(1)}%`);
    if (u.totalCost) parts.push(`$${u.totalCost.toFixed(3)}`);
    const ctxStr = ctx.percent !== null
      ? `${ctx.percent.toFixed(1)}%/${formatTokens(ctx.contextWindow)}`
      : `?/${formatTokens(ctx.contextWindow)}`;
    parts.push(ctxStr);
    $statsDisplay.textContent = parts.join(" \u00b7 ");
  }

  // ── Init ──────────────────────────────────────────

  async function init() {
    try {
      const data = await getStatus();
      currentPort = data.port;
      $portDisplay.textContent = `:${data.port}`;
      if (data.sessionName) $sessionName.textContent = data.sessionName;
      else if (data.sessionId) $sessionName.textContent = data.sessionId.slice(0, 8);
      updateStats(data);
    } catch {
      // Server might not be ready yet
    }

    await commandsView.load();
    sessionsView.load();
    input.autoResize();

    // Load conversation history from session JSONL
    try {
      const data = await getHistory();
      if (data.history && data.history.length > 0) {
        chat.loadHistory(data.history);
      }
    } catch {
      // History might not be available
    }
  }

  init();
})();
