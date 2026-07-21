/**
 * HTTP integration tests for the Hono bridge app.
 *
 * Tests call app.fetch(new Request(...)) directly — no real HTTP server,
 * no real pi session. All side effects are injected via mock deps.
 */

import assert from "node:assert/strict";
import { unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createBridgeApp } from "../bridge-app.js";

// ── Mock factory ──────────────────────────────────────────────────

function createMockDeps(overrides = {}) {
	const calls = {
		setSessionName: [],
		sendUserMessage: [],
	spawnNewSession: [],
	openSession: [],
		killSession: [],
		reload: [],
		clientLog: [],
		compact: [],
		abort: [],
		setModel: [],
		noteAbortRequested: [],
		navigateTree: [],
		steer: [],
	};

	return {
		calls,
		getActualPort: () => 7331,
		getPid: () => 12345,
		getStartedAt: () => 1700000000000,
		getCwd: () => "/tmp/test-cwd",
		getIsBusy: () => false,
		getSessionFile: () => "/tmp/test-session.jsonl",
		getSessionId: () => "test-session-id",
		getSessionName: () => "test-name",
		getSessionCtx: () => ({
			model: { id: "test-model" },
			compact: () => { calls.compact.push(true); },
			abort: () => { calls.abort.push(true); },
		}),
		getCommands: () => [
			{ name: "skill:test", source: "skill", description: "test skill", sourceInfo: { path: "/tmp/test-skill.md" } },
			{ name: "prompt:tpl", source: "prompt", description: "test template", sourceInfo: { path: "/tmp/test-tpl.md" } },
		],
		setSessionName: (name) => { calls.setSessionName.push(name); },
		builtinCommands: [
			{ name: "compact", description: "Compact conversation" },
			{ name: "model", description: "Select model" },
			{ name: "clear", description: "Clear screen (TUI only)" },
		],
		listAllSessions: () => [],
		spawnNewSession: (cwd) => { calls.spawnNewSession.push(cwd); return { pid: 99999 }; },
	openSession: (sessionId, name, cwd) => { calls.openSession.push({ sessionId, name, cwd }); return { pid: 88888 }; },
		killSession: (pid) => { calls.killSession.push(pid); return true; },
		readSessionHistory: async () => ({ history: [], total: 0 }),
		computeUsageStats: () => ({
			inputTokens: 100, outputTokens: 200, cacheReadTokens: 50,
			cacheWriteTokens: 10, cacheHitRate: 33.3, totalCost: 0.01,
		}),
		computeContextUsage: () => ({ tokens: 5000, contextWindow: 128000, percent: 3.9 }),
		sendAndWait: async (msg, timeoutMs) => {
			calls.sendUserMessage.push({ msg, timeoutMs });
			return [{ role: "assistant", content: [{ type: "text", text: "hello" }] }];
		},
		sendAndStream: async (_msg, _timeoutMs, res) => {
			calls.sendUserMessage.push({ msg, timeoutMs });
			res.write('data: {"type":"agent_start"}\n\n');
			res.write('data: {"type":"done","text":"hello","toolCalls":[],"thinking":"","messageCount":1}\n\n');
			res.end();
		},
		compactAndStream: async (res, _args) => {
			calls.compact.push(true);
			res.write('data: {"type":"done","text":"compacted","toolCalls":[],"compact":true,"tokensBefore":50000}\n\n');
			res.end();
		},
		attachStream: () => false,
		isPendingOrSse: () => false,
		steer: (message) => { calls.steer.push(message); return { ok: true }; },
		noteAbortRequested: () => { calls.noteAbortRequested.push(true); },
		getSessionTree: () => ({
			nodes: [{ id: "u1", navTargetId: "a1", text: "first", active: true, current: true, children: [] }],
			leafId: "a1",
		}),
		navigateTree: async (targetId) => {
			calls.navigateTree.push(targetId);
			if (targetId === "bad") return { ok: false, error: "Navigation cancelled" };
			return { ok: true };
		},
		listModels: () => ({
			current: { provider: "fireworks", id: "test-model", name: "Test Model", contextWindow: 128000 },
			models: [
				{ provider: "fireworks", id: "test-model", name: "Test Model", contextWindow: 128000 },
				{ provider: "anthropic", id: "other-model", name: "Other Model", contextWindow: 200000 },
			],
		}),
		setModel: async (provider, id) => {
			calls.setModel.push({ provider, id });
			if (provider === "fireworks" || provider === "anthropic") {
				return { ok: true, model: { provider, id, name: "X", contextWindow: 1000 } };
			}
			return { ok: false, error: `Unknown model: ${provider}/${id}` };
		},
		reload: () => { calls.reload.push(true); },
		clientLog: (level, message, data) => { calls.clientLog.push({ level, message, data }); },
		...overrides,
	};
}

