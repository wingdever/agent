"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";
import { applyEnvOverrides, readConfig } from "../../accounts/registry-kit.js";

test("env values win over the config file per field", () => {
  const instance = { id: "bot-a", credentials: { appId: "disk", appSecret: "disk" } };
  process.env.CHANNEL_BOT_A_APPSECRET = "env";
  try {
    const result = applyEnvOverrides(instance, "CHANNEL");
    assert.equal(result.credentials.appSecret, "env");
    assert.equal(result.credentials.appId, "disk");
    assert.equal(instance.credentials.appSecret, "disk", "input config must not be mutated");
  } finally {
    delete process.env.CHANNEL_BOT_A_APPSECRET;
  }
});

test("instance ids with punctuation still map to a usable env name", () => {
  const instance = { id: "feishu-main.v2", credentials: { appSecret: "disk" } };
  process.env.CHANNEL_FEISHU_MAIN_V2_APPSECRET = "env";
  try {
    assert.equal(applyEnvOverrides(instance, "CHANNEL").credentials.appSecret, "env");
  } finally {
    delete process.env.CHANNEL_FEISHU_MAIN_V2_APPSECRET;
  }
});

test("a missing file yields an empty instance list for the requested key", () => {
  const config = readConfig("/tmp/accounts-config-missing.json", { key: "proxies", envPrefix: "PROXY" });
  assert.deepEqual(config.proxies, []);
});

test("credentials equal to an empty string are not overridden", () => {
  const instance = { id: "empty", credentials: { token: "" } };
  const result = applyEnvOverrides(instance, "CHANNEL");
  assert.equal(result.credentials.token, "");
});
