"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mainProfile, effectiveSettings } from "../../lib/agent-profile/index.js";

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-global-"));
  const mainFile = path.join(dir, "agent", "config.json");
  const assetsFile = path.join(dir, "assets", "agent", "config.json");
  const settingsFile = path.join(dir, "user", "settings.json");
  fs.mkdirSync(path.dirname(assetsFile), { recursive: true });
  fs.writeFileSync(assetsFile, JSON.stringify({ identity: "default identity", persona: "", effort: "high", tools: [] }));
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  fs.writeFileSync(settingsFile, JSON.stringify({ provider: "p1", model: "m1", effort: "low", stream: true }));
  return { dir, mainFile, assetsFile, settingsFile };
}

test("an empty main profile is materialized from assets exactly once", () => {
  const fx = fixture();
  try {
    const first = mainProfile({ mainFile: fx.mainFile, assetsFile: fx.assetsFile });
    assert.equal(first.identity, "default identity");
    assert.equal(fs.existsSync(fx.mainFile), true);
    fs.writeFileSync(fx.mainFile, JSON.stringify({ identity: "edited" }));
    assert.equal(mainProfile({ mainFile: fx.mainFile, assetsFile: fx.assetsFile }).identity, "edited");
  } finally {
    fs.rmSync(fx.dir, { recursive: true, force: true });
  }
});

test("global agent fields migrate into the main profile and stay authoritative", () => {
  const fx = fixture();
  try {
    const merged = effectiveSettings({ settingsFile: fx.settingsFile, mainFile: fx.mainFile, assetsFile: fx.assetsFile });
    assert.equal(merged.provider, "p1");
    assert.equal(merged.model, "m1");
    assert.equal(merged.effort, "low");
    assert.equal(merged.stream, true);

    const settings = JSON.parse(fs.readFileSync(fx.settingsFile, "utf8"));
    assert.deepEqual(Object.keys(settings), ["stream"]);
    const main = JSON.parse(fs.readFileSync(fx.mainFile, "utf8"));
    assert.equal(main.identity, "default identity");
    assert.equal(main.provider, "p1");

    const again = effectiveSettings({ settingsFile: fx.settingsFile, mainFile: fx.mainFile, assetsFile: fx.assetsFile });
    assert.equal(again.provider, "p1", "second read uses the profile, not a removed settings field");
  } finally {
    fs.rmSync(fx.dir, { recursive: true, force: true });
  }
});
