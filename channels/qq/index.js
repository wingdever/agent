"use strict";

// QQ 官方机器人 driver.
//
// Third driver in the slot, and the first one where the credential rotates: appid
// + appsecret are exchanged for an access token with a lifetime, so
// accounts/auth's refresh path does real work instead of being a no-op.
//
// Why the official bot and not OneBot: the platform offers WebSocket delivery
// ("不依赖公网服务器部署"), so no public endpoint is needed, and a bot account
// cannot get banned for protocol abuse the way a personal QQ account can.
//
// Verified live (appid 1906507317): token exchange, `GET /gateway/bot`
// {"url":"wss://api.sgroup.qq.com/websocket","shards":1}, identify, and
// READY {"user":{"id":"10880449181683288941","username":"alice","bot":true}}.

import { createQqApi, createQqAuth, DEFAULT_API_BASE } from "./api.js";
import { createQqGateway, INTENTS } from "./gateway.js";
import { parseDispatch } from "./events.js";

export const type = "qq";

export function createChannel({ instance = {}, deps = {} } = {}) {
  const options = instance.options || {};
  const credentials = instance.credentials || {};
  const instanceId = instance.id || "qq";
  const appId = String(credentials.appId || "");
  const appSecret = String(credentials.appSecret || "");
  const botId = String(credentials.botId || "");

  // Constructing a driver must not require credentials: a bot that is configured
  // but not connected is a legitimate boot state, and check() is what reports the
  // gap at start time. Placeholders only exist so construction cannot throw.
  const auth = deps.auth || createQqAuth({ appId: appId || "missing-appid", appSecret: appSecret || "missing-secret", fetchImpl: deps.fetch, now: deps.now });
  const api = createQqApi({
    auth,
    baseUrl: options.apiBaseUrl || DEFAULT_API_BASE,
    fetchImpl: deps.fetch,
    qps: options.qps,
  });

  let gateway = null;

  const capabilities = {
    eventMode: "ws",
    // Nobody waits for an ack on a socket; the field is nominal, like yunhu's.
    ackDeadlineMs: 5000,
    maxTextBytes: options.maxTextBytes || 4000,
    outboundQps: options.qps || 3,
    // QQ has no edit-message endpoint for bot messages: one answer per inbound,
    // so streaming degrades to "send the final text once".
    streaming: false,
    canPromptUser: false,
    canAttachFiles: true,
  };

  const channel = {
    type,
    instanceId,
    capabilities,
    auth,

    check() {
      const problems = [];
      const env = (field) => `CHANNEL_${String(instanceId).toUpperCase().replace(/[^A-Z0-9]/g, "_")}_${field}`;
      if (!appId) problems.push(`credentials.appId is missing (or ${env("APPID")})`);
      if (!appSecret) problems.push(`credentials.appSecret is missing (or ${env("APPSECRET")})`);
      return problems;
    },

    async start(onMessage) {
      if (typeof onMessage !== "function") throw new TypeError("start requires an onMessage handler");
      if (gateway) throw new Error("qq channel is already started");

      const problems = this.check();
      if (problems.length) throw new Error(`channel "${instanceId}" cannot start: ${problems.join("; ")}`);

      gateway = createQqGateway({
        auth,
        fetchGateway: () => api.gateway(),
        dial: deps.dial,
        intents: options.intents || INTENTS.GROUP_AND_C2C,
        onError: deps.onError,
        schedule: deps.schedule,
        setIntervalImpl: deps.setInterval,
        clearIntervalImpl: deps.clearInterval,
        onDispatch: (frame) => {
          const message = parseDispatch(frame, { type, instanceId, botId });
          if (!message) return;
          onMessage(message);
        },
      });

      try {
        await gateway.connect();
      } catch (err) {
        gateway = null;
        throw err;
      }
    },

    /** One answer per inbound message, quoting its id (passive reply). */
    async project(message, event) {
      const kind = event && event.type;
      if (kind === "token") return; // no edit endpoint: partial text would be a second message
      // core's real turn ends with `done` carrying `message.content`; `final`
      // is the shape a direct emitter uses. Both are terminal here.
      if (kind !== "final" && kind !== "done" && kind !== "error") return;

      const text =
        kind === "error"
          ? `⚠️ 这轮没有跑完：${(event && (event.message || event.kind)) || "unknown error"}`
          : String((event && (event.content || (event.message && event.message.content))) || "").trim();
      if (!text) return;

      const target =
        message.recvType === "group"
          ? { groupOpenId: message.conversationKey }
          : { userOpenId: message.senderId };
      await api.sendMessage({ ...target, content: text, msgId: message.replyTo });
    },

    async stop() {
      if (gateway) await gateway.close();
      gateway = null;
    },

    get stats() {
      return gateway ? { mode: "ws", ...gateway.stats } : { mode: "ws", connects: 0, dispatches: 0 };
    },
    get api() {
      return api;
    },
    get gateway() {
      return gateway;
    },
  };

  return channel;
}
