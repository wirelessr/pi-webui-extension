import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  abortAgent,
  attachStream,
  clientLog,
  executeCommand,
  getCommands,
  getFile,
  getHistory,
  getModels,
  getSessions,
  getStatus,
  getTree,
  killSession,
  navigateTree,
  navUrl,
  newSession,
  openSession,
  pollUntil,
  reloadSession,
  renameSession,
  sendPromptStream,
  sessionUrl,
  setModel,
  statFiles,
  uploadImage,
} from "../src/api.js";

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

describe("navUrl", () => {
  const cases = [
    {
      name: "keeps localhost hostname when page opened via localhost",
      session: { url: "http://192.168.1.130:7331", port: 7331 },
      loc: { protocol: "http:", hostname: "localhost" },
      expected: "http://localhost:7331",
    },
    {
      name: "keeps LAN hostname when page opened via LAN IP",
      session: { url: "http://192.168.1.130:7332", port: 7332 },
      loc: { protocol: "http:", hostname: "192.168.1.130" },
      expected: "http://192.168.1.130:7332",
    },
    {
      name: "ignores discovery url entirely (only port is used)",
      session: { port: 7333 },
      loc: { protocol: "https:", hostname: "example.test" },
      expected: "https://example.test:7333",
    },
  ];
  for (const c of cases) {
    test(c.name, () => assert.equal(navUrl(c.session, c.loc), c.expected));
  }
});

