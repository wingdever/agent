"use strict";

// IPC transport (Electron main process): renderer commands go through the same
// RPC registry as HTTP.
function createIpcTransport() {
  return {
    name: "ipc",
    async start(core) {
      // lazy：非 electron 环境永远不加载这个模块。ESM 用动态 import 保持同样的惰性
      const { ipcMain } = await import("electron");
      ipcMain.handle("agent:call", async (event, payload) => {
        const fn = payload && payload.fn;
        const params = (payload && payload.params) || {};
        const callId = payload && payload.callId;
        const onEvent = (e) => event.sender.send("agent:event", Object.assign({ callId }, e));
        return await core.rpc.handle(fn, params, { onEvent });
      });
    },
  };
}

const __exports = { createIpcTransport };
export { createIpcTransport };
export default __exports;
