"use strict";

// JSON-RPC over HTTP + AgentCard for the A2A inbound edge. The server owns
// transport concerns (auth, body limit, status codes); A2AService owns the
// Task state machine.

import http from "http";
import { A2AError, A2A_ERROR } from "./index.js";

const MAX_BODY = 1024 * 1024;

function sendJson(res, status, value, extraHeaders = {}) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "A2A-Version": "1.0",
    ...extraHeaders,
  });
  res.end(body);
}

function rpcError(res, id, code, message, data) {
  sendJson(res, 200, {
    jsonrpc: "2.0",
    id: id == null ? null : id,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  });
}

function bearer(header) {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1] : null;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error("request body too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export class A2AHttpServer {
  constructor({ service, instanceId, host = "127.0.0.1", port = 8787, baseUrl = null, token = null, logger = console }) {
    this.service = service;
    this.instanceId = instanceId;
    this.host = host;
    this.port = port;
    this.baseUrl = baseUrl || `http://${host}:${port}`;
    this.token = token || null;
    this.logger = logger;
    this.server = null;
  }

  async start() {
    if (this.server) return this.address();
    this.server = http.createServer((req, res) => {
      this._handle(req, res).catch((err) => {
        this.logger?.error?.("[a2a] request failed: " + (err && err.stack || err));
        if (!res.headersSent) sendJson(res, 500, { error: "internal error" });
      });
    });
    // Do not keep the process alive solely for idle sockets.
    this.server.keepAliveTimeout = 5000;
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.port, this.host, () => {
        this.server.off("error", reject);
        resolve();
      });
    });
    this.address();
    return this.address();
  }

  address() {
    const addr = this.server && this.server.address();
    const port = addr && typeof addr === "object" ? addr.port : this.port;
    if (this.port === 0 && port) this.baseUrl = `http://${this.host}:${port}`;
    return { host: this.host, port, baseUrl: this.baseUrl };
  }

  async stop() {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    await new Promise((resolve) => server.close(resolve));
  }

  async _handle(req, res) {
    const url = new URL(req.url || "/", this.baseUrl);
    if (req.method === "GET") {
      const cardMatch = /^\/a2a\/([^/]+)\/agent-card\.json$/.exec(url.pathname);
      if (cardMatch || url.pathname === "/.well-known/agent-card.json") {
        const instanceId = decodeURIComponent(cardMatch ? cardMatch[1] : this.instanceId);
        const card = await this.service.agentCard(instanceId, { baseUrl: this.baseUrl, tokenRequired: !!this.token });
        return sendJson(res, 200, card, { "cache-control": "no-store" });
      }
      return sendJson(res, 404, { error: "not found" });
    }
    if (req.method !== "POST") return sendJson(res, 405, { error: "method not allowed" }, { allow: "POST, GET" });

    const rpcMatch = /^\/a2a\/([^/]+)\/?$/.exec(url.pathname);
    if (!rpcMatch) return sendJson(res, 404, { error: "not found" });
    const instanceId = decodeURIComponent(rpcMatch[1]);
    if (this.token) {
      const provided = bearer(req.headers.authorization);
      if (!provided || provided !== this.token) return sendJson(res, 401, { error: "unauthorized" }, { "www-authenticate": 'Bearer realm="a2a"' });
    }

    let raw;
    try { raw = await readBody(req); } catch (err) {
      return sendJson(res, err.status || 400, { error: err.message });
    }
    let body;
    try { body = JSON.parse(raw); } catch (_) {
      return rpcError(res, null, -32700, "Parse error");
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) return rpcError(res, null, -32600, "Invalid Request");
    if (body.jsonrpc !== "2.0" || typeof body.method !== "string") return rpcError(res, body.id, -32600, "Invalid Request");

    try {
      const result = await this._dispatch(instanceId, body.method, body.params || {});
      return sendJson(res, 200, { jsonrpc: "2.0", id: body.id == null ? null : body.id, result });
    } catch (err) {
      if (err instanceof A2AError) return rpcError(res, body.id, err.code, err.message, err.data);
      this.logger?.error?.("[a2a] " + (err && err.stack || err));
      return rpcError(res, body.id, -32603, "Internal error");
    }
  }

  async _dispatch(instanceId, method, params) {
    switch (method) {
      case "SendMessage":
        return this.service.sendMessage(instanceId, params);
      case "GetTask":
        return this.service.getTask({ ...params, instanceId });
      case "CancelTask":
        return this.service.cancelTask({ ...params, instanceId });
      case "ListTasks":
        return this.service.listTasks({ ...params, instanceId });
      case "GetExtendedAgentCard":
        return this.service.agentCard(instanceId, { baseUrl: this.baseUrl, tokenRequired: !!this.token });
      case "SendStreamingMessage":
      case "SubscribeToTask":
        throw new A2AError(A2A_ERROR.UNSUPPORTED, `${method} is not supported by this MVP`);
      default:
        throw new A2AError(A2A_ERROR.UNSUPPORTED, `Method not found: ${method}`);
    }
  }
}

export default A2AHttpServer;
