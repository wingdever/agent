"use strict";

// Skill registry: merges provider candidates by rank (lowest rank wins on
// name collision), exposes list/snapshot/get, and never caches full definitions
// (get() always re-reads through the winning provider).
//
// Adapted from @deepseek-ai/dsh@0.2.1-rc.2 / @deepseek-ai/dsh-skill/lib/index.js
// but WITHOUT cordis layered scopes: this project is a single-process,
// single-session agent, so resolution is a single flat rank merge
// (see docs/skills/skills.md 5.7). `scope` is intentionally absent from the API.

const { isSkillName } = require("./names");

const RUNTIME_RANK = 250;
const RUNTIME_PROVIDER = "runtime";

function compareCodePoints(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareSkillSummary(a, b) {
  return compareCodePoints(a.name, b.name);
}

function normalizeProviderObservation(output, providerName) {
  if (Array.isArray(output)) return { candidates: output, complete: true };
  if (output === null || typeof output !== "object") {
    throw new Error(`invalid provider observation from "${providerName}"`);
  }
  return output;
}

function toSummary(candidate) {
  const summary = {
    name: candidate.name,
    description: candidate.description,
    invocation: candidate.invocation,
    source: candidate.source,
    provider: candidate.provider
  };
  if (candidate.whenToUse !== void 0) summary.whenToUse = candidate.whenToUse;
  if (candidate.resourceBase !== void 0) summary.resourceBase = candidate.resourceBase;
  if (candidate.path !== void 0) summary.path = candidate.path;
  if (candidate.metadata !== void 0) summary.metadata = candidate.metadata;
  return summary;
}

function compareCandidates(a, b) {
  const ra = a.candidate.rank ?? RUNTIME_RANK;
  const rb = b.candidate.rank ?? RUNTIME_RANK;
  if (ra !== rb) return ra - rb;
  if (a.providerOrder !== b.providerOrder) return a.providerOrder - b.providerOrder;
  return a.localOrder - b.localOrder;
}

class SkillRegistry {
  constructor(opts = {}) {
    this.collectCacheMaxEntries = opts.collectCacheMaxEntries ?? 128;
    this.providers = []; // { provider, order }
    this.runtime = new Map(); // name -> { candidate, definition }
    this.collectCache = new Map(); // cwd -> Map<name, entry>
    this.revision = 0;
    this.changeListeners = [];
    this.logger = opts.logger;
    this.runtimeProvider = {
      name: RUNTIME_PROVIDER,
      get: (candidate) => Promise.resolve(this.runtime.get(candidate.name)?.definition)
    };
  }

  registerProvider(factory) {
    const self = this;
    const control = {
      signal: { aborted: false, addEventListener() {} },
      invalidate() { self.invalidateCache(); }
    };
    const provider = factory(control);
    this.providers.push({ provider, order: this.providers.length });
    return provider;
  }

  register(skill) {
    if (!skill || typeof skill.name !== "string" || !isSkillName(skill.name)) {
      throw new Error("runtime skill requires a valid name");
    }
    if (this.runtime.has(skill.name)) {
      this.logger?.warn?.(`runtime skill "${skill.name}" ignored because it is already registered`);
      return () => {};
    }
    const definition = {
      ...skill,
      invocation: skill.invocation ?? { modelInvocable: true, userInvocable: true },
      provider: skill.provider ?? RUNTIME_PROVIDER
    };
    const candidate = {
      name: definition.name,
      description: definition.description,
      invocation: definition.invocation,
      source: "runtime",
      provider: definition.provider,
      rank: RUNTIME_RANK
    };
    if (definition.whenToUse !== void 0) candidate.whenToUse = definition.whenToUse;
    if (definition.resourceBase !== void 0) candidate.resourceBase = definition.resourceBase;
    if (definition.path !== void 0) candidate.path = definition.path;
    if (definition.metadata !== void 0) candidate.metadata = definition.metadata;
    this.runtime.set(definition.name, { candidate, definition });
    const self = this;
    return () => {
      const entry = self.runtime.get(definition.name);
      if (entry && entry.definition === definition) self.runtime.delete(definition.name);
    };
  }

  onSkillsChange(cb) {
    this.changeListeners.push(cb);
  }

  invalidateCache() {
    this.revision += 1;
    this.collectCache.clear();
    this.notifyChange();
  }

  notifyChange() {
    for (const cb of this.changeListeners) {
      try { cb(); } catch (e) { this.logger?.warn?.(`skills/change listener threw: ${e && e.message}`); }
    }
  }

  async collect(options = {}) {
    const key = JSON.stringify({ cwd: options.cwd ?? null });
    const cached = this.collectCache.get(key);
    if (cached !== void 0) return { entries: cached, cacheable: true };
    const result = await this.collectFresh(options);
    if (result.cacheable) {
      this.collectCache.set(key, result.entries);
      if (this.collectCache.size > this.collectCacheMaxEntries) {
        const oldest = this.collectCache.keys().next().value;
        this.collectCache.delete(oldest);
      }
    }
    return result;
  }

  async collectFresh(options) {
    const entries = [];
    let cacheable = true;
    let runtimeOrder = 0;
    for (const { candidate } of this.runtime.values()) {
      entries.push({ candidate, provider: this.runtimeProvider, providerOrder: -1, localOrder: runtimeOrder });
      runtimeOrder += 1;
    }
    for (const { provider, order } of this.providers) {
      let localOrder = 0;
      let output;
      try {
        output = await provider.list(options);
      } catch (error) {
        cacheable = false;
        this.logger?.warn?.(`skill provider "${provider.name}" skipped: ${error && error.message}`);
        continue;
      }
      const observation = normalizeProviderObservation(output, provider.name);
      if (!observation.complete) cacheable = false;
      for (const candidate of observation.candidates) {
        entries.push({ candidate, provider, providerOrder: order, localOrder });
        localOrder += 1;
      }
    }
    entries.sort(compareCandidates);
    const seen = new Set();
    const merged = new Map();
    for (const entry of entries) {
      const name = entry.candidate.name;
      if (seen.has(name)) {
        this.logger?.warn?.(`skill "${name}" from ${entry.candidate.source} ignored because a higher-priority skill already exists`);
        continue;
      }
      seen.add(name);
      merged.set(name, entry);
    }
    return { entries: merged, cacheable };
  }

  async list(options) {
    return (await this.snapshot(options)).skills;
  }

  async snapshot(options) {
    const collected = await this.collect(options);
    return {
      skills: [...collected.entries.values()].map((e) => toSummary(e.candidate)).sort(compareSkillSummary),
      complete: collected.cacheable
    };
  }

  async get(name, options = {}) {
    if (!isSkillName(name)) return void 0;
    const collected = await this.collect(options);
    const entry = collected.entries.get(name);
    if (entry === void 0) return void 0;
    const definition = await entry.provider.get(entry.candidate, options);
    if (definition === void 0) return void 0;
    if (definition.name !== name) {
      this.invalidateCache();
      return void 0;
    }
    return definition;
  }
}

module.exports = { SkillRegistry, RUNTIME_RANK, RUNTIME_PROVIDER };
