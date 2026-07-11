import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  abortAgent,
  clientLog,
  executeCommand,
  getCommands,
  getHistory,
  getSessions,
  getStatus,
  killSession,
  newSession,
  pollUntil,
  reloadSession,
  renameSession,
  sendPromptStream,
  sessionUrl,
} from "../http-bridge-web/api.js";

// ── Mock helpers ──────────────────────────────────────

/**
 * Create a mock fetch that returns a controlled Response-like object.
 * @param {object} opts
 * @param {number} [opts.status=200]
 * @param {object} [opts.jsonData]
 * @param {string} [opts.bodyText] — for streaming responses
 * @returns {(url: string, init?: object) => Promise<object>}
 */
function mockFetch(opts = {}) {
  const { status = 200, jsonData, bodyText } = opts;
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    if (status < 400 && bodyText !== undefined) {
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(bodyText));
          controller.close();
        },
      });
      return {
        ok: true,
        status,
        body: stream,
        json: async () => jsonData,
      };
    }
    return {
      ok: status < 400,
      status,
      json: async () => jsonData ?? { error: `HTTP ${status}` },
    };
  };
  fn.calls = calls;
  return fn;
}

// ── sessionUrl + pollUntil (table-driven, no fetch) ──

describe("sessionUrl", () => {
  const cases = [
    { name: "uses s.url when present", session: { url: "http://192.168.1.130:7331", port: 7331 }, expected: "http://192.168.1.130:7331" },
    { name: "falls back to localhost when url missing", session: { port: 7332 }, expected: "http://localhost:7332" },
    { name: "falls back to localhost when url is empty string", session: { url: "", port: 7333 }, expected: "http://localhost:7333" },
    { name: "falls back to localhost when url is null", session: { url: null, port: 7334 }, expected: "http://localhost:7334" },
  ];
  for (const c of cases) {
    test(c.name, () => assert.equal(sessionUrl(c.session), c.expected));
  }
});

describe("pollUntil", () => {
  test("returns truthy result when condition met", async () => {
    let count = 0;
    const result = await pollUntil(async () => {
      count++;
      return count >= 3 ? "done" : false;
    }, 10, 10);
    assert.equal(result, "done");
    assert.equal(count, 3);
  });

  test("returns null when condition never met", async () => {
    const result = await pollUntil(async () => false, 10, 3);
    assert.equal(result, null);
  });

  test("swallows errors and keeps polling", async () => {
    let count = 0;
    const result = await pollUntil(async () => {
      count++;
      if (count < 2) throw new Error("transient");
      return "ok";
    }, 10, 5);
    assert.equal(result, "ok");
    assert.equal(count, 2);
  });

  test("returns null if all attempts throw", async () => {
    const result = await pollUntil(async () => {
      throw new Error("always fails");
    }, 10, 3);
    assert.equal(result, null);
  });

  test("respects maxAttempts", async () => {
    let count = 0;
    await pollUntil(async () => {
      count++;
      return false;
    }, 10, 4);
    assert.equal(count, 4);
  });

  test("zero maxAttempts returns null immediately", async () => {
    const result = await pollUntil(async () => true, 10, 0);
    assert.equal(result, null);
  });
});

// ── GET wrappers ──────────────────────────────────────

describe("GET wrappers", () => {
  const cases = [
    { name: "getStatus calls GET /api/status", fn: getStatus, expectedUrl: "/api/status" },
    { name: "getSessions calls GET /api/sessions", fn: getSessions, expectedUrl: "/api/sessions" },
    { name: "getCommands calls GET /api/commands", fn: getCommands, expectedUrl: "/api/commands" },
    { name: "getHistory calls GET /api/history", fn: getHistory, expectedUrl: "/api/history" },
  ];
  for (const c of cases) {
    test(c.name, async () => {
      const fetchFn = mockFetch({ jsonData: { ok: true } });
      const result = await c.fn(fetchFn);
      assert.equal(fetchFn.calls.length, 1);
      assert.equal(fetchFn.calls[0].url, c.expectedUrl);
      assert.equal(fetchFn.calls[0].init, undefined);
      assert.deepEqual(result, { ok: true });
    });
  }
});

