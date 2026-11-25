// Fresh-process worker for run_code. The parent owns permissions and tool
// execution; this process only evaluates the program and forwards inspect()
// blocks and nested tool calls over IPC.

import { stripTypeScriptTypes } from "node:module";

let started = false;
const pending = new Map();
let nextCall = 0;

function send(message) {
  try {
    if (process.connected) process.send(message);
  } catch (_) {
    // The parent may already be gone; the program will be killed with it.
  }
}

class ToolResult {
  constructor(text, content) {
    this.text = text;
    this.content = content || [];
  }
  toString() { return this.text; }
}

function textOf(value) {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.stack || (value.name + ": " + value.message);
  if (typeof value === "bigint") return value.toString() + "n";
  try {
    const seen = new WeakSet();
    const encoded = JSON.stringify(value, (_key, item) => {
      if (typeof item === "bigint") return item.toString() + "n";
      if (item && typeof item === "object") {
        if (seen.has(item)) return "[Circular]";
        seen.add(item);
      }
      return item;
    }, 2);
    return encoded === undefined ? String(value) : encoded;
  } catch (_) {
    return String(value);
  }
}

function imageBlockFrom(value) {
  if (!value || typeof value !== "object") return null;
  const candidate = value.image_url && typeof value.image_url === "object"
    ? value.image_url
    : value;
  if (typeof candidate.url !== "string" || !candidate.url.startsWith("data:image/")) return null;
  return { kind: "image", url: candidate.url, alt: typeof value.alt === "string" ? value.alt : "" };
}

function blocksFor(value) {
  if (value instanceof ToolResult) {
    const blocks = [{ kind: "text", text: value.text }];
    for (const part of value.content || []) {
      const image = imageBlockFrom(part);
      if (image) blocks.push(image);
    }
    return blocks;
  }
  const image = imageBlockFrom(value);
  if (image) return [image];
  return [{ kind: "text", text: textOf(value) }];
}

function inspect(...values) {
  const blocks = [];
  for (const value of values) blocks.push(...blocksFor(value));
  send({ type: "inspect", blocks });
}

const tools = new Proxy({}, {
  get(_target, name) {
    if (typeof name !== "string" || name === "then" || name === "toJSON") return undefined;
    return async (args = {}) => {
      const id = "call-" + (++nextCall);
      send({ type: "tool-call", id, name, args });
      const result = await new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
      });
      const text = typeof result.text === "string" ? result.text : "";
      if (result.isError === true) {
        const message = text.replace(/^Error: /, "") || "tool failed";
        throw new Error(message);
      }
      const content = Array.isArray(result.content) ? result.content : [];
      return content.length > 0 ? new ToolResult(text, content) : text;
    };
  },
});

function fail(error) {
  const message = error && error.message ? error.message : String(error);
  send({ type: "error", message });
  process.exit(1);
}

async function run(message) {
  try {
    const code = typeof message.code === "string" ? message.code : "";
    const wrapped = "async function __runCode__(){\n" + code + "\n}";
    const stripped = stripTypeScriptTypes(wrapped, { mode: "strip" });
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const fn = new AsyncFunction("tools", "inspect", stripped + "\nreturn __runCode__();");
    const value = await fn(tools, inspect);
    void value;
    send({ type: "done" });
    process.exit(0);
  } catch (error) {
    fail(error);
  }
}

process.on("message", (message) => {
  if (!message || typeof message !== "object") return;
  if (message.type === "start" && !started) {
    started = true;
    run(message);
    return;
  }
  if (message.type === "tool-result" && typeof message.id === "string") {
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    entry.resolve(message.result || {});
  }
});

process.on("disconnect", () => process.exit(0));
process.on("uncaughtException", fail);
process.on("unhandledRejection", fail);
