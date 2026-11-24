"use strict";

// lark proxy driver: a person's own grant.
//
// Two routes, one contract:
//   cli   -- wrap an already-logged-in lark-cli (dev and single-machine use)
//   oauth -- hold a user_access_token, refresh silently (deployable, platform-enforced)
//
// Selecting a route is a config decision (options.impl), never a code one, so the
// model-facing surface stays identical.

import { createCliProxy } from "./cli.js";
import { createOAuthProxy } from "./oauth.js";

export const type = "lark";

export function createProxy({ instance = {}, deps = {} } = {}) {
  const impl = (instance.options && instance.options.impl) || "cli";
  switch (impl) {
    case "cli":
      return createCliProxy({ instance, deps });
    case "oauth":
      return createOAuthProxy({ instance, deps });
    default:
      throw new TypeError(`lark proxy: unknown impl "${impl}" (known: cli, oauth)`);
  }
}
