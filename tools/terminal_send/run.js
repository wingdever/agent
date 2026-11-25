"use strict";

import { terminalOwner, requireTerminals, requiredString, optionalBoolean, errorResult } from "../lib/terminal-tool.js";
import { tailByBytes } from "../../lib/tool-result/index.js";

const MAX_SEND_OUTPUT_BYTES = 64 * 1024;

function renderOutput(result) {
  if (!result.text) return "(no output)";
  const kept = tailByBytes(result.text, MAX_SEND_OUTPUT_BYTES);
  if (kept === result.text) return result.text;
  return kept + "\n[terminal output truncated; use terminal_read for the retained tail]";
}

function backgroundSend(terminals, owner, sessionId, text, submit, exec) {
  const startJob = typeof exec.startJob === "function"
    ? exec.startJob
    : (exec.jobs && typeof exec.jobs.start === "function"
      ? (spec) => exec.jobs.start({ ...spec, sessionId: exec.sessionId })
      : null);
  if (!startJob) {
    throw new Error("terminal background send requires the background job service");
  }
  if (typeof terminals.getInteractive === "function") {
    terminals.getInteractive(owner, sessionId);
  }
  return startJob({
    kind: "terminal_send",
    label: "terminal " + sessionId,
    run: (job) => {
      const pending = terminals.send(owner, sessionId, text, {
        submit,
        wait: submit !== false,
        onData: (chunk) => job.append(chunk),
      });
      return {
        done: pending.then((result) => {
          const resultText = result.text || "(no output)";
          if (result.reason === "session_exit") {
            return { status: "failed", detail: "terminal exited", result: resultText };
          }
          return { status: "completed", detail: result.reason, result: resultText };
        }),
        cancel: () => {
          try { terminals.signal(owner, sessionId, "SIGINT"); } catch (_) {}
        },
      };
    },
  });
}

export default {
  async run(args = {}, exec = {}) {
    try {
      const sessionId = requiredString(args, "sessionId");
      if (typeof args.text !== "string") throw new Error("text must be a string");
      const submit = optionalBoolean(args, "submit", true);
      const background = optionalBoolean(args, "run_in_background", false);
      const terminals = requireTerminals(exec, ["send"]);
      const owner = terminalOwner(exec);

      if (background) {
        const started = await backgroundSend(terminals, owner, sessionId, args.text, submit, exec);
        return {
          text: "Started terminal send in the background as " + started.jobId + ". Use job_output to collect output or job_kill to stop it.",
          meta: { job_id: started.jobId, jobId: started.jobId, sessionId, run_in_background: true },
        };
      }

      const result = await terminals.send(owner, sessionId, args.text, {
        submit,
        wait: submit !== false,
      });
      if (submit === false) {
        return {
          text: "Sent text to terminal " + sessionId + " without Enter.",
          meta: {
            sessionId,
            reason: result.reason,
            promptSeen: result.promptSeen,
            elapsedMs: result.elapsedMs,
          },
        };
      }
      return {
        text: renderOutput(result),
        meta: {
          sessionId,
          reason: result.reason,
          promptSeen: result.promptSeen,
          elapsedMs: result.elapsedMs,
          alive: result.reason !== "session_exit",
        },
      };
    } catch (error) {
      return errorResult(error);
    }
  },
};
