"use strict";

// feishu channel driver: one bot account.
//
// Shape follows the slot contract: capabilities + auth + start/project/stop.
// Everything feishu-specific is in the sibling modules (wire format, token, API,
// projection, transport); this file only wires them together.

import { createAuth } from "./../../accounts/auth/index.js";
import { createFeishuApi } from "./api.js";
import { createTokenFetcher } from "./token.js";
import { parseEvent, SUPPORTED_EVENT } from "./events.js";
import { createProjector } from "./projector.js";
import { connect as connectWebSocket } from "./transport.js";

export const type = "feishu";

export function createChannel({ instance = {}, deps = {} } = {}) {
  const options = instance.options || {};
  const credentials = instance.credentials || {};
  const baseUrl = String(options.baseUrl || "https://open.feishu.cn").replace(/\/+$/, "");
  const wsUrl = options.wsUrl || `${baseUrl.replace(/^http/, "ws")}/ws/${SUPPORTED_EVENT}`;
  const fetchImpl = deps.fetch;
  const instanceId = instance.id || "feishu";

  const auth =
    deps.auth ||
    createAuth({
      strategy: "appSecretToToken",
      credentials,
      deps: {
        fetchToken: createTokenFetcher({
          baseUrl,
          appId: credentials.appId,
          appSecret: credentials.appSecret,
          fetchImpl,
        }),
        tokenCacheMs: options.tokenCacheMs,
        now: deps.now,
      },
    });

  const api = createFeishuApi({ baseUrl, auth, fetchImpl, qps: options.qps });
  const projector = createProjector({ api, throttleMs: options.throttleMs, now: deps.now });

  let connection = null;

  const capabilities = {
    eventMode: "ws",
    ackDeadlineMs: 3000, // documented: a callback must be answered within 3s
    // Conservative segmentation cap. Feishu does not state a single byte limit
    // for card markdown, so this stays well below the point where a card is
    // refused; confirm against the real platform before raising it.
    maxTextBytes: options.maxTextBytes || 30000,
    outboundQps: options.qps || 5,
    streaming: true,
    canPromptUser: false,
    canAttachFiles: true,
  };

  const channel = {
    type,
    instanceId,
    capabilities,
    auth,

    /**
     * Problems that would make a start pointless, checked only when someone
     * actually asks to start. Boot must not require credentials: a configured but
     * unconnected channel is a legitimate state (the user may add the app secret
     * tomorrow), and a missing secret is only a failure at the moment of use.
     * @returns {string[]}
     */
    check() {
      const problems = [];
      const env = (field) =>
        `CHANNEL_${String(instanceId).toUpperCase().replace(/[^A-Z0-9]/g, "_")}_${field.toUpperCase()}`;
      if (!credentials.appId) problems.push(`credentials.appId is missing (or ${env("appId")})`);
      if (!credentials.appSecret) problems.push(`credentials.appSecret is missing (or ${env("appSecret")})`);
      return problems;
    },

    async start(onMessage) {
      if (typeof onMessage !== "function") throw new TypeError("start requires an onMessage handler");
      if (connection) throw new Error("feishu channel is already started");

      const problems = this.check();
      if (problems.length) throw new Error(`feishu channel cannot start: ${problems.join("; ")}`);

      // Production passes the official SDK's WSClient here (see transport.js).
      const connector = deps.connect || connectWebSocket;
      connection = await connector({
        url: wsUrl,
        onEvent: (envelope) => {
          const message = parseEvent(envelope, { type, instanceId });
          if (!message) return; // not for us, or not a user message
          onMessage(message);
        },
        onStatus: deps.onStatus,
      });
    },

    async project(message, event) {
      await projector.push(message, event);
    },

    async stop() {
      if (connection && typeof connection.close === "function") connection.close();
      connection = null;
    },

    // --- test affordances -------------------------------------------------
    get api() {
      return api;
    },
    get projector() {
      return projector;
    },
  };

  return channel;
}
