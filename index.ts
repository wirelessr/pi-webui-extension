/**
 * HTTP Bridge Extension (multi-session safe, with WebUI + SSE streaming)
 *
 * Starts an HTTP server that lets external scripts send messages to the agent
 * and receive responses as HTTP responses. Also serves a WebUI and supports
 * SSE streaming for real-time response display.
 *
 * Multi-session support:
 *   Each pi session is a separate process with its own extension instance.
 *   There is no singleton. Instead, this extension auto-allocates a port
 *   (starting from PI_HTTP_PORT, default 7331) and writes a discovery file
 *   per session to a shared directory (default: <extension-dir>/data).
 *
 * Usage:
 *   # WebUI — open in browser
 *   open http://localhost:7331
 *
 *   # Plain text (curl)
 *   curl -X POST http://localhost:7331/api/prompt -d 'Run the tests'
 *
 *   # JSON body with options
 *   curl -X POST http://localhost:7331/api/prompt \
 *     -H 'Content-Type: application/json' \
 *     -d '{"message":"Summarize /tmp/report.csv","full":true}'
 *
 *   # SSE streaming (curl)
 *   curl -N -H 'Accept: text/event-stream' \
 *     -X POST http://localhost:7331/api/prompt -d 'What is 2+2?'
 *
 *   # Health check / status
 *   curl http://localhost:7331/api/status
 *
 *   # List all active sessions
 *   curl http://localhost:7331/api/sessions
 *
 * API routes:
 *   GET  /                  → WebUI (index.html)
 *   GET  /<static-file>     → Static files from http-bridge-web/
 *   GET  /api/status        → This session's status (JSON)
 *   GET  /api/sessions      → All active sessions (JSON)
 *   POST /api/prompt        → Send message to agent
 *       Accept: text/event-stream → SSE streaming response
 *       Otherwise                  → JSON response
 *
 * SSE event format:
 *   data: {"type":"agent_start"}
 *   data: {"type":"turn_start","turnIndex":0}
 *   data: {"type":"text_delta","delta":"Hello"}
 *   data: {"type":"tool_execution_start","toolName":"bash","args":{...}}
 *   data: {"type":"tool_execution_end","toolName":"bash","result":{...}}
 *   data: {"type":"turn_end","turnIndex":0}
 *   data: {"type":"done","text":"...","toolCalls":[...],"messages":[...]}
 *   data: {"type":"error","message":"..."}
 *
 * Discovery:
 *   <extension-dir>/data/<session-id>.json
 *   { port, host, sessionFile, sessionId, sessionName, pid, startedAt, webui }
 *
 * Hot reload:
 *   - Web UI files: just refresh the browser (served with no-cache)
 *   - Extension logic: type /reload in the TUI (preserves conversation,
 *     restarts HTTP server)
 *
 * Configuration (env vars):
 *   PI_HTTP_PORT   - Starting port for auto-allocation (default: 7331)
 *   PI_HTTP_HOST   - Bind address (default: 0.0.0.0 = all interfaces)
 *   PI_BRIDGE_DIR  - Discovery file directory (default: <extension-dir>/data)
 *
 * Security note:
 *   Binding to 0.0.0.0 exposes the bridge to anyone on your network.
 *   There is no authentication. Anyone who can reach the port can send
 *   messages to your agent and read responses. For local-only use, set
 *   PI_HTTP_HOST=127.0.0.1. For remote use, ensure you trust your
 *   network (e.g. home WiFi, not public WiFi).
 *
 * Skill / template expansion:
 *   sendUserMessage() bypasses pi's internal skill/template expansion
 *   (expandPromptTemplates: false). This extension manually expands
 *   /skill:name and /template commands before sending, replicating
 *   pi's _expandSkillCommand logic. Extension commands (/cmd) are not
 *   supported via HTTP — use the TUI for those.
 *
 *   GET /api/commands — list available skills, prompt templates, and built-in commands
 *
 * Limitations:
 *   - One request at a time per session; concurrent requests get HTTP 409.
 *   - Don't type in the TUI while a request is in flight.
 *   - Extension commands (/cmd) are not supported via HTTP.
 *   - Default response timeout is 5 minutes. Override with {"timeout": ms}.
 */