describe("uploadImage", () => {
  test("POSTs the blob and returns parsed path", async () => {
    const fetchFn = mockFetch({ status: 200, jsonData: { path: "/tmp/x.png" } });
    const blob = { type: "image/png" };
    const result = await uploadImage(blob, fetchFn);
    assert.deepEqual(result, { path: "/tmp/x.png" });
    assert.equal(fetchFn.calls[0].url, "/api/upload");
    assert.equal(fetchFn.calls[0].init.method, "POST");
    assert.equal(fetchFn.calls[0].init.headers["Content-Type"], "image/png");
    assert.equal(fetchFn.calls[0].init.body, blob);
  });

  test("defaults Content-Type to image/png when blob has no type", async () => {
    const fetchFn = mockFetch({ status: 200, jsonData: { path: "/tmp/y.png" } });
    await uploadImage({}, fetchFn);
    assert.equal(fetchFn.calls[0].init.headers["Content-Type"], "image/png");
  });

  test("throws on non-ok response", async () => {
    const fetchFn = mockFetch({ status: 400, jsonData: { error: "Empty body" } });
    await assert.rejects(() => uploadImage({ type: "image/png" }, fetchFn), /Empty body/);
  });
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

describe("getFile", () => {
  test("GETs /api/file with the path query-encoded and returns JSON", async () => {
    const fetchFn = mockFetch({ jsonData: { path: "/a b/x.md", content: "hi" } });
    const result = await getFile("/a b/x.md", fetchFn);
    assert.equal(fetchFn.calls[0].url, "/api/file?path=%2Fa%20b%2Fx.md");
    assert.deepEqual(result, { path: "/a b/x.md", content: "hi" });
  });

  test("throws on a non-ok response", async () => {
    const fetchFn = mockFetch({ status: 403, jsonData: { error: "nope" } });
    await assert.rejects(() => getFile("/etc/passwd", fetchFn), /file 403/);
  });
});

describe("statFiles", () => {
  test("POSTs the paths and returns the stats map", async () => {
    const fetchFn = mockFetch({ jsonData: { stats: { "a.md": 111 } } });
    const stats = await statFiles(["a.md"], fetchFn);
    assert.equal(fetchFn.calls[0].url, "/api/file/stat");
    assert.equal(fetchFn.calls[0].init.method, "POST");
    assert.deepEqual(JSON.parse(fetchFn.calls[0].init.body), { paths: ["a.md"] });
    assert.deepEqual(stats, { "a.md": 111 });
  });

  test("returns {} on a non-ok response", async () => {
    const fetchFn = mockFetch({ status: 500, jsonData: {} });
    assert.deepEqual(await statFiles(["a.md"], fetchFn), {});
  });

  test("tolerates a response with no stats field", async () => {
    const fetchFn = mockFetch({ jsonData: {} });
    assert.deepEqual(await statFiles([], fetchFn), {});
  });
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

describe("getTree", () => {
  test("GETs /api/tree and returns the payload", async () => {
    const payload = { nodes: [{ id: "u1" }], leafId: "a1" };
    const fetchFn = mockFetch({ jsonData: payload });
    const result = await getTree(fetchFn);
    assert.equal(fetchFn.calls[0].url, "/api/tree");
    assert.deepEqual(result, payload);
  });

  test("throws on non-ok response", async () => {
    const fetchFn = mockFetch({ status: 500, jsonData: { error: "boom" } });
    await assert.rejects(getTree(fetchFn), /boom/);
  });
});

describe("navigateTree", () => {
  test("POSTs the targetId as JSON", async () => {
    const fetchFn = mockFetch({ jsonData: { ok: true } });
    const result = await navigateTree("a1", fetchFn);
    assert.equal(fetchFn.calls[0].url, "/api/tree/navigate");
    assert.equal(fetchFn.calls[0].init.method, "POST");
    assert.deepEqual(JSON.parse(fetchFn.calls[0].init.body), { targetId: "a1" });
    assert.equal(result.ok, true);
  });

  test("throws the server error on non-ok response", async () => {
    const fetchFn = mockFetch({ status: 409, jsonData: { error: "Agent is busy" } });
    await assert.rejects(navigateTree("a1", fetchFn), /busy/);
  });
});

describe("getModels", () => {
  test("GETs /api/models and returns the payload", async () => {
    const payload = { current: { provider: "p", id: "m" }, models: [{ provider: "p", id: "m" }] };
    const fetchFn = mockFetch({ jsonData: payload });
    const result = await getModels(fetchFn);
    assert.equal(fetchFn.calls[0].url, "/api/models");
    assert.deepEqual(result, payload);
  });

  test("throws on non-ok response", async () => {
    const fetchFn = mockFetch({ status: 500, jsonData: { error: "boom" } });
    await assert.rejects(getModels(fetchFn), /boom/);
  });
});

describe("setModel", () => {
  test("POSTs provider + id as JSON", async () => {
    const fetchFn = mockFetch({ jsonData: { ok: true, model: { provider: "p", id: "m" } } });
    const result = await setModel("p", "m", fetchFn);
    assert.equal(fetchFn.calls[0].url, "/api/model");
    assert.equal(fetchFn.calls[0].init.method, "POST");
    assert.deepEqual(JSON.parse(fetchFn.calls[0].init.body), { provider: "p", id: "m" });
    assert.equal(result.ok, true);
  });

  test("throws the server error on non-ok response", async () => {
    const fetchFn = mockFetch({ status: 400, jsonData: { error: "Unknown model: p/m" } });
    await assert.rejects(setModel("p", "m", fetchFn), /Unknown model/);
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

describe("openSession", () => {
  test("calls POST /api/open-session with sessionId", async () => {
    const fetchFn = mockFetch({ jsonData: { pid: 99999 } });
    const result = await openSession("019f5aad", undefined, fetchFn);
    assert.equal(fetchFn.calls[0].url, "/api/open-session");
    assert.equal(fetchFn.calls[0].init.method, "POST");
    assert.deepEqual(JSON.parse(fetchFn.calls[0].init.body), { sessionId: "019f5aad" });
    assert.deepEqual(result, { pid: 99999 });
  });

  test("includes name when provided", async () => {
    const fetchFn = mockFetch({ jsonData: { pid: 88888 } });
    await openSession("abc-123", "my session", fetchFn);
    assert.deepEqual(JSON.parse(fetchFn.calls[0].init.body), { sessionId: "abc-123", name: "my session" });
  });

  test("throws on non-ok response", async () => {
    const fetchFn = mockFetch({ status: 500, jsonData: { error: "session not found" } });
    await assert.rejects(openSession("bad-id", undefined, fetchFn), /session not found/);
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

// ── attachStream ─────────────────────────────────────

describe("attachStream", () => {
  test("returns true and parses SSE events when stream available", async () => {
    const sseData = 'data: {"type":"agent_start"}\n\ndata: {"type":"done"}\n\n';
    const fetchFn = mockFetch({ bodyText: sseData });
    const events = [];
    const result = await attachStream((e) => events.push(e), fetchFn);
    assert.equal(result, true);
    assert.equal(events.length, 2);
    assert.equal(events[0].type, "agent_start");
    assert.equal(events[1].type, "done");
  });

  test("returns false on 409 (no active stream)", async () => {
    const fetchFn = mockFetch({ status: 409, jsonData: { error: "No active stream" } });
    const result = await attachStream(() => {}, fetchFn);
    assert.equal(result, false);
  });

  test("returns false on fetch failure", async () => {
    const fetchFn = async () => { throw new Error("network down"); };
    const result = await attachStream(() => {}, fetchFn);
    assert.equal(result, false);
  });

  test("returns true even on reader error after successful connect", async () => {
    const fetchFn = async () => ({
      ok: true,
      body: { getReader: () => ({ read: async () => { throw new Error("read failed"); } }) },
    });
    const result = await attachStream(() => {}, fetchFn);
    assert.equal(result, true);
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
