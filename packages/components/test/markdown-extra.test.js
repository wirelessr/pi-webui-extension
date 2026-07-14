import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { renderMarkdown } from "../src/markdown.js";

describe("renderMarkdown - tables", () => {
  test("basic table", () => {
    const result = renderMarkdown("| Name | Value |\n|------|-------|\n| a | 1 |\n| b | 2 |");
    assert.ok(result.includes("<table>"));
    assert.ok(result.includes("<thead>"));
    assert.ok(result.includes("<th>Name</th>"));
    assert.ok(result.includes("<th>Value</th>"));
    assert.ok(result.includes("<td>a</td>"));
    assert.ok(result.includes("<td>1</td>"));
    assert.ok(result.includes("<td>b</td>"));
    assert.ok(result.includes("<td>2</td>"));
  });

  test("table with alignment markers", () => {
    const result = renderMarkdown("| Left | Right |\n|:-----|------:|\n| a | b |");
    assert.ok(result.includes("<table>"));
    assert.ok(result.includes("<td>a</td>"));
  });

  test("table with inline formatting in cells", () => {
    const result = renderMarkdown("| Col |\n|-----|\n| **bold** |");
    assert.ok(result.includes("<strong>bold</strong>"));
  });

  test("pipe-only line not treated as table", () => {
    const result = renderMarkdown("---\n---");
    assert.ok(!result.includes("<table>"));
  });
});

describe("renderMarkdown - fenced code blocks", () => {
  const cases = [
    {
      name: "~~~ fence variant",
      md: "~~~\nhello\n~~~",
      assert: (r) => {
        assert.ok(r.includes("<pre><code"));
        assert.ok(r.includes("hello"));
      },
    },
    {
      name: "fence with language",
      md: "```python\nprint(1)\n```",
      assert: (r) => {
        assert.ok(r.includes('class="language-python"'));
        assert.ok(r.includes("print(1)"));
      },
    },
    {
      name: "fence with ~~~ and language",
      md: "~~~js\nconst x = 1\n~~~",
      assert: (r) => {
        assert.ok(r.includes('class="language-js"'));
        assert.ok(r.includes("const x = 1"));
      },
    },
    {
      name: "empty fence",
      md: "```\n```",
      assert: (r) => {
        assert.ok(r.includes("<pre><code"));
      },
    },
  ];
  for (const c of cases) {
    test(c.name, () => c.assert(renderMarkdown(c.md)));
  }
});

describe("renderMarkdown - nested lists", () => {
  test("indented list item gets margin", () => {
    const result = renderMarkdown("- top\n  - nested");
    assert.ok(result.includes("<ul>"));
    assert.ok(result.includes("<li>top</li>"));
    assert.ok(result.includes("margin-left"));
    assert.ok(result.includes("nested"));
  });

  test("deeply nested list items", () => {
    const result = renderMarkdown("- a\n  - b\n    - c");
    assert.ok(result.includes("margin-left:3em"));
  });
});

describe("renderMarkdown - blockquotes", () => {
  test("multi-line blockquote", () => {
    const result = renderMarkdown("> line 1\n> line 2");
    assert.ok(result.includes("<blockquote>"));
    assert.ok(result.includes("line 1"));
    assert.ok(result.includes("line 2"));
  });

  test("blockquote with inline formatting", () => {
    const result = renderMarkdown("> **bold quote**");
    assert.ok(result.includes("<blockquote>"));
    assert.ok(result.includes("<strong>bold quote</strong>"));
  });
});

describe("renderMarkdown - multi-line paragraphs", () => {
  test("consecutive lines join into one paragraph", () => {
    const result = renderMarkdown("line 1\nline 2\nline 3");
    assert.ok(result.includes("<p>"));
    assert.ok(result.includes("line 1"));
    assert.ok(result.includes("line 2"));
    assert.ok(result.includes("line 3"));
    assert.ok(result.includes("<br>"));
  });

  test("paragraph breaks on blank line", () => {
    const result = renderMarkdown("para 1\n\npara 2");
    assert.ok(result.includes("<p>para 1</p>"));
    assert.ok(result.includes("<p>para 2</p>"));
  });
});

describe("renderMarkdown - inline formatting edge cases", () => {
  test("bold inside bold does not nest", () => {
    const result = renderMarkdown("**outer ** inner**");
    assert.ok(result.includes("<strong>outer </strong>"));
  });

  test("underscore in word is NOT italic (removed _ italic support)", () => {
    const result = renderMarkdown("snake_case_var");
    assert.ok(result.includes("snake_case_var"));
    assert.ok(!result.includes("<em>"));
  });

  test("strikethrough", () => {
    const result = renderMarkdown("~~deleted~~");
    assert.ok(result.includes("<del>deleted</del>"));
  });

  test("inline code inside bold", () => {
    const result = renderMarkdown("**bold `code` text**");
    assert.ok(result.includes("<strong>bold "));
    assert.ok(result.includes("<code>code</code>"));
  });

  test("__ underscores do NOT make bold (use ** instead)", () => {
    const result = renderMarkdown("__bold__");
    assert.ok(result.includes("__bold__"));
    assert.ok(!result.includes("<strong>"));
  });

  test("_ underscores do NOT make italic (use * instead)", () => {
    const result = renderMarkdown("_italic_");
    assert.ok(result.includes("_italic_"));
    assert.ok(!result.includes("<em>"));
  });
});

describe("renderMarkdown - mixed content", () => {
  test("heading followed by paragraph", () => {
    const result = renderMarkdown("# Title\n\nSome text here.");
    assert.ok(result.includes("<h1>Title</h1>"));
    assert.ok(result.includes("<p>Some text here.</p>"));
  });

  test("list followed by code block", () => {
    const result = renderMarkdown("- item 1\n- item 2\n\n```\ncode\n```");
    assert.ok(result.includes("<ul>"));
    assert.ok(result.includes("<li>item 1</li>"));
    assert.ok(result.includes("<pre><code"));
    assert.ok(result.includes("code"));
  });

  test("multiple sections", () => {
    const md = [
      "# Heading",
      "",
      "Paragraph with **bold**.",
      "",
      "- List item",
      "",
      "> Quote",
      "",
      "```js",
      "code()",
      "```",
    ].join("\n");
    const result = renderMarkdown(md);
    assert.ok(result.includes("<h1>"));
    assert.ok(result.includes("<strong>bold</strong>"));
    assert.ok(result.includes("<ul>"));
    assert.ok(result.includes("<blockquote>"));
    assert.ok(result.includes("language-js"));
  });
});
