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
import { attach as attachChannelListen } from "./core/loops/builtins/channel-listen/run.js";
import { stopAllListeners } from "./lib/channel-listen/index.js";
import { applyInteraction } from "./lib/channel-interactions/index.js";
import { acquireChannelLock } from "./lib/channel-lock.js";
import { ensureServiceToken, readServiceToken } from "./lib/channel-token.js";
import { channelEnv, channelServiceMode, channelServiceEndpoint } from "./lib/channel-service/mode.js";
import { PROJECT_ROOT } from "./lib/paths/index.js";
import { profileFor, chatOptions } from "./lib/agent-profile/index.js";
import { startTransport } from "./core/transport.js";

const AGENT_UI = process.env.AGENT_UI || "electron";
const TRANSPORT = process.env.AGENT_TRANSPORT || "http";
const LOOP_ENGINE = process.env.AGENT_LOOP_ENGINE || "node-graph";
const channelListeners = [];

const channelHealthTimers = [];

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
    const channelInstances = await createChannels();
    const externalServiceIds = channelInstances
      .filter((instance) => channelServiceMode(instance) === "service")
      .map((instance) => instance.instanceId);
    channels = createChannelManager({
      channels: channelInstances,
      externalServiceIds,
      lockFactory: (id) => acquireChannelLock(id),
      log: (line) => console.log(line),
    });
    console.log(`[launcher] channels=${channels.list().length} configured, none started`);
    core = await createCore({ proxies, channels });

    // Standalone services are selected per instance. Embedded channels keep
    // using the local manager and sink below; service-mode channels are only
    // consumed from their own HTTP/SSE endpoint.
    const serviceTargets = channelInstances
      .filter((instance) => channelServiceMode(instance) === "service")
      .map((instance) => ({ instance, endpoint: channelServiceEndpoint(instance) }))
      .filter((target) => {
        if (target.endpoint) return true;
        console.error(`[launcher] channel ${target.instance.instanceId} is service-mode but has no service endpoint`);
        return false;
      });
    if (serviceTargets.length) {
      const channelToken = readServiceToken() || ensureServiceToken();
      const groups = new Map();
      for (const target of serviceTargets) {
        const endpoint = String(target.endpoint).replace(/\/+$/, "");
        if (!groups.has(endpoint)) {
          groups.set(endpoint, { endpoint, targets: [], listeners: [], features: [] });
        }
        groups.get(endpoint).targets.push(target.instance);
      }
      core.channelServices = new Map();
      for (const group of groups.values()) {
        let probing = false;
        // Health is re-probed: the systemd service may start after the app. A
        // late-arriving interaction stream flips future turns to supervised
        // without restarting core.
        const probeChannelService = async ({ quiet = false } = {}) => {
          if (probing) return group.features;
          probing = true;
          try {
            const health = await fetch(`${group.endpoint}/health`);
            const body = await health.json();
            group.features = Array.isArray(body && body.features) ? body.features : [];
            for (const [id, entry] of core.channelServices) {
              if (entry.endpoint === group.endpoint) entry.features = group.features;
            }
            if (!health.ok && !quiet) console.log(`[launcher] channel service ${group.endpoint} health: http ${health.status}`);
            if (group.features.includes("interactions")) {
              for (const listener of group.listeners) {
                if (typeof listener.enableInteractions === "function" && !listener.interactionListener) {
                  listener.enableInteractions();
                  console.log(`[launcher] interactions enabled for ${listener.instanceId}`);
                }
              }
              const timer = group.healthTimer;
              if (timer) {
                clearInterval(timer);
                group.healthTimer = null;
              }
            }
          } catch (err) {
            if (!quiet) console.log(`[launcher] channel service ${group.endpoint} health failed: ${(err && err.message) || err}; interactions stay autonomous`);
          } finally {
            probing = false;
          }
          return group.features;
        };
        for (const instance of group.targets) {
          // Only a service that advertises the interaction stream can carry a
          // supervised turn. Otherwise ask tools would hang waiting for a click.
          const listener = attachChannelListen(core, {
            endpoint: group.endpoint,
            instanceId: instance.instanceId,
            token: channelToken,
            canPromptUser: false,
            interactions: false,
            historyFile: process.env[channelEnv(instance.instanceId, "HISTORY_DB")]
              || process.env.CHANNEL_HISTORY_DB
              || path.join(PROJECT_ROOT, "data", "channels", `history-${instance.instanceId}.db`),
            archiveDir: process.env[channelEnv(instance.instanceId, "ARCHIVE_DIR")]
              || process.env.CHANNEL_ARCHIVE_DIR
              || path.join(PROJECT_ROOT, "data", "archive", instance.type || "channel", instance.instanceId),
            // Completed-event dedupe is commit-based: an interrupted turn is
            // replayable after a restart, not suppressed as a duplicate.
            dedupeFile: path.join(PROJECT_ROOT, "data", "channels", `core-dedupe-${instance.instanceId}.json`),
            log: (line) => console.log(line),
          });
          channelListeners.push(listener);
          group.listeners.push(listener);
          core.channelServices.set(instance.instanceId, {
            endpoint: group.endpoint,
            features: group.features,
            tokenPresent: Boolean(channelToken),
            listener,
          });
        }
        await probeChannelService();
        console.log(`[launcher] channel service ${group.endpoint} attached (interactions=${group.features.includes("interactions")})`);
        if (!group.features.includes("interactions")) {
          group.healthTimer = setInterval(() => { probeChannelService({ quiet: true }); }, 30_000);
          channelHealthTimers.push(group.healthTimer);
        }
      }
    }
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
      runTurn: async (message, emit, context = {}) => {
        const sessionId = await sessions.resolve(message);
        const capabilities = (context.channel && context.channel.capabilities) || {};
        return core.agent.chat(Object.assign({
          sessionId,
          messages: message.messages,
          onEvent: emit,
          inputSource: `channel:${message.type}:${message.instanceId}`,
          // A channel that can render a button card may wait for a click.
          // Platforms without that affordance would otherwise hang an `ask`
          // tool forever, so they stay autonomous and auto-deny.
          autonomy: capabilities.canPromptUser === true ? "supervised" : "autonomous",
        }, chatOptions(profileFor(message.instanceId))));
      },
      interact: async (interaction) => {
        return applyInteraction(core, interaction);
      },
    });
    // A paused turn only survives a restart through its snapshot
    // (docs/runtime/turn-pause.md §4): restore before any client can open a
    // session, so the first look at that session already shows it paused.
    try {
      const restored = await core.snapshots.restoreAll(core.agent);
      if (restored.length) console.log(`[launcher] restored paused session(s): ${restored.join(", ")}`);
    } catch (e) {
      console.error("[launcher] pause restore failed:", (e && e.message) || e);
    }
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
  // Paused sessions are snapshotted before anything else is torn down, and
  // before the store closes (docs/runtime/turn-pause.md §4.2).
  if (core && core.snapshots && core.agent) {
    try {
      const written = await core.snapshots.writeAll(core.agent.registry.list());
      if (written.length) console.log(`[launcher] wrote pause snapshot(s): ${written.join(", ")}`);
    } catch (e) {
      console.error("[launcher] pause snapshot failed:", (e && e.message) || e);
    }
  }
  for (const timer of channelHealthTimers) clearInterval(timer);
  if (channels) await channels.stopAll();
  for (const listener of channelListeners) { if (listener && listener.closeHistory) listener.closeHistory(); }
  stopAllListeners();
  if (core && core.browser) await core.browser.stop();
  if (core && core.lsp) await core.lsp.disposeAll();
  if (core && core.mcp) core.mcp.close();
  if (server && server.close) server.close();
  if (core && core.store && core.store.close) {
    try { await core.store.close(); } catch (_) { /* 忽略关闭错误 */ }
  }
});
