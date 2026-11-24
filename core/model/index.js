"use strict";

import responseProcess from "./../response-process.js";
import { fetchModels } from "./../network/http/client.js";

// Model service: the only place that talks to a provider. All calls receive an
// explicit target ({ model, baseUrl, apiKey, effort }).
class ModelService {
  constructor({ config }) {
    this.config = config;
  }

  reasoningParamFor(baseUrl) {
    return this.config.reasoningParamFor(baseUrl);
  }

  stream(opts) {
    return responseProcess.stream(this, opts);
  }

  emitUsage(onEvent, raw) {
    return responseProcess.emitUsage(onEvent, raw);
  }

  async fetchModels(baseurl, apikey) {
    if (!baseurl) throw new Error("missing baseurl");
    return fetchModels(baseurl, apikey);
  }

  async capabilities({ provider, model } = {}) {
    const providers = this.config.readProviders();
    // 1) Prefer the effort metadata cached in user/providers.json.
    for (const p of providers) {
      if (provider && p.name !== provider) continue;
      const m = (p.models || []).find((x) => x.name === model);
      if (m && m.effort && Array.isArray(m.effort.supported_levels)) {
        return { model, effort: m.effort.supported_levels, default_level: m.effort.default_level || null };
      }
    }
    // 2) Fall back to the provider's /models response.
    const candidates = providers.filter((p) => !provider || p.name === provider);
    for (const cand of candidates) {
      try {
        const res = await fetchModels(cand.base_url, cand.api_key);
        const list = res.list || res;
        const hit = list.find((m) => m.id === model);
        if (hit && hit.effort) return { model, effort: hit.effort, default_level: hit.default_level || null };
      } catch (_) {}
    }
    return { model, effort: null, default_level: null };
  }
}

const __exports = { ModelService };
export { ModelService };
export default __exports;
