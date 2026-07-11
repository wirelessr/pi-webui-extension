import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { renderMarkdown } from "../http-bridge-web/markdown.js";

describe("renderMarkdown - HTML escaping", () => {
  test("escapes raw HTML tags", () => {
    const result = renderMarkdown("<script>alert(1)</script>");
    assert.ok(result.includes("&lt;script&gt;"));
    assert.ok(!result.includes("<script>"));
  });

  test("escapes HTML entities", () => {
    const result = renderMarkdown("a & b < c > d");
    assert.ok(result.includes("&amp;"));
    assert.ok(result.includes("&lt;"));
    assert.ok(result.includes("&gt;"));
  });
});

describe("renderMarkdown - link scheme filtering", () => {
  test("allows http links", () => {
    const result = renderMarkdown("[text](http://example.com)");
    assert.ok(result.includes('href="http://example.com"'));
  });

  test("allows https links", () => {
    const result = renderMarkdown("[text](https://example.com)");
    assert.ok(result.includes('href="https://example.com"'));
  });

  test("allows mailto links", () => {
    const result = renderMarkdown("[text](mailto:a@b.com)");
    assert.ok(result.includes('href="mailto:a@b.com"'));
  });

  test("allows relative links", () => {
    const result = renderMarkdown("[text](/path/to/page)");
    assert.ok(result.includes('href="/path/to/page"'));
  });

  test("allows anchor links", () => {
    const result = renderMarkdown("[text](#section)");
    assert.ok(result.includes('href="#section"'));
  });

  test("blocks javascript: scheme", () => {
    const result = renderMarkdown("[click](javascript:alert(1))");
    assert.ok(!result.includes('href="javascript:'));
    assert.ok(result.includes('href="#"'));
  });

  test("blocks data: scheme", () => {
    const result = renderMarkdown("[click](data:text/html,<script>alert(1)</script>)");
    assert.ok(!result.includes('href="data:'));
  });

  test("blocks vbscript: scheme", () => {
    const result = renderMarkdown("[click](vbscript:msgbox(1))");
    assert.ok(!result.includes('href="vbscript:'));
  });

  test("blocks javascript with uppercase", () => {
    const result = renderMarkdown("[click](JavaScript:alert(1))");
    assert.ok(!result.includes('href="JavaScript:'));
  });
});

describe("renderMarkdown - basic formatting", () => {
  test("heading", () => {
    const result = renderMarkdown("# Title");
    assert.ok(result.includes("<h1>Title</h1>"));
  });

  test("bold", () => {
    const result = renderMarkdown("**bold**");
    assert.ok(result.includes("<strong>bold</strong>"));
  });

  test("italic", () => {
    const result = renderMarkdown("*italic*");
    assert.ok(result.includes("<em>italic</em>"));
  });

  test("inline code", () => {
    const result = renderMarkdown("`code`");
    assert.ok(result.includes("<code>code</code>"));
  });

  test("fenced code block", () => {
    const result = renderMarkdown("```js\nconsole.log(1)\n```");
    assert.ok(result.includes("<pre><code"));
    assert.ok(result.includes("console.log(1)"));
  });

  test("fenced code block escapes HTML inside", () => {
    const result = renderMarkdown("```\n<b>raw</b>\n```");
    assert.ok(result.includes("&lt;b&gt;"));
    assert.ok(!result.includes("<b>raw</b>"));
  });

  test("unordered list", () => {
    const result = renderMarkdown("- item1\n- item2");
    assert.ok(result.includes("<ul>"));
    assert.ok(result.includes("<li>item1</li>"));
    assert.ok(result.includes("<li>item2</li>"));
  });

  test("ordered list", () => {
    const result = renderMarkdown("1. first\n2. second");
    assert.ok(result.includes("<ol>"));
    assert.ok(result.includes("<li>first</li>"));
    assert.ok(result.includes("<li>second</li>"));
  });

  test("blockquote", () => {
    const result = renderMarkdown("> quoted text");
    assert.ok(result.includes("<blockquote>"));
    assert.ok(result.includes("quoted text"));
  });

  test("horizontal rule", () => {
    const result = renderMarkdown("---");
    assert.ok(result.includes("<hr>"));
  });

  test("paragraph", () => {
    const result = renderMarkdown("Just some text.");
    assert.ok(result.includes("<p>Just some text.</p>"));
  });

  test("empty input returns empty string", () => {
    assert.equal(renderMarkdown(""), "");
    assert.equal(renderMarkdown(null), "");
    assert.equal(renderMarkdown(undefined), "");
  });
});
