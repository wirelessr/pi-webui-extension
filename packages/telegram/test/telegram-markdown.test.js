import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { markdownToTelegramHtml, splitMarkdown } from "../src/telegram-markdown.js";

describe("markdownToTelegramHtml", () => {
  const cases = [
    { name: "plain text escapes html", md: "a < b & c > d", html: "a &lt; b &amp; c &gt; d" },
    { name: "bold with **", md: "x **bold** y", html: "x <b>bold</b> y" },
    { name: "bold with __", md: "x __bold__ y", html: "x <b>bold</b> y" },
    { name: "italic with *", md: "x *it* y", html: "x <i>it</i> y" },
    { name: "italic with _", md: "x _it_ y", html: "x <i>it</i> y" },
    { name: "strike", md: "x ~~gone~~ y", html: "x <s>gone</s> y" },
    { name: "snake_case identifiers are not italic", md: "call my_func_name now", html: "call my_func_name now" },
    { name: "spaced asterisks are not italic", md: "2 * 3 * 4", html: "2 * 3 * 4" },
    { name: "nested bold and italic", md: "**a *b* c**", html: "<b>a <i>b</i> c</b>" },
    { name: "inline code is escaped and shielded", md: "use `a<b> **x**` ok", html: "use <code>a&lt;b&gt; **x**</code> ok" },
    {
      name: "link",
      md: "see [docs](https://x.io/a_b_c?q=1&r=2)",
      html: 'see <a href="https://x.io/a_b_c?q=1&amp;r=2">docs</a>',
    },
    { name: "link label is escaped, url quotes escaped", md: '[<a>](https://x.io/"q")', html: '<a href="https://x.io/&quot;q&quot;">&lt;a&gt;</a>' },
    { name: "non-http link left as text", md: "[a](javascript:x)", html: "[a](javascript:x)" },
    { name: "heading becomes bold", md: "## Title **x**", html: "<b>Title <b>x</b></b>" },
    { name: "heading trailing hashes", md: "# Title #", html: "<b>Title</b>" },
    { name: "bullets keep indent", md: "- one\n  * two\n+ three", html: "\u2022 one\n  \u2022 two\n\u2022 three" },
    { name: "numbered list untouched", md: "1. one\n2. two", html: "1. one\n2. two" },
    { name: "blockquote", md: "> a\n> **b**\nafter", html: "<blockquote>a\n<b>b</b></blockquote>\nafter" },
    { name: "fenced code with lang", md: "```js\nif (a < b) {}\n```", html: '<pre><code class="language-js">if (a &lt; b) {}</code></pre>' },
    { name: "fenced code without lang", md: "```\nx\ny\n```\nz", html: "<pre>x\ny</pre>\nz" },
    { name: "lang is sanitized", md: "```a\"b\nx\n```", html: '<pre><code class="language-ab">x</code></pre>' },
    { name: "unterminated fence runs to the end", md: "```\nx", html: "<pre>x</pre>" },
    { name: "markdown inside fences is literal", md: "```\n**no**\n```", html: "<pre>**no**</pre>" },
    { name: "table becomes pre", md: "| a | b |\n|---|---|\n| 1 | 2 |", html: "<pre>| a | b |\n|---|---|\n| 1 | 2 |</pre>" },
    { name: "single pipe line is not a table", md: "| only |", html: "| only |" },
    { name: "NUL bytes are stripped", md: "a\u0000b", html: "ab" },
  ];
  for (const c of cases) test(c.name, () => assert.equal(markdownToTelegramHtml(c.md), c.html));
});

describe("splitMarkdown", () => {
  test("short text is one chunk", () => assert.deepEqual(splitMarkdown("hi"), ["hi"]));

  test("a fence cut by the limit is closed and reopened with its language", () => {
    const body = Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n");
    const chunks = splitMarkdown(`\`\`\`py\n${body}\n\`\`\``, 40);
    assert.ok(chunks.length > 1);
    for (const c of chunks) {
      const fences = c.split("\n").filter((l) => /^\s*```/.test(l)).length;
      assert.equal(fences % 2, 0, `unbalanced chunk: ${c}`);
    }
    assert.ok(chunks[1].startsWith("```py\n"));
  });

  test("text outside fences is not decorated", () => {
    const chunks = splitMarkdown(`${"a".repeat(30)}\n${"b".repeat(30)}`, 40);
    assert.deepEqual(chunks, ["a".repeat(30), "b".repeat(30)]);
  });
});
