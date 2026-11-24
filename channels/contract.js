"use strict";

// The channel slot contract.
//
// One channel = one authenticated external account binding. A driver is the
// implementation of this shape; registry.js asserts it at load time, so a half
// implemented driver fails at startup rather than at the first inbound message.
//
// The shape is deliberately thin: credentials lifecycle, event intake, event
// projection. Everything platform specific (what a card looks like, how a
// message is parsed) stays in the driver.

export const EVENT_MODES = Object.freeze(["ws", "webhook", "reverse-ws", "poll"]);

// `check()` is optional: it returns the problems that would make a start pointless
// (typically missing credentials). Drivers own that knowledge, the manager asks for
// it only when a start is requested -- never at construction, so a configured but
// unconnected instance cannot break app startup.
const REQUIRED_FUNCTIONS = ["start", "project", "stop"];const REQUIRED_AUTH_FUNCTIONS = ["headers", "invalidate"];
const REQUIRED_BOOLEANS = ["streaming", "canPromptUser", "canAttachFiles"];

 /**
 * Collect every contract violation instead of throwing on the first one - a
 * driver author should see the whole list in one pass.
 * @param {unknown} channel
 * @returns {string[]}
 */
export function channelProblems(channel) {
  const problems = [];
  const isFn = (v) => typeof v === "function";

  if (!channel || typeof channel !== "object") return ["channel is not an object"];

  if (typeof channel.type !== "string" || !channel.type) problems.push("type must be a non-empty string");
  if (typeof channel.instanceId !== "string" || !channel.instanceId) problems.push("instanceId must be a non-empty string");

  const caps = channel.capabilities;
  if (!caps || typeof caps !== "object") {
    problems.push("capabilities must be an object");
  } else {
    if (!EVENT_MODES.includes(caps.eventMode)) {
      problems.push(`capabilities.eventMode must be one of ${EVENT_MODES.join("|")}`);
    }
    // A deadline of Infinity would silently downgrade a platform's ack
    // requirement into an optional one. Refuse the value instead of accepting
    // a "no constraint" placeholder.
    if (!Number.isFinite(caps.ackDeadlineMs) || caps.ackDeadlineMs <= 0) {
      problems.push("capabilities.ackDeadlineMs must be a positive finite number (never Infinity)");
    }
    if (!Number.isFinite(caps.maxTextBytes) || caps.maxTextBytes <= 0) {
      problems.push("capabilities.maxTextBytes must be a positive finite number");
    }
    if (!Number.isFinite(caps.outboundQps) || caps.outboundQps <= 0) {
      problems.push("capabilities.outboundQps must be a positive finite number");
    }
    for (const key of REQUIRED_BOOLEANS) {
      if (typeof caps[key] !== "boolean") problems.push(`capabilities.${key} must be boolean`);
    }
  }

  const auth = channel.auth;
  if (!auth || typeof auth !== "object") {
    problems.push("auth must be an object");
  } else {
    for (const fn of REQUIRED_AUTH_FUNCTIONS) {
      if (!isFn(auth[fn])) problems.push(`auth.${fn} must be a function`);
    }
  }

  for (const fn of REQUIRED_FUNCTIONS) {
    if (!isFn(channel[fn])) problems.push(`${fn} must be a function`);
  }

  return problems;
}

/**
 * @template T
 * @param {T} channel
 * @returns {T}
 */
export function assertChannel(channel) {
  const problems = channelProblems(channel);
  if (problems.length) {
    const id = channel && channel.instanceId ? String(channel.instanceId) : "?";
    throw new TypeError(`invalid channel "${id}": ${problems.join("; ")}`);
  }
  return channel;
}
