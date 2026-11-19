/**
 * Markdown -> Telegram HTML. Telegram's HTML parse mode supports only a small
 * tag set (b, i, s, code, pre, a, blockquote), so headings become bold, lists
 * keep a bullet glyph and tables go into <pre>. Pure, no IO.
 *
 * Output is best-effort: crossing emphasis can yield invalid nesting. The
 * sender falls back to plain text when Telegram rejects a message.
 */

import { splitMessage } from "./telegram-helpers.js";

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Inline spans. Code and links are stashed behind placeholders first so their
// contents are never touched by the emphasis rules.
function inline(s) {
  const stash = [];
  const keep = (html) => {
    stash.push(html);
    return `\u0000${stash.length - 1}\u0000`;
  };
  let t = s.replace(/`([^`\n]+)`/g, (_, c) => keep(`<code>${esc(c)}</code>`));
  t = t.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, label, url) =>
    keep(`<a href="${esc(url).replace(/"/g, "&quot;")}">${esc(label)}</a>`),
  );
  t = esc(t);
  t = t.replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, "<b>$1</b>");
  t = t.replace(/__(?=\S)(.+?)(?<=\S)__/g, "<b>$1</b>");
  t = t.replace(/~~(?=\S)(.+?)(?<=\S)~~/g, "<s>$1</s>");
  t = t.replace(/(?<![\w*])\*(?=[^\s*])(.+?)(?<=[^\s*])\*(?![\w*])/g, "<i>$1</i>");
  t = t.replace(/(?<!\w)_(?=\S)(.+?)(?<=\S)_(?!\w)/g, "<i>$1</i>");
  return t.replace(/\u0000(\d+)\u0000/g, (_, i) => stash[Number(i)]);
}

const FENCE_OPEN = /^\s*```+\s*([^\s`]*)/;
const FENCE_CLOSE = /^\s*```+\s*$/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;

/**
 * @param {string} md
 * @returns {string} Telegram HTML
 */
export function markdownToTelegramHtml(md) {
  const lines = md.replace(/\u0000/g, "").split("\n");
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    const fence = line.match(FENCE_OPEN);
    if (fence) {
      const body = [];
      i++;
      while (i < lines.length && !FENCE_CLOSE.test(lines[i])) body.push(lines[i++]);
      i++; // closing fence (or EOF)
      const lang = fence[1].replace(/[^\w+-]/g, "");
      const code = esc(body.join("\n"));
      out.push(lang ? `<pre><code class="language-${lang}">${code}</code></pre>` : `<pre>${code}</pre>`);
      continue;
    }

    if (TABLE_ROW.test(line) && i + 1 < lines.length && TABLE_ROW.test(lines[i + 1])) {
      const rows = [];
      while (i < lines.length && TABLE_ROW.test(lines[i])) rows.push(lines[i++]);
      out.push(`<pre>${esc(rows.join("\n"))}</pre>`);
      continue;
    }

    if (/^>\s?/.test(line)) {
      const quoted = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) quoted.push(lines[i++].replace(/^>\s?/, ""));
      out.push(`<blockquote>${inline(quoted.join("\n"))}</blockquote>`);
      continue;
    }

    const heading = line.match(/^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/);
    if (heading) {
      out.push(`<b>${inline(heading[1])}</b>`);
      i++;
      continue;
    }

    const bullet = line.match(/^(\s*)[-*+]\s+(.*)$/);
    out.push(bullet ? `${bullet[1]}\u2022 ${inline(bullet[2])}` : inline(line));
    i++;
  }
  return out.join("\n");
}

/**
 * Split Markdown into chunks that each stay balanced: a code fence cut by the
 * size limit is closed at the end of one chunk and reopened in the next. The
 * default is below Telegram's cap to leave room for HTML escaping.
 * @param {string} text
 * @param {number} [max]
 * @returns {string[]}
 */
export function splitMarkdown(text, max = 3000) {
  const out = [];
  let reopen = null;
  for (let chunk of splitMessage(text, max)) {
    if (reopen) chunk = `${reopen}\n${chunk}`;
    let open = null;
    for (const line of chunk.split("\n")) {
      if (FENCE_OPEN.test(line)) open = open ? null : line.trim();
    }
    if (open) chunk += "\n```";
    reopen = open;
    out.push(chunk);
  }
  return out;
}
