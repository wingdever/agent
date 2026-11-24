#!/usr/bin/env node
/**
 * Standalone ACP server entry: JSON-RPC over stdio, no Electron window.
 *
 * stdout is the protocol channel; every diagnostic is redirected to stderr before
 * core starts so a stray console.log from a service cannot corrupt JSON-RPC.
 */
import { Readable, Writable } from "node:stream";
import { ndJsonStream } from "@agentclientprotocol/sdk";
import { createCore } from "./core/index.js";
import { createAcpServer } from "./core/acp/index.js";

function quietConsole() {
  const write = (...args) => {
    process.stderr.write(args.map((value) => {
      if (typeof value === "string") return value;
      try { return JSON.stringify(value); } catch { return String(value); }
    }).join(" ") + "\n");
  };
  console.log = write;
  console.info = write;
  console.debug = write;
}

function option(name, fallback) {
  const prefix = "--" + name + "=";
  const found = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

async function main() {
  quietConsole();
  const core = await createCore({
    provider: option("provider", undefined),
    model: option("model", undefined),
    baseUrl: option("base-url", undefined),
    apiKey: option("api-key", undefined),
  });
  const server = createAcpServer({ core });
  const stream = ndJsonStream(
    Writable.toWeb(process.stdout),
    Readable.toWeb(process.stdin),
  );
  const connection = server.app.connect(stream);
  process.stderr.write("[acp] listening on stdio\n");
  await connection.closed;
  try { await core.schedule?.dispose?.(); } catch (_) {}
  try { await core.jobs?.disposeAll?.(); } catch (_) {}
  try { await core.store?.close?.(); } catch (err) {
    process.stderr.write("[acp] store close failed: " + (err.message || String(err)) + "\n");
  }
}

main().catch((err) => {
  process.stderr.write("[acp] fatal: " + (err.stack || err.message || String(err)) + "\n");
  process.exitCode = 1;
});
