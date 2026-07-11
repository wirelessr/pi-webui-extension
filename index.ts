/**
 * HTTP Bridge Extension (multi-session safe, with WebUI + SSE streaming)
 *
 * Uses Hono + zod-openapi for route definitions with auto-generated OpenAPI spec.
 * Swagger UI available at /api/docs.
 *
 * Route logic lives in bridge-app.js (testable via app.fetch).
 * This file wires real pi APIs + side effects into the app.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { createServer as createNetServer } from "node:net";
import { networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBridgeApp } from "./bridge-app.js";
import * as helpers from "./http-bridge-web/helpers.js";
import { buildReloadCommand, buildSpawnCommand, dedupSessions } from "./session-helpers.js";

const EXT_DIR = dirname(fileURLToPath(import.meta.url));

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

	// ── Deps for createBridgeApp ─────────────────────────────────────

	const deps = {
		getActualPort: () => actualPort,
		getPid: () => process.pid,
		getStartedAt: () => sessionStartTime,
		getIsBusy: () => isBusy,
		getSessionFile: () => sessionFile,
		getSessionId: () => sessionId,
		getSessionName: () => sessionName,
		getSessionCtx: () => sessionCtx,
		getCommands: () => pi.getCommands(),
		setSessionName: (name: string) => pi.setSessionName(name),
		builtinCommands,
		listAllSessions,
		spawnNewSession,
		killSession,
		readSessionHistory,
		expandInput,
		computeUsageStats,
		computeContextUsage,
		sendAndWait,
		sendAndStream,
		isPendingOrSse: () => !!(pending || sse),
		reload: doReload,
	};

	const app = createBridgeApp(deps);

	// ── Session spawn helper ─────────────────────────────────────────

	function bridgeLogPath(): string {
		return join(BRIDGE_DIR, "bridge.log");
	}

	function spawnNewSession(cwd?: string): { pid: number } {
		const cmd = buildSpawnCommand({ logFile: bridgeLogPath() });
		const child = spawn("sh", ["-c", cmd], {
			cwd: cwd || process.cwd(),
			detached: true,
			stdio: "ignore",
		});
		child.unref();
		if (!child.pid) throw new Error("Failed to spawn new session");
		return { pid: child.pid };
	}

	function killSession(pid: number): boolean {
		try {
			console.error(`[http-bridge] killSession: pid=${pid}`);
			try {
				process.kill(-pid, "SIGTERM");
				console.error(`[http-bridge] killSession: killed process group -${pid}`);
			} catch (err: any) {
				console.error(`[http-bridge] killSession: group kill failed (${err.message}), trying direct kill`);
				process.kill(pid, "SIGTERM");
			}
			return true;
		} catch (err: any) {
			console.error(`[http-bridge] killSession: failed: ${err.message}`);
			return false;
		}
	}

	function doReload() {
		const sessionPath = sessionFile;
		if (!sessionPath) return;
		const logFile = bridgeLogPath();
		const cmd = buildReloadCommand({ port: actualPort, sessionPath, name: sessionName, logFile });
		spawn("sh", ["-c", cmd], {
			detached: true,
			stdio: "ignore",
		});
		// Delete discovery file on exit (after spawn), not before.
		// If spawn fails, the old process is still alive with its discovery file intact,
		// preventing orphan sessions with no discovery file.
		const oldDiscoveryFile = discoveryFile;
		console.error(`[http-bridge] reload: pi pid=${process.pid} ppid=${process.ppid} pgid=${process.ppid}`);
		const oldShPid = process.ppid;
		process.on("exit", () => {
			if (oldDiscoveryFile) {
				try { unlinkSync(oldDiscoveryFile); } catch {}
			}
			console.error(`[http-bridge] reload exit: killing process group -${oldShPid}`);
			if (oldShPid) {
				try { process.kill(-oldShPid, "SIGTERM"); } catch (err: any) {
					console.error(`[http-bridge] reload exit: kill failed: ${err.message}`);
				}
			}
		});
		setTimeout(() => process.exit(0), 100);
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
		console.error(`[http-bridge] writeDiscovery: pid=${process.pid} ppid=${process.ppid} → storing pid=${process.ppid || process.pid}`);
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
						pid: process.ppid || process.pid,
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
		return dedupSessions({
			sessions,
			unlinkFn: (name) => { try { unlinkSync(join(BRIDGE_DIR, name)); } catch {} },
			killGroupFn: (pid) => { try { process.kill(-pid, "SIGTERM"); return true; } catch { return false; } },
			killFn: (pid) => { try { process.kill(pid, "SIGTERM"); } catch {} },
			logFn: (msg) => console.error(`[http-bridge] listAllSessions: ${msg}`),
		});
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
			let body: string | undefined;
			if (method !== "GET" && method !== "HEAD") {
				let chunks = "";
				for await (const chunk of req) chunks += chunk;
				body = chunks;
			}
			const request = new Request(url, { method, headers, body });

			try {
				const response = await app.fetch(request);
				res.writeHead(response.status, Object.fromEntries(response.headers));
				if (response.body) {
					const reader = response.body.getReader();
					let clientClosed = false;
					res.on("close", () => {
						if (!res.writableEnded) {
							clientClosed = true;
							console.error("[http-bridge] client disconnected during stream");
							reader.cancel().catch(() => {});
							if (sse) {
								console.error("[http-bridge] closing SSE state after client disconnect");
								closeSse();
							}
						}
					});
					while (true) {
						const { done, value } = await reader.read();
						if (done || clientClosed) break;
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
