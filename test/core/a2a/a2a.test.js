import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { createStore } from "../../../core/storage/store.js";
import { A2AService, A2AError } from "../../../core/a2a/index.js";
import { A2AHttpServer } from "../../../core/a2a/http.js";
import { A2AClient } from "../../../core/a2a/client.js";

async function harness() {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "a2a-test-"));
  const store = await createStore({ path: path.join(dir, "store.db") });
  const calls = [];
  const agents = new Map();
  const agent = {
    get(id) { return agents.get(String(id)) || null; },
    getOrCreate(id) {
      const key = String(id);
      if (!agents.has(key)) {
        agents.set(key, {
          sessionId: id,
          interrupted: false,
          interrupt() { this.interrupted = true; return true; },
          async chat({ onEvent, messages }) {
            calls.push({ id, messages });
            onEvent({ type: "turn-start" });
            onEvent({ type: "turn-end", status: "succeeded", reason: "fake" });
            return { role: "assistant", content: "A2A answer" };
          },
        });
      }
      return agents.get(key);
    },
  };
  const service = new A2AService({
    store,
    agent,
    interactions: { approve() { return true; }, answerQuestions() { return true; }, reviewPlan() { return true; } },
    logger: { error() {}, warn() {} },
  });
  const instance = await service.ensureInstance({ workspacePath: dir });
  return { dir, store, service, instance, calls, agents, agent };
}

async function cleanup(h) {
  await h.store.close();
  await fs.promises.rm(h.dir, { recursive: true, force: true });
}

test("A2A SendMessage maps one context to one session and returns an artifact", async () => {
  const h = await harness();
  try {
    const result = await h.service.sendMessage(h.instance.instanceId, {
      message: { messageId: "m-1", role: "ROLE_USER", parts: [{ text: "hello" }] },
    });
    assert.equal(result.task.status.state, "TASK_STATE_COMPLETED");
    assert.equal(result.task.artifacts[0].parts[0].text, "A2A answer");
    const stored = await h.store.run("a2aTask.get", { task_id: result.task.id });
    assert.equal(stored.sessionId, (await h.store.run("a2aContext.get", { context_id: result.task.contextId })).sessionId);
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].messages[0].content, "hello");

    const card = await h.service.agentCard(h.instance.instanceId, { baseUrl: "http://127.0.0.1:8787" });
    assert.equal(card.skills[0].id, "chat");
    assert.equal(card.supportedInterfaces[0].protocolVersion, "1.0.1");
  } finally { await cleanup(h); }
});

test("messageId is idempotent and does not start a second turn", async () => {
  const h = await harness();
  try {
    const first = await h.service.sendMessage(h.instance.instanceId, {
      message: { messageId: "m-idem", role: "ROLE_USER", parts: [{ text: "once" }] },
    });
    const second = await h.service.sendMessage(h.instance.instanceId, {
      message: { messageId: "m-idem", role: "ROLE_USER", parts: [{ text: "once again" }] },
    });
    assert.equal(first.task.id, second.task.id);
    assert.equal(h.calls.length, 1);
  } finally { await cleanup(h); }
});

test("CancelTask interrupts an active turn and wins over its late completion", async () => {
  const h = await harness();
  try {
    let release;
    const gate = new Promise((r) => { release = r; });
    const original = h.agent.getOrCreate;
    h.agent.getOrCreate = function (id) {
      const item = original.call(this, id);
      item.chat = async ({ onEvent }) => {
        onEvent({ type: "turn-start" });
        await gate;
        onEvent({ type: "turn-end", status: "succeeded", reason: "late" });
        return { content: "late answer" };
      };
      return item;
    };
    const pending = h.service.sendMessage(h.instance.instanceId, {
      message: { messageId: "m-cancel", role: "ROLE_USER", parts: [{ text: "slow" }] },
    });
    // Let sendMessage enter the running state.
    await new Promise((r) => setTimeout(r, 100));
    const task = await h.store.run("a2aTask.list", { instance_id: h.instance.instanceId });
    assert.equal(task[0].state, "TASK_STATE_WORKING");
    const canceled = await h.service.cancelTask({ taskId: task[0].taskId });
    assert.equal(canceled.task.status.state, "TASK_STATE_CANCELED");
    release();
    const settled = await pending;
    assert.equal(settled.task.status.state, "TASK_STATE_CANCELED");
  } finally { await cleanup(h); }
});

test("JSON-RPC HTTP exposes AgentCard, SendMessage, GetTask and Bearer auth", async () => {
  const h = await harness();
  const server = new A2AHttpServer({
    service: h.service,
    instanceId: h.instance.instanceId,
    host: "127.0.0.1",
    port: 0,
    token: "secret",
    logger: { error() {}, warn() {} },
  });
  try {
    await server.start();
    const base = server.address().baseUrl;
    const cardRes = await fetch(`${base}/a2a/${h.instance.instanceId}/agent-card.json`);
    assert.equal(cardRes.status, 200);
    const card = await cardRes.json();
    assert.equal(card.securitySchemes.bearer.scheme, "bearer");

    const unauthorized = await fetch(`${base}/a2a/${h.instance.instanceId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "GetTask", params: { taskId: "x" } }),
    });
    assert.equal(unauthorized.status, 401);

    const rpc = (body) => fetch(`${base}/a2a/${h.instance.instanceId}`, {
      method: "POST",
      headers: { "content-type": "application/json", "authorization": "Bearer secret", "A2A-Version": "1.0" },
      body: JSON.stringify(body),
    });
    const send = await rpc({ jsonrpc: "2.0", id: 2, method: "SendMessage", params: { message: { messageId: "http-1", role: "ROLE_USER", parts: [{ text: "over http" }] } } });
    const sendJson = await send.json();
    assert.equal(sendJson.result.task.status.state, "TASK_STATE_COMPLETED");
    assert.equal(sendJson.result.task.artifacts[0].parts[0].text, "A2A answer");

    const id = sendJson.result.task.id;
    const get = await rpc({ jsonrpc: "2.0", id: 3, method: "GetTask", params: { taskId: id } });
    const getJson = await get.json();
    assert.equal(getJson.result.task.id, id);
  } finally {
    await server.stop();
    await cleanup(h);
  }
});

test("outbound A2AClient consumes the inbound server through its AgentCard", async () => {
  const h = await harness();
  const server = new A2AHttpServer({
    service: h.service,
    instanceId: h.instance.instanceId,
    host: "127.0.0.1",
    port: 0,
    logger: { error() {}, warn() {} },
  });
  try {
    await server.start();
    const base = server.address().baseUrl;
    const client = new A2AClient({ logger: { error() {}, warn() {} } });
    const result = await client.call({
      cardUrl: `${base}/a2a/${h.instance.instanceId}/agent-card.json`,
      prompt: "outbound hello",
      timeoutMs: 5000,
    });
    assert.equal(result.state, "TASK_STATE_COMPLETED");
    assert.equal(result.text, "A2A answer");
  } finally {
    await server.stop();
    await cleanup(h);
  }
});
