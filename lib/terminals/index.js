"use strict";

// Persistent bash terminals: one shell process per session, reused across tool
// calls so cwd and exported environment survive.
//
// Two interchangeable backends:
//
//   pty  (default) — node-pty gives the shell a controlling terminal. Commands
//                    arrive over a private FIFO, so the shell's stdin stays a
//                    tty for the programs it runs.
//   pipe           — no native dependency; stdout and stderr stay separate.
//
// Both backends read base64 commands from a private fd, execute them in place,
// then emit a token-framed completion marker carrying the exit code and cwd.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { shellEnv } from "../shell-env/index.js";
import { TerminalScreen } from "./screen.js";

const require = createRequire(import.meta.url);

const DEFAULT_TIMEOUT_MS = 120000;
const SETTLE_MS = 50;
const KILL_GRACE_MS = 1500;
const BACKEND_ENV = "AGENT_BASH_TERMINAL_BACKEND";

// Interactive terminals are a separate lifetime from the persistent bash
// command queue: the shell reads commands directly from its PTY instead of
// from a private FIFO. Keeping them separate matters because terminal_send
// writes raw stdin, which a FIFO-driven command loop would never read.
const TERMINAL_TYPES = new Set(["shell", "bash"]);
const TERMINAL_OUTPUT_LIMIT = 200 * 1024;
const TERMINAL_READ_DEFAULT = 500;
const TERMINAL_READ_CAP = 2000;
const TERMINAL_INITIAL_WAIT_MS = 1500;
const TERMINAL_IDLE_MS = 200;
const TERMINAL_MAX_WAIT_MS = 30000;
const TERMINAL_CLOSE_GRACE_MS = 1500;
const TERMINAL_CLOSE_KILL_WAIT_MS = 1000;
const ANSI_SEQUENCE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g;

// Pipe backend. The wrapper keeps the command pipe on fd4 so a command cannot
// consume the protocol stream as its stdin. Completion markers use fd3, a
// dedicated write-only pipe: redirecting stdout inside the shell cannot hide
// them. `if eval` also keeps `set -e` from killing the shell before the marker.
const SHELL_LOOP = String.raw`
exec 4<&0
exec 0</dev/null
while IFS= read -r -u 4 __dsh_line; do
  __dsh_cmd=$(printf '%s' "$__dsh_line" | base64 -d)
  if eval "$__dsh_cmd"; then
    __dsh_ec=0
  else
    __dsh_ec=$?
  fi
  printf '\x1e%s:%s:%s\x1f' "$DSH_PERSIST_TOKEN" "$__dsh_ec" "$(printf '%s' "$PWD" | base64 -w0)" >&3
done
`;

// PTY backend. Command input comes from a FIFO so fd0 can remain the terminal.
// Command stderr goes to a private temp file; that keeps the tool contract's
// separate stderr channel even though a normal terminal merges fd1/fd2.
const DOLLAR = "$";
const PTY_LOOP = String.raw`
exec 3>&1
exec 4<"$DSH_COMMAND_FIFO"
set -m 2>/dev/null || true
while IFS= read -r -u 4 __dsh_line; do
  __dsh_cmd=$(printf '%s' "$__dsh_line" | base64 -d)
  __dsh_err=$(mktemp "${DOLLAR}{TMPDIR:-/tmp}/dsh-bash-err-XXXXXX" 2>/dev/null) || __dsh_err=""
  if eval "$__dsh_cmd" 2>"${DOLLAR}{__dsh_err:-/dev/null}"; then
    __dsh_ec=0
  else
    __dsh_ec=$?
  fi
  if [ -n "$__dsh_err" ]; then
    __dsh_err_b64=$(printf '%s' "$__dsh_err" | base64 -w0)
  else
    __dsh_err_b64=""
  fi
  printf '\x1e%s:%s:%s:%s\x1f' "$DSH_PERSIST_TOKEN" "$__dsh_ec" "$(printf '%s' "$PWD" | base64 -w0)" "$__dsh_err_b64" >&3
done
`;

function normalizeBackend(value) {
  return String(value || "pty").toLowerCase() === "pipe" ? "pipe" : "pty";
}

function loadNodePty() {
  try {
    const loaded = require("node-pty");
    const module = loaded && typeof loaded.spawn === "function" ? loaded : loaded?.default;
    if (!module || typeof module.spawn !== "function") {
      throw new Error("node-pty does not export spawn()");
    }
    return { module };
  } catch (error) {
    return { error };
  }
}

function makeCommandFifo() {
  if (process.platform === "win32") throw new Error("PTY command FIFO requires a POSIX platform");
  const fifoPath = path.join(
    os.tmpdir(),
    "dsh-bash-" + process.pid + "-" + crypto.randomBytes(6).toString("hex") + ".fifo",
  );
  const made = spawnSync("mkfifo", ["-m", "600", fifoPath], { stdio: "ignore" });
  if (made.error || made.status !== 0) {
    throw made.error || new Error("mkfifo exited with status " + made.status);
  }
  return fifoPath;
}

function killGroup(child, signal) {
  if (!child || !child.pid) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (_) {
    try { child.kill(signal); } catch (_) {}
  }
}

function killChild(child, kind, signal) {
  if (!child) return;
  if (kind === "pty") {
    // node-pty's kill() reaches the process group on POSIX; the explicit group
    // kill is a fallback for shells that ignore the terminal hangup.
    try { child.kill(signal); } catch (_) {}
    if (process.platform !== "win32" && child.pid) {
      try { process.kill(-child.pid, signal); } catch (_) {}
    }
    return;
  }
  killGroup(child, signal);
}

function readProcStatus(pid) {
  try {
    const status = fs.readFileSync("/proc/" + pid + "/status", "utf8");
    const state = status.match(/^State:\s+(\S+)/m)?.[1] || "";
    const ppid = Number(status.match(/^PPid:\s+(\d+)/m)?.[1]);
    return { state, ppid: Number.isInteger(ppid) ? ppid : null };
  } catch (_) {
    return null;
  }
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  const status = readProcStatus(pid);
  if (!status || status.state === "Z") return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (_) {
    return false;
  }
}