const BASE = "http://localhost:7331";

function req(path, init) {
	return new Request(`${BASE}${path}`, init);
}

function postJson(path, body) {
	return req(path, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: typeof body === "string" ? body : JSON.stringify(body),
	});
}

// ── Tests ─────────────────────────────────────────────────────────

test("OPTIONS preflight returns 204 with CORS headers", async () => {
	const app = createBridgeApp(createMockDeps());
	const res = await app.fetch(req("/api/status", { method: "OPTIONS" }));
	assert.strictEqual(res.status, 204);
	assert.strictEqual(res.headers.get("Access-Control-Allow-Origin"), "*");
	assert.strictEqual(res.headers.get("Access-Control-Allow-Methods"), "GET, POST, OPTIONS");
	assert.strictEqual(res.headers.get("Access-Control-Allow-Headers"), "Content-Type");
});

test("CORS headers present on all responses", async () => {
	const app = createBridgeApp(createMockDeps());
	const res = await app.fetch(req("/api/status"));
	assert.strictEqual(res.headers.get("Access-Control-Allow-Origin"), "*");
});

test("GET /api/status returns session info", async () => {
	const app = createBridgeApp(createMockDeps());
	const res = await app.fetch(req("/api/status"));
	assert.strictEqual(res.status, 200);
	const body = await res.json();
	assert.strictEqual(body.status, "ok");
	assert.strictEqual(body.busy, false);
	assert.strictEqual(body.port, 7331);
	assert.strictEqual(body.pid, 12345);
	assert.strictEqual(body.sessionFile, "/tmp/test-session.jsonl");
	assert.strictEqual(body.sessionId, "test-session-id");
	assert.strictEqual(body.sessionName, "test-name");
	assert.strictEqual(body.model, "test-model");
	assert.strictEqual(body.cwd, "/tmp/test-cwd");
	assert.strictEqual(body.usage.inputTokens, 100);
	assert.strictEqual(body.context.tokens, 5000);
});

test("GET /api/sessions returns session list", async () => {
	const mockSessions = [
		{ port: 7331, host: "0.0.0.0", url: "http://localhost:7331", sessionFile: "/tmp/a.jsonl", sessionId: "a", sessionName: "A", pid: 100, startedAt: 1 },
	];
	const app = createBridgeApp(createMockDeps({ listAllSessions: () => mockSessions }));
	const res = await app.fetch(req("/api/sessions"));
	assert.strictEqual(res.status, 200);
	const body = await res.json();
	assert.strictEqual(body.sessions.length, 1);
	assert.strictEqual(body.sessions[0].port, 7331);
});

test("GET /api/commands returns skills + builtins, filters TUI-only", async () => {
	const app = createBridgeApp(createMockDeps());
	const res = await app.fetch(req("/api/commands"));
	assert.strictEqual(res.status, 200);
	const body = await res.json();
	const names = body.commands.map((c) => c.name);
	assert.ok(names.includes("skill:test"));
	assert.ok(names.includes("prompt:tpl"));
	assert.ok(names.includes("compact"));
	assert.ok(!names.includes("clear"));
	const model = body.commands.find((c) => c.name === "model");
	assert.ok(model);
	assert.strictEqual(model.executable, false);
	assert.match(model.description, /switch/);
	const compact = body.commands.find((c) => c.name === "compact");
	assert.strictEqual(compact.executable, true);
});

