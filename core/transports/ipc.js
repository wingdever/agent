"use strict";

// IPC transport (Electron main process): renderer commands go through the same
// RPC registry as HTTP.
function createIpcTransport() {
  return {
    name: "ipc",
    async start(core) {
      // lazy：非 electron 环境永远不加载这个模块。ESM 用动态 import 保持同样的惰性
      const { ipcMain } = await import("electron");
      const cancels = new Map();
      ipcMain.on("agent:cancel", (_event, callId) => {
        const cancel = cancels.get(callId);
        if (cancel) { cancels.delete(callId); cancel(); }
      });
      ipcMain.handle("agent:call", async (event, payload) => {
        const fn = payload && payload.fn;
        const params = (payload && payload.params) || {};
        const callId = payload && payload.callId;
        const onEvent = (e) => event.sender.send("agent:event", Object.assign({ callId }, e));
        try {
          return await core.rpc.handle(fn, params, {
            onEvent,
            onCancel: (fn2) => cancels.set(callId, fn2),
          });
        } finally {
          cancels.delete(callId);
        }
      });
    },
  };
}

const __exports = { createIpcTransport };
export { createIpcTransport };
export default __exports;
