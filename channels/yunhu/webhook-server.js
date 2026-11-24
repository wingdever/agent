"use strict";

// Webhook listener for yunhu events.
//
// A webhook channel needs an inbound HTTP endpoint, which is exactly the piece
// this machine cannot offer on its own (NAT, no public port). So the server binds
// loopback and expects something in front of it: a temporary tunnel, or a reverse
// proxy on a machine that does have an ingress. `publicUrl` is kept outside the
// server so the operator can log the tunnel URL without this module knowing about
// tunnels.
//
// Ack discipline: the platform retries when the callback is slow, so the handler
// is called synchronously and the response goes out immediately. The pipeline
// acks by contract without running a turn.

import http from "http";

/**
 * @param {{port?: number, path?: string, host?: string, secret?: string, onEvent: Function, onError?: Function}} options
 */
export function createWebhookServer({
  port = 0,
  path = "/webhook",
  host = "127.0.0.1",
  secret = "",
  onEvent,
  onError = null,
} = {}) {
  if (typeof onEvent !== "function") throw new TypeError("webhook server needs an onEvent handler");

  let server = null;
  let url = "";
  const stats = { received: 0, rejected: 0, errors: 0, duplicates: 0 };

  function reply(res, status, body) {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", Connection: "close" });
    res.end(JSON.stringify(body));
  }

  function handle(req, res) {
    if (req.method !== "POST") {
      stats.rejected++;
      reply(res, 405, { ok: false, error: "method not allowed" });
      return;
    }
    const requestUrl = new URL(req.url, `http://${host}`);
    if (requestUrl.pathname.replace(/\/+$/, "") !== path.replace(/\/+$/, "")) {
      stats.rejected++;
      reply(res, 404, { ok: false, error: "not found" });
      return;
    }
    // Optional shared secret. The platform's own signature scheme is not documented
    // anywhere I could verify, so this is a plain token and it is *optional*: inventing
    // a verification step that the platform does not perform would only look secure.
    if (secret) {
      const provided = requestUrl.searchParams.get("secret") || req.headers["x-yunhu-secret"] || "";
      if (provided !== secret) {
        stats.rejected++;
        reply(res, 403, { ok: false, error: "bad secret" });
        return;
      }
    }

    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      // A runaway body is a platform bug or an attack, not a message.
      if (body.length > 1024 * 1024) {
        req.destroy();
      }
    });
    req.on("end", () => {
      let payload;
      try {
        payload = JSON.parse(body || "{}");
      } catch (_) {
        stats.rejected++;
        reply(res, 400, { ok: false, error: "bad json" });
        return;
      }
      stats.received++;
      try {
        const result = onEvent(payload);
        if (result && result.accepted === false) stats.duplicates++;
        // Ack before any turn: the platform only needs to know we took it.
        reply(res, 200, { ok: true });
      } catch (err) {
        stats.errors++;
        if (onError) onError(err, payload);
        reply(res, 500, { ok: false });
      }
    });
  }

  return {
    async listen() {
      server = http.createServer(handle);
      server.keepAliveTimeout = 0;
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.off("error", reject);
          resolve();
        });
      });
      const actual = server.address();
      url = `http://${host}:${actual.port}${path}`;
      return { url, port: actual.port };
    },

    async close() {
      if (!server) return;
      const closing = server;
      server = null;
      await new Promise((resolve) => closing.close(() => resolve()));
    },

    get url() {
      return url;
    },
    get stats() {
      return { ...stats };
    },
  };
}