import { createServer } from "node:http";
import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, extname, normalize, dirname, basename } from "node:path";
import { networkInterfaces } from "node:os";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

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

	// Built-in commands loaded from pi's internal module (not public API, but
	// avoids hardcoding the list — stays in sync with pi updates)
	let builtinCommands: { name: string; description: string }[] = [];
	try {
		// Resolve from pi's main entry point to find internal submodules
		const piEntryUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
		const { createRequire } = require("node:module");
		const piRequire = createRequire(piEntryUrl);
		const slashMod = piRequire("./core/slash-commands.js");
		if (slashMod?.BUILTIN_SLASH_COMMANDS) {
			builtinCommands = slashMod.BUILTIN_SLASH_COMMANDS as { name: string; description: string }[];
		}
	} catch {
		// Fallback: no builtins if module path changes in future pi versions
	}

	// Commands that can be triggered from WebUI via /api/command
	const WEBUI_EXECUTABLE = new Set(["compact", "reload"]);

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
				// Streaming: send done event and close
				writeSse({
					type: "done",
					text: extractText(messages),
					toolCalls: extractToolCalls(messages),
					thinking: extractThinking(messages),
					messageCount: messages.length,
					messages,
				});
				closeSse();
				return;
			}

			if (pending) {
				// Non-streaming: resolve promise
				const p = pending;
				pending = null;
				clearTimeout(p.timeout);
				p.resolve(messages);
				return;
			}
		}

		ourTurnActive = false;

		// Notify idle waiters
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

		// Forward relevant streaming event types
		const forwardTypes = [
			"text_start", "text_delta", "text_end",
			"thinking_start", "thinking_delta", "thinking_end",
			"toolcall_start", "toolcall_delta", "toolcall_end",
			"done", "error",
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

	pi.on("tool_execution_end", (event: any) => {
		if (sse && ourTurnActive) {
			writeSse({
				type: "tool_execution_end",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				isError: event.isError,
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
		} catch {
			// Connection might be closed
		}
	}

	function writeSse(data: any): void {
		if (!sse) return;
		try {
			sse.res.write(`data: ${JSON.stringify(data)}\n\n`);
		} catch {
			// Connection might be closed
		}
	}

	function closeSse(): void {
		if (!sse) return;
		clearInterval(sse.heartbeat);
		clearTimeout(sse.timeout);
		try {
			sse.res.end();
		} catch {
			// Already closed
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

	/**
	 * pi.sendUserMessage() bypasses skill/template expansion (expandPromptTemplates: false).
	 * This replicates pi's _expandSkillCommand + expandPromptTemplate logic so that
	 * /skill:name and /template commands work via HTTP.
	 */
	function stripFrontmatter(content: string): string {
		const fmMatch = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/);
		return fmMatch ? content.slice(fmMatch[0].length) : content;
	}

	function expandSkillCommand(text: string): string {
		if (!text.startsWith("/skill:")) return text;
		const spaceIndex = text.indexOf(" ");
		const skillName = spaceIndex === -1 ? text.slice(7) : text.slice(7, spaceIndex);
		const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1).trim();

		const commands = pi.getCommands();
		const skill = commands.find((c) => c.name === `skill:${skillName}`);
		if (!skill) return text;

		const filePath = skill.sourceInfo?.path;
		if (!filePath) return text;

		try {
			const content = readFileSync(filePath, "utf-8");
			const body = stripFrontmatter(content).trim();
			const baseDir = dirname(filePath);
			const skillBlock = `<skill name="${skillName}" location="${filePath}">\nReferences are relative to ${baseDir}.\n\n${body}\n</skill>`;
			return args ? `${skillBlock}\n\n${args}` : skillBlock;
		} catch {
			return text;
		}
	}

	function expandPromptTemplate(text: string): string {
		if (!text.startsWith("/")) return text;
		const spaceIndex = text.indexOf(" ");
		const templateName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1).trim();

		const commands = pi.getCommands();
		const template = commands.find((c) => c.source === "prompt" && c.name === templateName);
		if (!template) return text;

		const filePath = template.sourceInfo?.path;
		if (!filePath) return text;

		try {
			const content = readFileSync(filePath, "utf-8");
			const body = stripFrontmatter(content).trim();
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

	/**
	 * Detect the primary LAN IP for display purposes.
	 * Returns the first non-internal IPv4 address, or null.
	 */
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
			const net = require("node:net");
			function tryPort(port: number): void {
				if (port > start + 1000) {
					reject(new Error(`No free port in range ${start}-${start + 1000}`));
					return;
				}
				const tester = net.createServer();
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

	function extractText(messages: any[]): string {
		const texts: string[] = [];
		for (const msg of messages) {
			if (msg.role !== "assistant") continue;
			const blocks = Array.isArray(msg.content) ? msg.content : [];
			for (const block of blocks) {
				if (block?.type === "text") texts.push(block.text);
			}
		}
		return texts.join("\n\n");
	}

	function extractToolCalls(messages: any[]): string[] {
		const calls: string[] = [];
		for (const msg of messages) {
			if (msg.role !== "assistant") continue;
			const blocks = Array.isArray(msg.content) ? msg.content : [];
			for (const block of blocks) {
				if (block?.type === "toolCall") {
					calls.push(`${block.name}(${JSON.stringify(block.arguments).slice(0, 200)})`);
				}
			}
		}
		return calls;
	}

	function extractThinking(messages: any[]): string {
		const parts: string[] = [];
		for (const msg of messages) {
			if (msg.role !== "assistant") continue;
			const blocks = Array.isArray(msg.content) ? msg.content : [];
			for (const block of blocks) {
				if (block?.type === "thinking") parts.push(block.thinking);
			}
		}
		return parts.join("\n\n");
	}

	/**
	 * Read the session JSONL file and extract message history.
	 * Returns an array of { role, content, toolCalls, thinking } entries.
	 */
	async function readSessionHistory(filePath: string | undefined, limit: number = 0, offset: number = 0): Promise<{ history: any[]; total: number }> {
		if (!filePath || !existsSync(filePath)) return { history: [], total: 0 };
		const data = await readFile(filePath, "utf-8");
		const allHistory: any[] = [];
		for (const line of data.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			let obj: any;
			try {
				obj = JSON.parse(trimmed);
			} catch {
				continue;
			}
			if (obj.type !== "message") continue;
			const msg = obj.message;
			if (!msg) continue;
			const role = msg.role;
			const content = msg.content;

			// Skip system messages
			if (role === "system") continue;

			const entry: any = {
				id: obj.id,
				timestamp: obj.timestamp,
				role,
			};

			if (typeof content === "string") {
				entry.text = content;
			} else if (Array.isArray(content)) {
				const texts: string[] = [];
				const toolCalls: any[] = [];
				const thinking: string[] = [];
				for (const part of content) {
					if (part.type === "text" && part.text) {
						texts.push(part.text);
					} else if (part.type === "thinking" && part.thinking) {
						thinking.push(part.thinking);
					} else if (part.type === "toolCall") {
						toolCalls.push({
							id: part.id,
							name: part.name,
							arguments: part.arguments,
						});
					}
				}
				if (texts.length) entry.text = texts.join("");
				if (thinking.length) entry.thinking = thinking.join("");
				if (toolCalls.length) entry.toolCalls = toolCalls;
			}

			// For toolResult messages, extract the result text
			if (role === "toolResult") {
				entry.toolCallId = msg.toolCallId;
				entry.toolName = msg.toolName;
				entry.isError = msg.isError;
				if (Array.isArray(content)) {
					entry.text = content.map((c: any) => c.text || "").join("");
				} else if (typeof content === "string") {
					entry.text = content;
				}
			}

			// Skip entries with no useful content
			if (!entry.text && !entry.toolCalls && !entry.thinking) continue;

			allHistory.push(entry);
		}
		const total = allHistory.length;
		if (limit > 0) {
			// offset counts from the tail: offset=0 → last `limit` items,
			// offset=50 → items[-(limit+50):-50]
			const start = Math.max(0, total - offset - limit);
			const end = Math.max(0, total - offset);
			return { history: allHistory.slice(start, end), total };
		}
		return { history: allHistory, total };
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
		return sessions.sort((a, b) => a.port - b.port);
	}

	// ── Static file serving ───────────────────────────────────────────

	async function serveStatic(path: string, res: any): Promise<boolean> {
		// Normalize and prevent path traversal
		const safePath = normalize(path).replace(/^(\.\.[/\\])+/, "");
		const filePath = join(WEB_DIR, safePath);

		// Ensure the resolved path is still within WEB_DIR
		if (!filePath.startsWith(WEB_DIR)) {
			res.writeHead(403, { "Content-Type": "text/plain" });
			res.end("Forbidden");
			return true;
		}

		if (!existsSync(filePath)) {
			res.writeHead(404, { "Content-Type": "text/plain" });
			res.end("Not found");
			return true;
		}

		try {
			const data = await readFile(filePath);
			const ext = extname(filePath).toLowerCase();
			const mime = MIME_TYPES[ext] || "application/octet-stream";
			res.writeHead(200, {
				"Content-Type": mime,
				"Cache-Control": "no-cache",
			});
			res.end(data);
		} catch {
			res.writeHead(500, { "Content-Type": "text/plain" });
			res.end("Internal server error");
		}
		return true;
	}

	// ── Prompt parsing ────────────────────────────────────────────────

	function parsePromptBody(
		body: string,
		contentType: string,
	): { message: string; timeoutMs: number; includeFull: boolean; stream: boolean } | { error: string } {
		let message: string;
		let timeoutMs = 300000;
		let includeFull = false;
		let stream = false;

		if (contentType.includes("application/json") || body.startsWith("{")) {
			try {
				const parsed = JSON.parse(body);
				message = parsed.message;
				if (typeof parsed.timeout === "number") timeoutMs = parsed.timeout;
				if (parsed.full === true) includeFull = true;
				if (parsed.stream === true) stream = true;
				if (!message || typeof message !== "string") {
					return { error: "Missing or invalid 'message' field" };
				}
			} catch {
				return { error: "Invalid JSON body" };
			}
		} else {
			message = body;
		}

		return { message, timeoutMs, includeFull, stream };
	}

	// ── Send message (shared logic) ───────────────────────────────────

	async function sendAndWait(
		message: string,
		timeoutMs: number,
	): Promise<any[]> {
		await waitForIdle(30000);

		const responsePromise = new Promise<any[]>((resolve, reject) => {
			pending = {
				resolve,
				reject,
				timeout: setTimeout(() => {
					pending = null;
					waitingForExtensionInput = false;
					ourTurnActive = false;
					reject(new Error("Agent response timeout"));
				}, timeoutMs),
			};
		});

		const expanded = expandInput(message);
		waitingForExtensionInput = true;
		try {
			pi.sendUserMessage(expanded);
		} catch (err) {
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

		// Set up SSE state
		const heartbeat = setInterval(() => {
			if (sse) {
				try {
					sse.res.write(": heartbeat\n\n");
				} catch {
					// Connection closed
				}
			}
		}, 15000);

		const timeout = setTimeout(() => {
			sendSseError("Agent response timeout");
		}, timeoutMs);

		sse = { res, heartbeat, timeout };

		// Clean up if client disconnects
		res.on("close", () => {
			if (sse && sse.res === res) {
				clearInterval(sse.heartbeat);
				clearTimeout(sse.timeout);
				sse = null;
			}
		});

		const expanded = expandInput(message);
		waitingForExtensionInput = true;

		// Safety timeout: if input event doesn't fire within 10s, abort
		inputWatchdog = setTimeout(() => {
			if (waitingForExtensionInput) {
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
			const url = (req.url || "/").split("?")[0];
			const method = req.method || "GET";

			// ── API routes ───────────────────────────────────────────
			if (url === "/api/status" && method === "GET") {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({
					status: "ok",
					busy: isBusy,
					sessionFile,
					sessionId,
					sessionName,
					port: actualPort,
				}, null, 2));
				return;
			}

				if (url === "/api/sessions" && method === "GET") {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ sessions: listAllSessions() }, null, 2));
				return;
			}

			if (url === "/api/history" && method === "GET") {
				try {
					const rawUrl = req.url || "/api/history";
					const queryIdx = rawUrl.indexOf("?");
					let limit = 0;
					let offset = 0;
					if (queryIdx !== -1) {
						const params = new URLSearchParams(rawUrl.slice(queryIdx));
						limit = parseInt(params.get("limit") || "0", 10);
						offset = parseInt(params.get("offset") || "0", 10);
					}
					const { history, total } = await readSessionHistory(sessionFile, limit, offset);
					res.writeHead(200, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ history, total }, null, 2));
				} catch (err: any) {
					res.writeHead(500, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ error: err.message }));
				}
				return;
			}

			if (url === "/api/commands" && method === "GET") {
				const commands = pi.getCommands()
					.filter((c) => c.source === "skill" || c.source === "prompt")
					.map((c) => ({
						name: c.name,
						description: c.description,
						source: c.source,
					}));
				const builtins = builtinCommands.map((c) => ({
					name: c.name,
					description: c.description,
					source: "builtin",
					executable: WEBUI_EXECUTABLE.has(c.name),
				}));
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ commands: [...commands, ...builtins] }, null, 2));
				return;
			}

			if (url === "/api/command" && method === "POST") {
				let body = "";
				for await (const chunk of req) body += chunk;
				let parsed: any;
				try { parsed = JSON.parse(body); } catch {
					res.writeHead(400, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ error: "Invalid JSON" }));
					return;
				}
				const cmdName = parsed.command;
				if (!WEBUI_EXECUTABLE.has(cmdName)) {
					res.writeHead(400, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ error: `Command "${cmdName}" is not executable from WebUI` }));
					return;
				}
				try {
					if (cmdName === "compact" && sessionCtx) {
						sessionCtx.compact();
					} else if (cmdName === "reload" && sessionCtx) {
						await sessionCtx.reload();
					} else {
						res.writeHead(400, { "Content-Type": "application/json" });
						res.end(JSON.stringify({ error: `Command "${cmdName}" has no handler` }));
						return;
					}
					res.writeHead(200, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ ok: true }));
				} catch (err: any) {
					res.writeHead(500, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ error: err.message }));
				}
				return;
			}

			if (url === "/api/abort" && method === "POST") {
				try {
					if (sessionCtx) {
						sessionCtx.abort();
						res.writeHead(200, { "Content-Type": "application/json" });
						res.end(JSON.stringify({ ok: true }));
					} else {
						res.writeHead(500, { "Content-Type": "application/json" });
						res.end(JSON.stringify({ error: "No active session context" }));
					}
				} catch (err: any) {
					res.writeHead(500, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ error: err.message }));
				}
				return;
			}

			if (url === "/api/prompt" && method === "POST") {
				// Read body
				let body = "";
				for await (const chunk of req) body += chunk;
				body = body.trim();

				if (!body) {
					res.writeHead(400, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ error: "Empty request body" }));
					return;
				}

				const parsed = parsePromptBody(body, req.headers["content-type"] || "");
				if ("error" in parsed) {
					res.writeHead(400, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ error: parsed.error }));
					return;
				}

				// One request at a time
				if (pending || sse) {
					res.writeHead(409, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ error: "Another request is being processed" }));
					return;
				}

				// Decide SSE vs JSON
				const accept = req.headers["accept"] || "";
				const useSse = parsed.stream || accept.includes("text/event-stream");

				try {
					if (useSse) {
						res.writeHead(200, {
							"Content-Type": "text/event-stream",
							"Cache-Control": "no-cache",
							"Connection": "keep-alive",
							"X-Accel-Buffering": "no",
						});
						res.flushHeaders();
						await sendAndStream(parsed.message, parsed.timeoutMs, res);
					} else {
						const messages = await sendAndWait(parsed.message, parsed.timeoutMs);
						const result: Record<string, any> = {
							text: extractText(messages),
							toolCalls: extractToolCalls(messages),
							thinking: extractThinking(messages),
							messageCount: messages.length,
						};
						if (parsed.includeFull) result.messages = messages;
						res.writeHead(200, { "Content-Type": "application/json" });
						res.end(JSON.stringify(result));
					}
				} catch (err) {
					if (!res.headersSent) {
						res.writeHead(500, { "Content-Type": "application/json" });
						res.end(JSON.stringify({
							error: err instanceof Error ? err.message : String(err),
						}));
					}
				}
				return;
			}

			// ── Static files (WebUI) ─────────────────────────────────
			if (method === "GET") {
				const filePath = url === "/" ? "/index.html" : url;
				await serveStatic(filePath, res);
				return;
			}

			res.writeHead(405, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "Method not allowed" }));
		});

		server.on("error", (err: any) => {
			if (err.code !== "EADDRINUSE" && ctx.hasUI) {
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

		if (discoveryFile && existsSync(discoveryFile)) {
			try {
				unlinkSync(discoveryFile);
			} catch {
				// Best effort
			}
		}
	});
}
