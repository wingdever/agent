"use strict";

// Model-facing bash, foreground-only for P0:
// - fresh `bash -c` per call, no state carried over
// - default 120s timeout, hard cap 600s; expiry kills the process group
// - each stream is capped to its last 64KB and spilled in full
// - stdout, a marked [stderr] section, then status markers
// Jobs/background execution are intentionally not exposed yet.

const { spawn } = require("child_process");
const path = require("path");
const { shellEnv } = require("../../core/tools/env");
const { writeSpill, tailByBytes } = require("../../core/tools/result");

// Phase 2 permission gate (tools/bash/policy). ESM modules are loaded lazily once
// and cached; CJS calls them via dynamic import. The gate runs before any shell
// is spawned. Outcome:
//   allow -> proceed;  ask/deny -> refuse execution (fail-closed; the tool layer
//   has no approval channel, so both block and explain why).
// NOTE: this agent implements NO sandbox. The BashToolArgs.sandbox_permissions /
// justification fields are intentionally ignored (not parsed, not enforced); the
// only safety boundary is this permission gate plus the host environment.
// and cached; CJS calls them via dynamic import. The gate runs before any shell
// is spawned. Outcome:
//   allow -> proceed;  ask/deny -> refuse execution (fail-closed; the tool layer
//   has no approval channel, so both block and explain why).
let _enginePromise = null;
function loadEngine() {
  if (!_enginePromise) {
    _enginePromise = (async () => {
      const policy = await import("./policy/index.mjs");
      const parse = await import("./parse/index.mjs");
      return { policy, parse };
    })();
  }
  return _enginePromise;
}

// Returns a verdict object describing whether the command may run:
//   { verdict: "allow" }                                   -> proceed
//   { verdict: "deny", ...blockedResult }                  -> refuse, no approval
//   { verdict: "ask", ...blockedResult, decision }         -> needs user approval
// Never throws to the caller.
async function gateBashCommand(command) {
  let engine;
  try {
    engine = await loadEngine();
  } catch (e) {
    // Cannot load the policy engine -> fail closed.
    return blockedVerdict("policy engine unavailable (" + (e.message || e) + ")");
  }
  let decision;
  try {
    const ir = engine.parse.parseCommand(command);
    const policy = engine.policy.loadPolicy();
    // Opt-in: the gate only enforces when a policy file is present. With no
    // configured policy the tool runs unconstrained (dev default); once
    // user/bash-policy.json exists, the fail-closed "default ask" applies.
    if (policy.source === null) return { verdict: "allow" };
    decision = engine.policy.evaluate(ir, policy);
  } catch (e) {
    // Malformed input unbash could not analyze -> fail closed.
    return blockedVerdict("unable to analyze command (" + (e.message || e) + ")");
  }
  if (decision.overall === "allow") return { verdict: "allow" };

  const blocked = decision.commands.filter((c) => c.decision !== "allow");
  const lines = blocked.map((c) => "  - " + (c.program || "?") + ": " + c.decision + " (" + c.reason + ")");
  if (decision.overall === "deny") {
    return {
      verdict: "deny",
      decision,
      text: "[bash policy] command denied by policy\n" + lines.join("\n"),
      isError: true,
      meta: { kind: "policy-blocked", decision },
    };
  }
  return {
    verdict: "ask",
    decision,
    text: "[bash policy] command requires approval\n" + lines.join("\n"),
    isError: true,
    meta: { kind: "policy-blocked", decision },
  };
}

function blockedVerdict(reason) {
  return {
    verdict: "deny",
    text: "[bash policy] command blocked: " + reason,
    isError: true,
    meta: { kind: "policy-blocked" },
  };
}

const DEFAULT_TIMEOUT_MS = 120000;
const MAX_TIMEOUT_MS = 600000;
const MAX_STREAM_BYTES = 64 * 1024;
const MAX_CAPTURE_BYTES = 20 * 1024 * 1024;
const KILL_GRACE_MS = 3000;

function parseBashArgs(args, cwd) {
  if (typeof args.command !== "string" || args.command.trim().length === 0) {
    throw new Error("invalid command: expected a non-empty string");
  }
  if (typeof args.description !== "string" || args.description.trim().length === 0) {
    throw new Error("invalid description: expected a non-empty string");
  }
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  if (args.timeoutMs !== undefined) {
    if (typeof args.timeoutMs !== "number" || !Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0) {
      throw new Error("invalid timeoutMs: expected a positive number, got " + JSON.stringify(args.timeoutMs));
    }
    timeoutMs = Math.min(args.timeoutMs, MAX_TIMEOUT_MS);
  }
  let workdir = cwd || process.cwd();
  if (args.workdir !== undefined) {
    if (typeof args.workdir !== "string" || args.workdir.trim().length === 0) {
      throw new Error("invalid workdir: expected a non-empty string");
    }
    workdir = path.isAbsolute(args.workdir) ? args.workdir : path.resolve(workdir, args.workdir);
  }
  return { command: args.command, description: args.description, timeoutMs, workdir };
}

