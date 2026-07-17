// Regression harness for the multi-loop / retry "斷更" (stuck-busy / stream
// goes silent) bug.
//
// Run it yourself (from packages/extension/):
//   node --experimental-strip-types test/retry-orphan.harness.ts
// Exit 0 = PASS, non-zero = FAIL. It prints the SSE events it observed.
//
// What it does: loads the REAL extension (../index.ts) with a mock `pi`,
// starts the extension's real HTTP server, connects a real SSE client via
// /api/prompt, then replays the exact event sequence seen in session 7332:
//   input -> agent_start -> agent_end(error) -> [retry backoff gap] ->
//   agent_start -> agent_end(stop)
// and asserts the client gets NO premature `done` during the retry gap and
// exactly one `done` at the true end.
//
// What it does NOT do: drive a real LLM. The event timeline is fed manually
// (reconstructed from 7332's bridge.log), not produced by a live provider.
// It exercises the bridge's event-handling logic, which is where the bug is.
//
// This is deliberately NOT named *.test.js, so `node --test test/*.test.js`
// (CI) skips it: it binds a port, uses real timers, and needs the TS loader.

import bridge from "../index.ts";

const PORT = Number(process.env.HARNESS_PORT ?? 7399);
process.env.PI_HTTP_PORT = String(PORT);
process.env.PI_HTTP_HOST = "127.0.0.1";
process.env.PI_BRIDGE_DIR = process.env.PI_BRIDGE_DIR ?? `${process.env.TMPDIR ?? "/tmp"}/retry-harness-bridge`;

type Handler = (event: any, ctx: any) => void;
const handlers: Record<string, Handler[]> = {};
const pi: any = {
	on: (evt: string, h: Handler) => { (handlers[evt] ||= []).push(h); },
	sendUserMessage: (_m: any) => { /* test drives events manually */ },
	setSessionName: (_n: any) => {},
	getCommands: () => [],
};
const emit = (evt: string, event: any, ctx: any) => { for (const h of handlers[evt] || []) h(event, ctx); };

const ctx: any = {
	sessionManager: {
		isPersisted: () => true,
		getSessionFile: () => "/tmp/fake-harness.jsonl",
		getSessionId: () => "harness-sid",
		getSessionName: () => "harness",
	},
	hasUI: false,
	tokens: 10, contextWindow: 1000, percent: 1,
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
	const fs = await import("node:fs");
	fs.mkdirSync(process.env.PI_BRIDGE_DIR as string, { recursive: true });

	bridge(pi);
	emit("session_start", { sessionId: "harness-sid" }, ctx);
	await sleep(500);

	const seen: Array<{ t: number; type: string }> = [];
	const t0 = Date.now();

	const controller = new AbortController();
	const respP = fetch(`http://127.0.0.1:${PORT}/api/prompt`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
		body: JSON.stringify({ message: "hi" }),
		signal: controller.signal,
	});

	let firstDoneAt = -1;
	let doneCount = 0;
	const readerDone = (async () => {
		const res = await respP;
		const reader = (res.body as any).getReader();
		const dec = new TextDecoder();
		let buf = "";
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buf += dec.decode(value, { stream: true });
			let idx: number;
			while ((idx = buf.indexOf("\n\n")) !== -1) {
				const chunk = buf.slice(0, idx); buf = buf.slice(idx + 2);
				const line = chunk.split("\n").find((l) => l.startsWith("data:"));
				if (!line) continue;
				try {
					const ev = JSON.parse(line.slice(5).trim());
					seen.push({ t: Date.now() - t0, type: ev.type });
					if (ev.type === "done") { doneCount++; if (firstDoneAt < 0) firstDoneAt = Date.now() - t0; }
				} catch {}
			}
		}
	})();

	await sleep(300);

	emit("input", { source: "extension", text: "hi" }, ctx);
	emit("agent_start", {}, ctx);
	emit("turn_start", { turnIndex: 0 }, ctx);
	emit("turn_end", { turnIndex: 0 }, ctx);
	emit("agent_end", { messages: [{ role: "assistant", stopReason: "error", content: [] }], willRetry: false }, ctx);
	const afterErrorEnd = Date.now() - t0;

	await sleep(2500); // pi's retry backoff (2s+) — old code sends a premature done here
	const doneAtError = seen.some((e) => e.type === "done");

	emit("agent_start", {}, ctx); // retry continuation (orphaned agent_start in the bug)
	emit("turn_start", { turnIndex: 0 }, ctx);
	emit("turn_end", { turnIndex: 0 }, ctx);
	emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "final answer" }] }], willRetry: false }, ctx);

	await sleep(1800); // clean-end grace (1s) + margin

	controller.abort();
	await readerDone.catch(() => {});

	console.log("EVENTS:", JSON.stringify(seen));
	console.log(`afterErrorEnd@${afterErrorEnd}ms firstDoneAt=${firstDoneAt}ms doneCount=${doneCount} doneDuringGap=${doneAtError}`);
	const PASS = !doneAtError && doneCount === 1 && firstDoneAt > afterErrorEnd + 2000;
	console.log(PASS
		? "RESULT: PASS (turn survived the retry; single done at the true end)"
		: "RESULT: FAIL (premature/missing done — turn orphaned)");
	process.exit(PASS ? 0 : 1);
}

main().catch((e) => { console.error("harness error:", e); process.exit(2); });
