import test from "node:test";
import assert from "node:assert/strict";
import {
  client as createAcpClientApp,
  methods,
  PROTOCOL_VERSION,
} from "@agentclientprotocol/sdk";
import { createAcpServer } from "../../../core/acp/index.js";

function fakeCore() {
  const state = {
    nextWorkspace: 1,
    nextSession: 1,
    workspaces: [],
    sessions: [],
    approvals: [],
  };
  const store = {
    async run(op, params = {}) {
      switch (op) {
        case "workspace.list":
          return state.workspaces;
        case "workspace.create": {
          const row = { id: state.nextWorkspace++, ...params };
          state.workspaces.push(row);
          return row;
        }
        case "workspace.get":
          return state.workspaces.find((row) => row.id === params.id) || null;
        case "session.create": {
          const row = { id: state.nextSession++, kind: params.kind || "normal", ...params, updated_at: "2026-11-24 10:00:00" };
          state.sessions.push(row);
          return row;
        }
        case "session.get":
          return state.sessions.find((row) => row.id === params.id) || null;
        case "session.list":
          return state.sessions;
        default:
          throw new Error("unknown store op: " + op);
      }
    },
  };
  const agents = new Map();
  const agent = {
    async getOrCreate(id) {
      if (!agents.has(String(id))) {
        agents.set(String(id), {
          sessionId: id,
          interrupted: false,
          interrupt() { this.interrupted = true; return true; },
        });
      }
      return agents.get(String(id));
    },
    get(id) { return agents.get(String(id)) || null; },
    agents() {
      return { dispose(id) { return agents.delete(String(id)); } };
    },
    async chat({ onEvent }) {
      onEvent({ type: "token", delta: "hello " });
      onEvent({ type: "token", delta: "world" });
      onEvent({ type: "tool_call", id: "call-1", name: "read_file", arguments: '{"path":"a.js"}' });
      onEvent({ type: "tool_result", id: "call-1", name: "read_file", content: "ok", isError: false });
      onEvent({ type: "turn-end", status: "succeeded", reason: "no-tool-calls" });
      return { role: "assistant", content: "hello world" };
    },
  };
  return {
    store,
    agent,
    interactions: {
      approve(id, decision) { state.approvals.push({ id, decision }); return true; },
      answerQuestions() { return true; },
      answerPlanReview() { return true; },
    },
    state,
  };
}

test("ACP initialize, new session, prompt and update stream", async () => {
  const core = fakeCore();
  const server = createAcpServer({ core, logger: { warn() {}, error() {} } });
  const clientApp = createAcpClientApp({ name: "acp-test-client" });
  const updates = [];
  const clientAppWithUpdates = clientApp.onNotification(methods.client.session.update, ({ params }) => {
    updates.push(params);
  });
  const connection = clientAppWithUpdates.connect(server.app);
  const client = connection.agent;

  const init = await client.request(methods.agent.initialize, {
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: {},
  });
  assert.equal(init.protocolVersion, PROTOCOL_VERSION);
  assert.equal(init.agentCapabilities.sessionCapabilities.list !== undefined, true);

  const created = await client.request(methods.agent.session.new, {
    cwd: process.cwd(),
    mcpServers: [],
  });
  assert.ok(created.sessionId);

  const result = await client.request(methods.agent.session.prompt, {
    sessionId: created.sessionId,
    prompt: [{ type: "text", text: "hi" }],
  });
  assert.equal(result.stopReason, "end_turn");
  assert.equal(updates.length >= 2, true);
  assert.equal(updates[0].sessionId, created.sessionId);
  assert.equal(updates[0].update.sessionUpdate, "agent_message_chunk");
  assert.equal(updates[0].update.content.text, "hello ");
  const toolUpdate = updates.find((entry) => entry.update.sessionUpdate === "tool_call");
  assert.equal(toolUpdate.update.toolCallId, "call-1");

  await client.request(methods.agent.session.close, { sessionId: created.sessionId });
  connection.close();
});

test("ACP rejects non-text prompt blocks and unsupported MCP servers", async () => {
  const core = fakeCore();
  const server = createAcpServer({ core, logger: { warn() {}, error() {} } });
  const clientApp = createAcpClientApp({ name: "acp-test-client" });
  const connection = clientApp.connect(server.app);
  const client = connection.agent;
  await client.request(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });

  await assert.rejects(client.request(methods.agent.session.new, {
    cwd: process.cwd(),
    mcpServers: [{ type: "stdio", name: "x", command: "x", args: [], env: [] }],
  }));
  const created = await client.request(methods.agent.session.new, { cwd: process.cwd(), mcpServers: [] });
  await assert.rejects(client.request(methods.agent.session.prompt, {
    sessionId: created.sessionId,
    prompt: [{ type: "image", data: "AA==", mimeType: "image/png" }],
  }));
  connection.close();
});
test("ACP bridges an ask permission to session/requestPermission", async () => {
  const core = fakeCore();
  const state = core.state;
  let release;
  core.agent.chat = async ({ onEvent }) => {
    onEvent({ type: "approval-request", id: 7, callId: "call-7", name: "write_file", arguments: "{}", permission: "ask" });
    await new Promise((resolve) => { release = resolve; });
    onEvent({ type: "turn-end", status: "succeeded", reason: "no-tool-calls" });
    return { role: "assistant", content: "done" };
  };
  core.interactions.approve = (id, decision) => {
    state.approvals.push({ id, decision });
    release?.();
    return true;
  };
  const permissionRequests = [];
  const server = createAcpServer({ core, logger: { warn() {}, error() {} } });
  const clientApp = createAcpClientApp({ name: "acp-permission-test" })
    .onRequest(methods.client.session.requestPermission, ({ params }) => {
      permissionRequests.push(params);
      return { outcome: { outcome: "selected", optionId: "allow-once" } };
    });
  const connection = clientApp.connect(server.app);
  const client = connection.agent;
  await client.request(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
  const created = await client.request(methods.agent.session.new, { cwd: process.cwd(), mcpServers: [] });
  const result = await client.request(methods.agent.session.prompt, {
    sessionId: created.sessionId,
    prompt: [{ type: "text", text: "write" }],
  });
  assert.equal(result.stopReason, "end_turn");
  assert.equal(permissionRequests.length, 1);
  assert.equal(permissionRequests[0].toolCall.toolCallId, "call-7");
  assert.deepEqual(permissionRequests[0].options.map((option) => option.optionId), ["allow-once", "reject-once"]);
  assert.deepEqual(state.approvals, [{ id: 7, decision: "approve" }]);
  connection.close();
});
