"use strict";

// A2A (Agent2Agent) protocol domain.
//
// A2A is an edge adapter, not a subagent provider. It maps the external
// Task/Context contract onto one durable session plus one or more internal
// turns, while keeping message ids, task states and artifacts in their own
// tables. See docs/runtime/a2a.md for the mapping table.

import { randomUUID } from "crypto";
import fs from "fs";
import path from "path";
import { A2AClient } from "./client.js";

export const A2A_ERROR = {
  TASK_NOT_FOUND: -32001,
  TASK_NOT_CANCELABLE: -32002,
  TASK_ALREADY_ACTIVE: -32003,
  TASK_NOT_RESUMABLE: -32004,
  UNSUPPORTED: -32601,
  INVALID_PARAMS: -32602,
};

const TERMINAL_STATES = new Set([
  "TASK_STATE_COMPLETED",
  "TASK_STATE_FAILED",
  "TASK_STATE_CANCELED",
  "TASK_STATE_REJECTED",
]);

export class A2AError extends Error {
  constructor(code, message, data) {
    super(message);
    this.name = "A2AError";
    this.code = code;
    this.data = data;
  }
}

function nowIso() { return new Date().toISOString(); }

function asTextParts(parts) {
  if (!Array.isArray(parts) || parts.length === 0) {
    throw new A2AError(A2A_ERROR.INVALID_PARAMS, "message.parts must contain at least one text part");
  }
  const texts = [];
  for (const part of parts) {
    if (!part || typeof part !== "object") {
      throw new A2AError(A2A_ERROR.INVALID_PARAMS, "message.parts must contain objects");
    }
    if (typeof part.text === "string") {
      texts.push(part.text);
    } else {
      // v1.0 also allows raw/url/data. The MVP accepts them in storage but
      // cannot hand them to a text-only model; reject explicitly instead of
      // silently dropping input.
      throw new A2AError(A2A_ERROR.INVALID_PARAMS, "this agent only accepts text parts in v1");
    }
  }
  const text = texts.join("\n").trim();
  if (!text) throw new A2AError(A2A_ERROR.INVALID_PARAMS, "message text is empty");
  return text;
}

function taskToJson(task) {
  const status = {
    state: task.state,
    timestamp: task.updatedAt || nowIso(),
  };
  if (task.statusMessage) {
    status.message = {
      messageId: task.lastMessageId || `status-${task.taskId}`,
      role: "ROLE_AGENT",
      parts: [{ text: task.statusMessage, mediaType: "text/plain" }],
    };
  }
  const out = {
    id: task.taskId,
    contextId: task.contextId,
    status,
  };
  if (task.artifacts && task.artifacts.length) out.artifacts = task.artifacts;
  if (task.input && task.input.message) out.history = [task.input.message];
  return out;
}

function artifactFor(content) {
  if (typeof content !== "string" || !content.trim()) return [];
  return [{
    artifactId: `art-${randomUUID()}`,
    name: "Answer",
    description: "Final answer from the agent turn",
    parts: [{ text: content, mediaType: "text/plain" }],
  }];
}

export class A2AService {
  constructor({ store, agent, interactions, logger = console }) {
    this.store = store;
    this.agent = agent;
    this.interactions = interactions;
    this.logger = logger;
    this.active = new Map(); // taskId -> { agent, cancelled }
    this.activeContexts = new Set();
    this.client = new A2AClient({ logger });
  }

  async ensureInstance({
    instanceId = "default",
    name = "Micro Agent",
    description = "Local micro AI agent exposed over A2A",
    version = "0.1.0",
    workspacePath = process.cwd(),
    skills = [{ id: "chat", name: "Chat", description: "General conversation", tags: ["chat"], inputModes: ["text/plain"], outputModes: ["text/plain"] }],
    tokenEnv = null,
    approvalPolicy = "deny",
  } = {}) {
    const existing = await this.store.run("a2aInstance.get", { instance_id: instanceId });
    if (existing) return existing;
    const workspace = await this._ensureWorkspace(workspacePath);
    return this.store.run("a2aInstance.create", {
      instance_id: instanceId,
      name,
      description,
      version,
      workspace_id: workspace.id,
      skills: skills || [],
      token_env: tokenEnv,
      approval_policy: approvalPolicy,
      enabled: 1,
    });
  }

  async getInstance(instanceId) {
    const instance = await this.store.run("a2aInstance.get", { instance_id: instanceId });
    if (!instance || !instance.enabled) throw new A2AError(A2A_ERROR.TASK_NOT_FOUND, `A2A instance not found: ${instanceId}`);
    return instance;
  }

