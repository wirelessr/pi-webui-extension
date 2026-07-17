/**
 * Stream accumulator — pure state machine for SSE event processing.
 *
 * Encodes the behavioral spec of how streaming events map to
 * text/thinking/tool state. No DOM dependency — the chat module
 * drives DOM rendering based on the accumulator's state.
 *
 * Key invariants:
 * - text_delta accumulates in pendingText, separate from committedText
 * - text_end flushes pending → committed
 * - tool_execution_start flushes text BEFORE registering the tool
 *   (tool block appears only after all prior text is committed)
 * - done flushes both text and thinking, marks stream as done
 * - error stores the error message, does not flush
 * - Each tool_execution_start gets a unique toolCallId with "running" status
 * - tool_execution_end updates the matching tool's status to "done" or "error"
 */

/**
 * @typedef {Object} ToolBlock
 * @property {string} toolCallId
 * @property {string} toolName
 * @property {object|null} args
 * @property {"running"|"done"|"error"} status
 * @property {string|null} resultText — extracted text from tool result
 * @property {boolean} isPartial — whether this is a partial result (still streaming)
 */

/**
 * Create a new stream accumulator.
 * @returns {{handleEvent: (e: object) => void, getState: () => object, getTool: (toolCallId: string) => ToolBlock|undefined}}
 */
export function createStreamAccumulator() {
  let committedText = "";
  let pendingText = "";
  let committedThinking = "";
  let pendingThinking = "";
  let thinkingActive = false;
  const tools = new Map();
  const subagentDetails = new Map();
  let done = false;
  let error = null;

  function flushText() {
    if (pendingText.length === 0) return;
    committedText += pendingText;
    pendingText = "";
  }

  function flushThinking() {
    if (pendingThinking.length === 0) return;
    committedThinking += pendingThinking;
    pendingThinking = "";
  }

  function handleEvent(event) {
    switch (event.type) {
      case "agent_start":
      case "turn_start":
      case "toolcall_start":
      case "toolcall_end":
        break;

      case "turn_end":
        flushText();
        flushThinking();
        break;

      case "done":
        flushText();
        flushThinking();
        done = true;
        break;

      case "error":
        error = event.message ?? "Unknown error";
        break;

      case "text_start":
        pendingText = "";
        break;

      case "text_delta":
        pendingText += event.delta;
        break;

      case "text_end":
        flushText();
        break;

      case "thinking_start":
        pendingThinking = "";
        thinkingActive = true;
        break;

      case "thinking_delta":
        pendingThinking += event.delta;
        break;

      case "thinking_end":
        flushThinking();
        thinkingActive = false;
        break;

      case "tool_execution_start":
        flushText();
        tools.set(event.toolCallId, {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: event.args ?? null,
          status: "running",
          resultText: null,
          isPartial: false,
        });
        break;

      case "tool_execution_update":
        if (event.toolCallId && tools.has(event.toolCallId)) {
          const tool = tools.get(event.toolCallId);
          tool.resultText = extractResultText(event.partialResult);
          tool.isPartial = true;
          if (tool.toolName === "subagent" && event.partialResult?.details) {
            subagentDetails.set(event.toolCallId, event.partialResult.details);
          }
        }
        break;

      case "tool_execution_end":
        if (event.toolCallId && tools.has(event.toolCallId)) {
          const tool = tools.get(event.toolCallId);
          tool.status = event.isError ? "error" : "done";
          tool.resultText = extractResultText(event.result);
          tool.isPartial = false;
          if (tool.toolName === "subagent" && event.result?.details) {
            subagentDetails.set(event.toolCallId, event.result.details);
          }
        }
        break;

      default:
        break;
    }
  }

  function getState() {
    return {
      committedText,
      pendingText,
      committedThinking,
      pendingThinking,
      thinkingActive,
      tools: Array.from(tools.values()),
      subagentDetails: Object.fromEntries(subagentDetails),
      done,
      error,
    };
  }

  // O(1) lookup for event handlers that need one tool by id — getState().tools
  // is a fresh array each call, so a find() over it per event is O(n²) across
  // a tool-heavy turn.
  function getTool(toolCallId) {
    return tools.get(toolCallId);
  }

  return { handleEvent, getState, getTool };
}

/**
 * Extract text content from a tool result/partialResult.
 * @param {object|undefined} result — { content: Array<{type, text?}>, ... }
 * @returns {string|null}
 */
function extractResultText(result) {
  if (!result?.content) return null;
  const texts = result.content
    .filter((c) => c.type === "text" && c.text)
    .map((c) => c.text);
  return texts.length > 0 ? texts.join("\n") : null;
}
