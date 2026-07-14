import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  extractSubagentViews,
  isSkillRead,
  parseSkillBlock,
  parseSkillFrontmatter,
  parseSubagentMessages,
  subagentStatus,
} from "../src/parsers.js";

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