function descendantsOf(rootPid) {
  if (!Number.isInteger(rootPid) || rootPid <= 0) return [];
  const children = new Map();
  let entries = [];
  try {
    entries = fs.readdirSync("/proc");
  } catch (_) {
    return [rootPid];
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    const status = readProcStatus(pid);
    if (!status || !status.ppid) continue;
    const list = children.get(status.ppid) || [];
    list.push(pid);
    children.set(status.ppid, list);
  }
  const found = [];
  const queue = [rootPid];
  const seen = new Set();
  while (queue.length) {
    const pid = queue.shift();
    if (seen.has(pid)) continue;
    seen.add(pid);
    found.push(pid);
    for (const child of children.get(pid) || []) queue.push(child);
  }
  return found;
}

function foregroundPgrp(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const stat = fs.readFileSync("/proc/" + pid + "/stat", "utf8");
    const close = stat.lastIndexOf(")");
    if (close < 0) return null;
    // Fields after comm: state, ppid, pgrp, session, tty_nr, tpgid.
    const fields = stat.slice(close + 2).trim().split(/\s+/);
    const tpgid = Number(fields[5]);
    return Number.isInteger(tpgid) && tpgid > 0 ? tpgid : null;
  } catch (_) {
    return null;
  }
}

function signalPids(pids, signal) {
  for (const pid of pids) {
    try { process.kill(pid, signal); } catch (_) {}
  }
}

async function waitForProcessesGone(pids, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (!pids.some((pid) => processAlive(pid))) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !pids.some((pid) => processAlive(pid));
}

class PersistentTerminal {
  constructor({ key, sessionId, cwd, logger = console, backend = "pty", ptyModule = null } = {}) {
    this.key = key;
    this.sessionId = sessionId;
    this.cwd = cwd || process.cwd();
    this.logger = logger;
    this.backend = normalizeBackend(backend);
    this.ptyModule = ptyModule;
    this.child = null;
    this.childKind = null;
    this.token = null;
    this.dead = true;
    this.current = null;
    this.orphanStdout = "";
    this.orphanStderr = "";
    this.markerBuffer = "";
    this.fifoPath = null;
    this.fifoStream = null;
    this._queue = Promise.resolve();
  }

  get busy() {
    return this.current != null;
  }

  _ensureStarted(cwd) {
    if (this.child && !this.dead) return;
    if (cwd) this.cwd = cwd;
    this.token = crypto.randomBytes(10).toString("hex");
    const env = shellEnv(this.sessionId);
    env.DSH_PERSIST_TOKEN = this.token;
    // Keep the shell quiet; no prompt text belongs in stdout.
    env.PS1 = "";
    env.PROMPT_COMMAND = "";
    env.HISTFILE = "/dev/null";

    if (this.backend === "pty") {
      try {
        this._startPty(env);
        this.logger.info?.(`[terminals] started persistent bash (pty) for ${this.key}`);
        return;
      } catch (error) {
        this.logger.warn?.(
          `[terminals] PTY backend unavailable for ${this.key}; falling back to pipe: ${error.message || error}`,
        );
        this.backend = "pipe";
        this._cleanupFifo();
      }
    }

    this._startPipe(env);
    this.logger.info?.(`[terminals] started persistent bash (pipe) for ${this.key}`);
  }

  _startPty(env) {
    if (!this.ptyModule) {
      const loaded = loadNodePty();
      if (loaded.error) throw loaded.error;
      this.ptyModule = loaded.module;
    }
    if (!this.ptyModule || typeof this.ptyModule.spawn !== "function") {
      throw new Error("node-pty is not available");
    }
    const fifoPath = makeCommandFifo();
    this.fifoPath = fifoPath;
    env.DSH_COMMAND_FIFO = fifoPath;

    let child;
    try {
      child = this.ptyModule.spawn("bash", ["--noprofile", "--norc", "-c", PTY_LOOP], {
        cwd: this.cwd,
        env,
        name: "xterm-256color",
        cols: 120,
        rows: 30,
      });
    } catch (error) {
      this._cleanupFifo();
      throw error;
    }

    this.child = child;
    this.childKind = "pty";
    this.dead = false;
    this.orphanStdout = "";
    this.orphanStderr = "";
    this.markerBuffer = "";

    // The FIFO's reader is opened by the shell. Opening the writer here creates
    // the rendezvous; writes before the stream is open are buffered by Node.
    this.fifoStream = fs.createWriteStream(fifoPath, { flags: "w" });
    this.fifoStream.on("error", (error) => {
      if (this.child === child) this._onExit(error, null, null, child);
    });

    child.onData((data) => this._onPtyData(data, child));
    child.onExit(({ exitCode, signal }) => this._onExit(null, exitCode, signal, child));
  }

  _startPipe(env) {
    const child = spawn("bash", ["--noprofile", "--norc", "-c", SHELL_LOOP], {
      cwd: this.cwd,
      env,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe", "pipe"],
    });
    this.child = child;
    this.childKind = "pipe";
    this.dead = false;
    this.orphanStdout = "";
    this.orphanStderr = "";
    this.markerBuffer = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdio[3]?.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this._onStdout(chunk, child));
    child.stderr.on("data", (chunk) => this._onStderr(chunk, child));
    child.stdio[3]?.on("data", (chunk) => this._onMarkerData(chunk, child));
    child.on("error", (error) => this._onExit(error, null, null, child));
    child.on("close", (code, signal) => this._onExit(null, code, signal, child));

