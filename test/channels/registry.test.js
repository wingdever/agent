"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import { createChannels, loadDrivers, loadConfig } from "../../channels/registry.js";

test("the registry discovers driver directories and skips shared machinery", async () => {
  const drivers = await loadDrivers();
  assert.ok(drivers.has("fake"), `known drivers: ${[...drivers.keys()].join(", ")}`);
  assert.equal(drivers.has("auth"), false);
  assert.equal(drivers.has("outbound"), false);
  assert.equal(drivers.has("inbound"), false);
});

test("an enabled instance is built and validated", async () => {
  const channels = await createChannels({ config: { channels: [{ id: "a", type: "fake", enabled: true }] } });
  assert.equal(channels.length, 1);
  assert.equal(channels[0].type, "fake");
  assert.equal(channels[0].instanceId, "a");
});

test("disabled instances are skipped without failing", async () => {
  const channels = await createChannels({
    config: {
      channels: [
        { id: "on", type: "fake", enabled: true },
        { id: "off", type: "fake", enabled: false },
      ],
    },
  });
  assert.deepEqual(
    channels.map((c) => c.instanceId),
    ["on"]
  );
});

test("an unknown type fails loudly and lists what is known", async () => {
  await assert.rejects(
    () => createChannels({ config: { channels: [{ id: "x", type: "nope" }] } }),
    /unknown channel type "nope".*known: fake/
  );
});

test("a missing config file yields no channels instead of throwing", () => {
  assert.deepEqual(loadConfig("/tmp/channel-config-does-not-exist.json").channels, []);
});

test("credentials can be injected from env instead of disk", () => {
  const file = "/tmp/channel-config-env.json";
  fs.writeFileSync(
    file,
    JSON.stringify({ channels: [{ id: "enva", type: "fake", credentials: { appSecret: "on-disk" } }] })
  );
  process.env.CHANNEL_ENVA_APPSECRET = "from-env";
  try {
    const config = loadConfig(file);
    assert.equal(config.channels[0].credentials.appSecret, "from-env");
  } finally {
    delete process.env.CHANNEL_ENVA_APPSECRET;
    fs.rmSync(file, { force: true });
  }
});
