import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { escapeHtml } from "../http-bridge-web/utils.js";

describe("escapeHtml", () => {
  const singleCharCases = [
    { name: "escapes ampersand", input: "a & b", expected: "a &amp; b" },
    { name: "escapes less-than", input: "a < b", expected: "a &lt; b" },
    { name: "escapes greater-than", input: "a > b", expected: "a &gt; b" },
    { name: "escapes double quote", input: 'say "hi"', expected: "say &quot;hi&quot;" },
    { name: "escapes single quote", input: "it's", expected: "it&#39;s" },
  ];
  for (const c of singleCharCases) {
    test(c.name, () => {
      assert.equal(escapeHtml(c.input), c.expected);
    });
  }

  test("escapes all characters together", () => {
    assert.equal(
      escapeHtml(`<div class="x" data-y='z'>&</div>`),
      "&lt;div class=&quot;x&quot; data-y=&#39;z&#39;&gt;&amp;&lt;/div&gt;",
    );
  });

  test("empty string passes through", () => {
    assert.equal(escapeHtml(""), "");
  });

  test("no special characters passes through unchanged", () => {
    assert.equal(escapeHtml("hello world"), "hello world");
  });
});
