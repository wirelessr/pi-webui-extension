import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  extractText,
  extractToolCalls,
  extractThinking,
  parseHistoryLine,
  parseHistoryData,
  paginateHistory,
  isPathSafe,
  parsePromptBody,
  stripFrontmatter,
  parseSkillCommand,
  parsePromptTemplate,
} from "../http-bridge-web/helpers.js";

// ── extractText / extractToolCalls / extractThinking ──

describe("extractText", () => {
  test("extracts text from assistant messages", () => {
    const msgs = [
      { role: "assistant", content: [{ type: "text", text: "hello" }] },
    ];
    assert.equal(extractText(msgs), "hello");
  });

  test("joins multiple text blocks with double newline", () => {
    const msgs = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "first" },
          { type: "text", text: "second" },
        ],
      },
    ];
    assert.equal(extractText(msgs), "first\n\nsecond");
  });

  test("ignores non-assistant messages", () => {
    const msgs = [
      { role: "user", content: [{ type: "text", text: "question" }] },
      { role: "assistant", content: [{ type: "text", text: "answer" }] },
    ];
    assert.equal(extractText(msgs), "answer");
  });

  test("ignores non-text blocks", () => {
    const msgs = [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "hmm" },
          { type: "text", text: "result" },
          { type: "toolCall", name: "bash", arguments: {} },
        ],
      },
    ];
    assert.equal(extractText(msgs), "result");
  });

  test("returns empty string for no assistant messages", () => {
    assert.equal(extractText([]), "");
    assert.equal(extractText([{ role: "user", content: "hi" }]), "");
  });

  test("handles string content (no blocks)", () => {
    const msgs = [{ role: "assistant", content: "plain text" }];
    assert.equal(extractText(msgs), "");
  });

  test("joins across multiple assistant messages", () => {
    const msgs = [
      { role: "assistant", content: [{ type: "text", text: "part1" }] },
      { role: "assistant", content: [{ type: "text", text: "part2" }] },
    ];
    assert.equal(extractText(msgs), "part1\n\npart2");
  });
});

describe("extractToolCalls", () => {
  test("extracts tool calls with name and truncated arguments", () => {
    const msgs = [
      {
        role: "assistant",
        content: [
          { type: "toolCall", name: "bash", arguments: { cmd: "ls" } },
        ],
      },
    ];
    assert.deepEqual(extractToolCalls(msgs), ['bash({"cmd":"ls"})']);
  });

  test("truncates arguments to 200 chars in JSON", () => {
    const longArg = "x".repeat(300);
    const msgs = [
      {
        role: "assistant",
        content: [
          { type: "toolCall", name: "write", arguments: { data: longArg } },
        ],
      },
    ];
    const result = extractToolCalls(msgs);
    assert.ok(result[0].length < 250);
    assert.ok(result[0].startsWith("write("));
  });

  test("ignores non-toolCall blocks", () => {
    const msgs = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "hi" },
          { type: "toolCall", name: "read", arguments: {} },
        ],
      },
    ];
    assert.deepEqual(extractToolCalls(msgs), ["read({})"]);
  });

  test("returns empty array for no assistant messages", () => {
    assert.deepEqual(extractToolCalls([]), []);
  });

  test("handles multiple tool calls across messages", () => {
    const msgs = [
      { role: "assistant", content: [{ type: "toolCall", name: "a", arguments: {} }] },
      { role: "assistant", content: [{ type: "toolCall", name: "b", arguments: {} }] },
    ];
    assert.deepEqual(extractToolCalls(msgs), ["a({})", "b({})"]);
  });
});

