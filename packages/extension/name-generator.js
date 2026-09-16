/**
 * Session name generator — pure functions for auto-naming sessions.
 *
 * Calls an OpenAI-compatible chat-completions endpoint. Provider, model, URL,
 * and API key are all configurable so it isn't hardwired to any one host.
 * Defaults match the original Fireworks setup for backward compatibility.
 *
 * Temperature=0 for deterministic output, reasoning_effort=none to skip thinking.
 */

const TITLE_SYSTEM_PROMPT = `You are a session title generator. Generate a SHORT title (2-6 words) for the user message below.

Rules:
- Extract key identifiers from the text and include them in the title:
  - GitHub PRs: extract repo name and PR number from the URL, format as "repo#123" (e.g. github.com/netSkope/service/pull/107231 -> service#107231)
  - Jira tickets: keep the full ticket ID (e.g. ENG-12345, OBS-12086)
  - Version numbers, feature names, repo names
- If there are multiple identifiers, include the most important ones. You can include 2 if they fit.
- The title should reflect what the user wants to DO, not just repeat the text.
- Keep it very short. For a PR, just "service#107231 review" is enough.
- Do NOT guess or infer content behind URLs. If the text ONLY contains a URL + a vague verb like "看一下" or "理解一下" with NO other descriptive context, reply SKIP.
- If the text has descriptive words about what the URL contains or what to do with it, that IS enough context. Generate a title.
- Reply with ONLY the title or SKIP. No explanation, no quotes, no markdown.`;

const DEFAULTS = {
  apiUrl: "https://api.fireworks.ai/inference/v1/chat/completions",
  // qwen3p8-max deterministically ignores the "reply with ONLY the title"
  // instruction on a meaningful fraction of prompts and dumps a full
  // explanatory preamble as plain content (not even flagged via
  // usage.completion_tokens_details.reasoning_tokens — it's not a reasoning
  // leak, it's an instruction-following failure). deepseek-v4p1-flash held up
  // clean across the same repro set, including deterministic re-runs of the
  // input that broke qwen every time.
  model: "accounts/fireworks/models/deepseek-v4p1-flash",
};

/**
 * Build the API request body for title generation.
 * @param {string} text — the user's first prompt
 * @param {object} [opts] — { model } override
 * @returns {object} request body for OpenAI-compatible chat completions API
 */
export function buildTitleRequest(text, opts = {}) {
  return {
    model: opts.model || DEFAULTS.model,
    temperature: 0,
    // 150 (not 50) — some providers don't fully honor reasoning_effort:"none"
    // and still emit a <think> block before the title; too small a budget
    // truncates mid-thought and leaves no title at all.
    max_tokens: 150,
    reasoning_effort: "none",
    messages: [
      { role: "system", content: TITLE_SYSTEM_PROMPT },
      { role: "user", content: text },
    ],
  };
}

const THINK_BLOCK_RE = /<think>[\s\S]*?<\/think>/gi;

// A real title is 2-6 words per the system prompt; anything this long is the
// model narrating instead of answering. Kept generous (well above any
// legitimate title) to avoid false-positive rejections.
const MAX_TITLE_LENGTH = 60;

// Telltale phrasing/tokens some models emit instead of following the "reply
// with ONLY the title" instruction — narrated reasoning or a stray tool-call
// token with no title at all.
const LEAK_MARKERS_RE = /<tool_call|<\/tool_call|^(the user|i'll|let me|looking at)\b/i;

/**
 * Parse the API response and extract the title.
 * Returns null for SKIP, empty, or leaked responses that should fall back
 * to the prompt-prefix naming instead.
 *
 * Some models leak chain-of-thought or narration into `message.content`
 * even with reasoning_effort:"none" requested — that's a provider/model
 * quirk, not something the request can fully suppress. Two independent
 * defenses:
 *   1. Strip <think>...</think> blocks when the model does tag its
 *      reasoning (if the block is never closed, max_tokens cut the
 *      response off mid-thought before any title was produced).
 *   2. Reject anything that doesn't look like a short title at all —
 *      covers models that narrate in plain, untagged prose instead of
 *      emitting a <think> block.
 *
 * @param {object} data — parsed JSON response from the chat completions API
 * @returns {string | null} the title, or null if should skip
 */
export function parseTitleResponse(data) {
  const content = data?.choices?.[0]?.message?.content;
  if (!content) return null;

  if (/<think>/i.test(content) && !/<\/think>/i.test(content)) return null;
  const stripped = content.replace(THINK_BLOCK_RE, "");

  const trimmed = stripped.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.toUpperCase() === "SKIP") return null;
  if (trimmed.length > MAX_TITLE_LENGTH) return null;
  if (LEAK_MARKERS_RE.test(trimmed)) return null;
  return trimmed;
}

/**
 * Build the auto-name config from env vars. Exported for testability and so
 * index.ts can log the resolved settings.
 *
 * Env vars (all optional; falls back to FIREWORKS_API_KEY for backward compat):
 *   PI_AUTO_NAME          — "0" disables auto-naming
 *   PI_AUTO_NAME_API_KEY  — API key (default: $FIREWORKS_API_KEY)
 *   PI_AUTO_NAME_API_URL  — chat completions URL
 *   PI_AUTO_NAME_MODEL    — model id
 *
 * @param {object} env — process.env or a test stub
 * @returns {{enabled:boolean, apiKey:string|undefined, apiUrl:string, model:string}}
 */
export function resolveAutoNameConfig(env = process.env) {
  const enabled = env.PI_AUTO_NAME !== "0";
  const apiKey = env.PI_AUTO_NAME_API_KEY || env.FIREWORKS_API_KEY;
  const apiUrl = env.PI_AUTO_NAME_API_URL || DEFAULTS.apiUrl;
  const model = env.PI_AUTO_NAME_MODEL || DEFAULTS.model;
  return { enabled, apiKey, apiUrl, model };
}

/**
 * Generate a session name by calling the chat completions API.
 * Returns the title string, or null if the model replied SKIP or on error.
 *
 * @param {string} text — the user's first prompt
 * @param {string} apiKey — API key
 * @param {object} [opts] — { apiUrl, model, fetch }
 * @returns {Promise<string | null>}
 */
export async function generateSessionName(text, apiKey, opts = {}) {
  const fetch = opts.fetch || globalThis.fetch;
  if (!fetch) throw new Error("No fetch available");
  if (!apiKey) return null;

  const apiUrl = opts.apiUrl || DEFAULTS.apiUrl;
  const body = JSON.stringify(buildTitleRequest(text, { model: opts.model }));

  try {
    const resp = await fetch(apiUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body,
    });

    if (!resp.ok) return null;

    const data = await resp.json();
    return parseTitleResponse(data);
  } catch {
    return null;
  }
}
