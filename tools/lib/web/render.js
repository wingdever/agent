"use strict";

// Model-facing rendering for web_fetch: HTML becomes markdown through the same
// turndown configuration DSH uses (ATX headings, fenced code, GFM tables), and
// the complete output is bounded by fetchMaxOutputChars with DSH's truncation
// footer. Text bodies pass through verbatim.

const TurndownService = require("turndown");
const { gfm } = require("@joplin/turndown-plugin-gfm");

const { DEFAULTS } = require("./config");
const { EXTERNAL_WEB_CONTENT_NOTICE } = require("./trust");

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
});
turndown.use(gfm);
turndown.addRule("removeNonVisibleContent", {
  filter(node) {
    if (
      ["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "IFRAME", "OBJECT", "EMBED"].includes(node.nodeName)
    ) {
      return true;
    }
    if (node.hasAttribute("hidden") || node.getAttribute("aria-hidden")?.toLowerCase() === "true") {
      return true;
    }
    if (node.nodeName === "INPUT" && node.getAttribute("type")?.toLowerCase() === "hidden") {
      return true;
    }
    const declarations = node.getAttribute("style")?.split(";") ?? [];
    return declarations.some((declaration) => {
      const separator = declaration.indexOf(":");
      if (separator === -1) return false;
      const property = declaration.slice(0, separator).trim().toLowerCase();
      const value = declaration
        .slice(separator + 1)
        .trim()
        .toLowerCase()
        .replace(/\s*!important\s*$/u, "");
      return (
        (property === "display" && value === "none") ||
        (property === "visibility" && (value === "hidden" || value === "collapse"))
      );
    });
  },
  replacement() {
    return "";
  },
});

// Render one GFM table cell without expanding colspan, which markdown cannot
// represent.
function renderTableCell(content, index) {
  const prefix = index === 0 ? "| " : " ";
  const escaped = content
    .trim()
    .replace(/\n\r/g, "<br>")
    .replace(/\n/g, "<br>")
    .replace(/\|+/g, "\\|")
    .padEnd(3, " ");
  return prefix + escaped + " |";
}

function isTableHeadingRow(row) {
  const cells = Array.from(row.cells);
  const section = row.parentElement;
  const table = section.parentElement;
  return (
    (section.nodeName === "THEAD" || table.rows[0] === row) &&
    cells.every((cell) => cell.nodeName === "TH")
  );
}

function tableBorder(cell) {
  const alignment = (cell.getAttribute("align") || cell.style.textAlign || "").toLowerCase();
  if (alignment === "left") return ":---";
  if (alignment === "right") return "---:";
  if (alignment === "center") return ":---:";
  return "---";
}

turndown.addRule("tableCellWithoutSpanExpansion", {
  filter: ["th", "td"],
  replacement(content, node) {
    const cell = node;
    const row = cell.parentNode;
    return renderTableCell(content, Array.prototype.indexOf.call(row.childNodes, cell));
  },
});
turndown.addRule("tableRowWithoutSpanExpansion", {
  filter: "tr",
  replacement(content, node) {
    const row = node;
    const border = isTableHeadingRow(row)
      ? Array.from(row.cells, (cell, index) => renderTableCell(tableBorder(cell), index)).join("")
      : "";
    return "\n" + content + (border.length > 0 ? "\n" + border : "");
  },
});

const TRUNCATION_FOOTER =
  "\n\n(Content truncated. Fetch a more specific URL or section for the full text.)";

// HTML nesting above this depth makes turndown's DOM walk superlinear. Real
// pages nest a few dozen levels, so a body this deep is treated as unsafe and
// omitted rather than converted synchronously on the event loop.
const MAX_CONVERSION_DEPTH = 512;
const VOID_ELEMENTS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr",
]);
const RAW_TEXT_ELEMENTS = new Set(["script", "style", "noscript"]);

function isTagBoundary(char) {
  return char === undefined || char === ">" || char === "/" || /\s/.test(char);
}

// Matching raw-text end tag, without interpreting markup-like body text.
function findRawTextEnd(lowerHtml, name, from) {
  const prefix = "</" + name;
  let candidate = lowerHtml.indexOf(prefix, from);
  while (candidate !== -1 && !isTagBoundary(lowerHtml[candidate + prefix.length])) {
    candidate = lowerHtml.indexOf(prefix, candidate + prefix.length);
  }
  return candidate;
}

