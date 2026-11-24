"use strict";

// One gate for both routes.
//
// The scope check answers "may this grant do it", the risk check answers "should
// this happen without asking". They are separate on purpose: a doc:readonly token
// still lets you read a document nobody asked you to read.
//
// Gate order is scope -> flag -> risk, and every check runs before a process or
// request exists, so a refused action has no side effect.

import { ChannelError, ERROR_KINDS } from "./../../accounts/errors.js";
import { KNOWN_ACTIONS, actionSpec, riskOf } from "./actions.js";

export function resolveAction({ action, params = {}, scopes = [], options = {} } = {}) {
  const spec = actionSpec(action);
  if (!spec) {
    throw new ChannelError(
      ERROR_KINDS.PLATFORM,
      `lark: unknown action "${action}" (known: ${KNOWN_ACTIONS.join(", ")})`
    );
  }
  if (!spec.scopeBypass && !scopes.includes(spec.scope)) {
    throw new ChannelError(ERROR_KINDS.PLATFORM, `lark: scope "${spec.scope}" is not granted`);
  }
  if (spec.requiresFlag && options[spec.requiresFlag] !== true) {
    throw new ChannelError(ERROR_KINDS.PLATFORM, `lark: action "${action}" requires options.${spec.requiresFlag}`);
  }

  const risk = riskOf(action, params);
  const allowed = Array.isArray(options.allow) ? options.allow : ["read"];
  if (!allowed.includes(risk)) {
    throw new ChannelError(
      ERROR_KINDS.PLATFORM,
      `lark: risk "${risk}" is not allowed for this instance (allowed: ${allowed.join(", ")})`
    );
  }

  return { spec, risk };
}
