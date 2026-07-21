import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buildTitleRequest, generateSessionName, parseTitleResponse, resolveAutoNameConfig } from "../name-generator.js";

describe("buildTitleRequest", () => {
  test("returns request body with correct model and params", () => {
    const req = buildTitleRequest("review PR 123");
    assert.equal(req.model, "accounts/fireworks/models/qwen3p7-plus");
    assert.equal(req.temperature, 0);
    assert.equal(req.max_tokens, 50);
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
  function makeFetch(responseContent) {
    return async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: responseContent } }] }),
    });
  }

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
    assert.equal(cfg.model, "accounts/fireworks/models/qwen3p7-plus");
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