// ── POST wrappers ─────────────────────────────────────

describe("abortAgent", () => {
  test("calls POST /api/abort with no body", async () => {
    const fetchFn = mockFetch({ jsonData: { ok: true } });
    await abortAgent(fetchFn);
    assert.equal(fetchFn.calls[0].url, "/api/abort");
    assert.equal(fetchFn.calls[0].init.method, "POST");
  });
});

describe("executeCommand", () => {
  test("calls POST /api/command with JSON body", async () => {
    const fetchFn = mockFetch({ jsonData: { output: "done" } });
    const result = await executeCommand("compact", fetchFn);
    assert.equal(fetchFn.calls[0].url, "/api/command");
    assert.equal(fetchFn.calls[0].init.method, "POST");
    assert.equal(fetchFn.calls[0].init.headers["Content-Type"], "application/json");
    assert.deepEqual(JSON.parse(fetchFn.calls[0].init.body), { command: "compact" });
    assert.deepEqual(result, { output: "done" });
  });

  test("throws on non-ok response", async () => {
    const fetchFn = mockFetch({ status: 400, jsonData: { error: "Unknown command" } });
    await assert.rejects(executeCommand("badcmd", fetchFn), /Unknown command/);
  });

  test("throws with HTTP status when no error field", async () => {
    const fetchFn = mockFetch({ status: 500, jsonData: {} });
    await assert.rejects(executeCommand("x", fetchFn), /HTTP 500/);
  });
});

// ── Session management ────────────────────────────────

describe("newSession", () => {
  test("calls POST /api/new-session with empty body when no cwd", async () => {
    const fetchFn = mockFetch({ jsonData: { pid: 12345 } });
    const result = await newSession(undefined, fetchFn);
    assert.equal(fetchFn.calls[0].url, "/api/new-session");
    assert.equal(fetchFn.calls[0].init.method, "POST");
    assert.deepEqual(JSON.parse(fetchFn.calls[0].init.body), {});
    assert.deepEqual(result, { pid: 12345 });
  });

  test("calls POST /api/new-session with cwd when provided", async () => {
    const fetchFn = mockFetch({ jsonData: { pid: 12346 } });
    await newSession("/home/user/project", fetchFn);
    assert.deepEqual(JSON.parse(fetchFn.calls[0].init.body), { cwd: "/home/user/project" });
  });

  test("throws on non-ok response", async () => {
    const fetchFn = mockFetch({ status: 500, jsonData: { error: "spawn failed" } });
    await assert.rejects(newSession(undefined, fetchFn), /spawn failed/);
  });
});

describe("killSession", () => {
  test("calls POST /api/kill-session with pid", async () => {
    const fetchFn = mockFetch({ jsonData: { ok: true } });
    await killSession(999, fetchFn);
    assert.equal(fetchFn.calls[0].url, "/api/kill-session");
    assert.deepEqual(JSON.parse(fetchFn.calls[0].init.body), { pid: 999 });
  });

  test("throws on non-ok response", async () => {
    const fetchFn = mockFetch({ status: 404, jsonData: { error: "not found" } });
    await assert.rejects(killSession(999, fetchFn), /not found/);
  });
});

// ── Cross-session API ─────────────────────────────────

describe("renameSession", () => {
  test("calls POST {baseUrl}/api/rename-session with name", async () => {
    const fetchFn = mockFetch({ jsonData: { ok: true } });
    await renameSession("my-session", "http://localhost:7332", fetchFn);
    assert.equal(fetchFn.calls[0].url, "http://localhost:7332/api/rename-session");
    assert.deepEqual(JSON.parse(fetchFn.calls[0].init.body), { name: "my-session" });
  });

  test("throws on non-ok response", async () => {
    const fetchFn = mockFetch({ status: 400, jsonData: { error: "name too long" } });
    await assert.rejects(renameSession("x", "http://localhost:7332", fetchFn), /name too long/);
  });
});

