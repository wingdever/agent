"use strict";
const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");
const path = require("path");

const TRANSPORT = process.env.AGENT_TRANSPORT || "http";

// Native folder picker for the renderer (via preload's agentBridge).
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

// Linux display compatibility: explicit ozone-wayland under Wayland.
if (process.env.WAYLAND_DISPLAY && !process.env.AGENT_OZONE) {
  app.commandLine.appendSwitch("ozone-platform", "wayland");
} else if (process.env.AGENT_OZONE) {
  app.commandLine.appendSwitch("ozone-platform", process.env.AGENT_OZONE);
}

function createWindow() {
  const win = new BrowserWindow({
    width: 900,
    height: 680,
    show: false,
    webPreferences:
      TRANSPORT === "ipc"
        ? { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false }
        : { contextIsolation: true, nodeIntegration: false },
  });
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

module.exports = { createWindow };
