"use strict";

// run_code process owner: one fresh child per program, an overall deadline,
// IPC tool calls back into the protected executor, and inspect() blocks.

import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";

const WORKER = fileURLToPath(new URL("./worker.mjs", import.meta.url));
const DEFAULT_TIMEOUT_MS = 120000;
const MAX_TIMEOUT_MS = 600000;
const MAX_STREAM_BYTES = 1024 * 1024;

function appendTail(current, chunk) {
  const text = current + chunk;
  if (Buffer.byteLength(text, "utf8") <= MAX_STREAM_BYTES) return text;
  return text.slice(-MAX_STREAM_BYTES);
}

function normalizeTimeout(value) {
  const number = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : 0;
  if (number <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(number, MAX_TIMEOUT_MS);
}

function contentFromBlocks(blocks) {
  const images = [];
  for (const block of blocks) {
    if (block && block.kind === "image" && typeof block.url === "string") {
      images.push({ type: "image_url", image_url: { url: block.url, detail: "auto" } });
    }
  }
  return images.length > 0 ? images : undefined;
}

async function runProgram({
  code,
  description,
  cwd,
  timeoutMs,
  signal,
  callTool,
} = {}) {
  const timeout = normalizeTimeout(timeoutMs);
  return new Promise((resolve, reject) => {
    const blocks = [];
    let stdout = "";
    let stderr = "";
    let settled = false;
    let child = null;
    let timer = null;
    let abortListener = null;
    const abortController = new AbortController();

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      if (signal && abortListener) signal.removeEventListener("abort", abortListener);
      abortListener = null;
      if (child) {
        try { child.kill("SIGKILL"); } catch (_) {}
      }
    };

    const finish = (result) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    const fail = (message) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(message));
    };

    const sendToChild = (message) => {
      if (!child || settled) return;
      try { child.send(message); } catch (_) {}
    };

    const handleMessage = async (message) => {
      if (!message || typeof message !== "object" || settled) return;
      if (message.type === "inspect" && Array.isArray(message.blocks)) {
        for (const block of message.blocks) {
          if (block && block.kind === "text" && typeof block.text === "string") {
            blocks.push({ kind: "text", text: block.text });
          } else if (block && block.kind === "image" && typeof block.url === "string") {
            blocks.push({ kind: "image", url: block.url, alt: block.alt || "" });
          }
        }
        return;
      }
      if (message.type === "done") {
        const lines = blocks.filter((b) => b.kind === "text").map((b) => b.text);
        if (stdout.trim()) lines.push(stdout.trim());
        const text = lines.join("\n");
        const content = contentFromBlocks(blocks);
        finish({ text, content, meta: { description: description || "", timeoutMs: timeout } });
        return;
      }
      if (message.type === "error") {
        fail(message.message || "run_code failed");
        return;
      }
      if (message.type === "tool-call") {
        if (typeof callTool !== "function") {
          fail("run_code cannot call tools in this context");
          return;
        }
        const id = typeof message.id === "string" ? message.id : "";
        const name = typeof message.name === "string" ? message.name : "";
        const args = message.args && typeof message.args === "object" ? message.args : {};
        try {
          const result = await callTool({
            name,
            args,
            callId: id,
            signal: abortController.signal,
          });
          sendToChild({
            type: "tool-result",
            id,
            result: {
              text: result && typeof result.text === "string" ? result.text : "",
              isError: result && result.isError === true,
              content: result && Array.isArray(result.content) ? result.content : [],
              meta: result ? result.meta : undefined,
            },
          });
        } catch (error) {
          sendToChild({
            type: "tool-result",
            id,
            result: { text: "Error: " + (error && error.message ? error.message : String(error)), isError: true },
          });
        }
      }
    };

    try {
      child = fork(WORKER, [], {
        cwd: cwd || process.cwd(),
        env: {},
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        execArgv: ["--no-warnings"],
      });
    } catch (error) {
      fail((error && error.message) || String(error));
      return;
    }

    child.stdout.on("data", (chunk) => { stdout = appendTail(stdout, String(chunk)); });
    child.stderr.on("data", (chunk) => { stderr = appendTail(stderr, String(chunk)); });
    child.on("message", (message) => { void handleMessage(message); });
    child.on("error", (error) => fail((error && error.message) || String(error)));
    child.on("close", (code, signalName) => {
      if (settled) return;
      const detail = stderr.trim() || stdout.trim();
      fail("run_code process exited with " + (signalName ? "signal " + signalName : "code " + code) +
        (detail ? ": " + detail : ""));
    });

    child.on("spawn", () => {
      sendToChild({ type: "start", code: typeof code === "string" ? code : "" });
    });

    timer = setTimeout(() => {
      abortController.abort();
      fail("run_code timed out after " + timeout + " ms");
    }, timeout);

    if (signal) {
      abortListener = () => {
        abortController.abort();
        fail("tool call aborted");
      };
      if (signal.aborted) abortListener();
      else signal.addEventListener("abort", abortListener, { once: true });
    }
  });
}

const __exports = { runProgram, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS };
export { runProgram, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS };
export default __exports;
