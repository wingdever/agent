"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mainProfile, effectiveSettings, loadAgentProfile, chatOptions } from "../../lib/agent-profile/index.js";

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

test("agent fields come from the profile, settings.json is never rewritten", () => {
  const fx = fixture();
  try {
    // Legacy settings.json still carries agent fields; the profile wins and
    // settings.json is left untouched (no migration writes).
    const merged = effectiveSettings({ settingsFile: fx.settingsFile, mainFile: fx.mainFile, assetsFile: fx.assetsFile });
    assert.equal(merged.identity, "default identity");
    assert.equal(merged.effort, "high", "profile value wins over settings");
    assert.equal(merged.stream, true, "field absent from profile falls back to settings");

    const settings = JSON.parse(fs.readFileSync(fx.settingsFile, "utf8"));
    assert.equal(settings.provider, "p1", "settings.json was not rewritten");
    const main = JSON.parse(fs.readFileSync(fx.mainFile, "utf8"));
    assert.equal(main.identity, "default identity");
  } finally {
    fs.rmSync(fx.dir, { recursive: true, force: true });
  }
});

function agentFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bot-agent-"));
  const agentDir = path.join(dir, "agents", "wingbot");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, "config.json"), JSON.stringify({
    identity: "You are wingbot.", model: "gpt-x", effort: "high", persona: "from config",
  }));
  fs.writeFileSync(path.join(agentDir, "loops.json"), JSON.stringify([
    { on: "model-call", slot: "after", target: "builtin.channel-send" },
  ]));
  fs.writeFileSync(path.join(agentDir, "prompt"), "You are a QQ bot.");
  fs.writeFileSync(path.join(agentDir, "tools.json"), JSON.stringify(["bash", "read"]));
  return { dir, agentDir };
}

test("loadAgentProfile reads the full agents/<name>/ directory", () => {
  const fx = agentFixture();
  try {
    const profile = loadAgentProfile("wingbot", { agentsDir: path.join(fx.dir, "agents") });
    assert.equal(profile.id, "wingbot");
    assert.equal(profile.config.model, "gpt-x");
    assert.deepEqual(profile.loops, [{ on: "model-call", slot: "after", target: "builtin.channel-send" }]);
    assert.equal(profile.prompt, "You are a QQ bot.");
    assert.deepEqual(profile.tools, ["bash", "read"]);
  } finally {
    fs.rmSync(fx.dir, { recursive: true, force: true });
  }
});

test("loadAgentProfile rejects invalid names and tolerates missing files", () => {
  const fx = agentFixture();
  try {
    assert.throws(() => loadAgentProfile("../escape", { agentsDir: path.join(fx.dir, "agents") }), /invalid agent name/);
    const bare = loadAgentProfile("empty", { agentsDir: path.join(fx.dir, "agents") });
    assert.deepEqual(bare.loops, []);
    assert.deepEqual(bare.tools, []);
    assert.equal(bare.toolsDeclared, false);
    assert.equal(bare.prompt, "");
  } finally {
    fs.rmSync(fx.dir, { recursive: true, force: true });
  }
});

test("an explicit empty bot allowlist stays empty instead of inheriting all tools", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bot-empty-tools-"));
  const agentDir = path.join(dir, "agents", "emptybot");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, "tools.json"), JSON.stringify([]));
  try {
    const profile = loadAgentProfile("emptybot", { agentsDir: path.join(dir, "agents") });
    assert.equal(profile.toolsDeclared, true);
    assert.deepEqual(chatOptions(profile), { toolNames: [] });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("chatOptions accepts both flat and full agent profiles", () => {
  const fx = agentFixture();
  try {
    const full = loadAgentProfile("wingbot", { agentsDir: path.join(fx.dir, "agents") });
    assert.deepEqual(chatOptions(full), {
      identity: "You are wingbot.",
      persona: "from config\n\nYou are a QQ bot.", model: "gpt-x", effort: "high", toolNames: ["bash", "read"],
    });
    assert.deepEqual(chatOptions({ persona: "flat", model: "m", tools: ["x"] }), {
      persona: "flat", model: "m", toolNames: ["x"],
    });
  } finally {
    fs.rmSync(fx.dir, { recursive: true, force: true });
  }
});

test("nested credentials in settings merge with agent-owned config", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "merge-creds-"));
  const mainFile = path.join(dir, "agent", "config.json");
  const assetsFile = path.join(dir, "assets", "agent", "config.json");
  const settingsFile = path.join(dir, "user", "settings.json");
  fs.mkdirSync(path.dirname(mainFile), { recursive: true });
  fs.mkdirSync(path.dirname(assetsFile), { recursive: true });
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  fs.writeFileSync(assetsFile, JSON.stringify({ identity: "main" }));
  fs.writeFileSync(mainFile, JSON.stringify({
    identity: "main",
    translate: { enabled: true, model: "trans-model", baseUrl: "http://trans" },
    web: { tavily: { baseUrl: "http://tavily" } },
  }));
  fs.writeFileSync(settingsFile, JSON.stringify({
    translate: { apiKey: "secret-trans" },
    web: { tavilyApiKey: "secret-tavily" },
  }));
  try {
    const merged = effectiveSettings({ settingsFile, mainFile, assetsFile });
    assert.equal(merged.translate.model, "trans-model", "config from profile");
    assert.equal(merged.translate.apiKey, "secret-trans", "credential from settings");
    assert.equal(merged.web.tavily.baseUrl, "http://tavily");
    assert.equal(merged.web.tavilyApiKey, "secret-tavily");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadAgentProfile materializes a bot agent from assets once", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-assets-"));
  const agentsDir = path.join(dir, "agents");
  const assetsDir = path.join(dir, "assets", "agents");
  const template = path.join(assetsDir, "sample");
  fs.mkdirSync(template, { recursive: true });
  fs.writeFileSync(path.join(template, "config.json"), JSON.stringify({ model: "from-assets" }));
  fs.writeFileSync(path.join(template, "loops.json"), JSON.stringify([{ on: "x", slot: "after", target: "y" }]));
  fs.writeFileSync(path.join(template, "prompt"), "hello from assets");
  try {
    const first = loadAgentProfile("sample", { agentsDir, assetsDir });
    assert.equal(first.config.model, "from-assets");
    assert.equal(first.prompt, "hello from assets");
    assert.equal(fs.existsSync(path.join(agentsDir, "sample", "config.json")), true);
    // User edits are not overwritten on later loads.
    fs.writeFileSync(path.join(agentsDir, "sample", "config.json"), JSON.stringify({ model: "edited" }));
    const second = loadAgentProfile("sample", { agentsDir, assetsDir });
    assert.equal(second.config.model, "edited");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
