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

  test("underscore italic NOT supported (technical names)", () => {
    assert.ok(renderMarkdown("V2_SWITCH_FF").includes("V2_SWITCH_FF"));
    assert.ok(!renderMarkdown("V2_SWITCH_FF").includes("<em>"));
    assert.ok(renderMarkdown("def __init__(self):").includes("__init__"));
    assert.ok(!renderMarkdown("def __init__(self):").includes("<strong>"));
    assert.ok(renderMarkdown("_clear_cache").includes("_clear_cache"));
    assert.ok(!renderMarkdown("_clear_cache").includes("<em>"));
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

// ── Bare URL autolinking ─────────────────────────────

describe("renderMarkdown - bare URL autolinking", () => {
  const cases = [
    { name: "simple bare URL", md: "See https://example.com", expect: '<a href="https://example.com"' },
    { name: "URL with trailing period excluded", md: "See https://example.com.", expect: '<a href="https://example.com"', notExpect: 'example.com."' },
    { name: "URL with trailing paren excluded", md: "(https://example.com)", expect: '<a href="https://example.com"' },
    { name: "URL with query params", md: "Visit https://foo.com/page?id=1&x=2", expect: '<a href="https://foo.com/page?id=1' },
    { name: "URL with path", md: "PR https://github.com/owner/repo/pull/123", expect: '<a href="https://github.com/owner/repo/pull/123"' },
    { name: "markdown link not double-linked", md: "[text](https://example.com)", expect: '<a href="https://example.com"', notExpect: 'href="https://example.com" target.*href="https://example.com"' },
    { name: "URL in inline code not autolinked", md: "Run `https://example.com` now", notExpect: '<a href="https://example.com"' },
  ];
  for (const c of cases) {
    test(c.name, () => {
      const result = renderMarkdown(c.md);
      if (c.expect) assert.ok(result.includes(c.expect), `expected ${c.expect} in ${result}`);
      if (c.notExpect) assert.ok(!new RegExp(c.notExpect).test(result), `expected NOT /${c.notExpect}/ in ${result}`);
    });
  }
});

// ── List tolerance (blank lines between items) ──────

describe("renderMarkdown - list tolerance for blank lines", () => {
  const cases = [
    {
      name: "ordered list with blank lines merges into one ol",
      md: "1. first\n\n1. second\n",
      expect: "<ol><li>first</li><li>second</li></ol>",
    },
    {
      name: "unordered list with blank lines merges into one ul",
      md: "- first\n\n- second\n\n- third\n",
      expect: "<ul><li>first</li><li>second</li><li>third</li></ul>",
    },
    {
      name: "ordered list followed by paragraph does not merge",
      md: "1. item one\n\nThis is a paragraph.\n",
      expect: "<ol><li>item one</li></ol>",
      notExpect: "<ol><li>item one</li><li>",
    },
    {
      name: "consecutive same-number items without blank line still work",
      md: "1. first\n1. second\n",
      expect: "<ol><li>first</li><li>second</li></ol>",
    },
  ];
  for (const c of cases) {
    test(c.name, () => {
      const result = renderMarkdown(c.md);
      assert.ok(result.includes(c.expect), `expected ${c.expect} in ${result}`);
      if (c.notExpect) assert.ok(!result.includes(c.notExpect), `expected NOT ${c.notExpect} in ${result}`);
    });
  }
});