  async agentCard(instanceId, { baseUrl, tokenRequired = false } = {}) {
    const instance = await this.getInstance(instanceId);
    const base = String(baseUrl || "").replace(/\/+$/, "");
    const url = base ? `${base}/a2a/${instance.instanceId}` : `/a2a/${instance.instanceId}`;
    const card = {
      name: instance.name,
      description: instance.description || "",
      version: instance.version,
      supportedInterfaces: [{
        url,
        protocolBinding: "JSONRPC",
        protocolVersion: "1.0.1",
      }],
      capabilities: {
        streaming: false,
        pushNotifications: false,
        extendedAgentCard: false,
      },
      defaultInputModes: ["text/plain"],
      defaultOutputModes: ["text/plain"],
      skills: (instance.skills || []).map((skill) => ({
        id: skill.id,
        name: skill.name || skill.id,
        description: skill.description || "",
        tags: skill.tags || [],
        examples: skill.examples || [],
        inputModes: skill.inputModes || ["text/plain"],
        outputModes: skill.outputModes || ["text/plain"],
      })),
    };
    if (tokenRequired) {
      card.securitySchemes = { bearer: { type: "http", scheme: "bearer" } };
      card.securityRequirements = [{ bearer: [] }];
    }
    return card;
  }

  async sendMessage(instanceId, params = {}) {
    const instance = await this.getInstance(instanceId);
    const message = params.message;
    if (!message || typeof message !== "object") throw new A2AError(A2A_ERROR.INVALID_PARAMS, "params.message is required");
    const messageId = String(message.messageId || "").trim();
    if (!messageId) throw new A2AError(A2A_ERROR.INVALID_PARAMS, "message.messageId is required");
    const role = message.role || "ROLE_USER";
    if (role !== "ROLE_USER") throw new A2AError(A2A_ERROR.INVALID_PARAMS, "message.role must be ROLE_USER");

    // Idempotency: messageId is the client's retry key. Return the same task
    // instead of starting a second turn.
    const seen = await this.store.run("a2aMessage.get", { message_id: messageId });
    if (seen) {
      const existing = await this.store.run("a2aTask.get", { task_id: seen.taskId });
      if (!existing || existing.instanceId !== instance.instanceId) {
        throw new A2AError(A2A_ERROR.TASK_NOT_FOUND, "task referenced by message no longer exists");
      }
      return { task: taskToJson(existing) };
    }

    const parts = message.parts;
    const text = asTextParts(parts);
    const metadata = message.metadata || params.metadata || {};
    const requestedSkill = String(metadata.skill || "").trim();
    const instanceSkillIds = (instance.skills || []).map((s) => s.id);
    const skill = requestedSkill || instanceSkillIds[0] || "chat";
    if (instanceSkillIds.length && !instanceSkillIds.includes(skill)) {
      throw new A2AError(A2A_ERROR.INVALID_PARAMS, `unknown skill: ${skill}`);
    }

    let task;
    let context;
    if (message.taskId) {
      task = await this.store.run("a2aTask.get", { task_id: String(message.taskId) });
      if (!task) throw new A2AError(A2A_ERROR.TASK_NOT_FOUND, `task not found: ${message.taskId}`);
      if (task.instanceId !== instance.instanceId) throw new A2AError(A2A_ERROR.TASK_NOT_FOUND, "task belongs to another instance");
      if (message.contextId && message.contextId !== task.contextId) throw new A2AError(A2A_ERROR.INVALID_PARAMS, "contextId does not match task");
      if (TERMINAL_STATES.has(task.state)) throw new A2AError(A2A_ERROR.TASK_NOT_RESUMABLE, `task is ${task.state}`);
      if (this.active.has(task.taskId)) throw new A2AError(A2A_ERROR.TASK_ALREADY_ACTIVE, "task is already running");
      context = await this.store.run("a2aContext.get", { context_id: task.contextId });
      if (!context) throw new A2AError(A2A_ERROR.TASK_NOT_FOUND, "context not found");
    } else {
      const contextId = String(message.contextId || `ctx-${randomUUID()}`);
      context = await this.store.run("a2aContext.get", { context_id: contextId });
      if (context) {
        if (context.instanceId !== instance.instanceId) throw new A2AError(A2A_ERROR.INVALID_PARAMS, "context belongs to another instance");
        if (this.activeContexts.has(contextId)) throw new A2AError(A2A_ERROR.TASK_ALREADY_ACTIVE, "context already has an active task");
      } else {
        const session = await this._createSession(instance);
        context = await this.store.run("a2aContext.getOrCreate", {
          context_id: contextId,
          instance_id: instance.instanceId,
          session_id: session.id,
        });
      }
      task = await this.store.run("a2aTask.create", {
        task_id: `a2a-${randomUUID()}`,
        context_id: context.contextId,
        session_id: context.sessionId,
        instance_id: instance.instanceId,
        skill,
        state: "TASK_STATE_SUBMITTED",
        input: { message: { messageId, role, parts }, metadata },
        artifacts: [],
        last_message_id: messageId,
      });
    }

    // Persist the inbound message before running so a crash cannot lose the
    // user's request. The unique message_id also closes the retry race.
    try {
      await this.store.run("a2aMessage.add", { message_id: messageId, task_id: task.taskId, role, parts });
    } catch (err) {
      const seenAgain = await this.store.run("a2aMessage.get", { message_id: messageId });
      if (seenAgain) {
        const existing = await this.store.run("a2aTask.get", { task_id: seenAgain.taskId });
        if (!existing || existing.instanceId !== instance.instanceId) {
          throw new A2AError(A2A_ERROR.TASK_NOT_FOUND, "task referenced by message no longer exists");
        }
        return { task: taskToJson(existing) };
      }
      throw err;
    }

    // The first message is already in input; continuation messages are in
    // a2a_messages and are appended to the session by executor.chat.
    if (task.state !== "TASK_STATE_SUBMITTED") {
      task = await this._updateTask(task, { last_message_id: messageId });
    }

    if (params.configuration && params.configuration.returnImmediately === true) {
      const active = await this._markWorking(task, context);
      void this._runTask(instance, active.task, text);
      return { task: taskToJson(active.task) };
    }

    const running = await this._markWorking(task, context);
    const final = await this._runTask(instance, running.task, text);
    return { task: taskToJson(final) };
  }

