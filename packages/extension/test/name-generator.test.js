import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  buildRetitleRequest,
  buildTitleRequest,
  createRetitleTracker,
  generateRetitle,
  generateSessionName,
  lastAssistantSummary,
  parseTitleResponse,
  placeholderName,
  resolveAutoNameConfig,
} from "../name-generator.js";

describe("buildTitleRequest", () => {
  test("returns request body with correct model and params", () => {
    const req = buildTitleRequest("review PR 123");
    assert.equal(req.model, "accounts/fireworks/models/deepseek-v4p1-flash");
    assert.equal(req.temperature, 0);
    assert.equal(req.max_tokens, 150);
    assert.equal(req.reasoning_effort, "none");
  });

  test("includes system and user messages", () => {
    const req = buildTitleRequest("fix the bug");
    assert.equal(req.messages.length, 2);
    assert.equal(req.messages[0].role, "system");
    assert.equal(req.messages[1].role, "user");
    assert.equal(req.messages[1].content, "fix the bug");
  });

  test("system prompt contains key rules", () => {
    const req = buildTitleRequest("test");
    const sys = req.messages[0].content;
    assert.match(sys, /repo#123/);
    assert.match(sys, /SKIP/);
    assert.match(sys, /Do NOT guess/);
  });
});

describe("parseTitleResponse", () => {
  test("extracts title from normal response", () => {
    const data = { choices: [{ message: { content: "service#107231 review" } }] };
    assert.equal(parseTitleResponse(data), "service#107231 review");
  });

  test("returns null for SKIP", () => {
    const data = { choices: [{ message: { content: "SKIP" } }] };
    assert.equal(parseTitleResponse(data), null);
  });

  test("returns null for skip (lowercase)", () => {
    const data = { choices: [{ message: { content: "skip" } }] };
    assert.equal(parseTitleResponse(data), null);
  });

  test("returns null for empty content", () => {
    const data = { choices: [{ message: { content: "" } }] };
    assert.equal(parseTitleResponse(data), null);
  });

  test("returns null for whitespace-only content", () => {
    const data = { choices: [{ message: { content: "   " } }] };
    assert.equal(parseTitleResponse(data), null);
  });

  test("returns null for missing choices", () => {
    assert.equal(parseTitleResponse({}), null);
  });

  test("returns null for null data", () => {
    assert.equal(parseTitleResponse(null), null);
  });

  test("trims whitespace from title", () => {
    const data = { choices: [{ message: { content: "  OBS-12086 investigation  " } }] };
    assert.equal(parseTitleResponse(data), "OBS-12086 investigation");
  });

  test("strips a closed <think> block and returns the title after it", () => {
    const data = {
      choices: [{ message: { content: "<think>User wants to review a PR, I should keep it short.</think>service#107231 review" } }],
    };
    assert.equal(parseTitleResponse(data), "service#107231 review");
  });

  test("strips a closed <think> block with trailing whitespace/newlines", () => {
    const data = {
      choices: [{ message: { content: "<think>\nsome reasoning here\n</think>\n\nENG-12345 fix\n" } }],
    };
    assert.equal(parseTitleResponse(data), "ENG-12345 fix");
  });

  test("returns null when <think> is never closed (truncated by max_tokens)", () => {
    const data = {
      choices: [{ message: { content: "<think>The user's message only contains a URL with a vague verb like" } }],
    };
    assert.equal(parseTitleResponse(data), null);
  });

  test("returns null when content is only a closed <think> block (no title left)", () => {
    const data = {
      choices: [{ message: { content: "<think>reasoning only, forgot the title</think>" } }],
    };
    assert.equal(parseTitleResponse(data), null);
  });

  test("returns null when content is untagged narrated reasoning (no <think> at all)", () => {
    const data = {
      choices: [{ message: { content: "The user is asking for a formal scale/failure re-review, reading CONTEXT.md and checking various technical items in detail." } }],
    };
    assert.equal(parseTitleResponse(data), null);
  });

  test("returns null for a lone <tool_call> token with no title", () => {
    const data = { choices: [{ message: { content: "<tool_call>" } }] };
    assert.equal(parseTitleResponse(data), null);
  });

  test("returns null for narration starting with 'Let me'", () => {
    const data = { choices: [{ message: { content: "Let me generate a short title for this." } }] };
    assert.equal(parseTitleResponse(data), null);
  });

  test("returns null for a title-shaped response that is still too long", () => {
    const data = {
      choices: [{ message: { content: "a".repeat(61) } }],
    };
    assert.equal(parseTitleResponse(data), null);
  });

  test("accepts a short title right at the length boundary", () => {
    const data = {
      choices: [{ message: { content: "a".repeat(60) } }],
    };
    assert.equal(parseTitleResponse(data), "a".repeat(60));
  });
});

describe("generateSessionName", () => {
  function makeFetch(responseContent) {
    return async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: responseContent } }] }),
    });
  }

  test("returns title on success", async () => {
    const name = await generateSessionName("review the PR", "fake-key", { fetch: makeFetch("PR review") });
    assert.equal(name, "PR review");
  });

  test("returns null for SKIP", async () => {
    const name = await generateSessionName("看一下", "fake-key", { fetch: makeFetch("SKIP") });
    assert.equal(name, null);
  });

  test("returns null when API returns error", async () => {
    const fetchFn = async () => ({ ok: false, json: async () => ({ error: "bad request" }) });
    const name = await generateSessionName("test", "fake-key", { fetch: fetchFn });
    assert.equal(name, null);
  });

  test("returns null when fetch throws", async () => {
    const fetchFn = async () => { throw new Error("network error"); };
    const name = await generateSessionName("test", "fake-key", { fetch: fetchFn });
    assert.equal(name, null);
  });

  test("returns null when apiKey is empty", async () => {
    const name = await generateSessionName("test", "", { fetch: makeFetch("title") });
    assert.equal(name, null);
  });

  test("returns null when apiKey is undefined", async () => {
    const name = await generateSessionName("test", undefined, { fetch: makeFetch("title") });
    assert.equal(name, null);
  });

  test("passes correct request to fetch", async () => {
    let capturedOpts = null;
    const fetchFn = async (url, opts) => {
      capturedOpts = { url, opts };
      return { ok: true, json: async () => ({ choices: [{ message: { content: "title" } }] }) };
    };
    await generateSessionName("my prompt", "my-key", { fetch: fetchFn });
    assert.equal(capturedOpts.url, "https://api.fireworks.ai/inference/v1/chat/completions");
    assert.equal(capturedOpts.opts.method, "POST");
    assert.match(capturedOpts.opts.headers.Authorization, /Bearer my-key/);
    const body = JSON.parse(capturedOpts.opts.body);
    assert.equal(body.messages[1].content, "my prompt");
  });
});