test("GET /api/models returns current + available models", async () => {
	const app = createBridgeApp(createMockDeps());
	const res = await app.fetch(req("/api/models"));
	assert.strictEqual(res.status, 200);
	const body = await res.json();
	assert.strictEqual(body.current.id, "test-model");
	assert.strictEqual(body.models.length, 2);
	assert.strictEqual(body.models[1].provider, "anthropic");
});

test("POST /api/model switches the model", async () => {
	const deps = createMockDeps();
	const app = createBridgeApp(deps);
	const res = await app.fetch(postJson("/api/model", { provider: "anthropic", id: "other-model" }));
	assert.strictEqual(res.status, 200);
	const body = await res.json();
	assert.strictEqual(body.ok, true);
	assert.strictEqual(body.model.id, "other-model");
	assert.deepEqual(deps.calls.setModel, [{ provider: "anthropic", id: "other-model" }]);
});

test("POST /api/model rejects unknown model with the deps error", async () => {
	const app = createBridgeApp(createMockDeps());
	const res = await app.fetch(postJson("/api/model", { provider: "nope", id: "missing" }));
	assert.strictEqual(res.status, 400);
	assert.match((await res.json()).error, /Unknown model/);
});

test("POST /api/model rejects missing fields and bad JSON", async () => {
	const app = createBridgeApp(createMockDeps());
	const res1 = await app.fetch(postJson("/api/model", { provider: "fireworks" }));
	assert.strictEqual(res1.status, 400);
	const res2 = await app.fetch(req("/api/model", { method: "POST", headers: { "Content-Type": "application/json" }, body: "not json" }));
	assert.strictEqual(res2.status, 400);
});

test("GET /api/history returns paginated history", async () => {
	const app = createBridgeApp(createMockDeps({
		readSessionHistory: async (file, limit, offset) => {
			assert.strictEqual(file, "/tmp/test-session.jsonl");
			assert.strictEqual(limit, 10);
			assert.strictEqual(offset, 0);
			return { history: [{ role: "user", text: "hi" }], total: 1 };
		},
	}));
	const res = await app.fetch(req("/api/history?limit=10&offset=0"));
	assert.strictEqual(res.status, 200);
	const body = await res.json();
	assert.strictEqual(body.total, 1);
	assert.strictEqual(body.history[0].text, "hi");
});

test("GET /api/file serves an allowlisted file the agent wrote", async () => {
	const filePath = join(tmpdir(), `pi-file-route-${process.pid}.md`);
	writeFileSync(filePath, "# hello\n\ndisk content", "utf8");
	const history = [
		{ role: "assistant", toolCalls: [{ name: "write", arguments: { path: filePath, content: "stale" } }] },
	];
	const app = createBridgeApp(createMockDeps({ readSessionHistory: async () => ({ history, total: 1 }) }));
	try {
		const res = await app.fetch(req(`/api/file?path=${encodeURIComponent(filePath)}`));
		assert.strictEqual(res.status, 200);
		const body = await res.json();
		assert.strictEqual(body.path, filePath);
		// Content comes from disk, not the (stale) write event.
		assert.strictEqual(body.content, "# hello\n\ndisk content");
	} finally {
		unlinkSync(filePath);
	}
});

test("GET /api/file rejects a path the session never wrote", async () => {
	const app = createBridgeApp(createMockDeps({ readSessionHistory: async () => ({ history: [], total: 0 }) }));
	const res = await app.fetch(req(`/api/file?path=${encodeURIComponent("/etc/passwd")}`));
	assert.strictEqual(res.status, 403);
});

test("GET /api/file returns 404 for an allowlisted path missing on disk", async () => {
	const missing = join(tmpdir(), `pi-file-route-missing-${process.pid}.md`);
	const history = [
		{ role: "assistant", toolCalls: [{ name: "write", arguments: { path: missing, content: "x" } }] },
	];
	const app = createBridgeApp(createMockDeps({ readSessionHistory: async () => ({ history, total: 1 }) }));
	const res = await app.fetch(req(`/api/file?path=${encodeURIComponent(missing)}`));
	assert.strictEqual(res.status, 404);
});