    // A broken shell start is reported by the first command, not here; spawn()
    // itself is asynchronous.
    child.on("spawn", () => {
      this.logger.info?.(`[terminals] persistent bash child ready for ${this.key}`);
    });
  }

  _cleanupFifo() {
    if (this.fifoStream) {
      const stream = this.fifoStream;
      this.fifoStream = null;
      try { stream.destroy(); } catch (_) {}
    }
    if (this.fifoPath) {
      const fifoPath = this.fifoPath;
      this.fifoPath = null;
      try { fs.unlinkSync(fifoPath); } catch (_) {}
    }
  }

  _onExit(error, code, signal, source) {
    // A reaped shell can close after the next shell already started in its
    // place; only the current child may settle the current command.
    if (source !== this.child || this.dead) return;
    this.dead = true;
    this.child = null;
    this.childKind = null;
    this._cleanupFifo();
    const reason = error
      ? (error.message || String(error))
      : ("shell exited" + (signal ? " by signal " + signal : "") + (code == null ? "" : " with code " + code));
    const current = this.current;
    this.current = null;
    if (current) {
      this._clearCommand(current);
      current.reject(new Error("persistent bash session " + reason));
    }
  }

  _onPtyData(chunk, source) {
    if (source !== this.child) return;
    this._onStdout(String(chunk), source);
  }

  _onStdout(chunk, source) {
    if (source !== this.child) return;
    const current = this.current;
    if (!current) {
      this.orphanStdout += chunk;
      return;
    }
    current.stdout += chunk;

    // The PTY backend puts the completion marker on the same terminal stream
    // as stdout. Split it out before the result is assembled. Only the tail
    // around the newest chunk needs scanning, so large output stays linear.
    if (!current.marker) {
      const from = Math.max(0, current.stdout.length - chunk.length - 1024);
      const marker = this._findMarker(current.stdout, from);
      if (marker) {
        const after = current.stdout.slice(marker.end);
        current.stdout = current.stdout.slice(0, marker.start);
        if (after) this.orphanStdout += after;
        current.marker = marker;
      }
    }
    this._scheduleComplete(current);
  }

  _onMarkerData(chunk, source) {
    if (source !== this.child) return;
    this.markerBuffer += chunk;
    const marker = this._findMarker(this.markerBuffer);
    if (!marker) return;
    this.markerBuffer = this.markerBuffer.slice(marker.end);
    const current = this.current;
    if (!current) return;
    current.marker = marker;
    this._scheduleComplete(current);
  }

  _scheduleComplete(current) {
    if (!current.marker) return;
    if (current.settleTimer) clearTimeout(current.settleTimer);
    // Completion and stdout/stderr travel on different pipes; hold briefly so
    // the command's own streams drain before the result is assembled. Cap the
    // wait so a background writer cannot keep one call open forever.
    const now = Date.now();
    if (!current.markerAt) current.markerAt = now;
    const wait = Math.max(0, Math.min(SETTLE_MS, current.markerAt + SETTLE_MS - now));
    current.settleTimer = setTimeout(() => this._complete(current), wait);
  }

  _onStderr(chunk, source) {
    if (source !== this.child) return;
    const current = this.current;
    if (!current) {
      this.orphanStderr += chunk;
      return;
    }
    current.stderr += chunk;
    this._scheduleComplete(current);
  }

  _findMarker(text, from = 0) {
    const prefix = "\x1e" + this.token + ":";
    const start = text.indexOf(prefix, from);
    if (start < 0) return null;
    const end = text.indexOf("\x1f", start + prefix.length);
    if (end < 0) return null;
    const payload = text.slice(start + prefix.length, end);
    const parts = payload.split(":");
    if (parts.length < 2) return null;
    return {
      start,
      end: end + 1,
      exitCode: Number(parts[0]),
      cwd: Buffer.from(parts[1] || "", "base64").toString("utf8"),
      errFile: parts[2] ? Buffer.from(parts[2], "base64").toString("utf8") : null,
    };
  }

  _complete(current) {
    if (this.current !== current) return;
    this.current = null;
    this._clearCommand(current);
    const marker = current.marker || {};
    this.cwd = marker.cwd || this.cwd;

    // A PTY terminal merges fd1/fd2, so the command's stderr is written to a
    // private file and appended here. Pipe backends already streamed it.
    if (marker.errFile) {
      try {
        current.stderr += fs.readFileSync(marker.errFile, "utf8");
      } catch (_) {
        // The command may have removed its own temp file; missing stderr is
        // preferable to failing the whole call.
      }
      try { fs.unlinkSync(marker.errFile); } catch (_) {}
    }

    // A terminal driver normally turns LF into CRLF. Tool text uses LF.
    current.stdout = current.stdout.replace(/\r\n/g, "\n");
    current.stderr = current.stderr.replace(/\r\n/g, "\n");

    current.resolve({
      stdout: current.stdout,
      stderr: current.stderr,
      exitCode: Number.isInteger(marker.exitCode) ? marker.exitCode : null,
      cwd: this.cwd,
      backend: this.backend,
    });
  }

  _clearCommand(current) {
    if (current.timer) clearTimeout(current.timer);
    if (current.settleTimer) clearTimeout(current.settleTimer);
    if (current.signal && current.onAbort) current.signal.removeEventListener("abort", current.onAbort);
    current.timer = null;
    current.settleTimer = null;
  }

  _fail(error) {
    const current = this.current;
    this.current = null;
    if (current) {
      this._clearCommand(current);
      current.reject(error);
    }
    this._destroy();
  }

  _destroy() {
    const child = this.child;
    const kind = this.childKind;
    this.child = null;
    this.childKind = null;
    this.dead = true;
    this.orphanStdout = "";
    this.orphanStderr = "";
    this.markerBuffer = "";
    this._cleanupFifo();
    if (!child) return;
    killChild(child, kind, "SIGTERM");
    const killTimer = setTimeout(() => killChild(child, kind, "SIGKILL"), KILL_GRACE_MS);
    killTimer.unref?.();
  }

  killNow(signal = "SIGKILL") {
    killChild(this.child, this.childKind, signal);
  }

  disposeSync() {
    this.killNow("SIGKILL");
    this._cleanupFifo();
  }

  run(command, { signal, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    if (signal && signal.aborted) return Promise.reject(new Error("persistent bash command aborted"));
    const task = async () => {
      this._ensureStarted();
      return await this._runOne(command, signal, timeoutMs);
    };
    // One command at a time per shell. A failed command must not poison the
    // queue: the next call either reuses the shell or starts a fresh one.
    this._queue = this._queue.catch(() => {}).then(task);
    return this._queue;
  }

  _runOne(command, signal, timeoutMs) {
    if (signal && signal.aborted) {
      return Promise.reject(new Error("persistent bash command aborted"));
    }
    if (!this.child || this.dead) {
      return Promise.reject(new Error("persistent bash session is not running"));
    }
    if (this.current) {
      return Promise.reject(new Error("persistent bash session is busy"));
    }

    return new Promise((resolve, reject) => {
      const current = {
        stdout: this.orphanStdout,
        stderr: this.orphanStderr,
        resolve,
        reject,
        timer: null,
        settleTimer: null,
        marker: null,
        signal: null,
        onAbort: null,
      };
      this.orphanStdout = "";
      this.orphanStderr = "";
      this.current = current;

      const onAbort = () => this._fail(new Error("persistent bash command aborted"));
      if (signal) {
        signal.addEventListener("abort", onAbort, { once: true });
        current.signal = signal;
        current.onAbort = onAbort;
      }

      current.timer = setTimeout(() => {
        this._fail(new Error("persistent bash command timed out after " + timeoutMs + "ms"));
      }, Math.max(1, Number(timeoutMs) || DEFAULT_TIMEOUT_MS));
      current.timer.unref?.();

      const line = Buffer.from(String(command), "utf8").toString("base64") + "\n";
      try {
        if (this.childKind === "pty") {
          if (!this.fifoStream) throw new Error("PTY command channel is not open");
          this.fifoStream.write(line);
        } else {
          this.child.stdin.write(line);
        }
      } catch (error) {
        this._fail(new Error("cannot write to persistent bash session: " + (error.message || error)));
      }
    });
  }

  destroy() {
    const current = this.current;
    this.current = null;
    if (current) {
      this._clearCommand(current);
      current.reject(new Error("persistent bash session closed"));
    }
    this._destroy();
  }
}

