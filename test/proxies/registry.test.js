"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import { createProxies, loadDrivers, loadConfig } from "../../proxies/registry.js";

test("the registry discovers proxy drivers", async () => {
  const drivers = await loadDrivers();
  assert.ok(drivers.has("fake"), `known drivers: ${[...drivers.keys()].join(", ")}`);
});

test("an enabled instance is built and validated", async () => {
  const proxies = await createProxies({
    config: { proxies: [{ id: "me", type: "fake", enabled: true, scopes: ["doc:read", "doc:write"] }] },
  });
  assert.equal(proxies.length, 1);
  assert.equal(proxies[0].instanceId, "me");
  assert.deepEqual(proxies[0].scopes, ["doc:read", "doc:write"]);
});

test("disabled instances are skipped", async () => {
  const proxies = await createProxies({
    config: {
      proxies: [
        { id: "on", type: "fake", enabled: true },
        { id: "off", type: "fake", enabled: false },
      ],
    },
  });
  assert.deepEqual(
    proxies.map((p) => p.instanceId),
    ["on"]
  );
});

test("an unknown type fails loudly", async () => {
  await assert.rejects(
    () => createProxies({ config: { proxies: [{ id: "x", type: "nope" }] } }),
    /unknown proxy type "nope".*known: fake/
  );
});

test("a missing config file yields no proxies", () => {
  assert.deepEqual(loadConfig("/tmp/proxy-config-does-not-exist.json").proxies, []);
});

test("user credentials can be injected from env", () => {
  const file = "/tmp/proxy-config-env.json";
  fs.writeFileSync(
    file,
    JSON.stringify({ proxies: [{ id: "enva", type: "fake", credentials: { refreshToken: "on-disk" } }] })
  );
  process.env.PROXY_ENVA_REFRESHTOKEN = "from-env";
  try {
    assert.equal(loadConfig(file).proxies[0].credentials.refreshToken, "from-env");
  } finally {
    delete process.env.PROXY_ENVA_REFRESHTOKEN;
    fs.rmSync(file, { force: true });
  }
});
