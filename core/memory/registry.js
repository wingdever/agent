"use strict";

// AgentRegistry: the process's only index of agent instances, keyed by
// String(sessionId) (docs/agents/agent-instance.md §1).
//
// Two objects, two jobs:
//   - the registry is the plural form: reach any session's instance by id
//     (`send_message`, `interrupt_agent`, RPC with an explicit sessionId).
//   - the cursor is the singular form: the agent an unnamed call interacts
//     with. It is a pointer, not a copy, and not necessarily an index entry.
//
// The cursor is derived, not remembered as "whoever was last":
//
//   1. an explicitly selected agent (or the one of the last turn that named a
//      session) that still exists, unless it is a subagent;
//   2. otherwise the most recently active working session (kind "normal");
//   3. otherwise the standing bare session, if one was opened;
//   4. otherwise no cursor.
//
// Registered instances are created lazily, stay resident until the process
// exits, and are disposed only when their session is hard-deleted. Nothing here
// caches session facts: identity is read from the store at creation time.

import { Agent } from "./agent.js";

class AgentRegistry {
  constructor({ shared = {}, gates = {} } = {}) {
    this.shared = shared;
    this.gates = gates;
    this.instances = new Map();
    // Working-session activity: String(sessionId) -> monotonic counter. Only
    // the most recent value matters; the stamp decides between candidates.
    this._activity = new Map();
    this._activitySeq = 0;
    // Explicit selection: instance, or null to fall back to derivation.
    this._selected = null;
    // The standing bare session: the last bare turn's instance. A new bare
    // turn replaces it and releases the previous one.
    this._bare = null;
  }

  keyFor(sessionId) {
    return String(sessionId);
  }

  get(sessionId) {
    if (sessionId == null) return null;
    return this.instances.get(this.keyFor(sessionId)) || null;
  }

  has(sessionId) {
    return this.get(sessionId) != null;
  }

  // Lazily create one instance, reading its identity from the store. A session
  // that no longer exists never yields an instance.
  async getOrCreate(sessionId, opts = {}) {
    const existing = this.get(sessionId);
    if (existing) return existing;
    const store = this.shared.store;
    let row = null;
    if (store) {
      row = await store.run("session.get", { id: Number(sessionId) }).catch(() => null);
    }
    if (!row) throw new Error("session not found: " + sessionId);
    let parentSessionId = null;
    let agentName = opts.agentName != null ? opts.agentName : "lead";
    try {
      const link = await store.run("subagent.get", { sub_sess_id: row.id });
      if (link) parentSessionId = link.par_sess_id;
      if (this.shared.subagents) agentName = await this.shared.subagents.pathOf(row.id);
    } catch (_) { /* a session without a delegation row is a root */ }
    return this._register(new Agent({
      sessionId: row.id,
      kind: row.kind || "normal",
      parentSessionId,
      agentName,
      persist: true,
      shared: this.shared,
      gates: this.gates,
    }));
  }

  // Unregistered instance: no registry entry and it never reads the store.
  // `sessionId` is carried only as the turn's label.
  createTransient(sessionId = null) {
    return new Agent({ sessionId, persist: false, shared: this.shared, gates: this.gates });
  }

  // Open the standing bare session. The previous one is released: the cursor
  // points at the most recent bare session only.
  openBare() {
    this._discardBare();
    this._bare = this.createTransient(null);
    return this._bare;
  }

  _discardBare() {
    if (!this._bare) return;
    if (this._bare.running()) this._bare.interrupt();
    if (this._selected === this._bare) this._selected = null;
    this._bare = null;
  }

  _register(agent) {
    this.instances.set(agent.key, agent);
    return agent;
  }

  list() {
    return Array.from(this.instances.values());
  }

  // The cursor instance: the default agent of the next unnamed interaction.
  //
  // Derived in priority order (see the header): an explicitly selected agent,
  // then the most recently active working session, then the standing bare
  // session, then nothing. A selected subagent only holds while it exists: an
  // unnamed call never starts out on a subagent.
  current() {
    const selected = this._selected;
    if (selected) {
      if (selected === this._bare) return selected;
      if (this._alive(selected) && selected.kind !== "subagent") return selected;
      this._selected = null;
    }
    const working = this._mostRecentWorking();
    if (working) return working;
    if (this._bare) return this._bare;
    return null;
  }

  // A selected agent stays selected while it exists: a registered instance
  // while its session is in the index, a transient one until its bare round
  // replaced it.
  _alive(agent) {
    if (!agent.persist) return false;
    return this.get(agent.sessionId) === agent;
  }

  _mostRecentWorking() {
    let best = null;
    let bestStamp = -1;
    for (const agent of this.instances.values()) {
      if (agent.kind !== "normal") continue;
      const stamp = this._activity.get(agent.key);
      if (stamp == null || stamp < bestStamp) continue;
      best = agent;
      bestStamp = stamp;
    }
    return best;
  }

  // Mark a working session as the most recently active one. Subagent turns call
  // this too: their stamp is recorded, but they are never derived as the cursor.
  touch(sessionId) {
    if (sessionId == null) return null;
    const agent = this.get(sessionId);
    if (!agent) return null;
    this._activity.set(agent.key, ++this._activitySeq);
    return agent;
  }

  // Select the cursor explicitly. Accepts the instance itself (registered or
  // transient) or a sessionId of an already instantiated session; passing
  // nothing drops the selection and falls back to derivation.
  setCurrent(agentOrSessionId) {
    if (agentOrSessionId == null) {
      this._selected = null;
      if (this._bare && !this._bare.running()) this._discardBare();
      return this.current();
    }
    if (agentOrSessionId instanceof Agent) {
      this._selected = agentOrSessionId;
      return agentOrSessionId;
    }
    const agent = this.get(agentOrSessionId);
    if (!agent) throw new Error("cannot select an uninstantiated session: " + agentOrSessionId);
    this._selected = agent;
    return agent;
  }

  // Drop a registered instance when its session is hard-deleted. A running
  // turn is interrupted first so nothing keeps writing to a deleted session.
  // A cursor on this instance falls back to derivation, never to nothing.
  dispose(sessionId) {
    const key = this.keyFor(sessionId);
    const agent = this.instances.get(key);
    if (!agent) return false;
    if (agent.running()) agent.interrupt();
    this.instances.delete(key);
    this._activity.delete(key);
    if (this._selected === agent) this._selected = null;
    return true;
  }
}

const __exports = { AgentRegistry };
export { AgentRegistry };
export default __exports;
