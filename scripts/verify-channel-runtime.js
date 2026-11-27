#!/usr/bin/env node
"use strict";

// Cross-boundary runtime verification for the QQ channel microservice.
//
// Runs the two roles in ONE process but they talk over REAL HTTP + SSE, not
// direct function calls:
//   channel service: createChannelCallback + createChannelManager + fake channel
//   core side:       createChannelListener (real fetch to /messages/subscribe)
// No real QQ credentials are touched. Verifies the transport boundary that
// unit tests (which stub fetch) cannot.

import fs from "node:fs";
import path from "node:path";

import { createChannelCallback } from "../channels/callback.js";
import { createChannelManager } from "../channels/manager.js";
import { createChannel as createFakeChannel } from "../channels/fake/index.js";
import { createChannelHistory } from "../lib/channel-history/index.js";
import { createMemoryAdapter } from "../lib/channel-history/adapters.js";
import { createChannelListener } from "../lib/channel-listen/index.js";

const ROOT = path.dirname(path.dirname(new URL(import.meta.url).pathname));

function message(overrides = {}) {
  return {
    type: "fake",
    instanceId: "fake-verify",
    conversationKey: "verify-chat",
    eventId: "verify-1",
    senderId: "verify-user",
    messages: [{ role: "user", content: "hello from fake channel" }],
    ...overrides,
  };
}

async function main() {
  // --- channel service role ---------------------------------------------
  const fake = createFakeChannel({ instance: { id: "fake-verify" } });
  const history = createChannelHistory({ db: createMemoryAdapter() });
  const callback = createChannelCallback({
    lookupChannel: (id) => (String(id) === "fake-verify" ? fake : null),
    getPending: (id) => history.getPending(id),
    onReplay: (msgs) => history.markDelivered(msgs.map((m) => m.eventId)),
    log: () => {},
  });
  const addr = await callback.listen();
  console.log(`[verify] channel service on ${addr.url}`);

  const manager = createChannelManager({
    channels: [fake],
    log: () => {},
    publish: async (m) => {
      await history.append(m);
      const result = callback.publish(m);
      if (result.sent > 0) await history.markDelivered(result.eventIds);
    },
  });
  await manager.start("fake-verify");

  // --- core role (real HTTP/SSE to the service) --------------------------
  const received = [];
  const listener = createChannelListener({
    endpoint: addr.url,
    instanceId: "fake-verify",
    onMessage: async (m) => received.push(m),
    schedule: () => {}, // no reconnect loop in a verification run
    log: (line) => console.log(`[verify] listener: ${line}`),
  });
  listener.start();
  await new Promise((resolve) => setTimeout(resolve, 50));

  // --- inject a message through the channel service ---------------------
  const ackMs = await fake.inject(message());
  console.log(`[verify] injected (ack ${ackMs}ms)`);
  await new Promise((resolve) => setTimeout(resolve, 50));

  const ok = received.length === 1 && received[0].eventId === "verify-1";
  const pending = await history.getPending("fake-verify");
  console.log(`[verify] received=${received.length} pending=${pending.length}`);

  listener.stop();
  await manager.stopAll();
  await callback.close();

  if (!ok) {
    console.error("[verify] FAIL: message did not cross the HTTP/SSE boundary");
    process.exit(1);
  }
  console.log("[verify] PASS: fake message crossed the boundary over real HTTP/SSE");
}

main().catch((err) => {
  console.error(`[verify] ERROR: ${(err && err.stack) || err}`);
  process.exit(1);
});
