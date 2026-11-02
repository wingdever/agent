"use strict";
// HTTP communication for LLM calls. Lives in core/network/http/.
// The caller (core/index.js _stream) attaches the SSE parser AND the tracker's
// capture listener to the returned (still-paused) response stream, so the stream
// never flows before both listeners are attached and no chunk is missed.
// All outbound LLM traffic (chat/completions + /models) is captured via tracker.js.

const http = require("http");
const https = require("https");
const { URL } = require("url");
const { trackCapture, recordCapture } = require("./tracker");

// POST /chat/completions. Resolves with { stream, cap } where stream is the raw
// (paused) IncomingMessage and cap carries request metadata for the tracker.
function postChatCompletions({ baseUrl, apiKey, payload, sessionId }) {
  return new Promise((resolve, reject) => {
    let base;
    try {
      base = new URL(baseUrl);
    } catch (e) {
      return reject(new Error("baseUrl invalid: " + baseUrl));
    }
    const prefix = base.pathname.replace(/\/$/, "");
    const reqPath = prefix + "/chat/completions";
    const body = JSON.stringify(payload);
    const t0 = Date.now();
    const httpMod = base.protocol === "http:" ? http : https;

    const req = httpMod.request(
      {
        method: "POST",
        hostname: base.hostname,
        port: base.port || 443,
        path: reqPath,
        headers: {
          Authorization: "Bearer " + apiKey,
          "Content-Type": "application/json",
          Accept: payload.stream ? "text/event-stream" : "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
        timeout: 60000,
      },
      (res) => {
        const status = res.statusCode;
        const cap = {
          provider: base.hostname,
          model: payload.model || "-",
          method: "POST",
          host: base.hostname,
          path: reqPath,
          status,
          durationMs: Date.now() - t0,
          sessionId: sessionId || "-",
          request: {
            url: base.origin + reqPath,
            headers: { Authorization: "Bearer " + apiKey, "Content-Type": "application/json" },
            body: payload,
          },
          response: { headers: res.headers, body: "" },
        };

        if (status < 200 || status >= 300) {
          // Error path: capture here and reject. Stream flows as we read it.
          trackCapture(res, cap);
          let acc = "";
          res.on("data", (c) => (acc += c));
          res.on("end", () => reject(new Error("HTTP " + status + " " + acc.slice(0, 400))));
          return;
        }
        // OK path: caller attaches its parser + trackCapture; stream stays paused.
        resolve({ stream: res, cap });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.write(body);
    req.end();
  });
}

// GET /models. Returns the normalized model list and captures the call.
async function fetchModels(baseUrl, apiKey) {
  let u;
  try {
    u = new URL(baseUrl);
  } catch (e) {
    throw new Error("baseUrl invalid");
  }
  const prefix = u.pathname.replace(/\/$/, "");
  const url = u.origin + prefix + "/models";
  const headers = { Accept: "application/json" };
  if (apiKey) headers["Authorization"] = "Bearer " + apiKey;

  const t0 = Date.now();
  const cap = {
    provider: u.hostname,
    model: "-",
    method: "GET",
    host: u.hostname,
    path: prefix + "/models",
    status: 0,
    durationMs: 0,
    sessionId: "local",
    request: { url, headers: { ...headers }, body: null },
    response: { headers: {}, body: "" },
  };

  let json = {};
  let err = null;
  try {
    const res = await fetch(url, { method: "GET", headers });
    cap.status = res.status;
    cap.response.headers = res.headers ? Object.fromEntries(res.headers.entries()) : {};
    const text = await res.text();
    cap.response.body = text;
    if (!res.ok) throw new Error("HTTP " + res.status + (text ? " " + text.slice(0, 200) : ""));
    try {
      json = JSON.parse(text);
    } catch (_) {
      json = {};
    }
  } catch (e) {
    err = e;
  } finally {
    cap.durationMs = Date.now() - t0;
    recordCapture(cap);
  }
  if (err) throw err;

  const list = Array.isArray(json.data)
    ? json.data
    : Array.isArray(json.models)
    ? json.models
    : [];
  return list
    .map((m) => ({ id: m.id || m.name, owned_by: m.owned_by || "" }))
    .filter((m) => m.id);
}

module.exports = { postChatCompletions, fetchModels, trackCapture };
