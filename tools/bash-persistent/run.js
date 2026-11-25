"use strict";

// Model-facing persistent bash. The registered tool name stays `bash`; the
// registry chooses between this provider and the one-shot provider, never
// registering both. A shell process per session carries cwd and exported
// environment across calls. Completion is framed by the terminal service, so
// stdout/stderr/exit status still map to the same model contract.

import { gateBashCommand } from "./../lib/bash-gate.js";
import { MAX_STREAM_BYTES, renderStream } from "./../lib/bash-output.js";
import { tailByBytes } from "./../../lib/tool-result/index.js";

const DEFAULT_TIMEOUT_MS = 120000;

function parseArgs(args) {
  if (typeof args.command !== "string" || args.command.trim().length === 0) {
    throw new Error("invalid command: expected a non-empty string");
  }
  return { command: args.command };
}

function shellKey(exec) {
  // Persistent state belongs to the agent instance. Persisted sessions have an
  // id; bare tool loops are not expected, but keep a stable fallback.
  if (exec.sessionId != null && exec.sessionId !== "") return String(exec.sessionId);
  if (exec.agent && exec.agent.key) return "agent:" + exec.agent.key;
  return "__bare__";
}

export default {
  async run(args = {}, exec = {}) {
    const input = parseArgs(args);

    const gate = await gateBashCommand(input.command);
    if (!gate || gate.verdict === "allow") {
      // proceed
    } else if (gate.verdict === "deny") {
      return gate;
    } else if (gate.verdict === "ask") {
      if (typeof exec.requestApproval !== "function") return gate;
      const decision = await exec.requestApproval({
        callId: exec.callId,
        name: "bash",
        args: { command: input.command },
        permission: "ask",
        policy: gate.decision,
      });
      if (decision !== "approve") {
        return {
          text: "[bash policy] command blocked: user denied approval\n" + (gate.text || ""),
          isError: true,
          meta: { kind: "policy-blocked", decision: gate.decision, userDenied: true },
        };
      }
    }

    const terminals = exec.terminals;
    if (!terminals || typeof terminals.run !== "function") {
      return {
        text: "Error: bash persistent provider requires the terminal service",
        isError: true,
      };
    }

    const timeoutMs = DEFAULT_TIMEOUT_MS;
    let result;
    try {
      result = await terminals.run(shellKey(exec), input.command, {
        cwd: exec.cwd,
        signal: exec.signal,
        timeoutMs,
      });
    } catch (error) {
      // runTool maps an aborted call to its own model-visible text. Timeouts
      // and shell deaths surface here as ordinary tool errors.
      throw error;
    }

    const callId = exec.callId || "bash";
    const out = renderStream(result.stdout || "", callId, "stdout");
    const err = renderStream(result.stderr || "", callId, "stderr");

    let body = out.text;
    if (err.text.length > 0) {
      if (body.length > 0 && !body.endsWith("\n")) body += "\n";
      body += "[stderr]\n" + err.text;
    }
    if (body.length === 0) body = "(no output)";

    const markers = [];
    if (result.exitCode != null && result.exitCode !== 0) {
      markers.push("[exit code: " + result.exitCode + "]");
    }
    let text = body;
    if (markers.length > 0) {
      if (!text.endsWith("\n")) text += "\n";
      text += markers.join("\n");
    }

    return {
      text,
      meta: {
        kind: "persistent",
        backend: result.backend || null,
        cwd: result.cwd || exec.cwd || null,
        exitCode: result.exitCode == null ? null : result.exitCode,
        timedOut: false,
        aborted: false,
        timeoutMs,
        stdout: {
          text: tailByBytes(result.stdout || "", MAX_STREAM_BYTES),
          truncated: out.truncated,
          ...(out.spillPath ? { spillPath: out.spillPath } : {}),
        },
        stderr: {
          text: tailByBytes(result.stderr || "", MAX_STREAM_BYTES),
          truncated: err.truncated,
          ...(err.spillPath ? { spillPath: err.spillPath } : {}),
        },
      },
    };
  },
};
