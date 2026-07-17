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
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { createServer as createNetServer } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildOpenSessionCommand, buildSpawnCommand, findSessionCwd } from "@wirelessr/pi-webui-components/session-spawn.js";
import { createBridgeApp } from "./bridge-app.js";
import * as helpers from "./helpers.js";
import { generateSessionName } from "./name-generator.js";
import { buildReloadCommand, dedupSessions, recoverStaleSessions as planRecoverStaleSessions } from "./session-helpers.js";
import { createTurnLifecycle, lastAssistantEndedOnError } from "./turn-lifecycle.js";

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
	origin: "prompt" | "attach";
}

export default function (pi: ExtensionAPI) {
	const BASE_PORT = parseInt(process.env.PI_HTTP_PORT || "7331", 10);
	const HOST = process.env.PI_HTTP_HOST || "0.0.0.0";
	const BRIDGE_DIR = process.env.PI_BRIDGE_DIR || join(EXT_DIR, "data");

	let server: ReturnType<typeof createServer> | null = null;
	let actualPort = BASE_PORT;
	let pending: PendingRequest | null = null;
	let sse: SseState | null = null;

	let waitingForExtensionInput = false;
	let inputWatchdog: ReturnType<typeof setTimeout> | null = null;

	let idleWaiters: IdleWaiter[] = [];
	let pendingDone: any = null;
	// Turn-active/busy tracking, finalize grace scheduling, and the coalescing
	// replay buffer all live in turn-lifecycle.js (pure, unit-tested — the
	// multi-loop/orphaned-turn bugs were here). This file only feeds pi events
	// in and delivers the done event out via onFinalize (below).
	const lifecycle = createTurnLifecycle({
		onFinalize: (event: any, wasActive: boolean) => finalizeTurn(event, wasActive),
	});
	let sessionFile: string | undefined;
	let sessionId: string | undefined;
	let sessionName: string | undefined;
	let discoveryFile: string | undefined;
	let sessionCtx: any = null;
	let sessionStartTime = Date.now();
	let autoNameAttempted = false;

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
	getCwd: () => sessionCtx?.cwd ?? process.cwd(),
		getIsBusy: () => lifecycle.isBusy(),
		getSessionFile: () => sessionFile,
		getSessionId: () => sessionId,
		getSessionName: () => sessionName,
		getSessionCtx: () => sessionCtx,
		getCommands: () => pi.getCommands(),
		setSessionName: (name: string) => pi.setSessionName(name),
		builtinCommands,
		listAllSessions,
		spawnNewSession,
		openSession,
		killSession,
		readSessionHistory,
		expandInput,
		computeUsageStats,
		computeContextUsage,
		sendAndWait,
		sendAndStream,
		compactAndStream,
		attachStream,
		saveUpload,
		isPendingOrSse: () => !!(pending || sse),
		reload: doReload,
		clientLog,
	};

	const app = createBridgeApp(deps);

	// ── Session spawn helper ─────────────────────────────────────────

	function bridgeLogPath(): string {
		return join(BRIDGE_DIR, "bridge.log");
	}

	function serverLog(message: string, data?: any): void {
		const prefix = `${new Date().toISOString()} [${actualPort}] [http-bridge]`;
		const dataStr = data ? ` ${JSON.stringify(data)}` : "";
		const line = `${prefix} ${message}${dataStr}`;
		try {
			appendFileSync(bridgeLogPath(), `${line}\n`);
		} catch {
			console.error(line);
		}
	}

	function clientLog(level: string, message: string, data?: any): void {
		const prefix = `${new Date().toISOString()} [${actualPort}] [client]`;
		const dataStr = data ? ` ${JSON.stringify(data)}` : "";
		const line = `${prefix} [${level}] ${message}${dataStr}`;
		try {
			appendFileSync(bridgeLogPath(), `${line}\n`);
		} catch {
			// Best effort — fall back to stderr if file write fails
			console.error(line);
		}
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

	function openSession(sessionId: string, name?: string, cwd?: string): { pid: number } {
		const resolvedCwd = cwd || findSessionCwd(sessionId);
		const cmd = buildOpenSessionCommand({ sessionId, name, logFile: bridgeLogPath() });
		const child = spawn("sh", ["-c", cmd], {
			cwd: resolvedCwd || process.cwd(),
			detached: true,
			stdio: "ignore",
		});
		child.unref();
		if (!child.pid) throw new Error("Failed to open session");
		return { pid: child.pid };
	}

	// Find the discovery file matching a piPid (from /api/status) or pid
	// (shell ppid), mark it intentionalClose, and return the shell pid
	// stored in that file so the caller can kill the correct process group.
	function markDiscoveryForClose(targetPid: number): number | undefined {
		try {
			const files = readdirSync(BRIDGE_DIR);
			for (const f of files) {
				if (!f.endsWith(".json")) continue;
				const fullPath = join(BRIDGE_DIR, f);
				try {
					const content = JSON.parse(readFileSync(fullPath, "utf-8"));
					// Match by piPid (process.pid from /api/status) or pid (shell ppid)
					if (content.piPid === targetPid || content.pid === targetPid) {
						content.intentionalClose = true;
						writeFileSync(fullPath, JSON.stringify(content, null, 2));
						serverLog(`killSession: marked ${f} as intentionalClose`);
						// content.pid is the shell ppid = process group leader.
						// Fall back to piPid only if shell pid missing.
						return content.pid ?? content.piPid;
					}
				} catch {
					// Skip
				}
			}
		} catch {
			// Dir doesn't exist
		}
		return undefined;
	}

	function killSession(piPid: number): boolean {
		try {
			serverLog(`killSession: piPid=${piPid}`);
			// piPid (from /api/status = process.pid) is the pi process, NOT the
			// process group leader. The group leader is the shell whose pid is
				// stored as content.pid in the discovery file. Killing -piPid hits a
				// non-existent group, falls back to direct kill, and orphans the shell
				// (which keeps the discovery file looking alive). Resolve the shell pid
				// via the discovery file and kill THAT group.
			const shellPid = markDiscoveryForClose(piPid);
			const groupPid = shellPid ?? piPid;
			// Kill the shell's process group to clean up the shell + children.
			// But pi may have setsid'd into its own group (e.g. when launched
			// directly rather than via the hub's sh -c wrapper), so the group
			// kill can succeed without reaching pi. Always send SIGTERM to piPid
			// directly as well — group kill cleans up the shell, direct kill
			// guarantees pi dies.
			try {
				process.kill(-groupPid, "SIGTERM");
				serverLog(`killSession: killed process group -${groupPid}`);
			} catch (err: any) {
				serverLog(`killSession: group kill failed (${err.message})`);
			}
			try {
				process.kill(piPid, "SIGTERM");
				serverLog(`killSession: sent SIGTERM to piPid=${piPid}`);
			} catch (err: any) {
				serverLog(`killSession: direct kill failed (${err.message})`);
			}
			return true;
		} catch (err: any) {
			serverLog(`killSession: failed: ${err.message}`);
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
		serverLog(`reload: pi pid=${process.pid} ppid=${process.ppid} pgid=${process.ppid}`);
		const oldShPid = process.ppid;
		process.on("exit", () => {
			if (oldDiscoveryFile) {
				try { unlinkSync(oldDiscoveryFile); } catch {}
			}
			serverLog(`reload exit: killing process group -${oldShPid}`);
			if (oldShPid) {
				try { process.kill(-oldShPid, "SIGTERM"); } catch (err: any) {
					serverLog(`reload exit: kill failed: ${err.message}`);
				}
			}
		});
		setTimeout(() => process.exit(0), 100);
	}

	// ── Agent event handlers ──────────────────────────────────────────

	// An agent_start/agent_end pair also fires for each *subagent* run (spawned
	// via the subagent tool), on the same emitter. Those belong to an ephemeral
	// child session, NOT our turn — if we let a subagent's agent_end clear
	// ourTurnActive, the rest of the main turn is orphaned (never streamed, no
	// done, isBusy left toggled → the "斷更 / stuck busy" bug). Skip any lifecycle
	// event whose session is positively a different or ephemeral session than the
	// bridge's own. Conservative: when the session can't be identified we fall
	// through, so the main session's events are never skipped.
	function isForeignAgentEvent(ctx: any): boolean {
		const sid = ctx?.sessionManager?.getSessionId?.();
		if (sid && sessionId && sid !== sessionId) return true;
		if (ctx?.sessionManager?.isPersisted?.() === false) return true;
		return false;
	}

	// Deliver the end of a turn: send/buffer the done event, resolve any pending
	// RPC + idle waiters. Called by the lifecycle after the grace window expired
	// with no continuation (busy/turn-active state is already cleared there).
	function finalizeTurn(event: any, wasActive: boolean): void {
		if (wasActive) {
			const messages = event.messages ?? [];
			const doneEvent = {
				type: "done",
				text: helpers.extractText(messages),
				toolCalls: helpers.extractToolCalls(messages),
				thinking: helpers.extractThinking(messages),
				messageCount: messages.length,
				messages,
			};

			let delivered = false;
			if (sse) {
				writeSse(doneEvent);
				closeSse();
				delivered = true;
			}
			if (pending) {
				const p = pending;
				pending = null;
				clearTimeout(p.timeout);
				p.resolve(messages);
				delivered = true;
			}
			if (!delivered) {
				// SSE disconnected (client navigated away). Buffer the done event
				// so attachStream can deliver it when the client reconnects.
				pendingDone = doneEvent;
				serverLog("finalizeTurn: SSE disconnected, buffered done event");
			}
		} else {
			if (sse || pending) {
				serverLog("finalizeTurn: turn not active", {
					hasSse: !!sse,
					hasPending: !!pending,
					waitingForExtensionInput,
				});
			}
		}

		const waiters = idleWaiters;
		idleWaiters = [];
		for (const w of waiters) {
			clearTimeout(w.timeout);
			w.resolve();
		}
	}

	pi.on("agent_start", (_event: any, ctx: any) => {
		const foreign = isForeignAgentEvent(ctx);
		serverLog(`agent_start fired: ourTurnActive=${lifecycle.isTurnActive()} isBusy(before)=${lifecycle.isBusy()} hasSse=${!!sse} foreign=${foreign} sid=${ctx?.sessionManager?.getSessionId?.()} persisted=${ctx?.sessionManager?.isPersisted?.()}`);
		if (foreign) return;
		// Any agent_start is a (re)start of the current turn's work — a fresh
		// prompt, or a continuation loop (retry after backoff, post-compaction, or
		// a queued message). The lifecycle cancels a pending finalize, and if the
		// finalize already fired (a retry whose backoff outran the grace window)
		// re-asserts the turn so the rest of it streams again — the hub sees
		// isBusy=true on its next poll, re-attaches, and replays the buffer.
		const { reasserted } = lifecycle.agentStart();
		if (reasserted) serverLog("agent_start: re-asserting ourTurnActive (orphaned continuation)");
		writeTurnEvent({ type: "agent_start" });
	});

	pi.on("agent_end", (event: any, ctx: any) => {
		const foreign = isForeignAgentEvent(ctx);
		const willRetry = event?.willRetry === true;
		serverLog(`agent_end fired: ourTurnActive=${lifecycle.isTurnActive()} hasSse=${!!sse} hasPending=${!!pending} foreign=${foreign} willRetry=${willRetry} sid=${ctx?.sessionManager?.getSessionId?.()} persisted=${ctx?.sessionManager?.isPersisted?.()}`);
		if (foreign) return;
		// The lifecycle keeps the turn alive on willRetry, otherwise schedules the
		// finalize after a grace window (long when the loop ended on a retryable
		// error, short otherwise) — see turn-lifecycle.js for the full rationale.
		const endedOnError = lastAssistantEndedOnError(event?.messages ?? []);
		const { scheduled, graceMs } = lifecycle.agentEnd(event, { willRetry, endedOnError });
		if (scheduled) serverLog(`agent_end: scheduling finalize in ${graceMs}ms (endedOnError=${endedOnError})`);
	});

	pi.on("input", (event: any) => {
		if (waitingForExtensionInput && event.source === "extension") {
			waitingForExtensionInput = false;
			lifecycle.beginTurn();
			if (inputWatchdog) {
				clearTimeout(inputWatchdog);
				inputWatchdog = null;
			}
		}

		// Auto-name session on first user prompt (fire-and-forget)
		if (!autoNameAttempted && !sessionName && typeof event.text === "string" && event.text.trim().length > 0) {
			autoNameAttempted = true;
			const apiKey = process.env.FIREWORKS_API_KEY;
			serverLog(`auto-name: attempting (apiKey=${apiKey ? "yes" : "no"}, textLen=${event.text.length})`);
			generateSessionName(event.text, apiKey).then((name) => {
				if (!name) {
					name = event.text.slice(0, 120).replace(/\n/g, " ").trim();
					serverLog(`auto-name: skipped, using prompt prefix fallback`);
				}
				sessionName = name;
				pi.setSessionName(name);
				serverLog(`auto-named session: ${name}`);
				try { writeDiscovery(); } catch { /* best effort */ }
			}).catch((err) => {
				serverLog(`auto-name error: ${err.message}`);
			});
		}
	});

	pi.on("turn_start", (event: any) => {
		serverLog(`turn_start fired: turnIndex=${event.turnIndex} ourTurnActive=${lifecycle.isTurnActive()} isBusy=${lifecycle.isBusy()}`);
		writeTurnEvent({ type: "turn_start", turnIndex: event.turnIndex });
	});

	pi.on("turn_end", (event: any) => {
		serverLog(`turn_end fired: turnIndex=${event.turnIndex} ourTurnActive=${lifecycle.isTurnActive()} isBusy=${lifecycle.isBusy()}`);
		writeTurnEvent({ type: "turn_end", turnIndex: event.turnIndex });
	});

	pi.on("message_update", (event: any) => {
		if (!lifecycle.isTurnActive()) return;
		const ae = event.assistantMessageEvent;
		if (!ae) return;

		const forwardTypes = [
			"text_start", "text_delta", "text_end",
			"thinking_start", "thinking_delta", "thinking_end",
			"toolcall_start", "toolcall_delta", "toolcall_end",
		];
		if (forwardTypes.includes(ae.type)) {
			writeTurnEvent(ae);
		}
	});

	pi.on("tool_execution_start", (event: any) => {
		writeTurnEvent({
			type: "tool_execution_start",
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			args: event.args,
		});
	});

	pi.on("tool_execution_update", (event: any) => {
		writeTurnEvent({
			type: "tool_execution_update",
			toolCallId: event.toolCallId,
			partialResult: event.partialResult,
		});
	});

	pi.on("tool_execution_end", (event: any) => {
		writeTurnEvent({
			type: "tool_execution_end",
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			isError: event.isError,
			result: event.result,
		});
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
			serverLog("writeSseSafe failed:", err);
		}
	}

	function writeSse(data: any): void {
		if (!sse) return;
		try {
			sse.res.write(`data: ${JSON.stringify(data)}\n\n`);
		} catch (err) {
			serverLog("writeSse failed, closing stream:", err);
			closeSse();
		}
	}

	// Record a turn event into the replay buffer (coalesced — see
	// turn-lifecycle.js) and, if a client is attached, stream it live per-event.
	// Buffering happens regardless of attachment so events that occur while the
	// client is switched away are not lost.
	function writeTurnEvent(data: any): void {
		if (!lifecycle.recordEvent(data)) return;
		if (sse) writeSse(data);
	}

	function closeSse(): void {
		if (!sse) return;
		clearInterval(sse.heartbeat);
		try {
			sse.res.end();
		} catch (err) {
			serverLog("closeSse res.end failed:", err);
		}
		sse = null;
	}

	function sendSseError(message: string): void {
		if (sse) {
			writeSse({ type: "error", message });
			closeSse();
		}
	}

	function attachStream(res: any): boolean {
		if (sse) {
			// Never steal an active /api/prompt stream from the sending client.
			if (sse.origin !== "attach") return false;
			// A previous attach stream is still registered (e.g. a suspended
			// mobile tab whose socket never closed). Newest attach wins.
			serverLog("attachStream: replacing previous attach stream");
			closeSse();
		}
		// Allow attach if agent is busy, or if there's a buffered done event
		if (!lifecycle.isBusy() && !pendingDone) return false;
		const heartbeat = setInterval(() => {
			if (sse) {
				try {
					sse.res.write(": heartbeat\n\n");
				} catch (err) {
					serverLog("heartbeat write failed:", err);
					closeSse();
				}
			}
		}, 15000);
		sse = { res, heartbeat, origin: "attach" };
		res.onClose = () => {
			if (sse && sse.res === res) {
				serverLog("attachStream: client disconnected, closing SSE state");
				closeSse();
			}
		};
		// If agent already ended while SSE was disconnected, send the
		// buffered done event immediately so the client can finalize.
		if (pendingDone) {
			serverLog("attachStream: sending buffered done event");
			writeSse(pendingDone);
			closeSse();
			pendingDone = null;
		} else {
			// Replay the current turn's events so the re-attaching client rebuilds
			// the in-progress assistant message, then continues live. Synchronous:
			// no pi event can interleave between here and the return.
			serverLog(`attachStream: re-attached SSE to busy agent, replaying ${lifecycle.bufferedCount()} buffered events`);
			for (const ev of lifecycle.bufferedEvents()) {
				if (!sse) break;
				writeSse(ev);
			}
		}
		return true;
	}

	function saveUpload(data: Uint8Array, ext: string): string {
		const filename = `pi-webui-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
		const filePath = join(tmpdir(), filename);
		writeFileSync(filePath, data);
		serverLog(`saveUpload: saved ${filePath} (${data.byteLength} bytes)`);
		return filePath;
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
		serverLog(`writeDiscovery: pid=${process.pid} ppid=${process.ppid} → storing pid=${process.ppid || process.pid}`);
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
						cwd: process.cwd(),
						pid: process.ppid || process.pid,
						piPid: process.pid,
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

	function recoverStaleSessions() {
		planRecoverStaleSessions({
			listDiscoveryFiles: () => {
				try {
					return readdirSync(BRIDGE_DIR).filter((f) => f.endsWith(".json"));
				} catch {
					return [];
				}
			},
			readDiscovery: (file) => {
				try {
					return JSON.parse(readFileSync(join(BRIDGE_DIR, file), "utf-8"));
				} catch {
					return null;
				}
			},
			isPidAlive,
			ownSessionId: sessionId,
			sessionFileExists: (p) => existsSync(p),
			// Atomic claim: rename throws if another starting bridge already
			// renamed it, so only one process wins.
			claimFn: (file) => {
				try {
					renameSync(join(BRIDGE_DIR, file), join(BRIDGE_DIR, `${file}.recovering`));
					return true;
				} catch {
					return false;
				}
			},
			releaseClaimFn: (file) => {
				try { unlinkSync(join(BRIDGE_DIR, `${file}.recovering`)); } catch {}
			},
			deleteDiscoveryFn: (file) => {
				try { unlinkSync(join(BRIDGE_DIR, file)); } catch {}
			},
			openSessionFn: (sid, name, cwd) => openSession(sid, name, cwd),
			logFn: serverLog,
		});
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
		if (!lifecycle.isBusy()) return Promise.resolve();
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
					// A session marked intentionalClose was killed via the UI; even
					// if the orphaned shell is still alive, don't surface it.
					if (content.intentionalClose) continue;
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
			logFn: (msg) => serverLog(`listAllSessions: ${msg}`),
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
		pendingDone = null;
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
					lifecycle.abandonTurn();
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
				lifecycle.abandonTurn();
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

	async function compactAndStream(res: any, customInstructions?: string): Promise<void> {
		if (!sessionCtx) {
			try { res.write('data: {"type":"error","message":"No session context"}\n\n'); } catch {}
			try { res.end(); } catch {}
			return;
		}

		const heartbeat = setInterval(() => {
			try { res.write(": heartbeat\n\n"); } catch {}
		}, 15000);

		// Send a system message so the browser shows immediate feedback
		try {
			res.write(`data: ${JSON.stringify({ type: "compact_start" })}\n\n`);
		} catch {}

		try {
			sessionCtx.compact({
				customInstructions: customInstructions || undefined,
				onComplete: (result: any) => {
					clearInterval(heartbeat);
					const tokensBefore = result?.tokensBefore ?? null;
					const summary = result?.summary ?? "";
					const doneEvent = {
						type: "done",
						text: summary,
						toolCalls: [],
						thinking: "",
						messageCount: 0,
						compact: true,
						tokensBefore,
					};
					try {
						res.write(`data: ${JSON.stringify(doneEvent)}\n\n`);
						res.end();
					} catch (err) {
						serverLog("compactAndStream: write failed:", err);
					}
				},
				onError: (err: Error) => {
					clearInterval(heartbeat);
					// Send as done (not error) so browser doesn't trigger history reload
					const doneEvent = {
						type: "done",
						text: `Compact failed: ${err.message}`,
						toolCalls: [],
						thinking: "",
						messageCount: 0,
						compact: true,
						tokensBefore: null,
					};
					try {
						res.write(`data: ${JSON.stringify(doneEvent)}\n\n`);
						res.end();
					} catch {}
				},
			});
		} catch (err: any) {
			clearInterval(heartbeat);
			try {
				res.write(`data: ${JSON.stringify({ type: "error", message: err.message })}\n\n`);
				res.end();
			} catch {}
		}
	}

	async function sendAndStream(
		message: string,
		_timeoutMs: number,
		res: any,
	): Promise<void> {
		pendingDone = null;
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
					serverLog("heartbeat write failed:", err);
					closeSse();
				}
			}
		}, 15000);

		if (sse) {
			serverLog("new SSE request while previous still open, closing old");
			closeSse();
		}

		sse = { res, heartbeat, origin: "prompt" };
		res.onClose = () => {
			if (sse && sse.res === res) {
				serverLog("sendAndStream: client disconnected, closing SSE state");
				closeSse();
			}
		};

		const expanded = expandInput(message);
		waitingForExtensionInput = true;

		inputWatchdog = setTimeout(() => {
			if (waitingForExtensionInput) {
				serverLog("input watchdog: agent did not start processing message");
				waitingForExtensionInput = false;
				lifecycle.abandonTurn();
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
		// Subagent sessions (--no-session) are ephemeral in-memory sessions.
		// Don't start an HTTP bridge or write discovery files for them.
		if (!ctx.sessionManager?.isPersisted()) return;

		sessionCtx = ctx;
		sessionFile = ctx.sessionManager?.getSessionFile() ?? undefined;
		sessionId = event.sessionId ?? ctx.sessionManager?.getSessionId();
		sessionName = ctx.sessionManager?.getSessionName() ?? undefined;

		try {
			mkdirSync(BRIDGE_DIR, { recursive: true });
		} catch {
			// Best effort
		}
		recoverStaleSessions();

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
			// Collect body as raw bytes — string concatenation would corrupt
			// binary uploads (PNG bytes are not valid UTF-8).
			let body: Buffer | undefined;
			if (method !== "GET" && method !== "HEAD") {
				const chunks: Buffer[] = [];
				for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
				if (chunks.length > 0) body = Buffer.concat(chunks);
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
							serverLog("client disconnected during stream");
							// Cancelling the reader errors the TransformStream writer,
							// which fires the SSE wrapper's onClose for THIS stream only.
							// Do not close the global sse here: this close event may
							// belong to an older socket than the currently attached SSE.
							reader.cancel().catch(() => {});
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
				serverLog("request handler error:", err);
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
		lifecycle.shutdown();
		if (inputWatchdog) { clearTimeout(inputWatchdog); inputWatchdog = null; }

		const waiters = idleWaiters;
		idleWaiters = [];
		for (const w of waiters) {
			clearTimeout(w.timeout);
			w.resolve();
		}

		if (discoveryFile && existsSync(discoveryFile)) {
			try {
				const content = JSON.parse(readFileSync(discoveryFile, "utf-8"));
				if (content.intentionalClose) {
					unlinkSync(discoveryFile);
					serverLog("session_shutdown: intentional close, deleted discovery file");
				} else {
					serverLog("session_shutdown: keeping discovery file for auto-recover");
				}
			} catch {
				// Can't read, delete as fallback
				try { unlinkSync(discoveryFile); } catch {}
			}
		}
	});
}