function renderStream(text, callId, name) {
  const kept = tailByBytes(text, MAX_STREAM_BYTES);
  if (kept === text) return { text: kept, truncated: false, spillPath: null };
  const spillPath = writeSpill(callId, name, text);
  return {
    text: kept + "\n[output truncated; full output: " + (spillPath || "(unavailable)") + "]",
    truncated: true,
    spillPath,
  };
}

module.exports = {
  gateBashCommand,
  async run(args = {}, exec = {}) {
    const input = parseBashArgs(args, exec.cwd);

    // Phase 2 permission gate.
    const gate = await gateBashCommand(input.command);
    if (!gate || gate.verdict === "allow") {
      // proceed
    } else if (gate.verdict === "deny") {
      return gate; // final refusal, no approval
    } else if (gate.verdict === "ask") {
      // Route through the caller-provided approval flow (core wires requestApproval).
      if (typeof exec.requestApproval !== "function") {
        // No approval channel available -> fail closed (block).
        return gate;
      }
      const decision = await exec.requestApproval({
        callId: exec.callId,
        name: "bash",
        args: { command: input.command, description: input.description },
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
      // approved -> proceed to execute
    }

    return await new Promise((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      let stdoutOverflow = false;
      let stderrOverflow = false;
      let timedOut = false;
      let settled = false;
      let killTimer = null;

      const child = spawn("bash", ["-c", input.command], {
        cwd: input.workdir,
        env: shellEnv(exec.sessionId),
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });

      function kill(signal) {
        if (!child.pid) return;
        try {
          if (process.platform !== "win32") process.kill(-child.pid, signal);
          else child.kill(signal);
        } catch (_) {
          try { child.kill(signal); } catch (_) {}
        }
      }

      const timeoutTimer = setTimeout(() => {
        timedOut = true;
        kill("SIGTERM");
        killTimer = setTimeout(() => kill("SIGKILL"), KILL_GRACE_MS);
      }, input.timeoutMs);

      function append(chunk, which) {
        if (which === "stdout") {
          if (stdoutOverflow) return;
          stdout += chunk;
          if (Buffer.byteLength(stdout, "utf8") > MAX_CAPTURE_BYTES) {
            stdout = stdout.slice(0, MAX_CAPTURE_BYTES);
            stdoutOverflow = true;
          }
        } else {
          if (stderrOverflow) return;
          stderr += chunk;
          if (Buffer.byteLength(stderr, "utf8") > MAX_CAPTURE_BYTES) {
            stderr = stderr.slice(0, MAX_CAPTURE_BYTES);
            stderrOverflow = true;
          }
        }
      }

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => append(chunk, "stdout"));
      child.stderr.on("data", (chunk) => append(chunk, "stderr"));

      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutTimer);
        if (killTimer) clearTimeout(killTimer);
        reject(new Error(error.code === "ENOENT"
          ? "cannot run bash in \"" + input.workdir + "\": " + error.message
          : error.message));
      });

      child.on("close", (exitCode, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutTimer);
        if (killTimer) clearTimeout(killTimer);

        const callId = exec.callId || "bash";
        const out = renderStream(stdout, callId, "stdout");
        const err = renderStream(stderr, callId, "stderr");

        let body = out.text;
        if (err.text.length > 0) {
          if (body.length > 0 && !body.endsWith("\n")) body += "\n";
          body += "[stderr]\n" + err.text;
        }
        if (body.length === 0) body = "(no output)";

        const markers = [];
        if (timedOut) markers.push("[timed out after " + input.timeoutMs + "ms]");
        if (signal) markers.push("[killed by signal: " + signal + "]");
        else if (!timedOut && exitCode !== 0) markers.push("[exit code: " + exitCode + "]");
        let text = body;
        if (markers.length > 0) {
          if (!text.endsWith("\n")) text += "\n";
          text += markers.join("\n");
        }

        resolve({
          text,
          meta: {
            kind: "foreground",
            cwd: input.workdir,
            exitCode: exitCode == null ? null : exitCode,
            signal: signal || null,
            timedOut,
            aborted: false,
            timeoutMs: input.timeoutMs,
            stdout: {
              text: tailByBytes(stdout, MAX_STREAM_BYTES),
              truncated: out.truncated,
              ...(out.spillPath ? { spillPath: out.spillPath } : {}),
            },
            stderr: {
              text: tailByBytes(stderr, MAX_STREAM_BYTES),
              truncated: err.truncated,
              ...(err.spillPath ? { spillPath: err.spillPath } : {}),
            },
            description: input.description,
          },
        });
      });
    });
  },
};