// Conservative single-pass depth check: comments are skipped, raw-text bodies
// are not parsed as markup, quoted `>` characters are respected, and only the
// current element may be closed. Malformed input over-counts rather than hiding
// nesting.
function exceedsConversionDepth(html) {
  const lowerHtml = html.toLowerCase();
  const openElements = [];
  let offset = 0;
  let inComment = false;

  while (offset < html.length) {
    const start = html.indexOf("<", offset);
    if (inComment) {
      const end = html.indexOf("-->", offset);
      if (end !== -1 && (start === -1 || end < start)) {
        inComment = false;
        offset = end + 3;
        continue;
      }
    }
    if (start === -1) break;
    if (!inComment && html.startsWith("<!--", start)) {
      inComment = true;
      offset = start + 4;
      continue;
    }

    let cursor = start + 1;
    const closing = html[cursor] === "/";
    if (closing) cursor += 1;
    const nameStart = cursor;
    while (/[a-zA-Z0-9-]/.test(html[cursor] ?? "")) cursor += 1;
    if (cursor === nameStart || !/[a-zA-Z]/.test(html.charAt(nameStart))) {
      offset = start + 1;
      continue;
    }

    const name = lowerHtml.slice(nameStart, cursor);
    let quote;
    while (cursor < html.length) {
      const char = html[cursor];
      cursor += 1;
      if (quote !== undefined) {
        if (char === quote) quote = undefined;
      } else if (char === '"' || char === "'") {
        quote = char;
      } else if (char === ">") {
        break;
      }
    }
    if (html[cursor - 1] !== ">") break;

    if (closing) {
      if (!inComment && openElements[openElements.length - 1] === name) openElements.pop();
    } else {
      let last = cursor - 2;
      while (/\s/.test(html.charAt(last))) last -= 1;
      if (!VOID_ELEMENTS.has(name) && html[last] !== "/") {
        openElements.push(name);
        if (openElements.length > MAX_CONVERSION_DEPTH) return true;
        if (!inComment && RAW_TEXT_ELEMENTS.has(name)) {
          const end = findRawTextEnd(lowerHtml, name, cursor);
          if (end === -1) break;
          offset = end;
          continue;
        }
      }
    }
    offset = cursor;
  }
  return false;
}

// Render the body to markdown/text. The source prefix is cut before conversion
// so synchronous DOM work stays bounded.
function renderBody(body, maxInputChars) {
  const content = body.content.slice(0, maxInputChars);
  const sourceTruncated = content.length !== body.content.length;
  if (body.kind === "html") {
    if (exceedsConversionDepth(content)) {
      return { text: "[HTML content omitted: unable to convert safely.]", sourceTruncated };
    }
    try {
      return { text: turndown.turndown(content), sourceTruncated };
    } catch (_) {
      return { text: "[HTML content omitted: unable to convert safely.]", sourceTruncated };
    }
  }
  if (body.kind === "text") return { text: content, sourceTruncated };
  throw new Error("unhandled web fetch body kind: " + String(body.kind));
}

// Compose the fetched header, rendered body, and truncation footer, bounded as
// a whole. Returns the exact text and the effective truncation flag.
function renderFetchOutput(result, maxOutputChars = DEFAULTS.fetchMaxOutputChars) {
  const header =
    "Fetched " + result.url + " (HTTP " + result.statusCode + ")\n\n" +
    EXTERNAL_WEB_CONTENT_NOTICE + "\n\n";
  const rendered = renderBody(result.body, maxOutputChars);
  const prefix = header + rendered.text;
  const truncated =
    result.truncated || rendered.sourceTruncated || prefix.length > maxOutputChars;
  const full = prefix + (truncated ? TRUNCATION_FOOTER : "");
  if (full.length <= maxOutputChars) return { text: full, truncated };
  if (maxOutputChars < TRUNCATION_FOOTER.length) {
    return { text: full.slice(0, maxOutputChars), truncated };
  }
  return {
    text: prefix.slice(0, maxOutputChars - TRUNCATION_FOOTER.length) + TRUNCATION_FOOTER,
    truncated,
  };
}

function formatFetchOutput(result, maxOutputChars = DEFAULTS.fetchMaxOutputChars) {
  return renderFetchOutput(result, maxOutputChars).text;
}

module.exports = {
  TRUNCATION_FOOTER,
  formatFetchOutput,
  renderFetchOutput,
  renderBody,
};
