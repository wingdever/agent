"use strict";

// HTTP(S) retrieval behind web_fetch: validates and pins public destinations,
// follows only same-origin redirects, enforces time and size limits, and
// decodes the body to text. Presentation (markdown conversion, truncation
// footer) lives in render.js. Requests carry no cookies or ambient credentials.

const http = require("http");
const https = require("https");
const zlib = require("zlib");

const { DEFAULTS } = require("./config");
const { WebToolError } = require("./errors");
const {
  validateFetchUrl,
  isSameOrigin,
  classifyContentType,
  parseCharset,
  decoderForCharset,
} = require("./policy");
const { resolvePublicAddresses, pinnedLookup, stripIpv6Brackets } = require("./network");

const ACCEPT_HEADER = "text/html,application/xhtml+xml,text/*;q=0.9,application/json;q=0.8";
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

class HttpFetcher {
  // `limits` overrides the DSH defaults; `resolveAddresses` is injectable so
  // tests can point at a local server without weakening the public-IP policy.
  constructor({ limits = {}, resolveAddresses } = {}) {
    this.limits = {
      maxResponseBytes: DEFAULTS.fetchMaxResponseBytes,
      maxBodyChars: DEFAULTS.fetchMaxBodyChars,
      timeoutMs: DEFAULTS.fetchTimeoutMs,
      maxRedirects: DEFAULTS.fetchMaxRedirects,
      userAgent: DEFAULTS.userAgent,
      ...limits,
    };
    this.resolveAddresses = resolveAddresses || resolvePublicAddresses;
  }

  // Fetch one URL and return { url, statusCode, body: { kind, content }, truncated }.
  async fetch(initialUrl, signal) {
    const initial = validateFetchUrl(initialUrl);
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.limits.timeoutMs);
    if (typeof timer.unref === "function") timer.unref();

    const composite = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    try {
      return await this.followAndRead(initial, composite);
    } catch (error) {
      if (error instanceof WebToolError) throw error;
      if (timedOut) throw new WebToolError("web fetch timed out");
      if (signal && signal.aborted) throw new WebToolError("web fetch aborted");
      throw new WebToolError("web fetch failed: " + String(error));
    } finally {
      clearTimeout(timer);
    }
  }

  async followAndRead(initial, signal) {
    let currentUrl = initial;
    let redirectsFollowed = 0;

    for (;;) {
      const response = await this.requestOnce(currentUrl, signal);

      if (REDIRECT_STATUSES.has(response.statusCode)) {
        if (redirectsFollowed >= this.limits.maxRedirects) {
          response.destroy();
          throw new WebToolError(
            "exceeded the maximum of " + this.limits.maxRedirects + " redirects"
          );
        }
        const location = response.headers.location;
        if (location === undefined || location === null) {
          response.destroy();
          throw new WebToolError(
            "redirect response (HTTP " + response.statusCode + ") without a Location header"
          );
        }

        let validatedTarget;
        try {
          const target = new URL(location, currentUrl);
          validatedTarget = validateFetchUrl(target.toString());
          if (!isSameOrigin(validatedTarget, currentUrl)) {
            throw new WebToolError(
              "cross-origin redirect to " +
                validatedTarget.origin +
                " is not followed automatically; retry against that URL directly"
            );
          }
        } catch (error) {
          response.destroy();
          throw error;
        }

        response.destroy();
        currentUrl = validatedTarget;
        redirectsFollowed += 1;
        continue;
      }

      return await this.readBody(response, currentUrl);
    }
  }

  async requestOnce(url, signal) {
    const addresses = await this.resolveAddresses(url.hostname, signal);
    const transport = url.protocol === "https:" ? https : http;
    const headers = {
      accept: ACCEPT_HEADER,
      "accept-encoding": "gzip, deflate, br",
      "user-agent": this.limits.userAgent,
      host: url.host,
    };

    return new Promise((resolve, reject) => {
      const request = transport.request(
        {
          protocol: url.protocol,
          hostname: stripIpv6Brackets(url.hostname),
          port: url.port || (url.protocol === "https:" ? 443 : 80),
          path: (url.pathname || "/") + url.search,
          method: "GET",
          headers,
          lookup: pinnedLookup(addresses),
          signal,
        },
        (response) => resolve(response)
      );
      request.on("error", reject);
      request.end();
    });
  }

  async readBody(response, finalUrl) {
    const contentType = response.headers["content-type"];
    const kind = classifyContentType(contentType);
    if (kind === undefined) {
      response.destroy();
      throw new WebToolError('unsupported content type "' + (contentType || "unknown") + '"');
    }

    let decoder;
    try {
      decoder = decoderForCharset(parseCharset(contentType));
    } catch (error) {
      response.destroy();
      throw error;
    }

    const declared = Number(response.headers["content-length"]);
    if (Number.isFinite(declared) && declared > this.limits.maxResponseBytes) {
      response.destroy();
      throw new WebToolError(
        "response exceeds the maximum of " + this.limits.maxResponseBytes + " bytes"
      );
    }

    const stream = decodedStream(response);
    const { bytes, truncatedByBytes } = await readCapped(stream, this.limits.maxResponseBytes);
    const decoded = decoder.decode(bytes);
    const truncatedByChars = decoded.length > this.limits.maxBodyChars;
    const content = truncatedByChars ? decoded.slice(0, this.limits.maxBodyChars) : decoded;

    return {
      url: finalUrl.toString(),
      statusCode: response.statusCode,
      body: { kind, content },
      truncated: truncatedByBytes || truncatedByChars,
    };
  }
}

// Wrap the response in the decoder its Content-Encoding asks for. `identity`
// and a missing header pass through untouched.
function decodedStream(response) {
  const encoding = String(response.headers["content-encoding"] || "")
    .toLowerCase()
    .trim();
  if (encoding === "" || encoding === "identity") return response;
  if (encoding === "gzip" || encoding === "x-gzip") return response.pipe(zlib.createGunzip());
  if (encoding === "deflate") return response.pipe(zlib.createInflate());
  if (encoding === "br") return response.pipe(zlib.createBrotliDecompress());
  response.destroy();
  throw new WebToolError('unsupported content encoding "' + encoding + '"');
}

// Read at most maxBytes from a (possibly decompressed) stream. A chunk that
// crosses the cap is cut at the boundary, which marks the result truncated; an
// exactly-at-cap body still observes EOF and is not flagged.
async function readCapped(stream, maxBytes) {
  const chunks = [];
  let total = 0;
  let truncated = false;

  try {
    for await (const chunk of stream) {
      const remaining = maxBytes - total;
      if (chunk.length > remaining) {
        if (remaining > 0) {
          chunks.push(chunk.subarray(0, remaining));
          total += remaining;
        }
        truncated = true;
        break;
      }
      chunks.push(chunk);
      total += chunk.length;
    }
  } catch (error) {
    if (!truncated) throw error;
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return { bytes, truncatedByBytes: truncated };
}

module.exports = { HttpFetcher, ACCEPT_HEADER };
