"use strict";

// Production transport for the real platform: the official SDK's long connection.
//
// Why this exists separately from transport.js: feishu frames its long-connection
// events as protobuf, not JSON, and the handshake needs an app credential. Only
// the SDK's own WSClient speaks that protocol, so it plugs in as `deps.connect`
// (same signature as transport.js: { onEvent, onStatus } -> { close }).
//
// Payload shape: the SDK flattens a v2 envelope before dispatch -- verified in
// @larksuiteoapi/node-sdk 1.76.0, RequestHandle.parse returns
// { event_type, ...header, ...event } -- so the handler receives event_type and
// event_id at the top level, with sender/message still nested. toEnvelope maps it
// back to the wire shape that events.js already understands.

import { WSClient, EventDispatcher, Domain, LoggerLevel } from "@larksuiteoapi/node-sdk";
import { SUPPORTED_EVENT } from "./events.js";

/**
 * Rebuild the { schema, header, event } envelope from the SDK's flattened payload.
 * @param {Object} payload what the event dispatcher hands to a handler
 * @returns {Object|null}
 */
export function toEnvelope(payload) {
  if (!payload || payload.event_type !== SUPPORTED_EVENT || !payload.message) return null;
  return {
    schema: "2.0",
    header: {
      event_id: payload.event_id,
      event_type: payload.event_type,
      create_time: payload.create_time,
      app_id: payload.app_id,
    },
    event: { sender: payload.sender, message: payload.message },
  };
}

/**
 * @param {{appId: string, appSecret: string, domain?: "feishu"|"lark", loggerLevel?: string, autoReconnect?: boolean}} options
 * @returns {(context: {onEvent: Function, onStatus?: Function}) => {close: Function}}
 */
export function createSdkConnect({
  appId,
  appSecret,
  domain = "feishu",
  loggerLevel = "warn",
  autoReconnect = true,
} = {}) {
  if (!appId || !appSecret) throw new TypeError("sdk connect needs appId and appSecret");

  const level = LoggerLevel[loggerLevel] ?? LoggerLevel.warn;
  const sdkDomain = domain === "lark" ? Domain.Lark : Domain.Feishu;

  return function connect({ onEvent, onStatus = null } = {}) {
    if (typeof onEvent !== "function") throw new TypeError("connect requires an onEvent handler");

    const dispatcher = new EventDispatcher({ loggerLevel: level });
    dispatcher.register({
      [SUPPORTED_EVENT]: (payload) => {
        const envelope = toEnvelope(payload);
        if (envelope) onEvent(envelope);
      },
    });

    const client = new WSClient({
      appId,
      appSecret,
      domain: sdkDomain,
      loggerLevel: level,
      autoReconnect,
      onReady: () => onStatus && onStatus({ state: "open" }),
      onReconnecting: () => onStatus && onStatus({ state: "reconnecting" }),
      onReconnected: () => onStatus && onStatus({ state: "open" }),
      onError: (err) => onStatus && onStatus({ state: "failed", error: String((err && err.message) || err) }),
    });

    // start() resolves once the client is wired up; connection failures arrive
    // through onError. Never let a rejection escape as an unhandled one.
    Promise.resolve(client.start({ eventDispatcher: dispatcher })).catch((err) => {
      if (onStatus) onStatus({ state: "failed", error: String((err && err.message) || err) });
    });

    return {
      close() {
        client.close();
      },
    };
  };
}
