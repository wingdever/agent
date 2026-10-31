"use strict";
const { createHttpTransport } = require("./transports/http");
const { createIpcTransport } = require("./transports/ipc");

// 传输层注册表：默认 http，可由 AGENT_TRANSPORT 切换
const registry = { http: createHttpTransport, ipc: createIpcTransport };
const DEFAULT = "http";

async function startTransport(name, core, options) {
  const make = registry[name] || registry[DEFAULT];
  return await make(options || {}).start(core);
}

module.exports = { registry, startTransport, DEFAULT };
 