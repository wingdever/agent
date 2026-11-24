/**
 * ACP (Agent Client Protocol) edge adapter.
 *
 * The adapter is deliberately a separate boundary: it translates ACP JSON-RPC
 * into the same `core.agent.chat` / `core.store` / `core.interactions` calls the
 * Electron client already uses. It never owns an agent loop and never imports
 * UI, transport or launcher modules.
 */
import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import {
  agent as createAcpAgentApp,
  methods,
  PROTOCOL_VERSION,
  RequestError,
} from "@agentclientprotocol/sdk";

const ACP_AGENT_NAME = "micro-agent";
const ACP_AGENT_VERSION = "0.1.0";

function invalid(message, data) {
  return RequestError.invalidParams(data, message);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

async function canonicalDirectory(cwd) {
  if (!isNonEmptyString(cwd) || !path.isAbsolute(cwd)) {
    throw invalid("cwd must be an absolute path");
  }
  let resolved;
  try {
    resolved = await realpath(cwd);
  } catch (err) {
    throw invalid("cwd is not accessible: " + (err.message || String(err)));
  }
  const info = await stat(resolved);
  if (!info.isDirectory()) throw invalid("cwd must be a directory");
  return resolved;
}

function promptText(prompt) {
  if (!Array.isArray(prompt) || prompt.length === 0) {
    throw invalid("prompt must contain at least one content block");
  }
  const parts = [];
  for (const block of prompt) {
    if (block && block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
      continue;
    }
    throw invalid("only text prompt blocks are supported by this adapter");
  }
  const text = parts.join("\n").trim();
  if (!text) throw invalid("prompt text is empty");
  return text;
}

function parseArguments(value) {
  if (typeof value !== "string") return value ?? {};
  try {
    return JSON.parse(value);
  } catch {
    return { raw: value };
  }
}

function timestamp(value) {
  if (!value) return null;
  const text = String(value);
  if (/^\d{4}-\d{2}-\d{2}T/.test(text)) return text;
  return text.replace(" ", "T") + "Z";
}

function stopReasonFor(status, reason) {
  if (status === "failed") return "refusal";
  if (reason === "truncated") return "max_tokens";
  return "end_turn";
}

/**
 * Create the ACP app and its session table. `core` is the object returned by
 * `createCore()`; tests can pass a fake with the same surface.
 */
export function createAcpServer({ core, logger = console, name = ACP_AGENT_NAME } = {}) {
  if (!core) throw new Error("createAcpServer requires core");
  const sessions = new Map(); // ACP session id -> record
  let connection = null;
  let closed = false;

  const app = createAcpAgentApp({ name: ACP_AGENT_NAME })
    .onConnect((conn) => {
      connection = conn;
      conn.closed.finally(() => {
        closed = true;
        connection = null;
      }).catch(() => {});
    })
    .onRequest(methods.agent.initialize, ({ params }) => {
      return {
        protocolVersion: PROTOCOL_VERSION,
        agentCapabilities: {
          promptCapabilities: { image: false, audio: false, embeddedContext: false },
          sessionCapabilities: { list: {}, resume: {}, close: {} },
        },
        authMethods: [],
        agentInfo: { name: ACP_AGENT_NAME, version: ACP_AGENT_VERSION },
      };
    })
    .onRequest(methods.agent.authenticate, () => ({}))
    .onRequest(methods.agent.session.new, async ({ params }) => {
      const cwd = await canonicalDirectory(params?.cwd);
      if (Array.isArray(params?.additionalDirectories) && params.additionalDirectories.length > 0) {
        throw invalid("additionalDirectories is not supported");
      }
      if (Array.isArray(params?.mcpServers) && params.mcpServers.length > 0) {
        throw invalid("MCP servers are not supported by this adapter");
      }
      const workspace = await ensureWorkspace(core, cwd);
      const row = await core.store.run("session.create", {
        workspace_id: workspace.id,
        kind: "normal",
        name: "ACP " + path.basename(cwd),
        description: "ACP session at " + cwd,
        activity: "coding",
      });
      const acpSessionId = String(row.id);
      const record = {
        sessionId: acpSessionId,
        internalId: row.id,
        cwd,
        agent: await core.agent.getOrCreate(acpSessionId),
        active: false,
        cancelled: false,
        stopReason: "end_turn",
        messageId: null,
        updateChain: Promise.resolve(),
      };
      sessions.set(acpSessionId, record);
      return { sessionId: acpSessionId };
    })
    .onRequest(methods.agent.session.list, async ({ params }) => {
      const cwd = params?.cwd ? await canonicalDirectory(params.cwd) : null;
      const rows = await core.store.run("session.list", {});
      const result = [];
      for (const row of rows || []) {
        if (row.kind && row.kind !== "normal") continue;
        const workspace = await core.store.run("workspace.get", { id: row.workspace_id }).catch(() => null);
        const folder = workspace?.folder_path ? path.resolve(workspace.folder_path) : null;
        if (cwd && folder !== cwd) continue;
        result.push({
          sessionId: String(row.id),
          cwd: folder || process.cwd(),
          title: row.name || null,
          updatedAt: timestamp(row.updated_at),
        });
      }
      return { sessions: result };
    })
    .onRequest(methods.agent.session.resume, async ({ params }) => {
      const acpSessionId = String(params?.sessionId || "");
      if (!acpSessionId) throw invalid("sessionId is required");
      const existing = sessions.get(acpSessionId);
      if (existing) throw invalid("session is already active: " + acpSessionId);
      const cwd = await canonicalDirectory(params?.cwd);
      const row = await core.store.run("session.get", { id: Number(acpSessionId) }).catch(() => null);
      if (!row) throw invalid("session not found: " + acpSessionId);
      if (row.kind && row.kind !== "normal") throw invalid("only normal sessions can be resumed");
      const workspace = await core.store.run("workspace.get", { id: row.workspace_id }).catch(() => null);
      if (!workspace?.folder_path || path.resolve(workspace.folder_path) !== cwd) {
        throw invalid("session cwd does not match the requested cwd");
      }
      const record = {
        sessionId: acpSessionId,
        internalId: row.id,
        cwd,
        agent: await core.agent.getOrCreate(acpSessionId),
        active: false,
        cancelled: false,
        stopReason: "end_turn",
        messageId: null,
        updateChain: Promise.resolve(),
      };
      sessions.set(acpSessionId, record);
      return {};
    })
    .onRequest(methods.agent.session.close, async ({ params }) => {
      const acpSessionId = String(params?.sessionId || "");
      const record = sessions.get(acpSessionId);
      if (record) {
        record.agent?.interrupt?.();
        core.agent.agents?.().dispose?.(record.internalId);
        sessions.delete(acpSessionId);
      } else {
        core.agent.agents?.().dispose?.(Number(acpSessionId));
      }
      return {};
    })
    .onRequest(methods.agent.session.prompt, async ({ params }) => {
      const acpSessionId = String(params?.sessionId || "");
      const record = sessions.get(acpSessionId);
      if (!record) throw invalid("unknown session: " + acpSessionId);
      if (record.active) throw invalid("a prompt turn is already active");
      const text = promptText(params?.prompt);
      record.active = true;
      record.cancelled = false;
      record.stopReason = "end_turn";
      record.messageId = "msg-" + randomUUID();
      const turn = { sessionId: acpSessionId, record };
      try {
        const result = await core.agent.chat({
          sessionId: record.internalId,
          messages: [{ role: "user", content: text }],
          inputSource: "acp",
          stream: true,
          onEvent: (event) => handleEvent(turn, event),
        });
        if (result?.queued) throw new Error("agent accepted the prompt as a queued turn");
        await record.updateChain;
        return { stopReason: record.cancelled ? "cancelled" : record.stopReason };
      } catch (err) {
        logger.error?.("[acp] prompt failed: " + (err.message || String(err)));
        throw RequestError.internalError(undefined, err.message || String(err));
      } finally {
        record.active = false;
      }
    })
    .onNotification(methods.agent.session.cancel, ({ params }) => {
      const acpSessionId = String(params?.sessionId || "");
      const record = sessions.get(acpSessionId);
      if (!record) return;
      record.cancelled = true;
      record.agent?.interrupt?.();
    });

  function update(record, payload) {
    const send = () => {
      if (!connection) return;
      return connection.client.notify(methods.client.session.update, {
        sessionId: record.sessionId,
        update: payload,
      }).catch((err) => logger.warn?.("[acp] session/update failed: " + (err.message || String(err))));
    };
    record.updateChain = record.updateChain.then(send, send);
    return record.updateChain;
  }

  function handleEvent(turn, event) {
    if (!event || !event.type) return;
    const record = turn.record;
    switch (event.type) {
      case "token":
        if (event.delta) update(record, {
          sessionUpdate: "agent_message_chunk",
          messageId: record.messageId,
          content: { type: "text", text: event.delta },
        });
        break;
      case "reasoning":
        if (event.delta) update(record, {
          sessionUpdate: "agent_thought_chunk",
          messageId: record.messageId,
          content: { type: "text", text: event.delta },
        });
        break;
      case "tool_call":
        update(record, {
          sessionUpdate: "tool_call",
          toolCallId: event.id,
          title: event.name,
          kind: "other",
          status: "in_progress",
          rawInput: parseArguments(event.arguments),
        });
        break;
      case "tool_result":
        update(record, {
          sessionUpdate: "tool_call_update",
          toolCallId: event.id,
          status: event.isError ? "failed" : "completed",
          content: event.content ? [{ type: "content", content: { type: "text", text: String(event.content) } }] : undefined,
        });
        break;
      case "approval-request":
        if (event.id != null && event.permission === "ask") {
          void requestPermission(record, event);
        }
        break;
      case "ask-user-question":
        // ACP has no standard user-question request; fail closed with empty
        // selections instead of leaving the turn suspended forever.
        if (event.id != null) core.interactions.answerQuestions(event.id, []);
        break;
      case "plan-review":
        // ACP has no standard plan-review request either. A plan is the agent's
        // own proposal, not a tool capability, so accept it and keep the turn
        // moving; permission for tools remains a separate request.
        if (event.id != null) core.interactions.answerPlanReview(event.id, { approved: true });
        break;
      case "turn-end":
        record.stopReason = stopReasonFor(event.status, event.reason);
        break;
      default:
        break;
    }
  }

  async function requestPermission(record, event) {
    const toolCall = {
      toolCallId: String(event.callId ?? event.id),
      title: event.name || "tool",
      kind: "other",
      status: "pending",
      rawInput: parseArguments(event.arguments),
    };
    const options = [
      { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
      { optionId: "reject-once", name: "Reject", kind: "reject_once" },
    ];
    try {
      if (!connection) throw new Error("ACP connection is closed");
      const response = await connection.client.request(methods.client.session.requestPermission, {
        sessionId: record.sessionId,
        toolCall,
        options,
      });
      const selected = response?.outcome?.outcome === "selected" ? response.outcome.optionId : null;
      core.interactions.approve(event.id, selected === "allow-once" ? "approve" : "deny");
    } catch (err) {
      logger.warn?.("[acp] permission request failed: " + (err.message || String(err)));
      core.interactions.approve(event.id, "deny");
    }
  }

  return {
    app,
    sessions,
    get connection() { return connection; },
    get closed() { return closed; },
  };
}

async function ensureWorkspace(core, cwd) {
  const rows = await core.store.run("workspace.list", {});
  const found = (rows || []).find((row) => row.folder_path === cwd);
  if (found) return found;
  return core.store.run("workspace.create", {
    folder_path: cwd,
    folder_name: path.basename(cwd) || cwd,
  });
}

export default createAcpServer;
