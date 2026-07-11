import assert from "node:assert/strict";
import { describe, test } from "node:test";
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
  const allowed = [
    { name: "allows http links", md: "[text](http://example.com)", href: 'href="http://example.com"' },
    { name: "allows https links", md: "[text](https://example.com)", href: 'href="https://example.com"' },
    { name: "allows mailto links", md: "[text](mailto:a@b.com)", href: 'href="mailto:a@b.com"' },
    { name: "allows relative links", md: "[text](/path/to/page)", href: 'href="/path/to/page"' },
    { name: "allows anchor links", md: "[text](#section)", href: 'href="#section"' },
  ];
  for (const c of allowed) {
    test(c.name, () => {
      assert.ok(renderMarkdown(c.md).includes(c.href));
    });
  }

  const blocked = [
    { name: "blocks javascript: scheme", md: "[click](javascript:alert(1))", blocked: 'href="javascript:', expect: 'href="#"' },
    { name: "blocks data: scheme", md: "[click](data:text/html,<script>alert(1)</script>)", blocked: 'href="data:' },
    { name: "blocks vbscript: scheme", md: "[click](vbscript:msgbox(1))", blocked: 'href="vbscript:' },
    { name: "blocks javascript with uppercase", md: "[click](JavaScript:alert(1))", blocked: 'href="JavaScript:' },
  ];
  for (const c of blocked) {
    test(c.name, () => {
      const result = renderMarkdown(c.md);
      assert.ok(!result.includes(c.blocked));
      if (c.expect) assert.ok(result.includes(c.expect));
    });
  }
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
