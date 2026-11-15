"use strict";

// IPC transport (Electron main process): renderer commands go through the same
// RPC registry as HTTP.
function createIpcTransport() {
  return {
    name: "ipc",
    async start(core) {
      const { ipcMain } = require("electron"); // lazy: non-electron environments never load it
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

module.exports = { createIpcTransport };
