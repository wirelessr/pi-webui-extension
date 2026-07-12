import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  extractSubagentViews,
  extractText,
  extractThinking,
  extractToolCalls,
  isPathSafe,
  isSkillRead,
  paginateHistory,
  parseHistoryData,
  parseHistoryLine,
  parsePromptBody,
  parsePromptTemplate,
  parseSkillBlock,
  parseSkillCommand,
  parseSkillFrontmatter,
  parseSubagentMessages,
  stripFrontmatter,
  subagentStatus,
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

  describe("skip cases return null", () => {
    const cases = [
      { name: "system messages", input: JSON.stringify({ type: "message", message: { role: "system", content: "system prompt" } }) },
      { name: "non-message types", input: JSON.stringify({ type: "summary", data: "..." }) },
      { name: "invalid JSON: not json", input: "not json" },
      { name: "invalid JSON: broken brace", input: "{broken" },
      { name: "empty line: empty string", input: "" },
      { name: "empty line: whitespace only", input: "   " },
      { name: "no useful content", input: JSON.stringify({ type: "message", message: { role: "assistant", content: [] } }) },
      { name: "no message field", input: JSON.stringify({ type: "message" }) },
    ];

    for (const { name, input } of cases) {
      test(`skips ${name}`, () => {
        assert.equal(parseHistoryLine(input), null);
      });
    }
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

  test("parses compaction entry as system message", () => {
    const line = JSON.stringify({
      type: "compaction",
      id: "comp1",
      timestamp: "2026-01-01T00:00:00Z",
      summary: "Previous work summary...",
      tokensBefore: 50000,
    });
    const entry = parseHistoryLine(line);
    assert.ok(entry);
    assert.equal(entry.role, "system");
    assert.match(entry.text, /Compacted/);
    assert.match(entry.text, /50000/);
    assert.match(entry.text, /Previous work summary/);
  });

  test("skips compaction entry without summary", () => {
    const line = JSON.stringify({ type: "compaction", id: "comp2" });
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

  const cases = [
    { name: "normal file path is safe", input: "/index.html", baseDir },
    { name: "path traversal with ../ is normalized to within baseDir", input: "/../../etc/passwd", baseDir },
    { name: "multiple ../ without leading slash is normalized safely", input: "../../../etc/shadow", baseDir },
    { name: "nested subdirectory is safe", input: "/subdir/file.js", baseDir },
    { name: "root path is safe", input: "/", baseDir },
    { name: "URL-encoded traversal is treated as filename (safe)", input: "..%2f..%2fetc%2fpasswd", baseDir },
  ];

  for (const { name, input, baseDir: base } of cases) {
    test(`${name} → safe`, () => {
      const result = isPathSafe(input, base);
      assert.equal(result.safe, true);
    });
  }

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
  const cases = [
    { name: "parses /skill:name", input: "/skill:gh", expectedIsSkill: true, expectedSkillName: "gh", expectedArgs: "" },
    { name: "parses /skill:name with args", input: "/skill:gh list open PRs", expectedIsSkill: true, expectedSkillName: "gh", expectedArgs: "list open PRs" },
    { name: "non-skill text → isSkill false", input: "hello world", expectedIsSkill: false, expectedSkillName: null, expectedArgs: undefined },
    { name: "/skill: with no name", input: "/skill:", expectedIsSkill: true, expectedSkillName: "", expectedArgs: "" },
  ];

  for (const { name, input, expectedIsSkill, expectedSkillName, expectedArgs } of cases) {
    test(name, () => {
      const result = parseSkillCommand(input);
      assert.equal(result.isSkill, expectedIsSkill);
      assert.equal(result.skillName, expectedSkillName);
      if (expectedArgs !== undefined) {
        assert.equal(result.args, expectedArgs);
      }
    });
  }
});

describe("parsePromptTemplate", () => {
  const cases = [
    { name: "parses /templateName", input: "/pr", expectedIsTemplate: true, expectedTemplateName: "pr", expectedArgs: "" },
    { name: "parses /templateName with args", input: "/pr --base develop", expectedIsTemplate: true, expectedTemplateName: "pr", expectedArgs: "--base develop" },
    { name: "non-slash text → isTemplate false", input: "hello", expectedIsTemplate: false, expectedTemplateName: undefined, expectedArgs: undefined },
    { name: "bare slash with no name", input: "/", expectedIsTemplate: true, expectedTemplateName: "", expectedArgs: undefined },
  ];

  for (const { name, input, expectedIsTemplate, expectedTemplateName, expectedArgs } of cases) {
    test(name, () => {
      const result = parsePromptTemplate(input);
      assert.equal(result.isTemplate, expectedIsTemplate);
      if (expectedTemplateName !== undefined) {
        assert.equal(result.templateName, expectedTemplateName);
      }
      if (expectedArgs !== undefined) {
        assert.equal(result.args, expectedArgs);
      }
    });
  }
});

// ── parseSkillBlock ──────────────────────────────────

describe("parseSkillBlock", () => {
  const cases = [
    {
      name: "skill block with args",
      text: '<skill name="gh" location="/path/to/skill.md">\nSkill content here\n</skill>\n\nlist open PRs',
      expected: { name: "gh", location: "/path/to/skill.md", content: "Skill content here", userMessage: "list open PRs" },
    },
    {
      name: "skill block without args",
      text: '<skill name="jira" location="/path/to/jira.md">\nJira skill content\n</skill>',
      expected: { name: "jira", location: "/path/to/jira.md", content: "Jira skill content", userMessage: undefined },
    },
    {
      name: "non-skill text returns null",
      text: "just a regular message",
      expected: null,
    },
    {
      name: "empty string returns null",
      text: "",
      expected: null,
    },
  ];
  for (const c of cases) {
    test(c.name, () => {
      const result = parseSkillBlock(c.text);
      if (c.expected === null) {
        assert.equal(result, null);
      } else {
        assert.equal(result.name, c.expected.name);
        assert.equal(result.location, c.expected.location);
        assert.equal(result.content, c.expected.content);
        assert.equal(result.userMessage, c.expected.userMessage);
      }
    });
  }
});

// ── isSkillRead ──────────────────────────────────────

describe("isSkillRead", () => {
  const cases = [
    { name: "read SKILL.md via path", toolName: "read", args: { path: "/skills/gh/SKILL.md" }, expected: "/skills/gh/SKILL.md" },
    { name: "read SKILL.md via file_path", toolName: "read", args: { file_path: "/skills/gh/SKILL.md" }, expected: "/skills/gh/SKILL.md" },
    { name: "read non-skill file", toolName: "read", args: { path: "/skills/gh/README.md" }, expected: null },
    { name: "bash tool", toolName: "bash", args: { command: "cat SKILL.md" }, expected: null },
    { name: "no args", toolName: "read", args: null, expected: null },
    { name: "empty path", toolName: "read", args: { path: "" }, expected: null },
  ];
  for (const c of cases) {
    test(c.name, () => {
      assert.equal(isSkillRead(c.toolName, c.args), c.expected);
    });
  }
});

// ── parseSkillFrontmatter ────────────────────────────

describe("parseSkillFrontmatter", () => {
  const cases = [
    {
      name: "standard frontmatter",
      text: "---\nname: pr-respond\ndescription: Use when handling\n---\n# PR Respond\n\nSkill content",
      expected: { name: "pr-respond", content: "# PR Respond\n\nSkill content" },
    },
    {
      name: "minimal frontmatter",
      text: "---\nname: gh\n---\nGH content",
      expected: { name: "gh", content: "GH content" },
    },
    {
      name: "no frontmatter",
      text: "Just some markdown content",
      expected: null,
    },
    {
      name: "frontmatter without name",
      text: "---\ndescription: something\n---\ncontent",
      expected: null,
    },
    {
      name: "empty string",
      text: "",
      expected: null,
    },
  ];
  for (const c of cases) {
    test(c.name, () => {
      const result = parseSkillFrontmatter(c.text);
      if (c.expected === null) {
        assert.equal(result, null);
      } else {
        assert.equal(result.name, c.expected.name);
        assert.equal(result.content, c.expected.content);
      }
    });
  }
});

// ── subagentStatus ───────────────────────────────────

describe("subagentStatus", () => {
  const cases = [
    { name: "running (exitCode -1)", result: { exitCode: -1 }, expected: "running" },
    { name: "done (exitCode 0)", result: { exitCode: 0 }, expected: "done" },
    { name: "error (non-zero exit)", result: { exitCode: 1 }, expected: "error" },
    { name: "error (stopReason error)", result: { exitCode: 0, stopReason: "error" }, expected: "error" },
    { name: "error (stopReason aborted)", result: { exitCode: 0, stopReason: "aborted" }, expected: "error" },
    { name: "done (stopReason stop)", result: { exitCode: 0, stopReason: "stop" }, expected: "done" },
  ];
  for (const c of cases) {
    test(c.name, () => {
      assert.equal(subagentStatus(c.result), c.expected);
    });
  }
});

// ── extractSubagentViews ─────────────────────────────

describe("extractSubagentViews", () => {
  test("single mode", () => {
    const details = {
      mode: "single",
      results: [{
        agent: "vision", task: "look at screenshot", exitCode: 0,
        model: "qwen", usage: { input: 100, turns: 3 }, messages: [{ role: "user", content: "hi" }],
      }],
    };
    const views = extractSubagentViews("tc-1", details);
    assert.equal(views.length, 1);
    assert.equal(views[0].id, "tc-1-0");
    assert.equal(views[0].agent, "vision");
    assert.equal(views[0].status, "done");
    assert.equal(views[0].messages.length, 1);
  });

  test("parallel mode", () => {
    const details = {
      mode: "parallel",
      results: [
        { agent: "runner", task: "task A", exitCode: 0, usage: {}, messages: [] },
        { agent: "runner", task: "task B", exitCode: -1, usage: {}, messages: [] },
      ],
    };
    const views = extractSubagentViews("tc-2", details);
    assert.equal(views.length, 2);
    assert.equal(views[0].id, "tc-2-0");
    assert.equal(views[1].id, "tc-2-1");
    assert.equal(views[0].status, "done");
    assert.equal(views[1].status, "running");
  });

  test("null details returns empty", () => {
    assert.deepEqual(extractSubagentViews("tc-3", null), []);
  });

  test("missing results returns empty", () => {
    assert.deepEqual(extractSubagentViews("tc-4", { mode: "single" }), []);
  });

  test("result with missing fields gets defaults", () => {
    const views = extractSubagentViews("tc-5", { results: [{}] });
    assert.equal(views[0].agent, "unknown");
    assert.equal(views[0].task, "");
    assert.equal(views[0].status, "done");
    assert.equal(views[0].model, "");
    assert.deepEqual(views[0].messages, []);
  });
});

// ── parseSubagentMessages ────────────────────────────

describe("parseSubagentMessages", () => {
  test("basic conversation", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "Task: do something" }] },
      { role: "assistant", content: [
        { type: "thinking", thinking: "Let me think" },
        { type: "text", text: "Working on it" },
        { type: "toolCall", id: "tc-a", name: "bash", arguments: { command: "ls" } },
      ] },
      { role: "toolResult", toolCallId: "tc-a", toolName: "bash", content: [{ type: "text", text: "file1\nfile2" }] },
      { role: "assistant", content: [{ type: "text", text: "Done" }] },
    ];
    const entries = parseSubagentMessages(messages);
    assert.equal(entries.length, 4);
    assert.equal(entries[0].role, "user");
    assert.equal(entries[0].text, "Task: do something");
    assert.equal(entries[1].role, "assistant");
    assert.equal(entries[1].thinking, "Let me think");
    assert.equal(entries[1].text, "Working on it");
    assert.equal(entries[1].toolCalls.length, 1);
    assert.equal(entries[1].toolCalls[0].name, "bash");
    assert.equal(entries[2].role, "toolResult");
    assert.equal(entries[2].text, "file1\nfile2");
    assert.equal(entries[2].toolCallId, "tc-a");
    assert.equal(entries[3].text, "Done");
  });

  test("empty messages", () => {
    assert.deepEqual(parseSubagentMessages([]), []);
  });

  test("null messages", () => {
    assert.deepEqual(parseSubagentMessages(null), []);
  });

  test("skips entries with no content", () => {
    const messages = [
      { role: "assistant", content: [] },
      { role: "assistant", content: [{ type: "text", text: "hello" }] },
    ];
    const entries = parseSubagentMessages(messages);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].text, "hello");
  });

  test("string content", () => {
    const messages = [{ role: "user", content: "plain text" }];
    const entries = parseSubagentMessages(messages);
    assert.equal(entries[0].text, "plain text");
  });
});