describe("reloadSession", () => {
  test("calls POST {baseUrl}/api/reload", async () => {
    const fetchFn = mockFetch({ jsonData: { ok: true } });
    await reloadSession("http://localhost:7331", fetchFn);
    assert.equal(fetchFn.calls[0].url, "http://localhost:7331/api/reload");
    assert.equal(fetchFn.calls[0].init.method, "POST");
  });

  test("throws on non-ok response", async () => {
    const fetchFn = mockFetch({ status: 500, jsonData: { error: "respawn failed" } });
    await assert.rejects(reloadSession("http://localhost:7331", fetchFn), /respawn failed/);
  });
});

// ── Streaming ─────────────────────────────────────────

describe("sendPromptStream", () => {
  test("calls POST /api/prompt with message and SSE accept header", async () => {
    const fetchFn = mockFetch({
      jsonData: {},
      bodyText: 'data: {"type":"done"}\n\n',
    });
    await sendPromptStream("hello", () => {}, fetchFn);
    // calls[0] is clientLog, calls[1] is the actual prompt fetch
    const promptCall = fetchFn.calls.find((c) => c.url === "/api/prompt");
    assert.ok(promptCall, "prompt fetch was made");
    assert.equal(promptCall.init.method, "POST");
    assert.equal(promptCall.init.headers.Accept, "text/event-stream");
    assert.deepEqual(JSON.parse(promptCall.init.body), { message: "hello" });
  });

  test("parses SSE events and calls onEvent for each", async () => {
    const sseData = [
      'data: {"type":"text","text":"hello"}\n\n',
      'data: {"type":"text","text":"world"}\n\n',
      'data: {"type":"done"}\n\n',
    ].join("");
    const fetchFn = mockFetch({ bodyText: sseData });
    const events = [];
    await sendPromptStream("test", (e) => events.push(e), fetchFn);
    assert.equal(events.length, 3);
    assert.equal(events[0].type, "text");
    assert.equal(events[0].text, "hello");
    assert.equal(events[1].text, "world");
    assert.equal(events[2].type, "done");
  });

  test("handles empty stream (no events)", async () => {
    const fetchFn = mockFetch({ bodyText: "" });
    const events = [];
    await sendPromptStream("test", (e) => events.push(e), fetchFn);
    assert.equal(events.length, 0);
  });

  test("handles heartbeat-only stream", async () => {
    const fetchFn = mockFetch({ bodyText: ": keepalive\n\n" });
    const events = [];
    await sendPromptStream("test", (e) => events.push(e), fetchFn);
    assert.equal(events.length, 0);
  });

  test("throws on non-ok response", async () => {
    const fetchFn = mockFetch({ status: 409, jsonData: { error: "busy" } });
    await assert.rejects(sendPromptStream("test", () => {}, fetchFn), /busy/);
  });

  test("throws on fetch failure", async () => {
    const fetchFn = async () => { throw new Error("network down"); };
    await assert.rejects(sendPromptStream("test", () => {}, fetchFn), /network down/);
  });

  test("throws on reader error", async () => {
    const fetchFn = async () => ({
      ok: true,
      body: { getReader: () => ({ read: async () => { throw new Error("read failed"); } }) },
    });
    await assert.rejects(sendPromptStream("test", () => {}, fetchFn), /read failed/);
  });
});

// ── clientLog ─────────────────────────────────────────

describe("clientLog", () => {
  test("sends POST to /api/client-log", async () => {
    let capturedUrl, capturedInit;
    const fetchFn = async (url, init) => {
      capturedUrl = url;
      capturedInit = init;
      return { ok: true, json: async () => ({ ok: true }) };
    };
    await clientLog("error", "test msg", { foo: 1 }, fetchFn);
    assert.equal(capturedUrl, "/api/client-log");
    assert.equal(capturedInit.method, "POST");
    const body = JSON.parse(capturedInit.body);
    assert.equal(body.level, "error");
    assert.equal(body.message, "test msg");
    assert.deepEqual(body.data, { foo: 1 });
  });

  test("swallows fetch errors silently", async () => {
    const fetchFn = async () => { throw new Error("network down"); };
    // Should not throw
    await clientLog("info", "msg", undefined, fetchFn);
  });
});