describe("generateSessionName with custom provider", () => {
  test("uses custom apiUrl and model", async () => {
    let captured = null;
    const fetchFn = async (url, opts) => {
      captured = { url, body: JSON.parse(opts.body) };
      return { ok: true, json: async () => ({ choices: [{ message: { content: "title" } }] }) };
    };
    const name = await generateSessionName("test", "key", {
      apiUrl: "https://example.com/v1/chat",
      model: "my-org/my-model",
      fetch: fetchFn,
    });
    assert.equal(name, "title");
    assert.equal(captured.url, "https://example.com/v1/chat");
    assert.equal(captured.body.model, "my-org/my-model");
  });
});

describe("resolveAutoNameConfig", () => {
  test("defaults to Fireworks + FIREWORKS_API_KEY", () => {
    const cfg = resolveAutoNameConfig({ FIREWORKS_API_KEY: "fw-key" });
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.apiKey, "fw-key");
    assert.equal(cfg.apiUrl, "https://api.fireworks.ai/inference/v1/chat/completions");
    assert.equal(cfg.model, "accounts/fireworks/models/deepseek-v4p1-flash");
  });

  test("PI_AUTO_NAME=0 disables", () => {
    const cfg = resolveAutoNameConfig({ PI_AUTO_NAME: "0", FIREWORKS_API_KEY: "k" });
    assert.equal(cfg.enabled, false);
  });

  test("PI_AUTO_NAME_API_KEY overrides FIREWORKS_API_KEY", () => {
    const cfg = resolveAutoNameConfig({ FIREWORKS_API_KEY: "fw", PI_AUTO_NAME_API_KEY: "custom" });
    assert.equal(cfg.apiKey, "custom");
  });

  test("falls back to FIREWORKS_API_KEY when no override", () => {
    const cfg = resolveAutoNameConfig({ FIREWORKS_API_KEY: "fw" });
    assert.equal(cfg.apiKey, "fw");
  });

  test("apiKey undefined when neither set", () => {
    const cfg = resolveAutoNameConfig({});
    assert.equal(cfg.apiKey, undefined);
    assert.equal(cfg.enabled, true);
  });

  test("PI_AUTO_NAME_API_URL overrides default URL", () => {
    const cfg = resolveAutoNameConfig({ PI_AUTO_NAME_API_URL: "https://other.example/v1/chat" });
    assert.equal(cfg.apiUrl, "https://other.example/v1/chat");
  });

  test("PI_AUTO_NAME_MODEL overrides default model", () => {
    const cfg = resolveAutoNameConfig({ PI_AUTO_NAME_MODEL: "org/my-model" });
    assert.equal(cfg.model, "org/my-model");
  });
});

