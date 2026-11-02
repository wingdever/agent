"use strict";
const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");
const path = require("path");
const { createCore } = require("../../core");
const { startTransport } = require("../../core/transport");

const TRANSPORT = process.env.AGENT_TRANSPORT || "http";
let server = null;

// 原生文件夹选择对话框：供渲染进程经 agentBridge.selectFolder 调用
let _selectFolderRegistered = false;
function registerSelectFolder() {
  if (_selectFolderRegistered) return;
  _selectFolderRegistered = true;
  ipcMain.handle("agent:selectFolder", async () => {
    const result = await dialog.showOpenDialog({ properties: ["openDirectory"] });
    if (result.canceled || !result.filePaths || !result.filePaths.length) return null;
    return result.filePaths[0];
  });
}
registerSelectFolder();

// Linux 显示兼容：Wayland 会话下显式走 ozone-wayland，否则窗口可能建了但不显示
if (process.env.WAYLAND_DISPLAY && !process.env.AGENT_OZONE) {
  app.commandLine.appendSwitch("ozone-platform", "wayland");
} else if (process.env.AGENT_OZONE) {
  app.commandLine.appendSwitch("ozone-platform", process.env.AGENT_OZONE);
}

function createWindow() {
  const win = new BrowserWindow({
    width: 900,
    height: 680,
    show: false, // 等页面就绪再显式 show，避免 Wayland 下闪没
    webPreferences:
      TRANSPORT === "ipc"
        ? { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false }
        : { contextIsolation: true, nodeIntegration: false },
  });
  // Markdown links open in the system browser instead of a new Electron window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url).catch(() => {});
    return { action: "deny" };
  });
  win.loadFile(path.join(__dirname, "..", "web", "index.html"));
  win.once("ready-to-show", () => { win.show(); win.focus(); });
  win.on("did-finish-load", () => console.log("[main] 页面加载完成"));
  win.on("did-fail-load", (_e, code, desc) => console.error("[main] 页面加载失败:", code, desc));
  console.log("[main] window created -> ui/web/index.html");
  return win;
}

function start(core) {
  const _core = core || createCore();
  app.whenReady()
    .then(() =>
      startTransport(TRANSPORT, _core)
        .then((s) => {
          server = s || null;
          console.log("[main] transport=" + TRANSPORT + " ready");
          createWindow();
          app.on("activate", () => {
            if (BrowserWindow.getAllWindows().length === 0) createWindow();
          });
        })
        .catch((e) => {
          console.error("[main] 启动失败: " + e.message + (e.code === "EADDRINUSE" ? "（端口被占用）" : ""));
          app.quit();
        })
    )
    .catch((e) => {
      console.error("[main] app 启动失败:", e.message);
      app.quit();
    });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
  app.on("before-quit", () => {
    if (server && server.close) server.close();
  });
}

if (require.main === module) start();

module.exports = { start, createWindow };
 