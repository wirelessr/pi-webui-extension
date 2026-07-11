/**
 * HTTP Bridge Extension (multi-session safe, with WebUI + SSE streaming)
 *
 * Uses Hono + zod-openapi for route definitions with auto-generated OpenAPI spec.
 * Swagger UI available at /api/docs.
 */

import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { createServer as createNetServer } from "node:net";
import { networkInterfaces } from "node:os";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as helpers from "./http-bridge-web/helpers.js";

// Resolve hono from the extension's own node_modules (pi's jiti doesn't
// look in extension directories, so we use createRequire from our path)
const extRequire = createRequire(import.meta.url);
const { OpenAPIHono, createRoute, z } = extRequire("@hono/zod-openapi");
const { swaggerUI } = extRequire("@hono/swagger-ui");

const EXT_DIR = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = join(EXT_DIR, "http-bridge-web");

const MIME_TYPES: Record<string, string> = {
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

interface PendingRequest {
	resolve: (messages: any[]) => void;
	reject: (error: Error) => void;
	timeout: ReturnType<typeof setTimeout>;
}

interface IdleWaiter {
	resolve: () => void;
	timeout: ReturnType<typeof setTimeout>;
}

interface SseState {
	res: any;
	heartbeat: ReturnType<typeof setInterval>;
	timeout: ReturnType<typeof setTimeout>;
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

export default function (pi: ExtensionAPI) {
	const BASE_PORT = parseInt(process.env.PI_HTTP_PORT || "7331", 10);
	const HOST = process.env.PI_HTTP_HOST || "0.0.0.0";
	const BRIDGE_DIR = process.env.PI_BRIDGE_DIR || join(EXT_DIR, "data");

	let server: ReturnType<typeof createServer> | null = null;
	let actualPort = BASE_PORT;
	let pending: PendingRequest | null = null;
	let sse: SseState | null = null;
	let isBusy = false;

	let waitingForExtensionInput = false;
	let ourTurnActive = false;
	let inputWatchdog: ReturnType<typeof setTimeout> | null = null;

	let idleWaiters: IdleWaiter[] = [];
	let sessionFile: string | undefined;
	let sessionId: string | undefined;
	let sessionName: string | undefined;
	let discoveryFile: string | undefined;
	let sessionCtx: any = null;
	let sessionStartTime = Date.now();

	// Built-in commands loaded from pi's internal module
	let builtinCommands: { name: string; description: string }[] = [];
	try {
		const piEntryUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
		const piRequire = createRequire(piEntryUrl);
		const slashMod = piRequire("./core/slash-commands.js");
		if (slashMod?.BUILTIN_SLASH_COMMANDS) {
			builtinCommands = slashMod.BUILTIN_SLASH_COMMANDS as { name: string; description: string }[];
		}
	} catch {
		// Fallback: no builtins if module path changes in future pi versions
	}

	const WEBUI_EXECUTABLE = new Set(["compact"]);

	// ── Route definitions ────────────────────────────────────────────

	const statusRoute = createRoute({
		method: "get",
		path: "/api/status",
		summary: "This session's status",
		responses: {
			200: {
				description: "OK",
				content: { "application/json": { schema: StatusResponse } },
			},
		},
	});

	const sessionsRoute = createRoute({
		method: "get",
		path: "/api/sessions",
		summary: "All active sessions on this machine",
		responses: {
			200: {
				description: "OK",
				content: { "application/json": { schema: SessionsResponse } },
			},
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
			200: {
				description: "OK",
				content: { "application/json": { schema: HistoryResponse } },
			},
		},
	});

	const commandsRoute = createRoute({
		method: "get",
		path: "/api/commands",
		summary: "Available skills, prompt templates, and executable built-in commands",
		responses: {
			200: {
				description: "OK",
				content: { "application/json": { schema: CommandsResponse } },
			},
		},
	});

	const commandRoute = createRoute({
		method: "post",
		path: "/api/command",
		summary: "Execute a built-in command (compact)",
		request: {
			body: {
				content: { "application/json": { schema: CommandBody } },
			},
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
			body: {
				content: { "application/json": { schema: NewSessionBody } },
			},
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
			body: {
				content: { "application/json": { schema: KillSessionBody } },
			},
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
			body: {
				content: { "application/json": { schema: RenameSessionBody } },
			},
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

	// ── Hono app ─────────────────────────────────────────────────────

	const app = new OpenAPIHono();

	// CORS middleware
	app.use("*", async (c, next) => {
		await next();
		c.header("Access-Control-Allow-Origin", "*");
		c.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
		c.header("Access-Control-Allow-Headers", "Content-Type");
	});
	app.options("*", (c) => c.text("", 204));

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

	// ── Route handlers ────────────────────────────────────────────────

	app.openapi(statusRoute, (c) => {
		return c.json({
			status: "ok",
			busy: isBusy,
			sessionFile: sessionFile ?? null,
			sessionId: sessionId ?? null,
			sessionName: sessionName ?? null,
			port: actualPort,
			pid: process.pid,
			startedAt: sessionStartTime,
			model: sessionCtx?.model?.id ?? null,
			usage: computeUsageStats(),
			context: computeContextUsage(),
		});
	});

	app.openapi(sessionsRoute, (c) => {
		return c.json({ sessions: listAllSessions() });
	});

	app.openapi(historyRoute, async (c) => {
		const limit = parseInt(c.req.query("limit") || "0", 10);
		const offset = parseInt(c.req.query("offset") || "0", 10);
		try {
			const { history, total } = await readSessionHistory(sessionFile, limit, offset);
			return c.json({ history, total });
		} catch (err: any) {
			return c.json({ error: err.message }, 500);
		}
	});

	app.openapi(commandsRoute, (c) => {
		const commands = pi.getCommands()
			.filter((cmd) => cmd.source === "skill" || cmd.source === "prompt")
			.map((cmd) => ({
				name: cmd.name,
				description: cmd.description,
				source: cmd.source,
			}));
		const builtins = builtinCommands
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
		let cmdName: string;
		try {
			cmdName = (await c.req.json()).command;
		} catch {
			return c.json({ error: "Invalid JSON body" }, 400);
		}
		if (!WEBUI_EXECUTABLE.has(cmdName)) {
			return c.json({ error: `Command "${cmdName}" is not executable from WebUI` }, 400);
		}
		try {
			if (cmdName === "compact" && sessionCtx) {
				sessionCtx.compact();
			} else {
				return c.json({ error: `Command "${cmdName}" has no handler` }, 400);
			}
			return c.json({ ok: true });
		} catch (err: any) {
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

		if (pending || sse) {
			return c.json({ error: "Another request is being processed" }, 409);
		}

		const accept = c.req.header("accept") || "";
		const useSse = parsed.stream || accept.includes("text/event-stream");

		if (useSse) {
			// SSE streaming — use raw Node response
			const { readable, writable } = new TransformStream();
			const writer = writable.getWriter();
			const encoder = new TextEncoder();

			// Start SSE in background
			(async () => {
				const res: any = {
					write: (chunk: string) => { writer.write(encoder.encode(chunk)); },
					writeHead: () => {},
					flushHeaders: () => {},
					end: () => { writer.close(); },
					on: () => {},
				};
				await sendAndStream(parsed.message, parsed.timeoutMs, res);
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
			const messages = await sendAndWait(parsed.message, parsed.timeoutMs);
			const result: Record<string, any> = {
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
			if (sessionCtx) {
				sessionCtx.abort();
				return c.json({ ok: true });
			}
			return c.json({ error: "No active session context" }, 500);
		} catch (err: any) {
			return c.json({ error: err.message }, 500);
		}
	});

	app.openapi(newSessionRoute, async (c) => {
		let cwd: string | undefined;
		try {
			const body = await c.req.json();
			cwd = body.cwd;
		} catch {
			// empty or non-JSON body is fine
		}
		try {
			const { pid } = spawnNewSession(cwd);
			return c.json({ ok: true, pid });
		} catch (err: any) {
			return c.json({ error: err.message }, 500);
		}
	});

	app.openapi(killSessionRoute, async (c) => {
		let pid: unknown;
		try {
			pid = (await c.req.json()).pid;
		} catch {
			return c.json({ error: "Invalid JSON body" }, 400);
		}
		if (!pid || typeof pid !== "number") {
			return c.json({ error: "Missing or invalid pid" }, 400);
		}
		const killed = killSession(pid);
		return c.json({ ok: killed, pid });
	});

	app.openapi(renameSessionRoute, async (c) => {
		let name: unknown;
		try {
			name = (await c.req.json()).name;
		} catch {
			return c.json({ error: "Invalid JSON body" }, 400);
		}
		if (!name || typeof name !== "string") {
			return c.json({ error: "Missing or invalid name" }, 400);
		}
		try {
			pi.setSessionName(name);
			return c.json({ ok: true, name });
		} catch (err: any) {
			return c.json({ error: err.message }, 500);
		}
	});

	app.openapi(reloadRoute, (c) => {
		const sessionPath = sessionFile;
		if (!sessionPath) {
			return c.json({ error: "No session file to resume" }, 500);
		}
		// Self-respawn: spawn new process, then exit
		const respawn = spawn("sh", ["-c", `sleep 1 && tail -f /dev/null | PI_HTTP_PORT=${actualPort} pi --mode rpc --session "${sessionPath}"`], {
			detached: true,
			stdio: ["ignore", "ignore", "pipe"],
		});
		// Pipe stderr to log file
		const logStream = createWriteStream(sessionLogPath(respawn.pid!), { flags: "a" });
		respawn.stderr?.pipe(logStream);
		// Clean up discovery file before exiting
		if (discoveryFile) {
			try { unlinkSync(discoveryFile); } catch {}
		}
		// Send response then exit
		setTimeout(() => process.exit(0), 100);
		return c.json({ ok: true });
	});

	// ── Static file serving (fallback) ───────────────────────────────

	app.get("*", async (c) => {
		const reqPath = c.req.path;
		const filePath = reqPath === "/" ? "/index.html" : reqPath;
		return serveStatic(filePath, c);
	});

	// ── Session spawn helper ─────────────────────────────────────────

	function sessionLogPath(pid: number): string {
		return join(dataDir, `session-${pid}.stderr.log`);
	}

	function spawnNewSession(cwd?: string): { pid: number } {
		const child = spawn("sh", ["-c", "tail -f /dev/null | pi --mode rpc"], {
			cwd: cwd || process.cwd(),
			detached: true,
			stdio: ["ignore", "ignore", "pipe"],
		});
		child.unref();
		const pid = child.pid!;
		// Pipe stderr to a log file for debugging
		const logStream = createWriteStream(sessionLogPath(pid), { flags: "a" });
		child.stderr?.pipe(logStream);
		return { pid };
	}

	function killSession(pid: number): boolean {
		try {
			process.kill(pid, "SIGTERM");
			return true;
		} catch {
			return false;
		}
	}

	// ── Agent event handlers ──────────────────────────────────────────

	pi.on("agent_start", () => {
		isBusy = true;
		if (sse && ourTurnActive) {
			writeSse({ type: "agent_start" });
		}
	});

	pi.on("agent_end", (event: any) => {
		isBusy = false;

		if (ourTurnActive) {
			ourTurnActive = false;
			const messages = event.messages ?? [];

			if (sse) {
				writeSse({
					type: "done",
					text: helpers.extractText(messages),
					toolCalls: helpers.extractToolCalls(messages),
					thinking: helpers.extractThinking(messages),
					messageCount: messages.length,
					messages,
				});
				closeSse();
				return;
			}

			if (pending) {
				const p = pending;
				pending = null;
				clearTimeout(p.timeout);
				p.resolve(messages);
				return;
			}
		} else {
			// agent_end fired but our turn wasn't active — either a TUI turn
			// or we missed the input event. Log for diagnosis.
			if (sse || pending) {
				console.error("[http-bridge] agent_end received but ourTurnActive=false", {
					hasSse: !!sse,
					hasPending: !!pending,
					waitingForExtensionInput,
				});
			}
		}

		ourTurnActive = false;

		const waiters = idleWaiters;
		idleWaiters = [];
		for (const w of waiters) {
			clearTimeout(w.timeout);
			w.resolve();
		}
	});

	pi.on("input", (event: any) => {
		if (waitingForExtensionInput && event.source === "extension") {
			waitingForExtensionInput = false;
			ourTurnActive = true;
			if (inputWatchdog) {
				clearTimeout(inputWatchdog);
				inputWatchdog = null;
			}
		}
	});

	pi.on("turn_start", (event: any) => {
		if (sse && ourTurnActive) {
			writeSse({ type: "turn_start", turnIndex: event.turnIndex });
		}
	});

	pi.on("turn_end", (event: any) => {
		if (sse && ourTurnActive) {
			writeSse({ type: "turn_end", turnIndex: event.turnIndex });
		}
	});

	pi.on("message_update", (event: any) => {
		if (!sse || !ourTurnActive) return;
		const ae = event.assistantMessageEvent;
		if (!ae) return;

		const forwardTypes = [
			"text_start", "text_delta", "text_end",
			"thinking_start", "thinking_delta", "thinking_end",
			"toolcall_start", "toolcall_delta", "toolcall_end",
		];
		if (forwardTypes.includes(ae.type)) {
			writeSse(ae);
		}
	});

	pi.on("tool_execution_start", (event: any) => {
		if (sse && ourTurnActive) {
			writeSse({
				type: "tool_execution_start",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
			});
		}
	});

	pi.on("tool_execution_update", (event: any) => {
		if (sse && ourTurnActive) {
			writeSse({
				type: "tool_execution_update",
				toolCallId: event.toolCallId,
				partialResult: event.partialResult,
			});
		}
	});

	pi.on("tool_execution_end", (event: any) => {
		if (sse && ourTurnActive) {
			writeSse({
				type: "tool_execution_end",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				isError: event.isError,
				result: event.result,
			});
		}
	});

	pi.on("session_info_changed", (event: any) => {
		sessionName = event.name;
		writeDiscovery();
	});

	// ── SSE helpers ───────────────────────────────────────────────────

	function writeSseSafe(res: any, data: any): void {
		try {
			res.write(`data: ${JSON.stringify(data)}\n\n`);
		} catch (err) {
			console.error("[http-bridge] writeSseSafe failed:", err);
		}
	}

	function writeSse(data: any): void {
		if (!sse) return;
		try {
			sse.res.write(`data: ${JSON.stringify(data)}\n\n`);
		} catch (err) {
			console.error("[http-bridge] writeSse failed, closing stream:", err);
			closeSse();
		}
	}

	function closeSse(): void {
		if (!sse) return;
		clearInterval(sse.heartbeat);
		clearTimeout(sse.timeout);
		try {
			sse.res.end();
		} catch (err) {
			console.error("[http-bridge] closeSse res.end failed:", err);
		}
		sse = null;
	}

	function sendSseError(message: string): void {
		if (sse) {
			writeSse({ type: "error", message });
			closeSse();
		}
	}

	// ── Skill / template expansion ─────────────────────────────────────

	function expandSkillCommand(text: string): string {
		const { isSkill, skillName, args } = helpers.parseSkillCommand(text);
		if (!isSkill) return text;

		const commands = pi.getCommands();
		const skill = commands.find((cmd) => cmd.name === `skill:${skillName}`);
		if (!skill) return text;

		const filePath = skill.sourceInfo?.path;
		if (!filePath) return text;

		try {
			const content = readFileSync(filePath, "utf-8");
			const body = helpers.stripFrontmatter(content).trim();
			const baseDir = dirname(filePath);
			const skillBlock = `<skill name="${skillName}" location="${filePath}">\nReferences are relative to ${baseDir}.\n\n${body}\n</skill>`;
			return args ? `${skillBlock}\n\n${args}` : skillBlock;
		} catch {
			return text;
		}
	}

	function expandPromptTemplate(text: string): string {
		const { isTemplate, templateName, args } = helpers.parsePromptTemplate(text);
		if (!isTemplate) return text;

		const commands = pi.getCommands();
		const template = commands.find((cmd) => cmd.source === "prompt" && cmd.name === templateName);
		if (!template) return text;

		const filePath = template.sourceInfo?.path;
		if (!filePath) return text;

		try {
			const content = readFileSync(filePath, "utf-8");
			const body = helpers.stripFrontmatter(content).trim();
			return args ? `${body}\n\n${args}` : body;
		} catch {
			return text;
		}
	}

	function expandInput(text: string): string {
		let expanded = expandSkillCommand(text);
		if (expanded === text) {
			expanded = expandPromptTemplate(text);
		}
		return expanded;
	}

	// ── General helpers ───────────────────────────────────────────────

	function writeDiscovery() {
		if (!discoveryFile || !sessionId) return;
		const lanIp = getLanIp();
		try {
			writeFileSync(
				discoveryFile,
				JSON.stringify(
					{
						port: actualPort,
						host: HOST,
						lanIp,
						url: lanIp ? `http://${lanIp}:${actualPort}` : `http://localhost:${actualPort}`,
						sessionFile,
						sessionId,
						sessionName,
						pid: process.pid,
						startedAt: Date.now(),
					},
					null,
					2,
				),
			);
		} catch {
			// Best effort
		}
	}

	function isPidAlive(pid: number): boolean {
		try {
			process.kill(pid, 0);
			return true;
		} catch {
			return false;
		}
	}

	function getLanIp(): string | null {
		try {
			const nets = networkInterfaces();
			for (const name of Object.keys(nets)) {
				const net = nets[name];
				if (!net) continue;
				for (const addr of net) {
					if (addr.family === "IPv4" && !addr.internal) {
						return addr.address;
					}
				}
			}
		} catch {
			// ignore
		}
		return null;
	}

	function cleanupStaleDiscoveryFiles() {
		try {
			const files = readdirSync(BRIDGE_DIR);
			for (const f of files) {
				if (!f.endsWith(".json")) continue;
				const fullPath = join(BRIDGE_DIR, f);
				try {
					const content = JSON.parse(readFileSync(fullPath, "utf-8"));
					if (content.pid && !isPidAlive(content.pid)) {
						unlinkSync(fullPath);
					}
				} catch {
					// Skip
				}
			}
		} catch {
			// Dir doesn't exist
		}
	}

	function findFreePort(start: number, host: string): Promise<number> {
		return new Promise((resolve, reject) => {
			function tryPort(port: number): void {
				if (port > start + 1000) {
					reject(new Error(`No free port in range ${start}-${start + 1000}`));
					return;
				}
				const tester = createNetServer();
				tester.once("error", (err: any) => {
					if (err.code === "EADDRINUSE") tryPort(port + 1);
					else reject(err);
				});
				tester.once("listening", () => tester.close(() => resolve(port)));
				tester.listen(port, host);
			}
			tryPort(start);
		});
	}

	function waitForIdle(timeoutMs: number): Promise<void> {
		if (!isBusy) return Promise.resolve();
		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				idleWaiters = idleWaiters.filter((w) => w.resolve !== resolve);
				reject(new Error("Timeout waiting for agent to become idle"));
			}, timeoutMs);
			idleWaiters.push({ resolve, timeout });
		});
	}

	async function readSessionHistory(filePath: string | undefined, limit: number = 0, offset: number = 0): Promise<{ history: any[]; total: number }> {
		if (!filePath || !existsSync(filePath)) return { history: [], total: 0 };
		const data = await readFile(filePath, "utf-8");
		const allHistory = helpers.parseHistoryData(data);
		return helpers.paginateHistory(allHistory, limit, offset);
	}

	function listAllSessions(): any[] {
		const sessions: any[] = [];
		try {
			const files = readdirSync(BRIDGE_DIR);
			for (const f of files) {
				if (!f.endsWith(".json")) continue;
				try {
					const content = JSON.parse(readFileSync(join(BRIDGE_DIR, f), "utf-8"));
					if (content.pid && isPidAlive(content.pid)) sessions.push(content);
				} catch {
					// Skip
				}
			}
		} catch {
			// Dir doesn't exist
		}
		// Deduplicate by sessionFile — multiple processes may share the same
		// session file (e.g. after multiple reloads). Keep the newest by startedAt.
		const bySessionFile = new Map<string, any>();
		const allFiles = new Set<string>();
		for (const s of sessions) {
			const key = s.sessionFile ?? s.sessionId;
			allFiles.add(key);
			const existing = bySessionFile.get(key);
			if (!existing || (s.startedAt ?? 0) > (existing.startedAt ?? 0)) {
				bySessionFile.set(key, s);
			}
		}
		// Clean up stale discovery files for sessions that lost the dedup
		const winnerPids = new Set(Array.from(bySessionFile.values()).map((s) => s.pid));
		for (const s of sessions) {
			if (!winnerPids.has(s.pid)) {
				try { unlinkSync(join(BRIDGE_DIR, `${s.sessionId}.json`)); } catch {}
			}
		}
		return Array.from(bySessionFile.values()).sort((a, b) => a.port - b.port);
	}

	function computeUsageStats(): { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; cacheHitRate: number | null; totalCost: number } {
		try {
			const entries = sessionCtx?.sessionManager?.getEntries();
			return helpers.computeUsageStats(entries);
		} catch {
			return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cacheHitRate: null, totalCost: 0 };
		}
	}

	function computeContextUsage(): { tokens: number | null; contextWindow: number; percent: number | null } {
		try {
			const ctx = sessionCtx?.getContextUsage?.();
			if (ctx) return { tokens: ctx.tokens, contextWindow: ctx.contextWindow, percent: ctx.percent };
		} catch {
			// Best effort
		}
		return { tokens: null, contextWindow: 0, percent: null };
	}

	// ── Static file serving ───────────────────────────────────────────

	async function serveStatic(path: string, c: any): Promise<Response> {
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
				headers: {
					"Content-Type": mime,
					"Cache-Control": "no-cache",
				},
			});
		} catch {
			return c.text("Internal server error", 500);
		}
	}

	// ── Send message (shared logic) ───────────────────────────────────

	async function sendAndWait(
		message: string,
		timeoutMs: number,
	): Promise<any[]> {
		await waitForIdle(30000);

		let watchdogReject: ((e: Error) => void) | null = null;
		const responsePromise = new Promise<any[]>((resolve, reject) => {
			watchdogReject = reject;
			pending = {
				resolve,
				reject,
				timeout: setTimeout(() => {
					pending = null;
					waitingForExtensionInput = false;
					ourTurnActive = false;
					try { sessionCtx?.abort(); } catch {}
					reject(new Error("Agent response timeout"));
				}, timeoutMs),
			};
		});

		const expanded = expandInput(message);
		waitingForExtensionInput = true;
		inputWatchdog = setTimeout(() => {
			if (waitingForExtensionInput) {
				waitingForExtensionInput = false;
				ourTurnActive = false;
				if (pending) { clearTimeout(pending.timeout); pending = null; }
				if (watchdogReject) watchdogReject(new Error("Agent did not start processing the message (input event not received)"));
			}
		}, 10000);

		try {
			pi.sendUserMessage(expanded);
		} catch (err) {
			if (inputWatchdog) { clearTimeout(inputWatchdog); inputWatchdog = null; }
			waitingForExtensionInput = false;
			pending = null;
			throw err;
		}

		return responsePromise;
	}

	async function sendAndStream(
		message: string,
		timeoutMs: number,
		res: any,
	): Promise<void> {
		try {
			await waitForIdle(30000);
		} catch (err: any) {
			writeSseSafe(res, { type: "error", message: err?.message || "Timeout waiting for agent to become idle" });
			res.end();
			return;
		}

		const heartbeat = setInterval(() => {
			if (sse) {
				try {
					sse.res.write(": heartbeat\n\n");
				} catch (err) {
					console.error("[http-bridge] heartbeat write failed:", err);
					closeSse();
				}
			}
		}, 15000);

		const timeout = setTimeout(() => {
			console.error("[http-bridge] SSE response timeout, aborting agent");
			try { sessionCtx?.abort(); } catch {}
			sendSseError("Agent response timeout");
		}, timeoutMs);

		sse = { res, heartbeat, timeout };

		const expanded = expandInput(message);
		waitingForExtensionInput = true;

		inputWatchdog = setTimeout(() => {
			if (waitingForExtensionInput) {
				console.error("[http-bridge] input watchdog: agent did not start processing message");
				waitingForExtensionInput = false;
				ourTurnActive = false;
				sendSseError("Agent did not start processing the message (input event not received)");
			}
		}, 10000);

		try {
			pi.sendUserMessage(expanded);
		} catch (err) {
			if (inputWatchdog) { clearTimeout(inputWatchdog); inputWatchdog = null; }
			waitingForExtensionInput = false;
			sendSseError(err instanceof Error ? err.message : String(err));
		}
	}

	// ── HTTP server ───────────────────────────────────────────────────

	pi.on("session_start", async (event: any, ctx: any) => {
		sessionCtx = ctx;
		sessionFile = ctx.sessionManager?.getSessionFile() ?? undefined;
		sessionId = event.sessionId ?? ctx.sessionManager?.getSessionId();
		sessionName = ctx.sessionManager?.getSessionName() ?? undefined;

		try {
			mkdirSync(BRIDGE_DIR, { recursive: true });
		} catch {
			// Best effort
		}
		cleanupStaleDiscoveryFiles();

		try {
			actualPort = await findFreePort(BASE_PORT, HOST);
		} catch (err) {
			if (ctx.hasUI) {
				ctx.ui.notify(`HTTP bridge: failed to find free port — ${err}`, "error");
			}
			return;
		}

		if (sessionId) {
			discoveryFile = join(BRIDGE_DIR, `${sessionId}.json`);
		}

		server = createServer(async (req, res) => {
			// Bridge Node's IncomingMessage to Hono's Request
			const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
			const method = req.method || "GET";
			const headers = new Headers();
			for (const [key, val] of Object.entries(req.headers)) {
				if (val) headers.set(key, Array.isArray(val) ? val.join(", ") : val);
			}
			// Read body into buffer for POST requests
			let body: string | undefined;
			if (method !== "GET" && method !== "HEAD") {
				let chunks = "";
				for await (const chunk of req) chunks += chunk;
				body = chunks;
			}
			const request = new Request(url, { method, headers, body });

			try {
				const response = await app.fetch(request);
				// Copy response back to Node res
				res.writeHead(response.status, Object.fromEntries(response.headers));
				if (response.body) {
					const reader = response.body.getReader();
					while (true) {
						const { done, value } = await reader.read();
						if (done) break;
						res.write(value);
					}
				}
				res.end();
			} catch (err: any) {
				console.error("[http-bridge] request handler error:", err);
				if (!res.headersSent) {
					res.writeHead(500, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ error: err.message }));
				}
			}
		});

		server.on("error", (err: any) => {
			if (err.code === "EADDRINUSE") {
				actualPort++;
				server?.listen(actualPort, HOST);
			} else if (ctx.hasUI) {
				ctx.ui.notify(`HTTP bridge error: ${err}`, "error");
			}
		});

		server.listen(actualPort, HOST, () => {
			writeDiscovery();
			if (ctx.hasUI) {
				const lanIp = getLanIp();
				const displayHost = lanIp || HOST;
				ctx.ui.notify(
					`HTTP bridge: http://${displayHost}:${actualPort} (session: ${sessionId ?? "?"})`,
					"info",
				);
			}
		});
	});

	pi.on("session_shutdown", () => {
		server?.close();
		server = null;

		if (pending) {
			clearTimeout(pending.timeout);
			pending.reject(new Error("Session shutting down"));
			pending = null;
		}

		if (sse) {
			sendSseError("Session shutting down");
		}

		waitingForExtensionInput = false;
		ourTurnActive = false;
		if (inputWatchdog) { clearTimeout(inputWatchdog); inputWatchdog = null; }

		const waiters = idleWaiters;
		idleWaiters = [];
		for (const w of waiters) {
			clearTimeout(w.timeout);
			w.resolve();
		}

		if (discoveryFile && existsSync(discoveryFile)) {
			try {
				unlinkSync(discoveryFile);
			} catch {
				// Best effort
			}
		}
	});
}
