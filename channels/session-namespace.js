"use strict";

// Session identity for channel traffic.
//
// Two instances of the same platform (say two feishu bots) can both have a chat
// with the same conversation key; without the instance segment they would share
// one session and answer across each other. Hence three segments, type first so
// a session id is readable at a glance in the db.

export const SESSION_PREFIX = "ch";

/**
 * @param {{type: string, instanceId: string, conversationKey: string}} parts
 * @returns {string} `ch:<type>:<instanceId>:<conversationKey>`
 */
export function sessionIdFor({ type, instanceId, conversationKey }) {
  for (const [name, value] of Object.entries({ type, instanceId, conversationKey })) {
    if (typeof value !== "string" || !value) throw new TypeError(`sessionIdFor requires a non-empty ${name}`);
  }
  if (type.includes(":") || instanceId.includes(":")) {
    throw new TypeError("type and instanceId must not contain ':'");
  }
  return `${SESSION_PREFIX}:${type}:${instanceId}:${conversationKey}`;
}

/**
 * @param {string} sessionId
 * @returns {{type: string, instanceId: string, conversationKey: string}}
 */
export function parseSessionId(sessionId) {
  const parts = String(sessionId || "").split(":");
  if (parts.length < 4 || parts[0] !== SESSION_PREFIX) {
    throw new TypeError(`not a channel session id: ${sessionId}`);
  }
  const [, type, instanceId, ...rest] = parts;
  return { type, instanceId, conversationKey: rest.join(":") };
}