test("POST /api/file/stat returns mtimes for allowlisted paths, skips others, null for missing", async () => {
	const present = join(tmpdir(), `pi-stat-present-${process.pid}.md`);
	const missing = join(tmpdir(), `pi-stat-missing-${process.pid}.md`);
	writeFileSync(present, "x", "utf8");
	const history = [
		{ role: "assistant", toolCalls: [
			{ name: "write", arguments: { path: present, content: "x" } },
			{ name: "write", arguments: { path: missing, content: "x" } },
		] },
	];
	const app = createBridgeApp(createMockDeps({ readSessionHistory: async () => ({ history, total: 1 }) }));
	try {
		const res = await app.fetch(postJson("/api/file/stat", { paths: [present, missing, "/etc/passwd"] }));
		assert.strictEqual(res.status, 200);
		const { stats } = await res.json();
		assert.strictEqual(typeof stats[present], "number");
		assert.strictEqual(stats[missing], null);
		assert.ok(!("/etc/passwd" in stats)); // not allowlisted → omitted
	} finally {
		unlinkSync(present);
	}
});

test("POST /api/file/stat tolerates a bad body", async () => {
	const app = createBridgeApp(createMockDeps({ readSessionHistory: async () => ({ history: [], total: 0 }) }));
	const res = await app.fetch(req("/api/file/stat", { method: "POST", headers: { "Content-Type": "application/json" }, body: "not json" }));
	assert.strictEqual(res.status, 200);
	assert.deepEqual((await res.json()).stats, {});
});

test("POST /api/command executes compact", async () => {
	const deps = createMockDeps();
	const app = createBridgeApp(deps);
	const res = await app.fetch(postJson("/api/command", { command: "compact" }));
	assert.strictEqual(res.status, 200);
	const body = await res.json();
	assert.strictEqual(body.ok, true);
	assert.strictEqual(deps.calls.compact.length, 1);
});

test("POST /api/command rejects non-executable command", async () => {
	const app = createBridgeApp(createMockDeps());
	const res = await app.fetch(postJson("/api/command", { command: "clear" }));
	assert.strictEqual(res.status, 400);
	const body = await res.json();
	assert.ok(body.error.includes("not executable"));
});

test("POST /api/command rejects invalid JSON", async () => {
	const app = createBridgeApp(createMockDeps());
	const res = await app.fetch(postJson("/api/command", "not json"));
	assert.strictEqual(res.status, 400);
});

test("POST /api/prompt (JSON, no stream) returns response", async () => {
	const deps = createMockDeps({
		sendAndWait: async (msg) => {
			assert.strictEqual(msg, "hello agent");
			return [{ role: "assistant", content: [{ type: "text", text: "hi back" }] }];
		},
	});
	const app = createBridgeApp(deps);
	const res = await app.fetch(postJson("/api/prompt", { message: "hello agent" }));
	assert.strictEqual(res.status, 200);
	const body = await res.json();
	assert.strictEqual(body.text, "hi back");
	assert.strictEqual(body.messageCount, 1);
});

test("POST /api/prompt with /compact intercepts and calls ctx.compact", async () => {
	const deps = createMockDeps();
	const app = createBridgeApp(deps);
	const res = await app.fetch(postJson("/api/prompt", { message: "/compact" }));
	assert.strictEqual(res.status, 200);
	const body = await res.json();
	assert.strictEqual(body.ok, true);
	assert.strictEqual(deps.calls.compact.length, 1);
	assert.strictEqual(deps.calls.sendUserMessage.length, 0);
});

test("POST /api/prompt with /compact via SSE returns done event", async () => {
	const deps = createMockDeps();
	const app = createBridgeApp(deps);
	const res = await app.fetch(req("/api/prompt", {
		method: "POST",
		headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
		body: JSON.stringify({ message: "/compact" }),
	}));
	assert.strictEqual(res.status, 200);
	assert.strictEqual(res.headers.get("content-type"), "text/event-stream");
	const text = await res.text();
	assert.ok(text.includes("\"type\":\"done\""));
	assert.ok(text.includes("\"compact\":true"));
	assert.strictEqual(deps.calls.compact.length, 1);
});

