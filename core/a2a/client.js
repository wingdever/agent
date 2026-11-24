"use strict";

// Outbound A2A client. It is intentionally stateless: the model-facing tool
// supplies a card URL, skill and prompt. Connection persistence can be added
// later without changing this wire layer.

import { randomUUID } from "crypto";

const VERSION_HEADER = "1.0";

function joinUrl(base, path) {
  if (!path) return base;
  return new URL(path, base).toString();
}

function textFromParts(parts) {
  if (!Array.isArray(parts)) return "";
  return parts.map((p) => (typeof p.text === "string" ? p.text : "")).filter(Boolean).join("\n");
}

function textFromArtifacts(artifacts) {
  if (!Array.isArray(artifacts)) return "";
  return artifacts.map((a) => textFromParts(a && a.parts)).filter(Boolean).join("\n");
}

export class A2AClient {
  constructor({ logger = console } = {}) { this.logger = logger; }

  async fetchCard(cardUrl) {
    const url = new URL(cardUrl);
    if (!/^https?:$/.test(url.protocol)) throw new Error("A2A card URL must be http(s)");
    const res = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`AgentCard fetch failed: HTTP ${res.status}`);
    const card = await res.json();
    if (!card || typeof card !== "object" || !Array.isArray(card.supportedInterfaces) || !card.supportedInterfaces.length) {
      throw new Error("AgentCard has no supportedInterfaces");
    }
    return card;
  }

  async call({ cardUrl, prompt, skill, token, timeoutMs = 60000 } = {}) {
    if (!cardUrl) throw new Error("cardUrl is required");
    if (!prompt || typeof prompt !== "string") throw new Error("prompt is required");
    const card = await this.fetchCard(cardUrl);
    const iface = card.supportedInterfaces.find((i) => i.protocolBinding === "JSONRPC") || card.supportedInterfaces[0];
    if (!iface || !iface.url) throw new Error("AgentCard has no JSON-RPC interface");
    const endpoint = joinUrl(cardUrl, iface.url);
    const messageId = `msg-${randomUUID()}`;
    const body = {
      jsonrpc: "2.0",
      id: `a2a-call-${randomUUID()}`,
      method: "SendMessage",
      params: {
        message: {
          messageId,
          role: "ROLE_USER",
          parts: [{ text: prompt, mediaType: "text/plain" }],
          metadata: skill ? { skill } : {},
        },
        configuration: { returnImmediately: true },
      },
    };
    const first = await this._rpc(endpoint, body, token, timeoutMs);
    if (first.message) return { text: textFromParts(first.message.parts), state: null, message: first.message };
    const task = first.task;
    if (!task) throw new Error("A2A response contains neither task nor message");
    if (task.status && task.status.state === "TASK_STATE_COMPLETED") {
      return { text: textFromArtifacts(task.artifacts), state: task.status.state, task };
    }
    if (task.status && ["TASK_STATE_FAILED", "TASK_STATE_CANCELED", "TASK_STATE_REJECTED"].includes(task.status.state)) {
      throw new Error(`A2A task ${task.status.state}${task.status.message ? ": " + textFromParts(task.status.message.parts) : ""}`);
    }
    const final = await this._poll(endpoint, task.id, token, timeoutMs);
    return { text: textFromArtifacts(final.artifacts), state: final.status.state, task: final };
  }

  async _poll(endpoint, taskId, token, timeoutMs) {
    const deadline = Date.now() + Math.max(1000, Number(timeoutMs) || 60000);
    let delay = 500;
    while (Date.now() < deadline) {
      const body = {
        jsonrpc: "2.0",
        id: `a2a-get-${randomUUID()}`,
        method: "GetTask",
        params: { taskId },
      };
      const res = await this._rpc(endpoint, body, token, Math.min(15000, deadline - Date.now()));
      const task = res.task;
      if (!task) throw new Error("GetTask returned no task");
      const state = task.status && task.status.state;
      if (state === "TASK_STATE_COMPLETED") return task;
      if (["TASK_STATE_FAILED", "TASK_STATE_CANCELED", "TASK_STATE_REJECTED"].includes(state)) {
        const detail = task.status && task.status.message ? textFromParts(task.status.message.parts) : "";
        throw new Error(`A2A task ${state}${detail ? ": " + detail : ""}`);
      }
      if (state === "TASK_STATE_INPUT_REQUIRED" || state === "TASK_STATE_AUTH_REQUIRED") {
        return task;
      }
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(4000, Math.round(delay * 1.5));
    }
    throw new Error("A2A task polling timed out");
  }

  async _rpc(endpoint, body, token, timeoutMs) {
    const headers = {
      "content-type": "application/json",
      "A2A-Version": VERSION_HEADER,
    };
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(Math.max(1000, Number(timeoutMs) || 60000)),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`A2A HTTP ${res.status}${json && json.error ? ": " + json.error.message : ""}`);
    if (!json || json.jsonrpc !== "2.0") throw new Error("A2A response is not JSON-RPC 2.0");
    if (json.error) {
      const err = new Error(json.error.message || "A2A error");
      err.code = json.error.code;
      throw err;
    }
    return json.result || {};
  }
}

export default A2AClient;
