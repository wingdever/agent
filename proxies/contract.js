"use strict";

// The proxy slot contract.
//
// A proxy is one authenticated grant for a *person*: it acts as that human, using
// their user credential (OAuth or a locally logged-in CLI). This is deliberately
// not a channel: there is no inbound event and no long-lived connection, so there
// is no ack deadline and nothing to project. The shape is:
//
//   identity (whoami) + granted scopes + one call surface.
//
// All credential, error and pacing mechanics come from accounts/, so a proxy driver
// never implements token refresh itself.

const REQUIRED_FUNCTIONS = ["whoami", "call"];
const REQUIRED_AUTH_FUNCTIONS = ["headers", "invalidate"];

/**
 * @param {unknown} proxy
 * @returns {string[]}
 */
export function proxyProblems(proxy) {
  const problems = [];
  if (!proxy || typeof proxy !== "object") return ["proxy is not an object"];

  if (typeof proxy.type !== "string" || !proxy.type) problems.push("type must be a non-empty string");
  if (typeof proxy.instanceId !== "string" || !proxy.instanceId) problems.push("instanceId must be a non-empty string");

  for (const fn of REQUIRED_FUNCTIONS) {
    if (typeof proxy[fn] !== "function") problems.push(`${fn} must be a function`);
  }

  if (!Array.isArray(proxy.scopes)) {
    problems.push("scopes must be an array of scope strings");
  } else if (proxy.scopes.some((scope) => typeof scope !== "string" || !scope)) {
    problems.push("scopes must contain only non-empty strings");
  }

  const auth = proxy.auth;
  if (!auth || typeof auth !== "object") {
    problems.push("auth must be an object");
  } else {
    for (const fn of REQUIRED_AUTH_FUNCTIONS) {
      if (typeof auth[fn] !== "function") problems.push(`auth.${fn} must be a function`);
    }
  }

  return problems;
}

/**
 * @template T
 * @param {T} proxy
 * @returns {T}
 */
export function assertProxy(proxy) {
  const problems = proxyProblems(proxy);
  if (problems.length) {
    const id = proxy && proxy.instanceId ? String(proxy.instanceId) : "?";
    throw new TypeError(`invalid proxy "${id}": ${problems.join("; ")}`);
  }
  return proxy;
}

/** Least-privilege check used by drivers before performing an action. */
export function hasScope(proxy, scope) {
  return Array.isArray(proxy.scopes) && proxy.scopes.includes(scope);
}
