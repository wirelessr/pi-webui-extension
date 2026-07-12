/**
 * Hono app factory — extracted from index.ts for HTTP integration testing.
 *
 * All route handlers read state and side effects through the `deps` object,
 * making them testable without a real pi session or HTTP server.
 * Tests call `app.fetch(new Request(...))` directly.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import * as helpers from "./http-bridge-web/helpers.js";

// Resolve hono from the extension's own node_modules
const extRequire = createRequire(import.meta.url);
const { OpenAPIHono, createRoute, z } = extRequire("@hono/zod-openapi");
const { swaggerUI } = extRequire("@hono/swagger-ui");

const EXT_DIR = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = join(EXT_DIR, "http-bridge-web");

const MIME_TYPES = {
	".html": "text/html; charset=utf-8",
	".js": "application/javascript; charset=utf-8",
	".mjs": "application/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".ico": "image/x-icon",
	".woff2": "font/woff2",
};

const WEBUI_EXECUTABLE = new Set(["compact"]);

/**
 * Execute a WebUI-executable builtin command.
 * Returns true if handled, false if no handler.
 */
function executeBuiltin(cmdName, ctx) {
	if (cmdName === "compact" && ctx) {
		ctx.compact();
		return true;
	}
	return false;
}

// ── Zod schemas ───────────────────────────────────────────────────

const UsageStats = z.object({
	inputTokens: z.number(),
	outputTokens: z.number(),
	cacheReadTokens: z.number(),
	cacheWriteTokens: z.number(),
	cacheHitRate: z.number().nullable(),
	totalCost: z.number(),
}).openapi("UsageStats");

const ContextUsageInfo = z.object({
	tokens: z.number().nullable(),
	contextWindow: z.number(),
	percent: z.number().nullable(),
}).openapi("ContextUsageInfo");

const StatusResponse = z.object({
	status: z.string(),
	busy: z.boolean(),
	sessionFile: z.string().nullable(),
	sessionId: z.string().nullable(),
	sessionName: z.string().nullable(),
	port: z.number(),
	pid: z.number(),
	startedAt: z.number(),
	model: z.string().nullable(),
	usage: UsageStats,
	context: ContextUsageInfo,
}).openapi("Status");

const SessionInfo = z.object({
	port: z.number(),
	host: z.string(),
	lanIp: z.string().nullable(),
	url: z.string(),
	sessionFile: z.string().nullable(),
	sessionId: z.string().nullable(),
	sessionName: z.string().nullable(),
	pid: z.number(),
	startedAt: z.number(),
}).openapi("SessionInfo");

const SessionsResponse = z.object({
	sessions: z.array(SessionInfo),
}).openapi("SessionsResponse");

const CommandInfo = z.object({
	name: z.string(),
	description: z.string().optional(),
	source: z.string(),
	executable: z.boolean().optional(),
}).openapi("CommandInfo");

const CommandsResponse = z.object({
	commands: z.array(CommandInfo),
}).openapi("CommandsResponse");

const HistoryEntry = z.object({
	id: z.string().optional(),
	timestamp: z.any().optional(),
	role: z.string(),
	text: z.string().optional(),
	thinking: z.string().optional(),
	toolCalls: z.array(z.any()).optional(),
	toolCallId: z.string().optional(),
	toolName: z.string().optional(),
	isError: z.boolean().optional(),
}).openapi("HistoryEntry");

const HistoryResponse = z.object({
	history: z.array(HistoryEntry),
	total: z.number(),
}).openapi("HistoryResponse");

const PromptBody = z.object({
	message: z.string(),
	timeout: z.number().optional(),
	full: z.boolean().optional(),
	stream: z.boolean().optional(),
}).openapi("PromptBody");

const PromptResponse = z.object({
	text: z.string(),
	toolCalls: z.array(z.string()),
	thinking: z.string(),
	messageCount: z.number(),
	messages: z.array(z.any()).optional(),
}).openapi("PromptResponse");

const ErrorResponse = z.object({
	error: z.string(),
}).openapi("ErrorResponse");

const CommandBody = z.object({
	command: z.string(),
}).openapi("CommandBody");

const NewSessionBody = z.object({
	cwd: z.string().optional(),
}).openapi("NewSessionBody");

const NewSessionResponse = z.object({
	ok: z.boolean(),
	pid: z.number(),
}).openapi("NewSessionResponse");

const KillSessionBody = z.object({
	pid: z.number(),
}).openapi("KillSessionBody");

const KillSessionResponse = z.object({
	ok: z.boolean(),
	pid: z.number(),
}).openapi("KillSessionResponse");

const RenameSessionBody = z.object({
	name: z.string(),
}).openapi("RenameSessionBody");

const RenameSessionResponse = z.object({
	ok: z.boolean(),
	name: z.string(),
}).openapi("RenameSessionResponse");

