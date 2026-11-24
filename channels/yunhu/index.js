"use strict";

// 云湖 driver: one bot account, two possible inbound transports, bot-token out.
//
// Same contract as the feishu driver (capabilities + auth + start/project/stop),
// but these platform differences are worth naming up front:
//
//   1. The console offers "long connection" (we dial wss://ws.jwzhd.com/subscribe)
//      or "server event push" (the platform POSTs to a webhook we host). They are
//      mutually exclusive: whichever mode the bot is switched to is the one that
//      delivers anything. The default here is the long connection, because it needs
//      no public endpoint; webhook stays available as `options.mode: "webhook"` for
//      deployments that would rather expose a URL than hold a socket.
//   2. The bot token goes in the query string. `auth.headers()` is empty, and
//      invalidate() is a no-op: a bot token does not rotate.
//   3. Events carry no bot id, so the configured botId is the only way to tell
//      "this is my own message".
//
// Verified against the live gateway (bot "ami", 83683850): the socket pushes the
// same envelope the webhook receives, `/bot/send` answers `{code:1,data:{messageInfo:{msgId}}}`.

import { createStaticAuth } from "./../../accounts/auth/index.js";
import { parseEvent } from "./events.js";
import { DEFAULT_API_BASE, createYunhuApi } from "./api.js";
import { createProjector } from "./projector.js";
import { createWebhookServer } from "./webhook-server.js";
import { createWsClient, wsUrlForToken } from "./ws-client.js";

export const type = "yunhu";

export function createChannel({ instance = {}, deps = {} } = {}) {
  const options = instance.options || {};
  const credentials = instance.credentials || {};
  const instanceId = instance.id || "yunhu";
  const botId = String(credentials.botId || "");
  const token = String(credentials.token || "");
  const fetchImpl = deps.fetch;
  const mode = options.mode === "webhook" ? "webhook" : "ws";

  const auth = deps.auth || createStaticAuth({});
  const api = createYunhuApi({
    baseUrl: options.baseUrl || DEFAULT_API_BASE,
    token: token || "missing-token",
    fetchImpl,
    qps: options.qps,
    auth,
  });
  const projector = createProjector({ api, throttleMs: options.throttleMs, now: deps.now });

  let server = null;
  let ws = null;

  const capabilities = {
    eventMode: mode,
    // In webhook mode this is the callback deadline (undocumented; 5s chosen loose
    // so a slow turn does not get the event redelivered). On a socket there is
    // nobody waiting for an ack, so the value is nominal.
    ackDeadlineMs: 5000,
    maxTextBytes: options.maxTextBytes || 30000,
    outboundQps: options.qps || 5,
    streaming: true, // "/bot/edit" replaces content, so partial text can be edited in place
    canPromptUser: false,
    canAttachFiles: false,
  };

  const channel = {
    type,
    instanceId,
    capabilities,
    auth,

    /** Credentials are a start-time concern: a configured-but-unconnected bot must not break boot. */
    check() {
      const problems = [];
      const env = (field) => `CHANNEL_${String(instanceId).toUpperCase().replace(/[^A-Z0-9]/g, "_")}_${field}`;
      if (!botId) problems.push(`credentials.botId is missing (or ${env("BOTID")})`);
      if (!token) problems.push(`credentials.token is missing (or ${env("TOKEN")})`);
      return problems;
    },

    async start(onMessage) {
      if (typeof onMessage !== "function") throw new TypeError("start requires an onMessage handler");
      if (server || ws) throw new Error("yunhu channel is already started");

      const problems = this.check();
      if (problems.length) throw new Error(`yunhu channel cannot start: ${problems.join("; ")}`);

      const handOff = (payload) => {
        const message = parseEvent(payload, {
          type,
          instanceId,
          botId,
          requireMention: options.requireMention !== false,
        });
        if (!message) return { accepted: false, reason: "ignored" };
        return onMessage(message);
      };

      if (mode === "webhook") {
        server = createWebhookServer({
          port: options.port || 0,
          path: options.path || "/webhook",
          secret: options.secret || "",
          onEvent: handOff,
          onError: deps.onError,
        });
        await server.listen();
        return;
      }

      ws = createWsClient({
        url: options.wsUrl || wsUrlForToken(token),
        dial: deps.dial,
        onEnvelope: handOff,
        onError: deps.onError,
        schedule: deps.schedule,
        connectTimeoutMs: deps.connectTimeoutMs,
      });
      try {
        await ws.connect();
      } catch (err) {
        ws = null;
        throw err;
      }
    },

    project(message, event) {
      return projector.push(message, event);
    },

    async stop() {
      if (server) await server.close();
      server = null;
      if (ws) await ws.close();
      ws = null;
    },

    // --- operational visibility -------------------------------------------
    /** Transport actually in use; the console's two modes are mutually exclusive. */
    get mode() {
      return mode;
    },
    /** Only meaningful in webhook mode: where the platform must post events. */
    get webhookUrl() {
      return server ? server.url : "";
    },
    get stats() {
      if (server) return { mode, ...server.stats };
      return { mode, ...(ws ? ws.stats : { frames: 0, ignored: 0, connects: 0, closes: 0, reconnects: 0, errors: 0 }) };
    },
    get api() {
      return api;
    },
    get projector() {
      return projector;
    },
  };

  return channel;
}
