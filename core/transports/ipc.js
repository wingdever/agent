"use strict";

// IPC 传输（备选）：Electron 主进程侧，渲染进程经 preload 桥接调用
function createIpcTransport() {
  return {
    name: "ipc",
    async start(core) {
      const { ipcMain } = require("electron"); // 懒加载：非 electron 环境不会触发
      const { handleCall } = require("../index");
      ipcMain.handle("agent:call", async (event, payload) => {
        const fn = payload && payload.fn;
        const params = (payload && payload.params) || {};
        const callId = payload && payload.callId;
        const onEvent = (e) => event.sender.send("agent:event", Object.assign({ callId }, e));
        return await handleCall(core, { fn, params, onEvent });
      });
    },
  };
}

module.exports = { createIpcTransport };
 