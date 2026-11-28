"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RpcRegistry } from "../../../core/rpc/registry.js";
import defineAgentCommands from "../../../core/rpc/handlers/agents.js";

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-profiles-"));
  const mainFile = path.join(dir, "agent", "config.json");
  const assetsFile = path.join(dir, "assets", "agent", "config.json");
  fs.mkdirSync(path.dirname(assetsFile), { recursive: true });
  fs.writeFileSync(assetsFile, JSON.stringify({}));
  const agentsDir = path.join(dir, "agents");
  const channelsFile = path.join(dir, "user", "channels.json");
  return {
    dir,
    mainFile,
    agentsDir,
    channelsFile,
    rpc() {
      const rpc = new RpcRegistry({});
      defineAgentCommands(rpc, { mainFile, assetsFile, agentsDir, channelsFile });
      return rpc;
    },
  };
}

test("profiles are stored as agent/config.json and agents/<id>/config.json", async () => {
  const fx = fixture();
  try {
    const rpc = fx.rpc();
    assert.deepEqual(await rpc.handle("agent.list", {}), { main: {}, agents: [] });
    assert.deepEqual(await rpc.handle("agent.get", {}), {});

    const main = await rpc.handle("agent.upsert", { payload: { name: "主智能", persona: "Be brief." } });
    assert.equal(main.persona, "Be brief.");
    assert.equal(fs.existsSync(fx.mainFile), true);
    assert.equal((await rpc.handle("agent.get", {})).persona, "Be brief.");

    const other = await rpc.handle("agent.upsert", {
      payload: { id: "helper", name: "助手", persona: "Be precise.", model: "model-x", effort: "low", tools: ["read"] },
    });
    assert.equal(other.id, "helper");
    assert.equal(fs.existsSync(path.join(fx.agentsDir, "helper", "config.json")), true);

    const listed = await rpc.handle("agent.list", {});
    assert.equal(listed.main.name, "主智能");
    assert.equal(listed.agents.length, 1);
    assert.equal(listed.agents[0].id, "helper");
    assert.equal((await rpc.handle("agent.get", { id: "helper" })).model, "model-x");

    assert.deepEqual(await rpc.handle("agent.delete", { id: "helper" }), { deleted: true });
    assert.equal((await rpc.handle("agent.list", {})).agents.length, 0);
    await assert.rejects(rpc.handle("agent.delete", {}), /main agent cannot be deleted/);
  } finally {
    fs.rmSync(fx.dir, { recursive: true, force: true });
  }
});

test("bot upsert writes prompt/tools/loops as separate files and delete removes them", async () => {
  const fx = fixture();
  try {
    const rpc = fx.rpc();
    const hooks = [{ on: "model-call", slot: "after", target: "channel-send" }];
    const saved = await rpc.handle("agent.upsert", {
      payload: {
        id: "curator", name: "采集", persona: "Terse.", model: "m", effort: "high",
        tools: ["read", "web_fetch"], prompt: "Collect sources.", loops: hooks,
      },
    });
    const botDir = path.join(fx.agentsDir, "curator");
    assert.deepEqual(saved.tools, ["read", "web_fetch"]);
    assert.deepEqual(saved.prompt, "Collect sources.");
    assert.deepEqual(saved.loops, hooks);
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(botDir, "config.json"), "utf8")).tools,
      undefined,
      "tools.json is authoritative for bot agents"
    );
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(botDir, "tools.json"), "utf8")), ["read", "web_fetch"]);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(botDir, "loops.json"), "utf8")), hooks);
    assert.equal(fs.readFileSync(path.join(botDir, "prompt"), "utf8"), "Collect sources.");

    const detail = await rpc.handle("agent.get", { id: "curator" });
    assert.deepEqual(detail.tools, ["read", "web_fetch"]);
    assert.deepEqual(detail.loops, hooks);
    assert.equal(detail.prompt, "Collect sources.");
    assert.deepEqual((await rpc.handle("agent.list", {})).agents[0].tools, ["read", "web_fetch"]);

    assert.deepEqual(await rpc.handle("agent.delete", { id: "curator" }), { deleted: true });
    assert.equal(fs.existsSync(botDir), false, "all profile files are removed");
  } finally {
    fs.rmSync(fx.dir, { recursive: true, force: true });
  }
});

test("bot upsert rejects invalid hooks before writing any file", async () => {
  const fx = fixture();
  try {
    const rpc = fx.rpc();
    await assert.rejects(
      rpc.handle("agent.upsert", {
        payload: { id: "bad", name: "x", loops: [{ on: "nope", slot: "after", target: "channel-send" }] },
      }),
      /is not an existing core node/
    );
    assert.equal(fs.existsSync(path.join(fx.agentsDir, "bad")), false);
  } finally {
    fs.rmSync(fx.dir, { recursive: true, force: true });
  }
});

test("agent upsert validates id and effort", async () => {
  const fx = fixture();
  try {
    const rpc = fx.rpc();
    await assert.rejects(
      rpc.handle("agent.upsert", { payload: { id: "Bad ID", name: "x" } }),
      /id must be lower-case/
    );
    await assert.rejects(
      rpc.handle("agent.upsert", { payload: { id: "good", name: "x", effort: "extreme" } }),
      /effort must be low, medium or high/
    );
    await assert.rejects(
      rpc.handle("agent.upsert", { payload: { id: "good" } }),
      /name is required/
    );
  } finally {
    fs.rmSync(fx.dir, { recursive: true, force: true });
  }
});

test("a profile bound to a channel cannot be deleted", async () => {
  const fx = fixture();
  try {
    const rpc = fx.rpc();
    await rpc.handle("agent.upsert", { payload: { id: "helper", name: "助手" } });
    fs.mkdirSync(path.dirname(fx.channelsFile), { recursive: true });
    fs.writeFileSync(fx.channelsFile, JSON.stringify({ channels: [{ id: "bot", agent: "helper" }] }));
    await assert.rejects(rpc.handle("agent.delete", { id: "helper" }), /bound to channel bot/);
  } finally {
    fs.rmSync(fx.dir, { recursive: true, force: true });
  }
});