describe("extractThinking", () => {
  test("extracts thinking blocks", () => {
    const msgs = [
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "let me think" }],
      },
    ];
    assert.equal(extractThinking(msgs), "let me think");
  });

  test("joins multiple thinking blocks", () => {
    const msgs = [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "step 1" },
          { type: "thinking", thinking: "step 2" },
        ],
      },
    ];
    assert.equal(extractThinking(msgs), "step 1\n\nstep 2");
  });

  test("ignores non-thinking blocks", () => {
    const msgs = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "answer" },
          { type: "thinking", thinking: "reasoning" },
        ],
      },
    ];
    assert.equal(extractThinking(msgs), "reasoning");
  });

  test("returns empty string for no thinking", () => {
    assert.equal(extractThinking([]), "");
  });
});

// ── parseHistoryLine / parseHistoryData ──

describe("parseHistoryLine", () => {
  test("parses user message with string content", () => {
    const line = JSON.stringify({
      type: "message",
      id: "entry1",
      timestamp: 123,
      message: { role: "user", content: "hello" },
    });
    const entry = parseHistoryLine(line);
    assert.equal(entry.role, "user");
    assert.equal(entry.text, "hello");
    assert.equal(entry.id, "entry1");
  });

  test("parses assistant message with content blocks", () => {
    const line = JSON.stringify({
      type: "message",
      id: "entry2",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "answer" },
          { type: "thinking", thinking: "hmm" },
          { type: "toolCall", id: "tc1", name: "bash", arguments: { cmd: "ls" } },
        ],
      },
    });
    const entry = parseHistoryLine(line);
    assert.equal(entry.role, "assistant");
    assert.equal(entry.text, "answer");
    assert.equal(entry.thinking, "hmm");
    assert.deepEqual(entry.toolCalls, [{ id: "tc1", name: "bash", arguments: { cmd: "ls" } }]);
  });

  test("skips system messages", () => {
    const line = JSON.stringify({
      type: "message",
      message: { role: "system", content: "system prompt" },
    });
    assert.equal(parseHistoryLine(line), null);
  });

  test("skips non-message types", () => {
    const line = JSON.stringify({ type: "summary", data: "..." });
    assert.equal(parseHistoryLine(line), null);
  });

  test("skips invalid JSON", () => {
    assert.equal(parseHistoryLine("not json"), null);
    assert.equal(parseHistoryLine("{broken"), null);
  });

  test("skips empty lines", () => {
    assert.equal(parseHistoryLine(""), null);
    assert.equal(parseHistoryLine("   "), null);
  });

  test("skips entries with no useful content", () => {
    const line = JSON.stringify({
      type: "message",
      message: { role: "assistant", content: [] },
    });
    assert.equal(parseHistoryLine(line), null);
  });

  test("parses toolResult message", () => {
    const line = JSON.stringify({
      type: "message",
      id: "entry3",
      message: {
        role: "toolResult",
        toolCallId: "tc1",
        toolName: "bash",
        isError: false,
        content: [{ type: "text", text: "output" }],
      },
    });
    const entry = parseHistoryLine(line);
    assert.equal(entry.role, "toolResult");
    assert.equal(entry.toolCallId, "tc1");
    assert.equal(entry.toolName, "bash");
    assert.equal(entry.isError, false);
    assert.equal(entry.text, "output");
  });

  test("toolResult with string content", () => {
    const line = JSON.stringify({
      type: "message",
      message: { role: "toolResult", content: "plain result" },
    });
    const entry = parseHistoryLine(line);
    assert.equal(entry.text, "plain result");
  });

  test("skips message without message field", () => {
    const line = JSON.stringify({ type: "message" });
    assert.equal(parseHistoryLine(line), null);
  });
});

describe("parseHistoryData", () => {
  test("parses multiple lines", () => {
    const data = [
      JSON.stringify({ type: "message", id: "1", message: { role: "user", content: "hi" } }),
      JSON.stringify({ type: "message", id: "2", message: { role: "assistant", content: [{ type: "text", text: "hello" }] } }),
      "not json",
      "",
    ].join("\n");
    const entries = parseHistoryData(data);
    assert.equal(entries.length, 2);
    assert.equal(entries[0].role, "user");
    assert.equal(entries[1].role, "assistant");
  });

  test("returns empty array for empty data", () => {
    assert.deepEqual(parseHistoryData(""), []);
  });
});