class InteractiveTerminal {
  constructor({
    id, ownerId, type, name, cwd, logger = console, ptyModule = null,
    createdBy = "agent", cols = 120, rows = 30,
  } = {}) {
    this.id = id;
    this.ownerId = ownerId;
    this.type = type;
    this.name = name;
    this.cwd = cwd;
    this.logger = logger;
    this.ptyModule = ptyModule;
    this.createdBy = createdBy === "user" ? "user" : "agent";
    // `control` is the person currently allowed to write keystrokes. Agent
    // tools may drive a terminal only while it remains `agent`; the browser
    // takes it over atomically on its first input and never gives it back.
    this.control = this.createdBy === "user" ? "user" : "agent";
    this.detached = false;
    this.cols = cols;
    this.rows = rows;
    this.child = null;
    this.childKind = null;
    this.dead = true;
    this.exitCode = null;
    this.output = "";
    this.rawSeq = 0;
    this.createdAt = Date.now();
    this.lastActivityAt = Date.now();
    this._waiters = new Set();
    this._subscribers = new Set();
    this._exitListeners = new Set();
    this._paused = false;
    this._promptCount = 0;
    this._promptToken = crypto.randomBytes(10).toString("hex");
    this._promptMarker = "\x1e" + this._promptToken + ":P\x1f";
    this._promptRe = new RegExp(this._promptMarker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
    this._closing = false;
    this._closePromise = null;
    this.screen = new TerminalScreen({ cols, rows });
  }

  get alive() {
    return !this.dead && this.child != null;
  }

  runningStatus() {
    if (!this.alive) return "no";
    const shellPid = this.child?.pid;
    if (!Number.isInteger(shellPid) || shellPid <= 0) return "unknown";
    const fg = foregroundPgrp(shellPid);
    if (fg == null) return "unknown";
    // A command is running when job control handed the terminal to a child
    // process group. At a prompt the foreground group is the shell itself.
    return fg === shellPid ? "no" : "yes";
  }

  start() {
    if (!this.alive) {
      const loaded = this.ptyModule ? { module: this.ptyModule } : loadNodePty();
      if (loaded.error) throw new Error("terminal backend requires node-pty: " + (loaded.error.message || loaded.error));
      this.ptyModule = loaded.module;
      if (!this.ptyModule || typeof this.ptyModule.spawn !== "function") {
        throw new Error("terminal backend requires node-pty");
      }

      const env = shellEnv(this.ownerId);
      env.TERM = "xterm-256color";
      env.PS1 = "dsh> \\[" + this._promptMarker + "\\]";
      env.PS2 = "> ";
      env.PROMPT_COMMAND = "";
      env.HISTFILE = "/dev/null";

      let child;
      try {
        child = this.ptyModule.spawn("bash", ["--noprofile", "--norc", "-i"], {
          cwd: this.cwd,
          env,
          name: "xterm-256color",
          cols: this.cols,
          rows: this.rows,
        });
      } catch (error) {
        throw new Error("cannot start shell terminal: " + (error.message || error));
      }

      this.child = child;
      this.childKind = "pty";
      this.dead = false;
      child.onData((data) => this._onData(data, child));
      child.onExit(({ exitCode, signal }) => this._onExit(exitCode, signal, child));
      this.logger.info?.(`[terminals] opened interactive ${this.type} ${this.id} for ${this.ownerId}`);
    }
    return this;
  }

  _appendOutput(text) {
    if (!text) return;
    this.output += text;
    if (Buffer.byteLength(this.output, "utf8") <= TERMINAL_OUTPUT_LIMIT) return;
    const buf = Buffer.from(this.output, "utf8");
    let start = buf.length - TERMINAL_OUTPUT_LIMIT;
    while (start < buf.length && (buf[start] & 0xc0) === 0x80) start += 1;
    const tail = buf.subarray(start).toString("utf8");
    const newline = tail.indexOf("\n");
    this.output = newline >= 0 ? tail.slice(newline + 1) : tail;
  }

  _onData(data, source) {
    if (source !== this.child) return;
    const raw = String(data);
    this.rawSeq += 1;
    const seq = this.rawSeq;
    // The prompt marker is a private sentinel for terminal_send wait
    // detection. It must never become visible text in the xterm screen, the
    // browser panel, or a user_terminal_read result.
    this._promptRe.lastIndex = 0;
    const displayRaw = raw.replace(this._promptRe, "");
    this._promptRe.lastIndex = 0;
    this.screen.write(displayRaw, seq);
    for (const subscriber of this._subscribers) {
      try { subscriber(displayRaw, seq); } catch (_) { /* a slow panel must not stall the PTY */ }
    }

    this._promptRe.lastIndex = 0;
    const promptSeen = this._promptRe.test(raw);
    if (promptSeen) this._promptCount += 1;
    this._promptRe.lastIndex = 0;
    const clean = raw
      .replace(this._promptRe, "")
      .replace(ANSI_SEQUENCE, "")
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "");
    this._appendOutput(clean);
    this.lastActivityAt = Date.now();

    for (const waiter of this._waiters) {
      waiter.text += clean;
      waiter.lastDataAt = this.lastActivityAt;
      if (typeof waiter.onData === "function") {
        try { waiter.onData(clean); } catch (_) { /* advisory */ }
      }
      if (promptSeen) {
        waiter.promptSeen = true;
        waiter.promptAt = this.lastActivityAt;
      }
    }
  }

