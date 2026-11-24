"use strict";

// Shared ripgrep runner for glob/grep. Prefers the packaged @vscode/ripgrep
// binary (portable inside Electron) and falls back to `rg` on PATH.

import { execFile } from "child_process";

const RAW_OUTPUT_MAX_BYTES = 20 * 1024 * 1024;

async function resolveRg() {
  try {
    const ns = await import("@vscode/ripgrep");
    const pkg = ns.default || ns;
    if (pkg && typeof pkg.rgPath === "string" && pkg.rgPath) return pkg.rgPath;
  } catch (_) {}
  return "rg";
}

async function runRg(args, { cwd, timeoutMs = 30000, maxBuffer = RAW_OUTPUT_MAX_BYTES } = {}) {
  const rgPath = await resolveRg();
  return new Promise((resolve, reject) => {
    execFile(
      rgPath,
      args,
      {
        cwd: cwd || process.cwd(),
        encoding: "utf8",
        timeout: timeoutMs,
        killSignal: "SIGKILL",
        maxBuffer,
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ stdout: stdout || "", stderr: stderr || "", code: 0, timedOut: false });
          return;
        }
        if (error.code === "ENOENT") {
          reject(new Error("ripgrep (rg) is not available; install @vscode/ripgrep or rg"));
          return;
        }
        if (error.killed) {
          reject(new Error("ripgrep timed out after " + timeoutMs + "ms"));
          return;
        }
        if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
          reject(new Error("ripgrep output exceeded " + maxBuffer + " bytes; narrow the search"));
          return;
        }
        const code = typeof error.code === "number" ? error.code : 1;
        // rg exits 1 for "no matches"; callers decide what that means.
        resolve({ stdout: stdout || "", stderr: stderr || "", code, timedOut: false });
      }
    );
  });
}

const __exports = { resolveRg, runRg, RAW_OUTPUT_MAX_BYTES };
export { resolveRg, runRg, RAW_OUTPUT_MAX_BYTES };
export default __exports;