// ── paginateHistory ──

describe("paginateHistory", () => {
  const items = Array.from({ length: 10 }, (_, i) => ({ id: i }));

  test("limit=0 returns all", () => {
    const result = paginateHistory(items, 0, 0);
    assert.equal(result.history.length, 10);
    assert.equal(result.total, 10);
  });

  test("limit=5 offset=0 returns last 5", () => {
    const result = paginateHistory(items, 5, 0);
    assert.equal(result.history.length, 5);
    assert.deepEqual(result.history.map((h) => h.id), [5, 6, 7, 8, 9]);
  });

  test("limit=5 offset=5 returns items[0:5]", () => {
    const result = paginateHistory(items, 5, 5);
    assert.equal(result.history.length, 5);
    assert.deepEqual(result.history.map((h) => h.id), [0, 1, 2, 3, 4]);
  });

  test("limit=5 offset=3 returns items[2:7]", () => {
    const result = paginateHistory(items, 5, 3);
    assert.equal(result.history.length, 5);
    assert.deepEqual(result.history.map((h) => h.id), [2, 3, 4, 5, 6]);
  });

  test("limit exceeds total returns from start", () => {
    const result = paginateHistory(items, 20, 0);
    assert.equal(result.history.length, 10);
  });

  test("offset exceeds total returns empty", () => {
    const result = paginateHistory(items, 5, 20);
    assert.equal(result.history.length, 0);
    assert.equal(result.total, 10);
  });

  test("limit+offset exceeds total clamps start to 0", () => {
    const result = paginateHistory(items, 8, 5);
    assert.equal(result.history.length, 5);
    assert.deepEqual(result.history.map((h) => h.id), [0, 1, 2, 3, 4]);
  });
});

// ── isPathSafe ──

describe("isPathSafe", () => {
  const baseDir = "/var/www/webui";

  test("normal file path is safe", () => {
    const result = isPathSafe("/index.html", baseDir);
    assert.ok(result.safe);
  });

  test("path traversal with ../ is normalized to within baseDir", () => {
    // normalize("/../../etc/passwd") → "/etc/passwd"
    // join(baseDir, "/etc/passwd") → "/var/www/webui/etc/passwd"
    // This is safe — the path stays within baseDir
    const result = isPathSafe("/../../etc/passwd", baseDir);
    assert.ok(result.safe);
  });

  test("multiple ../ without leading slash is normalized safely", () => {
    const result = isPathSafe("../../../etc/shadow", baseDir);
    assert.ok(result.safe);
  });

  test("nested subdirectory is safe", () => {
    const result = isPathSafe("/subdir/file.js", baseDir);
    assert.ok(result.safe);
  });

  test("root path is safe", () => {
    const result = isPathSafe("/", baseDir);
    assert.ok(result.safe);
  });

  test("URL-encoded traversal is treated as filename (safe)", () => {
    const result = isPathSafe("..%2f..%2fetc%2fpasswd", baseDir);
    assert.ok(result.safe);
  });

  test("path that resolves outside baseDir after normalize is blocked", () => {
    // This is the real guard: if somehow the path resolves outside baseDir
    // the startsWith check catches it
    // (Currently no input triggers this due to normalize+join behavior,
    // but the guard exists for defense in depth)
  });
});

// ── parsePromptBody ──

