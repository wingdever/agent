"use strict";

export default {
  async run(args = {}, exec = {}) {
    const client = exec.a2a && exec.a2a.client;
    if (!client) return { text: "Error: A2A is unavailable in this context", isError: true };
    if (!args.card_url || !args.prompt) {
      return { text: "Error: card_url and prompt are required", isError: true };
    }
    const token = args.token_env ? process.env[args.token_env] : null;
    try {
      const result = await client.call({
        cardUrl: args.card_url,
        prompt: args.prompt,
        skill: args.skill,
        token,
        timeoutMs: args.timeout_ms,
      });
      const text = result.text || (result.state ? `Remote task ended in ${result.state} with no artifact text` : "Remote agent returned no text");
      return {
        text,
        meta: {
          state: result.state || null,
          task_id: result.task && result.task.id || null,
          artifact_count: result.task && Array.isArray(result.task.artifacts) ? result.task.artifacts.length : 0,
        },
      };
    } catch (err) {
      return { text: `A2A call failed: ${err && err.message || err}`, isError: true };
    }
  },
};
