"use strict";
// Network capture tracker for LLM calls.
// Persists one JSON file per capture under
// log/network/track/data/<provider>/<model>/<sessionId>-<timestamp>.json
// (structured: response body parsed/expanded for readability) and a matching
// raw file under
// log/network/track/raw/<provider>/<model>/<sessionId>-<timestamp>.json
// (verbatim request + response bytes, no SSE expansion / JSON parsing).
// Both files share the same <sessionId>-<timestamp> name for easy pairing.
// Prints a one-line summary per call (unless NETTRACK_QUIET=1).
//
// Capture is ON by default; set NETTRACK=0 to disable (applies to both trees).

const fs = require("fs");
const path = require("path");

const ENABLED = process.env.NETTRACK !== "0";
const QUIET = process.env.NETTRACK_QUIET === "1";
const DATA_DIR = path.join(__dirname, "..", "..", "..", "log", "network", "track", "data");
const RAW_DIR = path.join(__dirname, "..", "..", "..", "log", "network", "track", "raw");

const SENSITIVE = new Set(["authorization", "cookie", "x-api-key", "proxy-authorization"]);

function sanitize(s) {
  return String(s == null ? "-" : s).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
}

function redactHeaders(headers) {
  const out = {};
  for (const k of Object.keys(headers || {})) {
    out[k] = SENSITIVE.has(k.toLowerCase()) ? "***" : headers[k];
  }
  return out;
}

// Turn a raw response body into a structured value when possible.
// - SSE (text/event-stream or data: lines): array of parsed data events.
// - Plain JSON: the parsed object.
// - Otherwise: the original string.
function expandBody(raw, headers) {
  if (typeof raw !== "string" || !raw.trim()) return raw;
  const ct = ((headers && headers["content-type"]) || "").toLowerCase();
  if (ct.includes("text/event-stream") || /(^|\n)data:/.test(raw)) {
    const events = [];
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (t.indexOf("data:") !== 0) continue;
      const data = t.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      try { events.push(JSON.parse(data)); }
      catch (_) { events.push(data); }
    }
    if (events.length) return { format: "sse", events };
  }
  try { return JSON.parse(raw); }
  catch (_) { return raw; }
}

function recordCapture(cap) {
  if (!ENABLED) return;
  try {
    const dir = path.join(DATA_DIR, sanitize(cap.provider), sanitize(cap.model));
    fs.mkdirSync(dir, { recursive: true });
    const ts = Date.now();
    const file = path.join(dir, sanitize(cap.sessionId) + "-" + ts + ".json");
    const record = {
      timestamp: new Date(ts).toISOString(),
      provider: cap.provider,
      model: cap.model,
      sessionId: cap.sessionId,
      method: cap.method,
      host: cap.host,
      path: cap.path,
      status: cap.status,
      durationMs: cap.durationMs,
      request: {
        url: cap.request && cap.request.url,
        headers: redactHeaders(cap.request && cap.request.headers),
        body: cap.request ? cap.request.body : null,
      },
      response: {
        headers: redactHeaders(cap.response && cap.response.headers),
        body: expandBody((cap.response && cap.response.body) || "", cap.response && cap.response.headers),
      },
    };
    fs.writeFileSync(file, JSON.stringify(record, null, 2));

    // Raw twin: verbatim request + response bytes, no expansion/parsing.
    const reqBody = cap.request && cap.request.body;
    const reqRaw = reqBody == null
      ? null
      : typeof reqBody === "string" ? reqBody : JSON.stringify(reqBody);
    const rawRecord = {
      timestamp: record.timestamp,
      provider: cap.provider,
      model: cap.model,
      sessionId: cap.sessionId,
      method: cap.method,
      host: cap.host,
      path: cap.path,
      status: cap.status,
      durationMs: cap.durationMs,
      request: {
        url: cap.request && cap.request.url,
        headers: redactHeaders(cap.request && cap.request.headers),
        body: reqRaw,
      },
      response: {
        headers: redactHeaders(cap.response && cap.response.headers),
        body: (cap.response && cap.response.body) || "",
      },
    };
    const rawDir = path.join(RAW_DIR, sanitize(cap.provider), sanitize(cap.model));
    fs.mkdirSync(rawDir, { recursive: true });
    fs.writeFileSync(path.join(rawDir, sanitize(cap.sessionId) + "-" + ts + ".json"), JSON.stringify(rawRecord, null, 2));

    if (!QUIET) {
      console.log("[nettrack] " + cap.method + " " + cap.host + cap.path + " · " + cap.model + " · " + cap.status + " · " + cap.durationMs + "ms");
    }
  } catch (e) {
    if (!QUIET) console.error("[nettrack] record failed:", e.message);
  }
}

// Attach capture listeners to a (still-paused) response stream. Must be called
// synchronously alongside the caller's own listeners, BEFORE the stream starts
// flowing, so no chunks are missed. Accumulates raw Buffers to stay multibyte-safe.
function trackCapture(res, cap) {
  if (!ENABLED) return;
  const chunks = [];
  res.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c))));
  res.on("end", () => {
    cap.response.body = Buffer.concat(chunks).toString("utf8");
    recordCapture(cap);
  });
  res.on("error", () => {
    cap.response.body = Buffer.concat(chunks).toString("utf8");
    recordCapture(cap);
  });
}

module.exports = { recordCapture, trackCapture, expandBody, redactHeaders, ENABLED, QUIET };
