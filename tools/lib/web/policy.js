"use strict";

// URL validation and content-type classification for web_fetch, mirroring the
// pure half of DSH's web-fetch-http provider. Kept free of network access so it
// is cheap to test and reuse before any destination is resolved.

const { DEFAULTS } = require("./config");
const { WebToolError } = require("./errors");

// Parse a URL and enforce the transport restrictions that need no DNS lookup:
// HTTP(S) only and no embedded credentials.
function parseFetchUrl(input) {
  let url;
  try {
    url = new URL(input);
  } catch (_) {
    throw new WebToolError("invalid URL: " + input);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new WebToolError(
      'unsupported URL scheme "' + url.protocol + '" (only http and https are allowed)'
    );
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new WebToolError("credentials in URLs are not allowed");
  }
  return url;
}

// Complete pre-network policy: bounded length plus scheme/credential checks.
function validateFetchUrl(input) {
  if (input.length > DEFAULTS.fetchMaxUrlLength) {
    throw new WebToolError("URL exceeds the maximum length of " + DEFAULTS.fetchMaxUrlLength);
  }
  return parseFetchUrl(input);
}

// Same scheme, hostname, and port. Redirects that cross origins are refused so
// every new origin requires a fresh tool call and fresh address validation.
function isSameOrigin(a, b) {
  return a.protocol === b.protocol && a.hostname === b.hostname && a.port === b.port;
}

// `text/html` and XHTML convert to markdown; other text and structured text
// pass through verbatim. Anything else (images, binaries) is unsupported.
function classifyContentType(contentType) {
  const mime = String(contentType == null ? "" : contentType)
    .replace(/;.*$/s, "")
    .trim()
    .toLowerCase();
  if (mime === "text/html" || mime === "application/xhtml+xml") return "html";
  if (mime.startsWith("text/")) return "text";
  if (
    mime === "application/json" ||
    mime === "application/xml" ||
    mime.endsWith("+json") ||
    mime.endsWith("+xml")
  ) {
    return "text";
  }
  return undefined;
}

// Lower-cased charset parameter from Content-Type, or undefined when absent.
function parseCharset(contentType) {
  const match = /;\s*charset\s*=\s*"?([^";]+)"?/i.exec(String(contentType == null ? "" : contentType));
  return match && match[1] ? match[1].trim().toLowerCase() : undefined;
}

// TextDecoder for the declared charset (UTF-8 when absent). An unrecognized
// label fails loudly instead of returning mojibake.
function decoderForCharset(charset) {
  if (charset === undefined) return new TextDecoder("utf-8");
  try {
    return new TextDecoder(charset);
  } catch (_) {
    throw new WebToolError('unsupported charset "' + charset + '"');
  }
}

module.exports = {
  parseFetchUrl,
  validateFetchUrl,
  isSameOrigin,
  classifyContentType,
  parseCharset,
  decoderForCharset,
};
