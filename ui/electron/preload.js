"use strict";
// 仅 ipc 模式使用：把渲染进程的调用桥接到 ipcMain
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("agentBridge", {
  // 原生文件夹选择对话框（主进程处理），返回所选目录绝对路径或 null
  selectFolder() {
    return ipcRenderer.invoke("agent:selectFolder");
  },
  async call(fn, params, onEvent) {
    const callId = Math.random().toString(36).slice(2);
    const listener = (_e, evt) => {
      if (evt && evt.callId === callId && onEvent) onEvent(evt);
    };
    ipcRenderer.on("agent:event", listener);
    try {
      return await ipcRenderer.invoke("agent:call", { fn: fn, params: params || {}, callId: callId });
    } finally {
      ipcRenderer.removeListener("agent:event", listener);
    }
  },
  listFunctions() {
    return ipcRenderer.invoke("agent:call", { fn: "listFunctions", params: {}, callId: "x" });
  },
});
 