  _onExit(exitCode, signal, source) {
    if (source !== this.child) return;
    this.dead = true;
    this.child = null;
    this.exitCode = Number.isInteger(exitCode) ? exitCode : null;
    this.lastActivityAt = Date.now();
    this._finishWaiters("session_exit");
    for (const listener of this._exitListeners) {
      try { listener({ exitCode: this.exitCode, signal }); } catch (_) {}
    }
    this.logger.info?.(
      "[terminals] interactive " + this.id + " exited" +
      (signal ? " by signal " + signal : "") +
      (exitCode == null ? "" : " with code " + exitCode),
    );
  }

  subscribe(listener) {
    if (typeof listener !== "function") return () => {};
    this._subscribers.add(listener);
    return () => this._subscribers.delete(listener);
  }

  onExit(listener) {
    if (typeof listener !== "function") return () => {};
    this._exitListeners.add(listener);
    return () => this._exitListeners.delete(listener);
  }

  takeOver() {
    if (this.control === "user") return false;
    this.control = "user";
    this.lastActivityAt = Date.now();
    this.logger.info?.("[terminals] " + this.id + " taken over by user");
    return true;
  }

  detach() {
    this.detached = true;
    return { sessionId: this.id, detached: true, closed: false };
  }

  input(data) {
    if (this.dead || !this.child) {
      throw new Error("terminal " + this.id + " is not running");
    }
    this.takeOver();
    try {
      this.child.write(String(data));
    } catch (error) {
      throw new Error("cannot write to terminal " + this.id + ": " + (error.message || error));
    }
    this.lastActivityAt = Date.now();
  }

  async resize(cols, rows) {
    const numericCols = Number(cols);
    const numericRows = Number(rows);
    if (!Number.isFinite(numericCols) || !Number.isFinite(numericRows)) {
      throw new Error("terminal size must be finite cols/rows");
    }
    const nextCols = Math.max(2, Math.min(500, Math.floor(numericCols)));
    const nextRows = Math.max(2, Math.min(300, Math.floor(numericRows)));
    await this.screen.resize(nextCols, nextRows);
    this.cols = nextCols;
    this.rows = nextRows;
    if (this.alive && typeof this.child.resize === "function") {
      this.child.resize(nextCols, nextRows);
    }
    return { sessionId: this.id, cols: nextCols, rows: nextRows };
  }

  async snapshot() {
    const snap = await this.screen.snapshot();
    return {
      data: snap.data,
      seq: snap.seq,
      cols: this.cols,
      rows: this.rows,
      control: this.control,
      createdBy: this.createdBy,
      alive: this.alive,
      running: this.runningStatus(),
    };
  }

  async readScreen(lines) {
    const screen = await this.screen.readLines(lines);
    return {
      text: screen.text,
      meta: {
        sessionId: this.id,
        count: Math.max(1, Math.floor(Number(lines)) || TERMINAL_READ_DEFAULT),
        totalLines: screen.totalLines,
        fromLine: screen.fromLine,
        toLine: screen.toLine,
        alive: this.alive,
      },
    };
  }

  pause() {
    if (this._paused) return;
    this._paused = true;
    try { this.child?.pause?.(); } catch (_) {}
  }

  resume() {
    if (!this._paused) return;
    this._paused = false;
    try { this.child?.resume?.(); } catch (_) {}
  }

  _finishWaiters(reason) {
    for (const waiter of [...this._waiters]) {
      this._finishWaiter(waiter, reason);
    }
  }

  _finishWaiter(waiter, reason) {
    if (waiter.done) return;
    waiter.done = true;
    if (waiter.timer) clearTimeout(waiter.timer);
    waiter.timer = null;
    this._waiters.delete(waiter);
    waiter.resolve({
      sessionId: this.id,
      text: waiter.text,
      reason,
      promptSeen: waiter.promptSeen === true,
      elapsedMs: Date.now() - waiter.startedAt,
    });
  }

