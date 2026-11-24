"use strict";

// Direct HTTPS fetch that ignores proxy environment variables.
//
// Why this exists: the cloud host routes outbound HTTP through a hijacking proxy
// via HTTP(S)_PROXY. That proxy intermittently answers the Feishu Open API with
// "504 hijack proxy request failed" (measured: the reply card POST right after an
// inbound event), and Node's global fetch does not honor NO_PROXY by default. A
// bot that misses one card because of a proxy hiccup is indistinguishable from a
// bot that is broken, so the entry point injects this instead of global fetch.
//
// Shape matches just enough of fetch() for the channel driver: { ok, status,
// headers, json(), text() }. No redirects, no streaming: every Feishu call this
// serves is a small JSON request/response.

import https from "node:https";
import http from "node:http";

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * @param {{timeoutMs?: number}} [options]
 * @returns {typeof fetch}
 */
export function createDirectFetch({ timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  function directFetch(url, { method = "GET", headers = {}, body } = {}) {
    return new Promise((resolve, reject) => {
      const target = new URL(url);
      const transport = target.protocol === "http:" ? http : https;
      // Feishu answers chunked request bodies with "invalid param" on the token
      // endpoint, so the body length is stated explicitly.
      const sendHeaders = { ...headers };
      if (body !== undefined && !Object.keys(sendHeaders).some((k) => k.toLowerCase() === "content-length")) {
        sendHeaders["Content-Length"] = Buffer.byteLength(body);
      }
      const req = transport.request(
        {
          protocol: target.protocol,
          hostname: target.hostname,
          port: target.port || undefined,
          path: target.pathname + target.search,
          method,
          headers: sendHeaders,
        },
        (res) => {
          let data = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => {
            data += chunk;
          });
          res.on("end", () => {
            const status = res.statusCode || 0;
            resolve({
              ok: status >= 200 && status < 300,
              status,
              headers: res.headers,
              text: async () => data,
              json: async () => JSON.parse(data || "{}"),
            });
          });
        }
      );
      req.setTimeout(timeoutMs, () => req.destroy(new Error(`direct fetch timeout after ${timeoutMs}ms`)));
      req.on("error", reject);
      if (body !== undefined) req.write(body);
      req.end();
    });
  }

  return directFetch;
}
