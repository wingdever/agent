"use strict";

// 主项目协调器：
//   1. 按 AGENT_UI 选择并启动对应的 UI 子项目（默认 electron）
//   2. 由主项目统一拉起 transport 层（共享），各 UI 子项目只负责创建窗口
const { app, BrowserWindow } = require("electron");
const { createCore } = require("./core");
const { startTransport } = require("./core/transport");

const AGENT_UI = process.env.AGENT_UI || "electron";
const TRANSPORT = process.env.AGENT_TRANSPORT || "http";

// UI 子项目注册表：将来新增 UI（如 web）在此登记即可，无需改协调逻辑。
const UIS = {
  electron: "./ui/electron/main.js",
  // web: "./ui/web/main.js",
};

if (!Object.prototype.hasOwnProperty.call(UIS, AGENT_UI)) {
  console.error(`[launcher] 未知 AGENT_UI='${AGENT_UI}'，可选：${Object.keys(UIS).join(", ")}`);
  process.exit(1);
}

// 加载 UI 子项目模块（其 main.js 已导出 { start, createWindow }）
const ui = require(UIS[AGENT_UI]);

let server = null;
let core = null;

app.whenReady()
  .then(async () => {
    console.log(`[launcher] 启动 transport 层 (${TRANSPORT}) …`);
    core = await createCore();
    server = await startTransport(TRANSPORT, core);
    return server;
  })
  .then((s) => {
    server = s || null;
    console.log(`[launcher] transport=${TRANSPORT} ready, ui=${AGENT_UI}`);
    ui.createWindow();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) ui.createWindow();
    });
  })
  .catch((e) => {
    console.error("[launcher] 启动失败:", e.message);
    app.quit();
  });

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", async () => {
  if (server && server.close) server.close();
  if (core && core.store && core.store.close) {
    try { await core.store.close(); } catch (_) { /* 忽略关闭错误 */ }
  }
});