describe("placeholderName", () => {
  const cases = [
    ["slack link + vague verb", "https://netskope.slack.com/archives/C0CJ/p17954 他在問什麼", "Slack 他在問什麼"],
    ["github PR", "https://github.com/netSkope/service/pull/107231 看一下", "service#107231 看一下"],
    ["github non-PR -> hostname", "https://github.com/netSkope/service/issues/5 看一下", "github.com 看一下"],
    ["jira browse", "https://netskope.atlassian.net/browse/ENG-12345 理解一下", "ENG-12345 理解一下"],
    ["atlassian non-browse -> hostname", "https://netskope.atlassian.net/wiki/x/abc 看一下", "netskope.atlassian.net 看一下"],
    ["unknown host", "https://docs.example.com/a/b?c=1 看一下", "docs.example.com 看一下"],
    ["URL-only prompt", "https://netskope.slack.com/archives/C0CJ/p17954", "Slack"],
    ["multiple URLs", "https://github.com/o/r/pull/1 vs https://netskope.atlassian.net/browse/OBS-9", "r#1 vs OBS-9"],
    ["unparseable URL", "https://[bad 看一下", "link 看一下"],
    ["CJK glued to slack link", "https://netskope.slack.com/archives/C0CJ/p17954他在問什麼", "Slack 他在問什麼"],
    ["CJK glued to bare host", "https://example.com看一下", "example.com 看一下"],
    ["closing paren stays", "(see https://docs.example.com/x)", "(see docs.example.com)"],
    ["trailing period stays", "look at https://github.com/o/r/pull/7.", "look at r#7."],
    ["whitespace/newline collapse", "  https://x.example.com/p\n\n  看一下\t這個  ", "x.example.com 看一下 這個"],
  ];
  for (const [name, input, expected] of cases) {
    test(name, () => assert.equal(placeholderName(input), expected));
  }

  test("caps at 120 chars, trims after the cap", () => {
    const out = placeholderName(`${"a".repeat(119)} bbbb`);
    assert.equal(out, "a".repeat(119));
    assert.equal(placeholderName("x".repeat(300)).length, 120);
  });

  test("idempotent under pi name normalization", () => {
    const normalize = (s) => s.replace(/[\r\n]+/g, " ").trim();
    for (const [, input] of cases) {
      const out = placeholderName(input);
      assert.equal(normalize(out), out);
    }
    const capped = placeholderName(`${"a".repeat(119)}\n\nb`);
    assert.equal(normalize(capped), capped);
  });
});

