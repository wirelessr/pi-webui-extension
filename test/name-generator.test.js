import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buildTitleRequest, generateSessionName, parseTitleResponse } from "../name-generator.js";

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
    const name = await generateSessionName("review the PR", "fake-key", makeFetch("PR review"));
    assert.equal(name, "PR review");
  });

  test("returns null for SKIP", async () => {
    const name = await generateSessionName("看一下", "fake-key", makeFetch("SKIP"));
    assert.equal(name, null);
  });

  test("returns null when API returns error", async () => {
    const fetchFn = async () => ({ ok: false, json: async () => ({ error: "bad request" }) });
    const name = await generateSessionName("test", "fake-key", fetchFn);
    assert.equal(name, null);
  });

  test("returns null when fetch throws", async () => {
    const fetchFn = async () => { throw new Error("network error"); };
    const name = await generateSessionName("test", "fake-key", fetchFn);
    assert.equal(name, null);
  });

  test("returns null when apiKey is empty", async () => {
    const name = await generateSessionName("test", "", makeFetch("title"));
    assert.equal(name, null);
  });

  test("returns null when apiKey is undefined", async () => {
    const name = await generateSessionName("test", undefined, makeFetch("title"));
    assert.equal(name, null);
  });

  test("passes correct request to fetch", async () => {
    let capturedOpts = null;
    const fetchFn = async (url, opts) => {
      capturedOpts = { url, opts };
      return { ok: true, json: async () => ({ choices: [{ message: { content: "title" } }] }) };
    };
    await generateSessionName("my prompt", "my-key", fetchFn);
    assert.equal(capturedOpts.url, "https://api.fireworks.ai/inference/v1/chat/completions");
    assert.equal(capturedOpts.opts.method, "POST");
    assert.match(capturedOpts.opts.headers.Authorization, /Bearer my-key/);
    const body = JSON.parse(capturedOpts.opts.body);
    assert.equal(body.messages[1].content, "my prompt");
  });
});