  async getTask({ taskId, instanceId } = {}) {
    if (!taskId) throw new A2AError(A2A_ERROR.INVALID_PARAMS, "taskId is required");
    const task = await this.store.run("a2aTask.get", { task_id: String(taskId) });
    if (!task) throw new A2AError(A2A_ERROR.TASK_NOT_FOUND, `task not found: ${taskId}`);
    if (instanceId && task.instanceId !== instanceId) throw new A2AError(A2A_ERROR.TASK_NOT_FOUND, `task not found: ${taskId}`);
    return { task: taskToJson(task) };
  }

  async listTasks({ contextId, instanceId } = {}) {
    const tasks = await this.store.run("a2aTask.list", { context_id: contextId, instance_id: instanceId });
    return { tasks: tasks.map(taskToJson) };
  }

  async cancelTask({ taskId, instanceId } = {}) {
    if (!taskId) throw new A2AError(A2A_ERROR.INVALID_PARAMS, "taskId is required");
    const task = await this.store.run("a2aTask.get", { task_id: String(taskId) });
    if (!task) throw new A2AError(A2A_ERROR.TASK_NOT_FOUND, `task not found: ${taskId}`);
    if (instanceId && task.instanceId !== instanceId) throw new A2AError(A2A_ERROR.TASK_NOT_FOUND, `task not found: ${taskId}`);
    if (TERMINAL_STATES.has(task.state)) {
      throw new A2AError(A2A_ERROR.TASK_NOT_CANCELABLE, `task is already ${task.state}`);
    }
    const running = this.active.get(task.taskId);
    if (running) {
      running.cancelled = true;
      try { running.agent.interrupt(); } catch (_) { /* already settled */ }
    }
    const canceled = await this._updateTask(task, {
      state: "TASK_STATE_CANCELED",
      status_message: "Canceled by client",
      finished_at: nowIso(),
    });
    this.active.delete(task.taskId);
    this.activeContexts.delete(task.contextId);
    return { task: taskToJson(canceled) };
  }

  // ---- internals ----

  async _ensureWorkspace(folder) {
    const abs = await fs.promises.realpath(path.resolve(folder)).catch(() => path.resolve(folder));
    const existing = await this.store.run("workspace.list", {});
    const hit = (existing || []).find((w) => w.folder_path === abs);
    if (hit) return hit;
    return this.store.run("workspace.create", {
      folder_path: abs,
      folder_name: path.basename(abs) || abs,
    });
  }

  async _createSession(instance) {
    const workspace = await this.store.run("workspace.get", { id: instance.workspaceId });
    if (!workspace) throw new A2AError(A2A_ERROR.INVALID_PARAMS, "A2A instance workspace no longer exists");
    return this.store.run("session.create", {
      workspace_id: workspace.id,
      name: `A2A ${instance.instanceId}`,
      description: `A2A context under ${workspace.folder_path}`,
      activity: "coding",
      kind: "normal",
    });
  }

