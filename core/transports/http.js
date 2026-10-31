"use strict";
const http = require("http");
const { handleCall } = require("../index");

// HTTP 传输（默认）：REST + SSE 流式，绑定 127.0.0.1，开启 CORS
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

          if (req.method === "GET" && req.url === "/api/functions") {
            res.writeHead(200, { "Content-Type": "application/json" });
            return res.end(JSON.stringify(core.listFunctions()));
          }

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
              if (fn === "chat") {
                res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
                try { await core.chat(Object.assign({ onEvent }, params)); }
                catch (err) { res.write("data: " + JSON.stringify({ callId, type: "error", error: String(err.message || err) }) + "\n\n"); }
                res.write("data: [DONE]\n\n");
                return res.end();
              }
              try {
                const result = await handleCall(core, { fn, params, onEvent });
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
        server.on("error", reject); // 端口占用等错误交给上层处理
        server.listen(port, host, () => {
          console.log("[http] listening on http://" + host + ":" + port);
          resolve(server);
        });
      });
    },
  };
}

module.exports = { createHttpTransport };
 