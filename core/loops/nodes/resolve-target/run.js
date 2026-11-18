"use strict";

// Node resolve-target: resolve provider/model credentials and the stream flag
// into the turn's single RequestSpec.
module.exports = async function run(input, ctx) {
  const settings = ctx.services.config.readSettings();
  const request = ctx.request;
  const target = ctx.services.config.resolveTarget({
    provider: settings.provider,
    model: request.model || settings.model,
  });
  request.model = target.model;
  request.baseUrl = target.baseUrl;
  request.apiKey = target.apiKey;
  request.effort = request.effort && request.effort !== "undefined" ? request.effort : null;
  request.stream = request.stream !== undefined ? !!request.stream : settings.stream === true;
  return { output: request, next: "assemble-system" };
};