describe("buildRetitleRequest", () => {
  test("carries both texts with the same model params as buildTitleRequest", () => {
    const req = buildRetitleRequest("https://x.example.com 看一下", "It is a design doc about caching.");
    const base = buildTitleRequest("x");
    assert.equal(req.model, base.model);
    assert.equal(req.temperature, base.temperature);
    assert.equal(req.max_tokens, base.max_tokens);
    assert.equal(req.reasoning_effort, base.reasoning_effort);
    assert.equal(req.messages.length, 2);
    assert.equal(req.messages[0].role, "system");
    assert.match(req.messages[1].content, /https:\/\/x\.example\.com 看一下/);
    assert.match(req.messages[1].content, /design doc about caching/);
  });

  test("model override", () => {
    assert.equal(buildRetitleRequest("u", "a", { model: "org/m" }).model, "org/m");
  });

  test("truncates user text to 500 and assistant text to 1500 chars", () => {
    const content = buildRetitleRequest("Q".repeat(800), "Z".repeat(3000)).messages[1].content;
    assert.equal(content.match(/Q+/)[0].length, 500);
    assert.equal(content.match(/Z+/)[0].length, 1500);
  });

  test("system prompt keeps identifier rules and has no SKIP option", () => {
    const sys = buildRetitleRequest("u", "a").messages[0].content;
    assert.match(sys, /repo#123/);
    assert.match(sys, /ENG-12345/);
    assert.doesNotMatch(sys, /SKIP/i);
  });
});

describe("lastAssistantSummary", () => {
  const cases = [
    [
      "last assistant wins",
      [
        { role: "user", content: "q" },
        { role: "assistant", content: [{ type: "text", text: "first" }], stopReason: "toolUse" },
        { role: "toolResult", content: [{ type: "text", text: "tool out" }] },
        { role: "assistant", content: [{ type: "text", text: "final" }], stopReason: "stop" },
      ],
      { stopReason: "stop", text: "final" },
    ],
    [
      "ignores thinking and toolCall blocks, joins text blocks",
      [
        {
          role: "assistant",
          stopReason: "stop",
          content: [
            { type: "thinking", thinking: "hmm" },
            { type: "text", text: "part one" },
            { type: "toolCall", name: "bash", arguments: {} },
            { type: "text", text: "part two" },
          ],
        },
      ],
      { stopReason: "stop", text: "part one\npart two" },
    ],
    ["string content", [{ role: "assistant", content: "  plain  ", stopReason: "stop" }], { stopReason: "stop", text: "plain" }],
    ["missing content -> empty text", [{ role: "assistant", stopReason: "aborted" }], { stopReason: "aborted", text: "" }],
    ["no assistant -> null", [{ role: "user", content: "q" }], null],
    ["empty list -> null", [], null],
    ["not an array -> null", undefined, null],
  ];
  for (const [name, messages, expected] of cases) {
    test(name, () => assert.deepEqual(lastAssistantSummary(messages), expected));
  }
});

describe("createRetitleTracker", () => {
  const PH = "Slack 他在問什麼";
  const reply = (text, stopReason = "stop") => [
    { role: "user", content: "q" },
    { role: "assistant", content: [{ type: "text", text }], stopReason },
  ];
  const retitle = (assistantText) => ({ action: "retitle", userText: "PROMPT", assistantText });
  const drop = (reason) => ({ action: "drop", reason });
  const WAIT = { action: "wait" };
  const NONE = { action: "none" };

  // Each step: [method, arg, expected return (undefined = not asserted)].
  const cases = [
    ["placeholder then settle -> retitle", [
      ["onPrompt", "PROMPT"], ["onAgentEnd", reply("found X")], ["onPlaceholder", PH, WAIT], ["onSettled", PH, retitle("found X")],
    ]],
    ["settle then placeholder (late SKIP) -> retitle from first-run stash", [
      ["onPrompt", "PROMPT"], ["onAgentEnd", reply("found X")], ["onSettled", PH, WAIT], ["onPlaceholder", PH, retitle("found X")],
    ]],
    ["second run after settle cannot overwrite the frozen stash", [
      ["onPrompt", "PROMPT"], ["onAgentEnd", reply("found X")], ["onSettled", PH, WAIT],
      ["onAgentEnd", reply("second run")], ["onSettled", PH, WAIT], ["onPlaceholder", PH, retitle("found X")],
    ]],
    ["renamed before decision -> drop renamed", [
      ["onPrompt", "PROMPT"], ["onAgentEnd", reply("found X")], ["onPlaceholder", PH, WAIT], ["onSettled", "my name", drop("renamed")],
    ]],
    ["stopReason error -> drop bad-stop", [
      ["onPrompt", "PROMPT"], ["onAgentEnd", reply("partial", "error")], ["onPlaceholder", PH, WAIT], ["onSettled", PH, drop("bad-stop")],
    ]],
    ["stopReason length -> drop bad-stop", [
      ["onPrompt", "PROMPT"], ["onAgentEnd", reply("partial", "length")], ["onPlaceholder", PH, WAIT], ["onSettled", PH, drop("bad-stop")],
    ]],
    ["stopReason aborted -> drop bad-stop", [
      ["onPrompt", "PROMPT"], ["onAgentEnd", reply("partial", "aborted")], ["onPlaceholder", PH, WAIT], ["onSettled", PH, drop("bad-stop")],
    ]],
    ["late SKIP with aborted stash -> drop bad-stop", [
      ["onPrompt", "PROMPT"], ["onAgentEnd", reply("partial", "aborted")], ["onSettled", PH, WAIT], ["onPlaceholder", PH, drop("bad-stop")],
    ]],
    ["empty text -> drop empty", [
      ["onPrompt", "PROMPT"], ["onAgentEnd", reply("   ")], ["onPlaceholder", PH, WAIT], ["onSettled", PH, drop("empty")],
    ]],
    ["no agent_end at all -> drop missing", [
      ["onPrompt", "PROMPT"], ["onPlaceholder", PH, WAIT], ["onSettled", PH, drop("missing")],
    ]],
    ["retry within one run: latest stash wins", [
      ["onPrompt", "PROMPT"], ["onAgentEnd", reply("boom", "error")], ["onAgentEnd", reply("found X")],
      ["onPlaceholder", PH, WAIT], ["onSettled", PH, retitle("found X")],
    ]],
    ["decision returned once, then none", [
      ["onPrompt", "PROMPT"], ["onAgentEnd", reply("found X")], ["onPlaceholder", PH, WAIT], ["onSettled", PH, retitle("found X")],
      ["onSettled", PH, NONE], ["onPlaceholder", PH, NONE], ["onAgentEnd", reply("later")], ["onPrompt", "again"], ["onSettled", PH, NONE],
    ]],
    ["collecting without placeholder: settle waits, repeat settles keep waiting", [
      ["onPrompt", "PROMPT"], ["onAgentEnd", reply("found X")], ["onSettled", PH, WAIT], ["onSettled", PH, WAIT],
    ]],
    ["onNoPlaceholder from collecting -> later events none", [
      ["onPrompt", "PROMPT"], ["onAgentEnd", reply("found X")], ["onNoPlaceholder"], ["onSettled", PH, NONE], ["onPlaceholder", PH, NONE],
    ]],
    ["onNoPlaceholder from settled -> later events none", [
      ["onPrompt", "PROMPT"], ["onAgentEnd", reply("found X")], ["onSettled", PH, WAIT], ["onNoPlaceholder"], ["onSettled", PH, NONE],
    ]],
    ["idle: every event is none", [
      ["onAgentEnd", reply("found X")], ["onSettled", PH, NONE], ["onPlaceholder", PH, NONE], ["onNoPlaceholder"], ["onSettled", PH, NONE],
    ]],
    ["only the first prompt counts", [
      ["onPrompt", "PROMPT"], ["onPrompt", "second prompt"], ["onAgentEnd", reply("found X")], ["onPlaceholder", PH, WAIT], ["onSettled", PH, retitle("found X")],
    ]],
  ];
  for (const [name, steps] of cases) {
    test(name, () => {
      const t = createRetitleTracker();
      steps.forEach(([method, arg, expected], i) => {
        const out = t[method](arg);
        if (expected !== undefined) assert.deepEqual(out, expected, `step ${i} ${method}`);
      });
    });
  }

  test("canApply: only while the current name is the registered placeholder", () => {
    const t = createRetitleTracker();
    assert.equal(t.canApply(PH), false);
    t.onPrompt("PROMPT");
    assert.equal(t.canApply(PH), false);
    t.onPlaceholder(PH);
    assert.equal(t.canApply(PH), true);
    assert.equal(t.canApply("user name"), false);
  });
});

describe("generateRetitle", () => {
  const respond = (content, ok = true) => async () => ({ ok, json: async () => ({ choices: [{ message: { content } }] }) });
  const cases = [
    ["ok", "fake-key", respond("Caching design doc review"), "Caching design doc review"],
    ["<think> leak stripped", "fake-key", respond("<think>reasoning</think>Caching doc"), "Caching doc"],
    ["unclosed <think> -> null", "fake-key", respond("<think>still thinking"), null],
    ["non-ok -> null", "fake-key", respond("x", false), null],
    ["no key -> null", "", respond("title"), null],
    ["fetch throws -> null", "fake-key", async () => { throw new Error("network"); }, null],
  ];
  for (const [name, key, fetch, expected] of cases) {
    test(name, async () => assert.equal(await generateRetitle("u", "a", key, { fetch }), expected));
  }

  test("posts a retitle request to the configured url and model", async () => {
    let captured = null;
    const fetch = async (url, opts) => {
      captured = { url, opts, body: JSON.parse(opts.body) };
      return { ok: true, json: async () => ({ choices: [{ message: { content: "t" } }] }) };
    };
    await generateRetitle("my prompt", "my reply", "k", { fetch, apiUrl: "https://example.com/v1/chat", model: "org/m" });
    assert.equal(captured.url, "https://example.com/v1/chat");
    assert.match(captured.opts.headers.Authorization, /Bearer k/);
    assert.equal(captured.body.model, "org/m");
    assert.doesNotMatch(captured.body.messages[0].content, /SKIP/);
    assert.match(captured.body.messages[1].content, /my prompt[\s\S]*my reply/);
  });
});