const OkResponse = z.object({
	ok: z.boolean(),
}).openapi("OkResponse");

// ── Route definitions ────────────────────────────────────────────

const statusRoute = createRoute({
	method: "get",
	path: "/api/status",
	summary: "This session's status",
	responses: {
		200: { description: "OK", content: { "application/json": { schema: StatusResponse } } },
	},
});

const sessionsRoute = createRoute({
	method: "get",
	path: "/api/sessions",
	summary: "All active sessions on this machine",
	responses: {
		200: { description: "OK", content: { "application/json": { schema: SessionsResponse } } },
	},
});

const historyRoute = createRoute({
	method: "get",
	path: "/api/history",
	summary: "Conversation history from session JSONL (paginated)",
	request: {
		query: z.object({
			limit: z.string().optional().openapi({ description: "Max entries (0 = all)" }),
			offset: z.string().optional().openapi({ description: "Skip from end (0 = most recent)" }),
		}),
	},
	responses: {
		200: { description: "OK", content: { "application/json": { schema: HistoryResponse } } },
	},
});

const commandsRoute = createRoute({
	method: "get",
	path: "/api/commands",
	summary: "Available skills, prompt templates, and executable built-in commands",
	responses: {
		200: { description: "OK", content: { "application/json": { schema: CommandsResponse } } },
	},
});

const commandRoute = createRoute({
	method: "post",
	path: "/api/command",
	summary: "Execute a built-in command (compact)",
	request: {
		body: { content: { "application/json": { schema: CommandBody } } },
	},
	responses: {
		200: { description: "OK", content: { "application/json": { schema: OkResponse } } },
		400: { description: "Bad request", content: { "application/json": { schema: ErrorResponse } } },
	},
});

const promptRoute = createRoute({
	method: "post",
	path: "/api/prompt",
	summary: "Send message to agent (JSON or plain text, supports SSE streaming)",
	request: {
		body: {
			content: {
				"application/json": { schema: PromptBody },
				"text/plain": { schema: z.string() },
			},
		},
	},
	responses: {
		200: {
			description: "OK (JSON or SSE stream)",
			content: {
				"application/json": { schema: PromptResponse },
				"text/event-stream": { schema: z.string() },
			},
		},
		400: { description: "Bad request", content: { "application/json": { schema: ErrorResponse } } },
		409: { description: "Conflict", content: { "application/json": { schema: ErrorResponse } } },
	},
});

const abortRoute = createRoute({
	method: "post",
	path: "/api/abort",
	summary: "Abort the current agent operation",
	responses: {
		200: { description: "OK", content: { "application/json": { schema: OkResponse } } },
		500: { description: "Server error", content: { "application/json": { schema: ErrorResponse } } },
	},
});

const newSessionRoute = createRoute({
	method: "post",
	path: "/api/new-session",
	summary: "Spawn a new pi session in RPC mode",
	request: {
		body: { content: { "application/json": { schema: NewSessionBody } } },
	},
	responses: {
		200: { description: "OK", content: { "application/json": { schema: NewSessionResponse } } },
		500: { description: "Server error", content: { "application/json": { schema: ErrorResponse } } },
	},
});

const killSessionRoute = createRoute({
	method: "post",
	path: "/api/kill-session",
	summary: "Terminate a session by PID (SIGTERM)",
	request: {
		body: { content: { "application/json": { schema: KillSessionBody } } },
	},
	responses: {
		200: { description: "OK", content: { "application/json": { schema: KillSessionResponse } } },
		400: { description: "Bad request", content: { "application/json": { schema: ErrorResponse } } },
	},
});

const renameSessionRoute = createRoute({
	method: "post",
	path: "/api/rename-session",
	summary: "Rename the current session",
	request: {
		body: { content: { "application/json": { schema: RenameSessionBody } } },
	},
	responses: {
		200: { description: "OK", content: { "application/json": { schema: RenameSessionResponse } } },
		400: { description: "Bad request", content: { "application/json": { schema: ErrorResponse } } },
	},
});

const reloadRoute = createRoute({
	method: "post",
	path: "/api/reload",
	summary: "Self-respawn (resume same session with fresh code)",
	responses: {
		200: { description: "OK", content: { "application/json": { schema: OkResponse } } },
		500: { description: "Server error", content: { "application/json": { schema: ErrorResponse } } },
	},
});

const ClientLogBody = z.object({
	level: z.string(),
	message: z.string(),
	data: z.any().optional(),
}).openapi("ClientLogBody");

const clientLogRoute = createRoute({
	method: "post",
	path: "/api/client-log",
	summary: "Log a client-side message to bridge.log",
	request: {
		body: { content: { "application/json": { schema: ClientLogBody } } },
	},
	responses: {
		200: { description: "OK", content: { "application/json": { schema: OkResponse } } },
	},
});

