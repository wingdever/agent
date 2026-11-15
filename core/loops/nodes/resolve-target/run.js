"use strict";

// Node resolve-target: resolve provider/model credentials and the stream flag
// from the single config source.
module.exports = async function run(input, ctx) {
  const settings = ctx.services.config.readSettings();
  const target = ctx.services.config.resolveTarget({
    provider: settings.provider,
    model: ctx.model || settings.model,
  });
  ctx.target = {
    provider: target.provider,
    model: target.model,
    baseUrl: target.baseUrl,
    apiKey: target.apiKey,
    effort: ctx.effort && ctx.effort !== "undefined" ? ctx.effort : null,
    stream: ctx.stream !== undefined ? !!ctx.stream : settings.stream === true,
  };
  return { output: ctx.target, next: "assemble-system" };
};