test("POST /api/prompt with /compact args passes customInstructions", async () => {
	let receivedArgs = null;
	const deps = createMockDeps({
		compactAndStream: async (res, args) => {
			receivedArgs = args;
			res.write('data: {"type":"done","text":"ok","toolCalls":[],"compact":true,"tokensBefore":1000}\n\n');
			res.end();
		},
	});
	const app = createBridgeApp(deps);
	const res = await app.fetch(req("/api/prompt", {
		method: "POST",
		headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
		body: JSON.stringify({ message: "/compact focus on API changes" }),
	}));
	assert.strictEqual(res.status, 200);
	assert.strictEqual(receivedArgs, "focus on API changes");
});

test("POST /api/prompt with /nonexistent does not intercept", async () => {
	const deps = createMockDeps({
		sendAndWait: async () => [{ role: "assistant", content: [{ type: "text", text: "ok" }] }],
	});
	const app = createBridgeApp(deps);
	const res = await app.fetch(postJson("/api/prompt", { message: "/nonexistent cmd" }));
	assert.strictEqual(res.status, 200);
	assert.strictEqual(deps.calls.compact.length, 0);
});

test("POST /api/prompt (plain text) returns response", async () => {
	const deps = createMockDeps({
		sendAndWait: async (msg) => {
			assert.strictEqual(msg, "plain text message");
			return [{ role: "assistant", content: [{ type: "text", text: "ok" }] }];
		},
	});
	const app = createBridgeApp(deps);
	const res = await app.fetch(req("/api/prompt", {
		method: "POST",
		headers: { "Content-Type": "text/plain" },
		body: "plain text message",
	}));
	assert.strictEqual(res.status, 200);
	const body = await res.json();
	assert.strictEqual(body.text, "ok");
});

test("POST /api/prompt empty body returns 400", async () => {
	const app = createBridgeApp(createMockDeps());
	const res = await app.fetch(req("/api/prompt", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: "",
	}));
	assert.strictEqual(res.status, 400);
});

test("POST /api/prompt with stream=true returns SSE", async () => {
	const deps = createMockDeps({
		sendAndStream: async (_msg, _timeoutMs, res) => {
			res.write('data: {"type":"agent_start"}\n\n');
			res.write('data: {"type":"done","text":"hi","toolCalls":[],"thinking":"","messageCount":1}\n\n');
			res.end();
		},
	});
	const app = createBridgeApp(deps);
	const res = await app.fetch(postJson("/api/prompt", { message: "hello", stream: true }));
	assert.strictEqual(res.status, 200);
	assert.strictEqual(res.headers.get("Content-Type"), "text/event-stream");
	const text = await res.text();
	assert.ok(text.includes("agent_start"));
	assert.ok(text.includes("done"));
});

test("POST /api/prompt returns 409 when busy", async () => {
	const app = createBridgeApp(createMockDeps({ isPendingOrSse: () => true }));
	const res = await app.fetch(postJson("/api/prompt", { message: "hello" }));
	assert.strictEqual(res.status, 409);
	const body = await res.json();
	assert.ok(body.error.includes("Another request"));
});

test("POST /api/prompt with full=true includes messages", async () => {
	const deps = createMockDeps({
		sendAndWait: async () => [
			{ role: "assistant", content: [{ type: "text", text: "response" }] },
		],
	});
	const app = createBridgeApp(deps);
	const res = await app.fetch(postJson("/api/prompt", { message: "hello", full: true }));
	assert.strictEqual(res.status, 200);
	const body = await res.json();
	assert.ok(Array.isArray(body.messages));
	assert.strictEqual(body.messages.length, 1);
});

test("POST /api/prompt sendAndWait error returns 500", async () => {
	const deps = createMockDeps({
		sendAndWait: async () => { throw new Error("agent timeout"); },
	});
	const app = createBridgeApp(deps);
	const res = await app.fetch(postJson("/api/prompt", { message: "hello" }));
	assert.strictEqual(res.status, 500);
	const body = await res.json();
	assert.strictEqual(body.error, "agent timeout");
});