  read(offset = 0, count = TERMINAL_READ_DEFAULT) {
    const off = Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0;
    const requested = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : TERMINAL_READ_DEFAULT;
    const limit = Math.min(TERMINAL_READ_CAP, requested);
    let lines = this.output.split("\n");
    if (lines.length && lines[lines.length - 1] === "") lines.pop();
    const end = Math.max(0, lines.length - off);
    const start = Math.max(0, end - limit);
    const selected = lines.slice(start, end);
    return {
      text: selected.length ? selected.join("\n") : "(no output)",
      meta: {
        sessionId: this.id,
        offset: off,
        count: limit,
        totalLines: lines.length,
        fromLine: selected.length ? start + 1 : 0,
        toLine: selected.length ? end : 0,
        alive: this.alive,
      },
    };
  }

  send(text, {
    submit = true,
    wait = true,
    initialMs = TERMINAL_INITIAL_WAIT_MS,
    idleMs = TERMINAL_IDLE_MS,
    maxWaitMs = TERMINAL_MAX_WAIT_MS,
    onData = null,
  } = {}) {
    if (this.control === "user") {
      return Promise.reject(new Error(
        "terminal " + this.id + " is controlled by the user; " +
        "use user_terminal_read to inspect its screen",
      ));
    }
    if (this.dead || !this.child) {
      return Promise.reject(new Error("terminal " + this.id + " is not running"));
    }
    const payload = String(text) + (submit ? "\r" : "");
    try {
      this.child.write(payload);
    } catch (error) {
      return Promise.reject(new Error("cannot write to terminal " + this.id + ": " + (error.message || error)));
    }
    this.lastActivityAt = Date.now();
    if (!wait) {
      return Promise.resolve({
        sessionId: this.id,
        text: "",
        reason: "sent",
        promptSeen: false,
        elapsedMs: 0,
      });
    }

    return new Promise((resolve, reject) => {
      const waiter = {
        text: "",
        startedAt: Date.now(),
        lastDataAt: Date.now(),
        promptSeen: false,
        promptAt: 0,
        onData: typeof onData === "function" ? onData : null,
        timer: null,
        resolve,
        reject,
        done: false,
      };
      this._waiters.add(waiter);

      const check = () => {
        if (waiter.done) return;
        const now = Date.now();
        const elapsed = now - waiter.startedAt;
        if (this.dead) {
          this._finishWaiter(waiter, "session_exit");
          return;
        }
        if (waiter.promptSeen && now - Math.max(waiter.lastDataAt, waiter.promptAt) >= 80) {
          this._finishWaiter(waiter, "prompt");
          return;
        }
        if (waiter.text && now - waiter.lastDataAt >= idleMs) {
          this._finishWaiter(waiter, "output_silence");
          return;
        }
        if (!waiter.text && elapsed >= initialMs) {
          this._finishWaiter(waiter, "no_output");
          return;
        }
        if (elapsed >= maxWaitMs) {
          this._finishWaiter(waiter, "timeout");
          return;
        }
        waiter.timer = setTimeout(check, 50);
        waiter.timer.unref?.();
      };
      waiter.timer = setTimeout(check, 50);
      waiter.timer.unref?.();
    });
  }

  signal(signal) {
    if (this.control === "user") {
      throw new Error(
        "terminal " + this.id + " is controlled by the user; " +
        "signals are disabled after takeover",
      );
    }
    if (this.dead || !this.child) {
      throw new Error("terminal " + this.id + " is not running");
    }
    const shellPid = this.child.pid;
    const pgid = foregroundPgrp(shellPid) || shellPid;
    if (signal === "SIGKILL" && pgid === shellPid) {
      throw new Error("refusing SIGKILL to the shell process group; use terminal_close");
    }
    try {
      process.kill(-pgid, signal);
    } catch (error) {
      try {
        process.kill(pgid, signal);
      } catch (_) {
        throw new Error("cannot signal terminal " + this.id + ": " + (error.message || error));
      }
    }
    return { sessionId: this.id, signal, pgid, shellPid, shellTargeted: pgid === shellPid };
  }

  close() {
    if (this._closePromise) return this._closePromise;
    this._closing = true;
    this._closePromise = this._close();
    return this._closePromise;
  }

  async _close() {
    const child = this.child;
    const kind = this.childKind;
    const root = child?.pid;
    const captured = descendantsOf(root);
    this._finishWaiters("closed");
    if (!root) {
      this.dead = true;
      this.child = null;
      this.screen.dispose();
      return { sessionId: this.id, closed: true, captured: [], gone: true };
    }

    // Hang up first so the shell's own children see the controlling terminal
    // disappear; then terminate leftovers that ignored the hangup.
    try { child.kill("SIGHUP"); } catch (_) {}
    try { process.kill(-root, "SIGHUP"); } catch (_) {}
    signalPids(captured, "SIGHUP");
    await new Promise((resolve) => setTimeout(resolve, 200));

    if (captured.some((pid) => processAlive(pid))) {
      try { child.kill("SIGTERM"); } catch (_) {}
      try { process.kill(-root, "SIGTERM"); } catch (_) {}
      signalPids(captured, "SIGTERM");
      await waitForProcessesGone(captured, TERMINAL_CLOSE_GRACE_MS);
    }
    if (captured.some((pid) => processAlive(pid))) {
      try { child.kill("SIGKILL"); } catch (_) {}
      try { process.kill(-root, "SIGKILL"); } catch (_) {}
      signalPids(captured, "SIGKILL");
      await waitForProcessesGone(captured, TERMINAL_CLOSE_KILL_WAIT_MS);
    }

    // node-pty's exit callback may have run between the snapshots above.
    this.dead = true;
    this.child = null;
    const gone = !captured.some((pid) => processAlive(pid));
    this.screen.dispose();
    this.logger.info?.("[terminals] closed interactive " + this.id + (gone ? "" : " (some processes remain)"));
    return { sessionId: this.id, closed: true, captured, gone };
  }

  disposeSync() {
    const child = this.child;
    const captured = descendantsOf(child?.pid);
    this.dead = true;
    this.child = null;
    this._finishWaiters("closed");
    this.screen.dispose();
    if (child) {
      try { child.kill("SIGKILL"); } catch (_) {}
      try { process.kill(-child.pid, "SIGKILL"); } catch (_) {}
    }
    signalPids(captured, "SIGKILL");
  }
}

