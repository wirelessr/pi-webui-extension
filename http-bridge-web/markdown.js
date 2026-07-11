/**
 * Minimal markdown renderer — no dependencies.
 *
 * Supports: headings, code blocks (fenced), inline code, bold, italic,
 * links, lists, blockquotes, horizontal rules, tables.
 *
 * Escapes HTML first, then applies markdown transformations.
 */

function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderInline(text) {
  const codePlaceholders = [];
  text = text.replace(/`([^`]+)`/g, (_, code) => {
    const idx = codePlaceholders.length;
    codePlaceholders.push(`<code>${escapeHtml(code)}</code>`);
    return `\x00CODE${idx}\x00`;
  });

  text = escapeHtml(text);

  text = text.replace(/\*\*([^\*]+)\*\*/g, "<strong>$1</strong>");
  text = text.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  text = text.replace(/(?<!\*)\*([^\*]+)\*(?!\*)/g, "<em>$1</em>");
  text = text.replace(/(?<!_)_([^_]+)_(?!_)/g, "<em>$1</em>");
  text = text.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  text = text.replace(
    /\[([^\]]+)\]\(([^)\s]+)\)/g,
    (_, label, url) => {
      const safe = /^(https?:|mailto:|\/|#)/i.test(url);
      const href = safe ? url : "#";
      return `<a href="${href}" target="_blank" rel="noopener">${label}</a>`;
    },
  );

  text = text.replace(/\x00CODE(\d+)\x00/g, (_, idx) => codePlaceholders[parseInt(idx)]);
  return text;
}

export function renderMarkdown(md) {
  if (!md) return "";

  const lines = md.split("\n");
  const html = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === "") { i++; continue; }

    // Fenced code block
    const fenceMatch = line.match(/^(\s*)(```|~~~)(\w*)/);
    if (fenceMatch) {
      const lang = fenceMatch[3] || "";
      const codeLines = [];
      i++;
      while (i < lines.length && !lines[i].match(/^(\s*)(```|~~~)/)) {
        codeLines.push(lines[i]);
        i++;
      }
      i++;
      const code = escapeHtml(codeLines.join("\n"));
      const langClass = lang ? ` class="language-${escapeHtml(lang)}"` : "";
      html.push(`<pre><code${langClass}>${code}</code></pre>`);
      continue;
    }

    // Heading
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      html.push(`<h${level}>${renderInline(headingMatch[2].trim())}</h${level}>`);
      i++;
      continue;
    }

    // Horizontal rule
    if (line.match(/^(\s*[-*_]){3,}\s*$/)) { html.push("<hr>"); i++; continue; }

    // Blockquote
    if (line.match(/^\s*>/)) {
      const quoteLines = [];
      while (i < lines.length && lines[i].match(/^\s*>/)) {
        quoteLines.push(lines[i].replace(/^\s*>\s?/, ""));
        i++;
      }
      html.push(`<blockquote>${renderInline(quoteLines.join(" "))}</blockquote>`);
      continue;
    }

    // Table
    if (line.includes("|") && i + 1 < lines.length && lines[i + 1].match(/^[\s|:-]+$/)) {
      const headerCells = line.split("|").map((c) => c.trim()).filter((c) => c !== "");
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim() !== "") {
        rows.push(lines[i].split("|").map((c) => c.trim()).filter((c) => c !== ""));
        i++;
      }
      let table = "<table><thead><tr>";
      for (const cell of headerCells) table += `<th>${renderInline(cell)}</th>`;
      table += "</tr></thead><tbody>";
      for (const row of rows) {
        table += "<tr>";
        for (const cell of row) table += `<td>${renderInline(cell)}</td>`;
        table += "</tr>";
      }
      table += "</tbody></table>";
      html.push(table);
      continue;
    }

    // Ordered list
    if (line.match(/^\s*\d+\.\s/)) {
      const items = [];
      while (i < lines.length && lines[i].match(/^\s*\d+\.\s/)) {
        items.push(`<li>${renderInline(lines[i].replace(/^\s*\d+\.\s+/, ""))}</li>`);
        i++;
      }
      html.push(`<ol>${items.join("")}</ol>`);
      continue;
    }

    // Unordered list
    if (line.match(/^\s*[-*]\s/)) {
      const items = [];
      while (i < lines.length && lines[i].match(/^\s*[-*]\s/)) {
        const itemText = lines[i].replace(/^\s*[-*]\s+/, "");
        const indent = lines[i].match(/^(\s*)/)[1].length;
        items.push(indent > 0
          ? `<li style="margin-left:${indent * 1.5}em">${renderInline(itemText)}</li>`
          : `<li>${renderInline(itemText)}</li>`);
        i++;
      }
      html.push(`<ul>${items.join("")}</ul>`);
      continue;
    }

    // Paragraph
    const paraLines = [];
    while (
      i < lines.length && lines[i].trim() !== "" &&
      !lines[i].match(/^(\s*)(```|~~~)/) &&
      !lines[i].match(/^#{1,6}\s/) &&
      !lines[i].match(/^(\s*[-*_]){3,}\s*$/) &&
      !lines[i].match(/^\s*>/) &&
      !lines[i].match(/^\s*\d+\.\s/) &&
      !lines[i].match(/^\s*[-*]\s/) &&
      !(lines[i].includes("|") && i + 1 < lines.length && lines[i + 1].match(/^[\s|:-]+$/))
    ) {
      paraLines.push(lines[i]);
      i++;
    }
    if (paraLines.length > 0) {
      html.push(`<p>${renderInline(paraLines.join("<br>"))}</p>`);
    }
  }

  return html.join("\n");
}