test("POST /api/abort calls sessionCtx.abort", async () => {
	const deps = createMockDeps();
	const app = createBridgeApp(deps);
	const res = await app.fetch(req("/api/abort", { method: "POST" }));
	assert.strictEqual(res.status, 200);
	const body = await res.json();
	assert.strictEqual(body.ok, true);
	assert.strictEqual(deps.calls.abort.length, 1);
	assert.strictEqual(deps.calls.noteAbortRequested.length, 1);
});

test("POST /api/abort without session context returns 500", async () => {
	const app = createBridgeApp(createMockDeps({ getSessionCtx: () => null }));
	const res = await app.fetch(req("/api/abort", { method: "POST" }));
	assert.strictEqual(res.status, 500);
});

test("POST /api/steer forwards the message to deps.steer", async () => {
	const deps = createMockDeps();
	const app = createBridgeApp(deps);
	const res = await app.fetch(postJson("/api/steer", { message: "only look at TS files" }));
	assert.strictEqual(res.status, 200);
	assert.deepStrictEqual(await res.json(), { ok: true });
	assert.deepStrictEqual(deps.calls.steer, ["only look at TS files"]);
});

test("POST /api/steer rejects an empty message with 400", async () => {
	const deps = createMockDeps();
	const app = createBridgeApp(deps);
	const res = await app.fetch(postJson("/api/steer", { message: "   " }));
	assert.strictEqual(res.status, 400);
	assert.strictEqual(deps.calls.steer.length, 0);
});

test("POST /api/steer rejects a non-JSON body with 400", async () => {
	const app = createBridgeApp(createMockDeps());
	const res = await app.fetch(req("/api/steer", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: "not json",
	}));
	assert.strictEqual(res.status, 400);
});

test("POST /api/steer returns 500 when deps.steer fails", async () => {
	const app = createBridgeApp(createMockDeps({ steer: () => ({ ok: false, error: "boom" }) }));
	const res = await app.fetch(postJson("/api/steer", { message: "hi" }));
	assert.strictEqual(res.status, 500);
	assert.strictEqual((await res.json()).error, "boom");
});

test("GET /api/stream/attach returns 409 when not busy", async () => {
	const deps = createMockDeps();
	const app = createBridgeApp(deps);
	const res = await app.fetch(req("/api/stream/attach"));
	assert.strictEqual(res.status, 409);
});

test("GET /api/stream/attach returns 409 when busy but SSE already active", async () => {
	const deps = createMockDeps({ getIsBusy: () => true, isPendingOrSse: () => true });
	const app = createBridgeApp(deps);
	const res = await app.fetch(req("/api/stream/attach"));
	assert.strictEqual(res.status, 409);
});

test("GET /api/stream/attach returns SSE stream when busy and no active SSE", async () => {
	const deps = createMockDeps({
		getIsBusy: () => true,
		isPendingOrSse: () => false,
		attachStream: (res) => {
			res.write('data: {"type":"agent_start"}\n\n');
			res.end();
			return true;
		},
	});
	const app = createBridgeApp(deps);
	const res = await app.fetch(req("/api/stream/attach"));
	assert.strictEqual(res.status, 200);
	assert.strictEqual(res.headers.get("content-type"), "text/event-stream");
});

test("POST /api/new-session spawns and returns pid", async () => {
	const deps = createMockDeps();
	const app = createBridgeApp(deps);
	const res = await app.fetch(postJson("/api/new-session", { cwd: "/tmp" }));
	assert.strictEqual(res.status, 200);
	const body = await res.json();
	assert.strictEqual(body.ok, true);
	assert.strictEqual(body.pid, 99999);
	assert.strictEqual(deps.calls.spawnNewSession[0], "/tmp");
});

