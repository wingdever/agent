"use strict";
import { createHttpTransport } from "./transports/http.js";
import { createIpcTransport } from "./transports/ipc.js";

// 传输层注册表：默认 http，可由 AGENT_TRANSPORT 切换
const registry = { http: createHttpTransport, ipc: createIpcTransport };
const DEFAULT = "http";

async function startTransport(name, core, options) {
  const make = registry[name] || registry[DEFAULT];
  return await make(options || {}).start(core);
}

const __exports = { registry, startTransport, DEFAULT };
export { registry, startTransport, DEFAULT };
export default __exports;
 