// ── Static file serving ───────────────────────────────────────────

async function serveStatic(path, c) {
	const check = helpers.isPathSafe(path, WEB_DIR);
	if (!check.safe) {
		return c.text(check.reason || "Forbidden", 403);
	}

	const safePath = normalize(path).replace(/^(\.\.[/\\])+/, "");
	const filePath = join(WEB_DIR, safePath);

	if (!existsSync(filePath)) {
		return c.text("Not found", 404);
	}

	try {
		const data = await readFile(filePath);
		const ext = extname(filePath).toLowerCase();
		const mime = MIME_TYPES[ext] || "application/octet-stream";
		return new Response(data, {
			headers: { "Content-Type": mime, "Cache-Control": "no-cache" },
		});
	} catch {
		return c.text("Internal server error", 500);
	}
}

// ── App factory ───────────────────────────────────────────────────

/**
 * Create the Hono app with all routes registered.
 *
 * @param {object} deps — injectable dependencies
 * @returns {OpenAPIHono} the Hono app (call app.fetch(request) to test)
 */
export function createBridgeApp(deps) {
	const app = new OpenAPIHono();

	// CORS middleware
	app.use("*", async (c, next) => {
		await next();
		c.header("Access-Control-Allow-Origin", "*");
		c.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
		c.header("Access-Control-Allow-Headers", "Content-Type");
	});
	app.options("*", (c) => {
		c.header("Access-Control-Allow-Origin", "*");
		c.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
		c.header("Access-Control-Allow-Headers", "Content-Type");
		return c.body(null, 204);
	});

	// Swagger UI
	app.doc("/api/openapi.json", {
		openapi: "3.0.0",
		info: {
			title: "pi HTTP Bridge",
			version: "1.0.0",
			description: "HTTP bridge for pi coding agent sessions",
		},
	});
	app.get("/api/docs", swaggerUI({ url: "/api/openapi.json" }));

	// ── Route handlers ────────────────────────────────────────────

	app.openapi(statusRoute, (c) => {
		return c.json({
			status: "ok",
			busy: deps.getIsBusy(),
			sessionFile: deps.getSessionFile() ?? null,
			sessionId: deps.getSessionId() ?? null,
			sessionName: deps.getSessionName() ?? null,
			port: deps.getActualPort(),
			pid: deps.getPid(),
			startedAt: deps.getStartedAt(),
			model: deps.getSessionCtx()?.model?.id ?? null,
			usage: deps.computeUsageStats(),
			context: deps.computeContextUsage(),
		});
	});

	app.openapi(sessionsRoute, (c) => {
		return c.json({ sessions: deps.listAllSessions() });
	});

	app.openapi(historyRoute, async (c) => {
		const limit = Number.parseInt(c.req.query("limit") || "0", 10);
		const offset = Number.parseInt(c.req.query("offset") || "0", 10);
		try {
			const { history, total } = await deps.readSessionHistory(deps.getSessionFile(), limit, offset);
			return c.json({ history, total });
		} catch (err) {
			return c.json({ error: err.message }, 500);
		}
	});

	app.openapi(commandsRoute, (c) => {
		const commands = deps
			.getCommands()
			.filter((cmd) => cmd.source === "skill" || cmd.source === "prompt")
			.map((cmd) => ({
				name: cmd.name,
				description: cmd.description,
				source: cmd.source,
			}));
		const builtins = deps.builtinCommands
			.filter((cmd) => WEBUI_EXECUTABLE.has(cmd.name))
			.map((cmd) => ({
				name: cmd.name,
				description: cmd.description,
				source: "builtin",
				executable: true,
			}));
		return c.json({ commands: [...commands, ...builtins] });
	});

	app.openapi(commandRoute, async (c) => {
		let cmdName;
		try {
			cmdName = (await c.req.json()).command;
		} catch {
			return c.json({ error: "Invalid JSON body" }, 400);
		}
		if (!WEBUI_EXECUTABLE.has(cmdName)) {
			return c.json({ error: `Command "${cmdName}" is not executable from WebUI` }, 400);
		}
		try {
			if (!executeBuiltin(cmdName, deps.getSessionCtx())) {
				return c.json({ error: `Command "${cmdName}" has no handler` }, 400);
			}
			return c.json({ ok: true });
		} catch (err) {
			return c.json({ error: err.message }, 500);
		}
	});

	app.openapi(promptRoute, async (c) => {
		const contentType = c.req.header("content-type") || "";
		const rawBody = await c.req.text();

		if (!rawBody.trim()) {
			return c.json({ error: "Empty request body" }, 400);
		}

		const parsed = helpers.parsePromptBody(rawBody, contentType);
		if ("error" in parsed) {
			return c.json({ error: parsed.error }, 400);
		}

		if (deps.isPendingOrSse()) {
			return c.json({ error: "Another request is being processed" }, 409);
		}

		// Intercept executable builtins (e.g. /compact) typed in the prompt box
		const trimmed = parsed.message.trim();
		if (trimmed.startsWith("/") && WEBUI_EXECUTABLE.has(trimmed.slice(1))) {
			const cmdName = trimmed.slice(1);
			const accept = c.req.header("accept") || "";
			const useSse = accept.includes("text/event-stream");
			if (cmdName === "compact") {
				if (useSse) {
					const { readable, writable } = new TransformStream();
					const writer = writable.getWriter();
					const encoder = new TextEncoder();
					const res = {
						write: (chunk) => writer.write(encoder.encode(chunk)),
						end: () => writer.close(),
					};
					deps.compactAndStream(res);
					return new Response(readable, {
						headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
					});
				}
				try {
					if (!executeBuiltin(cmdName, deps.getSessionCtx())) {
						return c.json({ error: `Command "${cmdName}" has no handler` }, 400);
					}
					return c.json({ ok: true });
				} catch (err) {
					return c.json({ error: err.message }, 500);
				}
			}
		}

		const accept = c.req.header("accept") || "";
		const useSse = parsed.stream || accept.includes("text/event-stream");

		if (useSse) {
			const { readable, writable } = new TransformStream();
			const writer = writable.getWriter();
			const encoder = new TextEncoder();

			(async () => {
				const res = {
					write: (chunk) => writer.write(encoder.encode(chunk)),
					writeHead: () => {},
					flushHeaders: () => {},
					end: () => writer.close(),
					on: () => {},
				};
				await deps.sendAndStream(parsed.message, parsed.timeoutMs, res);
			})();

			return new Response(readable, {
				headers: {
					"Content-Type": "text/event-stream",
					"Cache-Control": "no-cache",
					"Connection": "keep-alive",
					"X-Accel-Buffering": "no",
				},
			});
		}

		try {
			const messages = await deps.sendAndWait(parsed.message, parsed.timeoutMs);
			const result = {
				text: helpers.extractText(messages),
				toolCalls: helpers.extractToolCalls(messages),
				thinking: helpers.extractThinking(messages),
				messageCount: messages.length,
			};
			if (parsed.includeFull) result.messages = messages;
			return c.json(result);
		} catch (err) {
			return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
		}
	});

	app.openapi(abortRoute, (c) => {
		try {
			const ctx = deps.getSessionCtx();
			if (ctx) {
				ctx.abort();
				return c.json({ ok: true });
			}
			return c.json({ error: "No active session context" }, 500);
		} catch (err) {
			return c.json({ error: err.message }, 500);
		}
	});

	app.openapi(newSessionRoute, async (c) => {
		let cwd;
		try {
			const body = await c.req.json();
			cwd = body.cwd;
		} catch {
			// empty or non-JSON body is fine
		}
		try {
			const { pid } = deps.spawnNewSession(cwd);
			return c.json({ ok: true, pid });
		} catch (err) {
			return c.json({ error: err.message }, 500);
		}
	});

	app.openapi(killSessionRoute, async (c) => {
		let pid;
		try {
			pid = (await c.req.json()).pid;
		} catch {
			return c.json({ error: "Invalid JSON body" }, 400);
		}
		if (!pid || typeof pid !== "number") {
			return c.json({ error: "Missing or invalid pid" }, 400);
		}
		const killed = deps.killSession(pid);
		return c.json({ ok: killed, pid });
	});

	app.openapi(renameSessionRoute, async (c) => {
		let name;
		try {
			name = (await c.req.json()).name;
		} catch {
			return c.json({ error: "Invalid JSON body" }, 400);
		}
		if (!name || typeof name !== "string") {
			return c.json({ error: "Missing or invalid name" }, 400);
		}
		try {
			deps.setSessionName(name);
			return c.json({ ok: true, name });
		} catch (err) {
			return c.json({ error: err.message }, 500);
		}
	});

	app.openapi(reloadRoute, (c) => {
		const sessionPath = deps.getSessionFile();
		if (!sessionPath) {
			return c.json({ error: "No session file to resume" }, 500);
		}
		deps.reload();
		return c.json({ ok: true });
	});

	app.openapi(clientLogRoute, async (c) => {
		let body;
		try {
			body = await c.req.json();
		} catch {
			return c.json({ ok: false });
		}
		deps.clientLog(body.level || "info", body.message, body.data);
		return c.json({ ok: true });
	});

	// ── Static file serving (fallback) ───────────────────────────

	app.get("*", async (c) => {
		const reqPath = c.req.path;
		const filePath = reqPath === "/" ? "/index.html" : reqPath;
		return serveStatic(filePath, c);
	});

	return app;
}