test("POST /api/new-session with empty body spawns with undefined cwd", async () => {
	const deps = createMockDeps();
	const app = createBridgeApp(deps);
	const res = await app.fetch(req("/api/new-session", { method: "POST", body: "" }));
	assert.strictEqual(res.status, 200);
	assert.strictEqual(deps.calls.spawnNewSession[0], undefined);
});

test("POST /api/open-session opens session by ID", async () => {
	const deps = createMockDeps();
	const app = createBridgeApp(deps);
	const res = await app.fetch(postJson("/api/open-session", { sessionId: "019f5aad", name: "test" }));
	assert.strictEqual(res.status, 200);
	const body = await res.json();
	assert.strictEqual(body.ok, true);
	assert.strictEqual(body.pid, 88888);
	assert.strictEqual(deps.calls.openSession[0].sessionId, "019f5aad");
	assert.strictEqual(deps.calls.openSession[0].name, "test");
	assert.strictEqual(deps.calls.openSession[0].cwd, undefined);
});

test("POST /api/open-session passes cwd through", async () => {
	const deps = createMockDeps();
	const app = createBridgeApp(deps);
	const res = await app.fetch(postJson("/api/open-session", { sessionId: "019f5aad", cwd: "/Users/ctw/Workdir/Codebase/service" }));
	assert.strictEqual(res.status, 200);
	assert.strictEqual(deps.calls.openSession[0].sessionId, "019f5aad");
	assert.strictEqual(deps.calls.openSession[0].cwd, "/Users/ctw/Workdir/Codebase/service");
});

test("POST /api/open-session rejects missing sessionId", async () => {
	const deps = createMockDeps();
	const app = createBridgeApp(deps);
	const res = await app.fetch(postJson("/api/open-session", {}));
	assert.strictEqual(res.status, 400);
});

test("POST /api/kill-session calls killSession with pid", async () => {
	const deps = createMockDeps();
	const app = createBridgeApp(deps);
	const res = await app.fetch(postJson("/api/kill-session", { pid: 12345 }));
	assert.strictEqual(res.status, 200);
	const body = await res.json();
	assert.strictEqual(body.ok, true);
	assert.strictEqual(body.pid, 12345);
	assert.strictEqual(deps.calls.killSession[0], 12345);
});

test("POST /api/kill-session rejects missing pid", async () => {
	const app = createBridgeApp(createMockDeps());
	const res = await app.fetch(postJson("/api/kill-session", {}));
	assert.strictEqual(res.status, 400);
});

test("POST /api/kill-session rejects invalid JSON", async () => {
	const app = createBridgeApp(createMockDeps());
	const res = await app.fetch(postJson("/api/kill-session", "broken"));
	assert.strictEqual(res.status, 400);
});

test("POST /api/rename-session calls setSessionName", async () => {
	const deps = createMockDeps();
	const app = createBridgeApp(deps);
	const res = await app.fetch(postJson("/api/rename-session", { name: "my new name" }));
	assert.strictEqual(res.status, 200);
	const body = await res.json();
	assert.strictEqual(body.ok, true);
	assert.strictEqual(body.name, "my new name");
	assert.strictEqual(deps.calls.setSessionName[0], "my new name");
});

test("POST /api/rename-session rejects missing name", async () => {
	const app = createBridgeApp(createMockDeps());
	const res = await app.fetch(postJson("/api/rename-session", {}));
	assert.strictEqual(res.status, 400);
});

test("POST /api/rename-session rejects invalid JSON", async () => {
	const app = createBridgeApp(createMockDeps());
	const res = await app.fetch(postJson("/api/rename-session", "not json"));
	assert.strictEqual(res.status, 400);
});

test("POST /api/reload calls reload dep", async () => {
	const deps = createMockDeps();
	const app = createBridgeApp(deps);
	const res = await app.fetch(req("/api/reload", { method: "POST" }));
	assert.strictEqual(res.status, 200);
	const body = await res.json();
	assert.strictEqual(body.ok, true);
	assert.strictEqual(deps.calls.reload.length, 1);
});

test("POST /api/reload without session file returns 500", async () => {
	const app = createBridgeApp(createMockDeps({ getSessionFile: () => null }));
	const res = await app.fetch(req("/api/reload", { method: "POST" }));
	assert.strictEqual(res.status, 500);
});