class TerminalService {
  constructor({ idleTimeoutMs = 30 * 60 * 1000, backend, ptyModule = null, logger = console } = {}) {
    this.idleTimeoutMs = idleTimeoutMs;
    this.logger = logger;
    this.backend = normalizeBackend(backend ?? process.env[BACKEND_ENV]);
    this.ptyModule = ptyModule;
    this.ptyError = null;

    if (this.backend === "pty") {
      if (process.platform === "win32") {
        this.backend = "pipe";
      } else if (!this.ptyModule) {
        const loaded = loadNodePty();
        if (loaded.error) {
          this.backend = "pipe";
          this.ptyError = loaded.error;
          this.logger.warn?.(
            `[terminals] node-pty unavailable; persistent bash will use pipe: ${loaded.error.message || loaded.error}`,
          );
        } else {
          this.ptyModule = loaded.module;
        }
      }
    }

    this.terminals = new Map(); // key -> PersistentTerminal
    this.interactive = new Map(); // owner key -> Map<terminal id, InteractiveTerminal>
    this._idleTimers = new Map();
    this._terminalSeq = 0;
    process.once("exit", () => this.disposeSync());
  }

  keyFor(sessionId) {
    return sessionId == null || sessionId === "" ? "__bare__" : String(sessionId);
  }

  _interactiveFor(ownerId) {
    const key = this.keyFor(ownerId);
    let sessions = this.interactive.get(key);
    if (!sessions) {
      sessions = new Map();
      this.interactive.set(key, sessions);
    }
    return sessions;
  }

  _newTerminalId(sessions) {
    while (true) {
      this._terminalSeq += 1;
      const id = "term_" + Date.now().toString(36) + "_" + this._terminalSeq.toString(36);
      if (!sessions.has(id)) return id;
    }
  }

  async open(ownerId, {
    type = "shell", name, cwd, createdBy = "agent", cols = 120, rows = 30,
  } = {}) {
    const kind = typeof type === "string" ? type.trim() : "";
    if (!kind) throw new Error("terminal type is required");
    if (!TERMINAL_TYPES.has(kind)) {
      throw new Error('unknown terminal backend type "' + kind + '"; registered types: ' + [...TERMINAL_TYPES].join(", "));
    }
    const base = cwd || process.cwd();
    const resolved = path.resolve(base, cwd || ".");
    let stat;
    try {
      stat = fs.statSync(resolved);
    } catch (_) {
      throw new Error("terminal cwd does not exist: " + resolved);
    }
    if (!stat.isDirectory()) throw new Error("terminal cwd is not a directory: " + resolved);

    const sessions = this._interactiveFor(ownerId);
    let requested = typeof name === "string" ? name.trim() : "";
    if (!requested) {
      let n = sessions.size + 1;
      requested = kind + "-" + n;
      while ([...sessions.values()].some((terminal) => terminal.name === requested)) {
        n += 1;
        requested = kind + "-" + n;
      }
    }
    const id = this._newTerminalId(sessions);
    const terminal = new InteractiveTerminal({
      id,
      ownerId,
      type: kind,
      name: requested,
      cwd: resolved,
      logger: this.logger,
      ptyModule: this.ptyModule,
      createdBy,
      cols,
      rows,
    });
    terminal.start();
    sessions.set(id, terminal);
    return {
      id,
      name: requested,
      type: kind,
      cwd: resolved,
      createdAt: terminal.createdAt,
      control: terminal.control,
      createdBy: terminal.createdBy,
    };
  }

  list(ownerId) {
    const sessions = this.interactive.get(this.keyFor(ownerId));
    if (!sessions) return [];
    return [...sessions.values()]
      // Agent tooling cannot see terminals the user created, nor agent
      // terminals that have been detached after takeover. Those belong to the
      // panel and stay reachable only through user_terminal_*.
      .filter((terminal) => terminal.createdBy !== "user" && !terminal.detached)
      .map((terminal) => ({
        id: terminal.id,
        name: terminal.name,
        type: terminal.type,
        cwd: terminal.cwd,
        alive: terminal.alive,
        running: terminal.runningStatus(),
        control: terminal.control,
        createdBy: terminal.createdBy,
        exitCode: terminal.exitCode,
        createdAt: terminal.createdAt,
        lastActivityAt: terminal.lastActivityAt,
        foregroundPgrp: terminal.alive ? foregroundPgrp(terminal.child?.pid) : null,
      }));
  }

  listPanel(ownerId) {
    const sessions = this.interactive.get(this.keyFor(ownerId));
    if (!sessions) return [];
    return [...sessions.values()].map((terminal) => this._panelSummary(terminal));
  }

  _panelSummary(terminal) {
    return {
      id: terminal.id,
      name: terminal.name,
      type: terminal.type,
      cwd: terminal.cwd,
      running: terminal.runningStatus(),
      alive: terminal.alive,
      control: terminal.control,
      createdBy: terminal.createdBy,
      detached: terminal.detached,
      exitCode: terminal.exitCode,
      cols: terminal.cols,
      rows: terminal.rows,
      createdAt: terminal.createdAt,
      lastActivityAt: terminal.lastActivityAt,
    };
  }

  getInteractive(ownerId, sessionId) {
    const sessions = this.interactive.get(this.keyFor(ownerId));
    const terminal = sessions?.get(String(sessionId));
    if (!terminal) throw new Error("no persistent terminal found with id " + sessionId);
    return terminal;
  }

  openPanel(ownerId, options = {}) {
    return this.open(ownerId, Object.assign({}, options, {
      createdBy: "user",
    }));
  }

  getPanelTerminal(ownerId, sessionId) {
    return this.getInteractive(ownerId, sessionId);
  }

  panelList(ownerId) {
    return this.listPanel(ownerId);
  }