  async _markWorking(task, context) {
    this.activeContexts.add(context.contextId);
    const entry = { agent: null, cancelled: false };
    this.active.set(task.taskId, entry);
    const result = await this.store.run("a2aTask.cas", {
      task_id: task.taskId,
      expected_revision: task.revision,
      patch: { state: "TASK_STATE_WORKING", status_message: null, error: null },
    });
    const working = result.task || {
      ...task,
      state: "TASK_STATE_WORKING",
      statusMessage: null,
      error: null,
    };
    return { task: working, context };
  }

  async _updateTask(task, patch) {
    const current = await this.store.run("a2aTask.get", { task_id: task.taskId });
    if (!current) return null;
    const result = await this.store.run("a2aTask.cas", {
      task_id: task.taskId,
      expected_revision: current.revision,
      patch,
    });
    return result.task;
  }

  async _runTask(instance, task, text) {
    const entry = this.active.get(task.taskId) || { agent: null, cancelled: false };
    this.active.set(task.taskId, entry);
    let lastTurn = null;
    let failed = null;
    try {
      const agent = this.agent.get(task.sessionId) || this.agent.getOrCreate(task.sessionId);
      entry.agent = agent;
      const policy = instance.approvalPolicy || "deny";
      const result = await agent.chat({
        sessionId: task.sessionId,
        messages: [{ role: "user", content: text }],
        inputSource: "a2a",
        stream: true,
        onEvent: (event) => {
          if (!event || typeof event !== "object") return;
          if (event.type === "turn-start") lastTurn = { status: "pending" };
          if (event.type === "turn-end") lastTurn = { status: event.status, error: event.error, reason: event.reason };
          if (event.type === "approval-request" && event.permission === "ask" && event.id != null) {
            // A2A has no interactive approval UI. Only an instance explicitly
            // set to `allow` can approve; everything else is denied. We never
            // burn AUTH_REQUIRED for tool approval — that would be a lie.
            try {
              if (policy === "allow") this.interactions.approve(event.id, "approve");
              else this.interactions.approve(event.id, "deny");
            } catch (_) { /* expired */ }
          }
          if (event.type === "ask-user-question" && event.id != null) {
            // No remote user prompt channel in MVP; answer empty so the tool
            // returns its default and the task can finish. A future version
            // maps this to INPUT_REQUIRED + a follow-up message.
            try { this.interactions.answerQuestions(event.id, []); } catch (_) { /* expired */ }
          }
          if (event.type === "plan-review" && event.id != null) {
            try { this.interactions.reviewPlan(event.id, { approved: policy === "allow" }); } catch (_) { /* expired */ }
          }
        },
      });
      if (entry.cancelled) {
        return this._settle(task, "TASK_STATE_CANCELED", { status_message: "Canceled by client", artifacts: [], error: null });
      }
      const status = result && typeof result === "object" && result.status != null
        ? result.status
        : (lastTurn ? lastTurn.status : null);
      if (status === "failed" || (result && result.error)) {
        failed = (result && result.error) || (lastTurn && lastTurn.error) || "turn failed";
      }
      if (failed) return this._settle(task, "TASK_STATE_FAILED", { status_message: "Turn failed", error: String(failed), artifacts: [] });

      const content = typeof result === "string" ? result : (result && result.content);
      const artifacts = artifactFor(content);
      return this._settle(task, "TASK_STATE_COMPLETED", {
        status_message: artifacts.length ? null : "Turn completed with no text output",
        artifacts,
        error: null,
      });
    } catch (err) {
      if (entry.cancelled) {
        return this._settle(task, "TASK_STATE_CANCELED", { status_message: "Canceled by client", artifacts: [], error: null });
      }
      return this._settle(task, "TASK_STATE_FAILED", { status_message: "Turn failed", error: String(err && err.message || err), artifacts: [] });
    } finally {
      this.active.delete(task.taskId);
      this.activeContexts.delete(task.contextId);
    }
  }

  async _settle(task, state, patch) {
    const current = await this.store.run("a2aTask.get", { task_id: task.taskId });
    if (!current) return { ...task, state };
    if (current.state === "TASK_STATE_CANCELED" && state !== "TASK_STATE_CANCELED") return current;
    const result = await this.store.run("a2aTask.cas", {
      task_id: task.taskId,
      expected_revision: current.revision,
      patch: {
        state,
        status_message: patch.status_message || null,
        artifacts: patch.artifacts || [],
        error: patch.error || null,
        finished_at: nowIso(),
      },
    });
    return result.task || current;
  }
}

export function createA2AService(options) { return new A2AService(options); }
export default A2AService;
