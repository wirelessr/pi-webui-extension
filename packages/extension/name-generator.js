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
  model: "accounts/fireworks/models/qwen3p7-plus",
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
    max_tokens: 50,
    reasoning_effort: "none",
    messages: [
      { role: "system", content: TITLE_SYSTEM_PROMPT },
      { role: "user", content: text },
    ],
  };
}

/**
 * Parse the API response and extract the title.
 * Returns null for SKIP or empty responses.
 * @param {object} data — parsed JSON response from the chat completions API
 * @returns {string | null} the title, or null if should skip
 */
export function parseTitleResponse(data) {
  const content = data?.choices?.[0]?.message?.content;
  if (!content) return null;
  const trimmed = content.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.toUpperCase() === "SKIP") return null;
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