test("POST /api/client-log calls clientLog dep", async () => {
	const deps = createMockDeps();
	const app = createBridgeApp(deps);
	const res = await app.fetch(postJson("/api/client-log", { level: "error", message: "test error", data: { foo: 1 } }));
	assert.strictEqual(res.status, 200);
	const body = await res.json();
	assert.strictEqual(body.ok, true);
	assert.strictEqual(deps.calls.clientLog.length, 1);
	assert.strictEqual(deps.calls.clientLog[0].level, "error");
	assert.strictEqual(deps.calls.clientLog[0].message, "test error");
	assert.deepStrictEqual(deps.calls.clientLog[0].data, { foo: 1 });
});

test("POST /api/client-log with invalid JSON returns 400", async () => {
	const app = createBridgeApp(createMockDeps());
	const res = await app.fetch(postJson("/api/client-log", "{bad json"));
	assert.strictEqual(res.status, 400);
});

test("GET /api/openapi.json returns OpenAPI spec", async () => {
	const app = createBridgeApp(createMockDeps());
	const res = await app.fetch(req("/api/openapi.json"));
	assert.strictEqual(res.status, 200);
	const body = await res.json();
	assert.strictEqual(body.openapi, "3.0.0");
	assert.ok(body.paths["/api/status"]);
	assert.ok(body.paths["/api/prompt"]);
});

test("GET / serves index.html", async () => {
	const app = createBridgeApp(createMockDeps());
	const res = await app.fetch(req("/"));
	assert.strictEqual(res.status, 200);
	assert.match(res.headers.get("Content-Type"), /text\/html/);
});

test("GET nonexistent path returns 404", async () => {
	const app = createBridgeApp(createMockDeps());
	const res = await app.fetch(req("/no-such-file.js"));
	assert.strictEqual(res.status, 404);
});

test("GET path traversal is blocked by URL normalization", async () => {
	const app = createBridgeApp(createMockDeps());
	// new Request() normalizes ../../etc/passwd against the base URL,
	// so the path never reaches route handlers as traversal.
	const res = await app.fetch(req("/../../etc/passwd"));
	assert.ok(res.status === 403 || res.status === 404);
});

test("GET /api/tree returns the compacted user tree", async () => {
	const app = createBridgeApp(createMockDeps());
	const res = await app.fetch(req("/api/tree"));
	assert.strictEqual(res.status, 200);
	const body = await res.json();
	assert.strictEqual(body.leafId, "a1");
	assert.strictEqual(body.nodes[0].id, "u1");
	assert.strictEqual(body.nodes[0].current, true);
});

test("POST /api/tree/navigate moves the leaf", async () => {
	const deps = createMockDeps();
	const app = createBridgeApp(deps);
	const res = await app.fetch(postJson("/api/tree/navigate", { targetId: "a1" }));
	assert.strictEqual(res.status, 200);
	assert.deepEqual(await res.json(), { ok: true, reload: true });
	assert.deepEqual(deps.calls.navigateTree, ["a1"]);
});

test("POST /api/tree/navigate surfaces navigation failure as 400", async () => {
	const app = createBridgeApp(createMockDeps());
	const res = await app.fetch(postJson("/api/tree/navigate", { targetId: "bad" }));
	assert.strictEqual(res.status, 400);
	assert.match((await res.json()).error, /cancelled/i);
});

test("POST /api/tree/navigate rejects while busy with 409", async () => {
	const deps = createMockDeps({ getIsBusy: () => true });
	const app = createBridgeApp(deps);
	const res = await app.fetch(postJson("/api/tree/navigate", { targetId: "a1" }));
	assert.strictEqual(res.status, 409);
	assert.deepEqual(deps.calls.navigateTree, []);
});

test("POST /api/tree/navigate rejects a missing targetId", async () => {
	const app = createBridgeApp(createMockDeps());
	const res = await app.fetch(postJson("/api/tree/navigate", {}));
	assert.strictEqual(res.status, 400);
});