  async resize(ownerId, sessionId, cols, rows) {
    return await this.getInteractive(ownerId, sessionId).resize(cols, rows);
  }

  async snapshot(ownerId, sessionId) {
    return await this.getInteractive(ownerId, sessionId).snapshot();
  }

  async readScreen(ownerId, sessionId, lines) {
    return await this.getInteractive(ownerId, sessionId).readScreen(lines);
  }

  subscribe(ownerId, sessionId, listener) {
    return this.getInteractive(ownerId, sessionId).subscribe(listener);
  }

  onExit(ownerId, sessionId, listener) {
    return this.getInteractive(ownerId, sessionId).onExit(listener);
  }

  input(ownerId, sessionId, data) {
    return this.getInteractive(ownerId, sessionId).input(data);
  }

  detach(ownerId, sessionId) {
    return this.getInteractive(ownerId, sessionId).detach();
  }

  pause(ownerId, sessionId) {
    this.getInteractive(ownerId, sessionId).pause();
  }

  resume(ownerId, sessionId) {
    this.getInteractive(ownerId, sessionId).resume();
  }

  read(ownerId, sessionId, { offset, count } = {}) {
    const terminal = this.getInteractive(ownerId, sessionId);
    if (terminal.createdBy === "user") {
      throw new Error(
        "terminal " + terminal.id + " was created by the user; use user_terminal_read",
      );
    }
    return terminal.read(offset, count);
  }

  send(ownerId, sessionId, text, options = {}) {
    return this.getInteractive(ownerId, sessionId).send(text, options);
  }

  signal(ownerId, sessionId, signal) {
    return this.getInteractive(ownerId, sessionId).signal(signal);
  }

  async closeTerminal(ownerId, sessionId, { actor = "agent" } = {}) {
    const key = this.keyFor(ownerId);
    const sessions = this.interactive.get(key);
    const terminal = sessions?.get(String(sessionId));
    if (!terminal) throw new Error("no persistent terminal found with id " + sessionId);

    if (actor === "agent") {
      if (terminal.createdBy === "user") {
        throw new Error(
          "terminal " + terminal.id + " was created by the user and can only be closed from the terminal panel",
        );
      }
      if (terminal.control === "user") {
        // DSH semantics: once the user takes over, the agent's close is a
        // detach. The shell keeps running and the panel remains attached.
        terminal.detach();
        return { sessionId: terminal.id, closed: false, detached: true, captured: [], gone: false };
      }
    }

    sessions.delete(terminal.id);
    if (sessions.size === 0) this.interactive.delete(key);
    return await terminal.close();
  }

  async closePanel(ownerId, sessionId) {
    return await this.closeTerminal(ownerId, sessionId, { actor: "user" });
  }

  async resolveTerminalId(ownerId, sessionId) {
    return this.getInteractive(ownerId, sessionId).id;
  }

  _touch(key, terminal) {
    if (this.idleTimeoutMs <= 0) return;
    const old = this._idleTimers.get(key);
    if (old) clearTimeout(old);
    const timer = setTimeout(() => {
      const current = this.terminals.get(key);
      if (!current || current.busy) return;
      this.terminals.delete(key);
      this._idleTimers.delete(key);
      current.destroy();
    }, this.idleTimeoutMs);
    timer.unref?.();
    this._idleTimers.set(key, timer);
  }

  get(sessionId, { cwd } = {}) {
    const key = this.keyFor(sessionId);
    let terminal = this.terminals.get(key);
    if (!terminal) {
      terminal = new PersistentTerminal({
        key,
        sessionId,
        cwd,
        logger: this.logger,
        backend: this.backend,
        ptyModule: this.ptyModule,
      });
      this.terminals.set(key, terminal);
    }
    this._touch(key, terminal);
    return terminal;
  }

  async run(sessionId, command, { cwd, signal, timeoutMs } = {}) {
    const terminal = this.get(sessionId, { cwd });
    try {
      return await terminal.run(command, { signal, timeoutMs });
    } finally {
      this._touch(this.keyFor(sessionId), terminal);
    }
  }

  close(sessionId) {
    const key = this.keyFor(sessionId);
    let closed = false;
    const terminal = this.terminals.get(key);
    if (terminal) {
      this.terminals.delete(key);
      const timer = this._idleTimers.get(key);
      if (timer) clearTimeout(timer);
      this._idleTimers.delete(key);
      terminal.destroy();
      closed = true;
    }
    const sessions = this.interactive.get(key);
    if (sessions) {
      for (const interactive of sessions.values()) {
        interactive.close().catch(() => {});
      }
      this.interactive.delete(key);
      closed = true;
    }
    return closed;
  }

  disposeAll() {
    const terminals = [...this.terminals.values()];
    this.terminals.clear();
    const interactive = [...this.interactive.values()].flatMap((sessions) => [...sessions.values()]);
    this.interactive.clear();
    for (const timer of this._idleTimers.values()) clearTimeout(timer);
    this._idleTimers.clear();
    for (const terminal of terminals) terminal.destroy();
    for (const terminal of interactive) terminal.disposeSync();
    return terminals.length + interactive.length;
  }

  disposeSync() {
    for (const terminal of this.terminals.values()) {
      terminal.disposeSync();
    }
    this.terminals.clear();
    for (const sessions of this.interactive.values()) {
      for (const terminal of sessions.values()) terminal.disposeSync();
    }
    this.interactive.clear();
  }
}

const __exports = {
  TerminalService,
  PersistentTerminal,
  InteractiveTerminal,
  DEFAULT_TIMEOUT_MS,
  BACKEND_ENV,
  TERMINAL_READ_DEFAULT,
  TERMINAL_READ_CAP,
};
export {
  TerminalService,
  PersistentTerminal,
  InteractiveTerminal,
  DEFAULT_TIMEOUT_MS,
  BACKEND_ENV,
  TERMINAL_READ_DEFAULT,
  TERMINAL_READ_CAP,
};
export default __exports;
