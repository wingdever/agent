import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function waitForLine(child, matcher, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${matcher}; output=${buffer}`)), timeoutMs);
    const onData = (chunk) => {
      buffer += chunk.toString();
      const match = buffer.match(matcher);
      if (match) {
        clearTimeout(timer);
        child.stdout.off("data", onData);
        resolve(match);
      }
    };
    child.stdout.on("data", onData);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`channel-run exited ${code}; output=${buffer}`));
    });
  });
}

test("channel-run starts a configured instance and serves /health", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "channel-run-"));
  const configFile = path.join(dir, "channels.json");
  const id = "fake-cli";
  fs.writeFileSync(configFile, JSON.stringify({
    channels: [{ id, type: "fake", enabled: true, options: {} }],
  }));
  const child = spawn(process.execPath, [
    path.join(ROOT, "channel-run.js"),
    "--channel", id,
    "--config", configFile,
  ], {
    cwd: ROOT,
    env: {
      ...process.env,
      CHANNEL_FAKE_CLI_HISTORY_DB: path.join(dir, "history.db"),
      CHANNEL_FAKE_CLI_ARCHIVE_DIR: path.join(dir, "archive"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  try {
    const match = await waitForLine(child, /channel service on (http:\/\/127\.0\.0\.1:\d+)/);
    const health = await fetch(`${match[1]}/health`);
    assert.equal(health.status, 200);
    const body = await health.json();
    assert.equal(body.ok, true);
    assert.equal(body.status.status, "running");
    assert.deepEqual(body.features, ["messages", "proactive", "auth"]);
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
    assert.equal(stderr, "");
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
