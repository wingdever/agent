"use strict";

// 主项目协调器：
//   1. 按 AGENT_UI 选择并启动对应的 UI 子项目（默认 electron）
//   2. 由主项目统一拉起 transport 层（共享），各 UI 子项目只负责创建窗口
import path from "path";
import { app, BrowserWindow } from "electron";
import { createCore } from "./core/index.js";
import { createProxies } from "./proxies/registry.js";
import { createChannels } from "./channels/registry.js";
import { createChannelManager } from "./channels/manager.js";
import { createSessionBinder } from "./channels/inbound/sessions.js";
import { PROJECT_ROOT } from "./lib/paths/index.js";
import { startTransport } from "./core/transport.js";

const AGENT_UI = process.env.AGENT_UI || "electron";
const TRANSPORT = process.env.AGENT_TRANSPORT || "http";
const LOOP_ENGINE = process.env.AGENT_LOOP_ENGINE || "node-graph";

// UI 子项目注册表：将来新增 UI（如 web）在此登记即可，无需改协调逻辑。
const UIS = {
  electron: "./ui/electron/main.js",
  // web: "./ui/web/main.js",
};

if (!Object.prototype.hasOwnProperty.call(UIS, AGENT_UI)) {
  console.error(`[launcher] 未知 AGENT_UI='${AGENT_UI}'，可选：${Object.keys(UIS).join(", ")}`);
  process.exit(1);
}

// UI 子项目按环境变量动态选定，ESM 下用动态 import 加载（其 main.js 导出 { start, createWindow }）
async function loadUI(name) {
  const ns = await import(UIS[name]);
  return ns.default && typeof ns.default.createWindow === "function" ? ns.default : ns;
}

let server = null;
let core = null;
let ui = null;
let channels = null;

app.whenReady()
  .then(async () => {
    console.log(`[launcher] 启动 transport 层 (${TRANSPORT}) …`);
    // 插槽在这里装配：core 只接收实例对象，不 import proxies/。
    // 配置为空等于零实例，不报错；配置写错（未知 type）直接启动失败。
    const proxies = await createProxies();
    console.log(`[launcher] proxies=${proxies.length}`);
    // Channels are built (and validated) here but started only on request: an
    // open connection tells an external platform this machine is online, and
    // that must never be a side effect of launching the app.
    channels = createChannelManager({ channels: await createChannels(), log: (line) => console.log(line) });
    console.log(`[launcher] channels=${channels.list().length} configured, none started`);
    core = await createCore({ proxies, channels });
    // A channel turn is an ordinary agent turn: the sink maps one inbound message
    // to one chat call, whose events the channel projects into cards.
    // The conversation key is a platform id, not a session id: the binder opens
    // (or reuses) the session row for that chat.
    const sessions = createSessionBinder({
      store: core.store,
      file: path.join(PROJECT_ROOT, "data", "channels", "sessions.json"),
      workspaceFolder: PROJECT_ROOT,
    });
    channels.setSink({
      runTurn: async (message, emit) => {
        const sessionId = await sessions.resolve(message);
        return core.agent.chat({
          sessionId,
          messages: message.messages,
          onEvent: emit,
          inputSource: `channel:${message.type}:${message.instanceId}`,
        });
      },
    });
    server = await startTransport(TRANSPORT, core);
    ui = await loadUI(AGENT_UI);
    return server;
  })
  .then((s) => {
    server = s || null;
    console.log(`[launcher] transport=${TRANSPORT} ready, ui=${AGENT_UI}, loopEngine=${LOOP_ENGINE}`);
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
  if (channels) await channels.stopAll();
  if (core && core.browser) await core.browser.stop();
  if (core && core.mcp) core.mcp.close();
  if (server && server.close) server.close();
  if (core && core.store && core.store.close) {
    try { await core.store.close(); } catch (_) { /* 忽略关闭错误 */ }
  }
});
