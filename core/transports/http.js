"use strict";
import http from "http";

// HTTP transport: REST + SSE. It knows only the RPC registry's streaming flag;
// it never special-cases domain command names.
function createHttpTransport(options = {}) {
  const port = options.port || process.env.AGENT_PORT || 18765;
  const host = options.host || "127.0.0.1";
  return {
    name: "http",
    start(core) {
      return new Promise((resolve, reject) => {
        const server = http.createServer((req, res) => {
          const origin = req.headers.origin || "*";
          res.setHeader("Access-Control-Allow-Origin", origin);
          res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
          res.setHeader("Access-Control-Allow-Headers", "Content-Type");
          if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

          if (req.method === "POST" && req.url === "/api/call") {
            let body = "";
            req.on("data", (c) => (body += c));
            req.on("end", async () => {
              let payload;
              try { payload = JSON.parse(body || "{}"); } catch (_) { res.writeHead(400); return res.end("bad json"); }
              const fn = payload.fn;
              const params = payload.params || {};
              const callId = payload.callId || "";
              const onEvent = (e) => res.write("data: " + JSON.stringify(Object.assign({ callId }, e)) + "\n\n");

              if (core.rpc.isStreaming(fn)) {
                res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
                try {
                  const result = await core.rpc.handle(fn, params, { onEvent });
                  res.write("data: " + JSON.stringify({ callId, type: "result", result: result ?? null }) + "\n\n");
                } catch (err) {
                  res.write("data: " + JSON.stringify({ callId, type: "error", error: String(err.message || err) }) + "\n\n");
                }
                res.write("data: [DONE]\n\n");
                return res.end();
              }

              try {
                const result = await core.rpc.handle(fn, params, { onEvent });
                res.writeHead(200, { "Content-Type": "application/json" });
                return res.end(JSON.stringify(result ?? null));
              } catch (err) {
                res.writeHead(400, { "Content-Type": "application/json" });
                return res.end(JSON.stringify({ error: String(err.message || err) }));
              }
            });
            return;
          }
          res.writeHead(404); res.end("not found");
        });
        server.on("error", reject);
        server.listen(port, host, () => {
          console.log("[http] listening on http://" + host + ":" + port);
          resolve(server);
        });
      });
    },
  };
}

const __exports = { createHttpTransport };
export { createHttpTransport };
export default __exports;