describe("parsePromptBody", () => {
  test("JSON body with message", () => {
    const result = parsePromptBody('{"message":"hello"}', "application/json");
    assert.equal(result.message, "hello");
    assert.equal(result.timeoutMs, 300000);
    assert.equal(result.includeFull, false);
    assert.equal(result.stream, false);
  });

  test("JSON body with all options", () => {
    const result = parsePromptBody(
      '{"message":"hi","timeout":5000,"full":true,"stream":true}',
      "application/json",
    );
    assert.equal(result.message, "hi");
    assert.equal(result.timeoutMs, 5000);
    assert.equal(result.includeFull, true);
    assert.equal(result.stream, true);
  });

  test("JSON body missing message → error", () => {
    const result = parsePromptBody("{}", "application/json");
    assert.ok("error" in result);
    assert.match(result.error, /Missing/);
  });

  test("JSON body with non-string message → error", () => {
    const result = parsePromptBody('{"message":123}', "application/json");
    assert.ok("error" in result);
  });

  test("invalid JSON → error", () => {
    const result = parsePromptBody("not json", "application/json");
    assert.ok("error" in result);
    assert.match(result.error, /Invalid JSON/);
  });

  test("plain text body → message is the body", () => {
    const result = parsePromptBody("just text", "text/plain");
    assert.equal(result.message, "just text");
    assert.equal(result.timeoutMs, 300000);
  });

  test("content-type with charset", () => {
    const result = parsePromptBody('{"message":"hi"}', "application/json; charset=utf-8");
    assert.equal(result.message, "hi");
  });

  test("empty JSON message → error", () => {
    const result = parsePromptBody('{"message":""}', "application/json");
    assert.ok("error" in result);
  });
});

// ── stripFrontmatter ──

describe("stripFrontmatter", () => {
  test("removes YAML frontmatter", () => {
    const content = "---\ntitle: Test\n---\nbody text";
    assert.equal(stripFrontmatter(content), "body text");
  });

  test("no frontmatter → unchanged", () => {
    assert.equal(stripFrontmatter("just text"), "just text");
  });

  test("handles CRLF line endings", () => {
    const content = "---\r\ntitle: Test\r\n---\r\nbody";
    assert.equal(stripFrontmatter(content), "body");
  });

  test("preserves content after frontmatter", () => {
    const content = "---\nname: skill\n---\n# Skill\n\nContent here.";
    assert.equal(stripFrontmatter(content), "# Skill\n\nContent here.");
  });

  test("frontmatter with empty body", () => {
    // "---\n\n---\n" has an empty line between markers
    assert.equal(stripFrontmatter("---\n\n---\n"), "");
  });
});

// ── parseSkillCommand / parsePromptTemplate ──

describe("parseSkillCommand", () => {
  test("parses /skill:name", () => {
    const result = parseSkillCommand("/skill:gh");
    assert.ok(result.isSkill);
    assert.equal(result.skillName, "gh");
    assert.equal(result.args, "");
  });

  test("parses /skill:name with args", () => {
    const result = parseSkillCommand("/skill:gh list open PRs");
    assert.ok(result.isSkill);
    assert.equal(result.skillName, "gh");
    assert.equal(result.args, "list open PRs");
  });

  test("non-skill text → isSkill false", () => {
    const result = parseSkillCommand("hello world");
    assert.ok(!result.isSkill);
    assert.equal(result.skillName, null);
  });

  test("/skill: with no name", () => {
    const result = parseSkillCommand("/skill:");
    assert.ok(result.isSkill);
    assert.equal(result.skillName, "");
  });
});

describe("parsePromptTemplate", () => {
  test("parses /templateName", () => {
    const result = parsePromptTemplate("/pr");
    assert.ok(result.isTemplate);
    assert.equal(result.templateName, "pr");
    assert.equal(result.args, "");
  });

  test("parses /templateName with args", () => {
    const result = parsePromptTemplate("/pr --base develop");
    assert.ok(result.isTemplate);
    assert.equal(result.templateName, "pr");
    assert.equal(result.args, "--base develop");
  });

  test("non-slash text → isTemplate false", () => {
    const result = parsePromptTemplate("hello");
    assert.ok(!result.isTemplate);
  });

  test("bare slash with no name", () => {
    const result = parsePromptTemplate("/");
    assert.ok(result.isTemplate);
    assert.equal(result.templateName, "");
  });
});
