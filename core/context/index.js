"use strict";

const { assembleSystemPrompt } = require("../system-prompt");
const compactionRunner = require("../compaction-runner");
const tokenAnchor = require("../token-anchor");
const { prepareUserInput } = require("../user-input");
const { resolveWorkspaceFolder } = require("./workspace");
const { cleanMessage } = require("./messages");
const translation = require("../translation");

// Context service: system prompt assembly, input references, request-message
// projection, compaction, token anchors, workspace resolution and translation.
// It owns no turn state; the runtime is injected so compaction can use the
// active-session/compaction gates.
class ContextService {
  constructor({ config, model, tools, skills, store }) {
    this.config = config;
    this.model = model;
    this.tools = tools;
    this.skills = skills;
    this.store = store;
    this.runtime = null;
  }

  setRuntime(runtime) {
    this.runtime = runtime;
  }

  deps() {
    if (!this.runtime) throw new Error("context runtime not initialized");
    return {
      store: this.store,
      bootId: this.runtime.bootId,
      activeSessions: this.runtime.activeSessions,
      compacting: this.runtime.compacting,
      model: this.model,
      config: this.config,
      tools: this.tools,
    };
  }

  settings() {
    return this.config.readSettings();
  }

  assembleSystem(opts) {
    return assembleSystemPrompt(opts);
  }

  prepareInput(opts) {
    return prepareUserInput({ store: this.store, skills: this.skills }, opts);
  }

  surfaceNodes(sessionId) {
    return compactionRunner.surfaceNodes(this.deps(), sessionId);
  }

  requestMessages(sessionId, system, pending) {
    return compactionRunner.requestMessages(this.deps(), sessionId, system, pending);
  }

  summarizeMessages(opts) {
    return compactionRunner.summarizeMessages(this.deps(), opts);
  }

  pruneToolResults(sessionId) {
    return compactionRunner.pruneToolResults(this.deps(), sessionId);
  }

  runCompaction(opts) {
    return compactionRunner.runCompaction(this.deps(), opts);
  }

  compactSession(opts) {
    return compactionRunner.compactSession(this.deps(), opts);
  }

  maybeCompactStep(opts) {
    return compactionRunner.maybeCompactStep(this.deps(), opts);
  }

  recordTokenAnchor(opts) {
    return tokenAnchor.recordTokenAnchor({ store: this.store }, opts);
  }

  resolveContextWindow(opts) {
    return this.config.resolveContextWindow(opts);
  }

  cleanMessage(message) {
    return cleanMessage(message);
  }

  async resolveCwd(sessionId) {
    if (!sessionId || !this.store) return process.cwd();
    try {
      const session = await this.store.run("session.get", { id: sessionId });
      if (session && session.workspace_id != null) {
        const workspace = await this.store.run("workspace.get", { id: session.workspace_id });
        if (workspace && typeof workspace.folder_path === "string" && workspace.folder_path.trim()) {
          const resolved = resolveWorkspaceFolder(workspace.folder_path);
          if (resolved) return resolved;
          console.warn("[core] workspace folder not found:", workspace.folder_path, "-> falling back to", process.cwd());
        }
      }
    } catch (e) {
      console.error("[core] resolve cwd failed:", e.message);
    }
    return process.cwd();
  }

  resolveTranslateConfig(settings) {
    return translation.resolveConfig(settings);
  }

  shouldTranslateUser(text, config) {
    return translation.shouldTranslateUser(text, config);
  }

  shouldTranslateAssistant(text, config) {
    return translation.shouldTranslateAssistant(text, config);
  }

  translateText(opts) {
    return translation.translateText(opts);
  }
}

module.exports = { ContextService };
