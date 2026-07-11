import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { escapeHtml } from "../http-bridge-web/utils.js";

describe("escapeHtml", () => {
  test("escapes ampersand", () => {
    assert.equal(escapeHtml("a & b"), "a &amp; b");
  });

  test("escapes less-than", () => {
    assert.equal(escapeHtml("a < b"), "a &lt; b");
  });

  test("escapes greater-than", () => {
    assert.equal(escapeHtml("a > b"), "a &gt; b");
  });

  test("escapes double quote", () => {
    assert.equal(escapeHtml('say "hi"'), "say &quot;hi&quot;");
  });

  test("escapes single quote", () => {
    assert.equal(escapeHtml("it's"), "it&#39;s");
  });

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
