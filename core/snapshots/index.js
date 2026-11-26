"use strict";

// Pause service (docs/runtime/turn-pause.md §4): decides which sessions get a
// snapshot when the app closes, writes them, and on start reads the index back
// and restores each paused session to its pause point.
//
// It is deliberately thin: the Agent owns the phase and the pause marker while
// the process runs; this service only crosses the process boundary.

import { createSnapshotStore } from "./store.js";

class SnapshotService {
  constructor({ store, dir, logger = console }) {
    if (!store) throw new Error("SnapshotService requires a store");
    this.store = store;
    this.logger = logger;
    this.snapshots = createSnapshotStore({ store, dir });
  }

  // Close path: persist every session that is paused right now. Only `paused`
  // sessions are written; a `running` turn has no pause point to continue from
  // (docs/runtime/turn-pause.md §4.2).
  async writeAll(agents) {
    const written = [];
    for (const agent of agents || []) {
      try {
        if (typeof agent.pausedAt === "function" && !agent.pausedAt()) continue;
        const snapshot = agent.snapshotPause();
        if (!snapshot) continue;
        await this.snapshots.write(agent.sessionId, snapshot);
        written.push(String(agent.sessionId));
      } catch (error) {
        this.logger.warn("[snapshots] write failed for session " + agent.sessionId + ": " + ((error && error.message) || error));
      }
    }
    return written;
  }

  // Start path: every index row names a session worth restoring. Restoring a
  // snapshot means either a paused turn (from the file) or, when the file is
  // gone, the pause point inferred from pending calls (§4.4).
  async restoreAll(runtime) {
    let sessions;
    try {
      sessions = await this.snapshots.listIndex();
    } catch (error) {
      this.logger.warn("[snapshots] index read failed: " + ((error && error.message) || error));
      return [];
    }
    const restored = [];
    for (const sessionId of sessions) {
      try {
        const snapshot = await this.snapshots.read(sessionId);
        await this.snapshots.clearIndex(sessionId);
        const agent = await runtime.getOrCreate(sessionId);
        const pausedAt = snapshot && snapshot.state === "paused" && snapshot.pausedAt
          ? snapshot.pausedAt
          : await this.inferPausedAt(sessionId);
        if (!pausedAt) continue;
        agent.restorePause({
          pausedAt,
          nextStep: snapshot && snapshot.state === "paused" ? snapshot.nextStep : [],
          continueAt: snapshot && snapshot.state === "paused" ? snapshot.continueAt : null,
        });
        restored.push(String(sessionId));
      } catch (error) {
        this.logger.warn("[snapshots] restore failed for session " + sessionId + ": " + ((error && error.message) || error));
      }
    }
    return restored;
  }

  // No snapshot survived (crash) or the file was never written: the pause
  // point is still inferable from the store. A turn that never finished with
  // pending calls stopped before its tools; one without pending calls stopped
  // before its next model request (§4.4).
  async inferPausedAt(sessionId) {
    const turns = await this.store.run("turn.list", { session_id: sessionId }).catch(() => []);
    const open = (turns || []).filter((turn) => turn.status === "pending" || turn.status === "running");
    if (open.length === 0) return null;
    const turn = open[open.length - 1];
    const steps = await this.store.run("step.list", { turn_id: turn.id }).catch(() => []);
    const last = (steps || [])[steps.length - 1];
    if (!last) return null;
    const messages = await this.store.run("message.list", { step_id: last.id }).catch(() => []);
    const assistant = (messages || []).filter((message) => message.role === "assistant").pop();
    if (!assistant) return null;
    const calls = await this.store.run("call.list", { reply_id: assistant.id }).catch(() => []);
    const pending = (calls || []).filter((call) => call.status === "pending");
    return pending.length > 0 ? "before-tools" : "before-model";
  }
}

function createSnapshotService(opts) {
  return new SnapshotService(opts);
}

const __exports = { SnapshotService, createSnapshotService };
export { SnapshotService, createSnapshotService };
export default __exports;
