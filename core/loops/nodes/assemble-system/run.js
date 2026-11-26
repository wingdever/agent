"use strict";

// Node assemble-system: build the session system prompt + skill catalog on the
// first turn and reuse the stored prompt afterwards.
import _mod0 from "./../../../skills/index.js";
const { isModelInvocable } = _mod0;
import { LANGUAGE_POLICY } from "./../../../translation.js";

export default async function run(input, ctx) {
  const { services, session, request } = ctx;
  const settings = services.config.readSettings();
  const persist = session.persist;

  let system = persist ? await services.store.run("session.prompt", { session_id: session.id }) : null;
  const systemIsNew = !system;
  let catalogMsg = null;

  if (systemIsNew) {
    const skills = services.skills
      ? (await services.skills.list({ cwd: ctx.cwd })).filter((s) => isModelInvocable(s))
      : [];
    const assembled = services.context.assembleSystem({
      identity: settings.identity,
      persona: typeof ctx.persona === "string"
        ? ctx.persona
        : (typeof settings.persona === "string" ? settings.persona : ""),
      languagePolicy: ctx.translateCfg && ctx.translateCfg.enabled ? LANGUAGE_POLICY : "",
      tools: request.selected,
      executorMode: ctx.executorMode,
      sdkTools: request.sdkTools || [],
      cwd: ctx.cwd,
      model: request.model,
      skills,
      catalogDescriptionMaxLength: settings.skills ? settings.skills.catalogDescriptionMaxLength : undefined,
      // Names must match the live resource tools; a server that is down is not
      // advertised, so the model never gets a name it cannot use.
      mcpResourceServers: services.mcp ? services.mcp.resourceServerNames() : [],
      mcpInstructions: services.mcp ? services.mcp.serverInstructions() : [],
    });
    system = assembled.system;
    if (assembled.block.length > 1) catalogMsg = assembled.block[1];
    ctx.emit({ type: "system-prompt", content: system });
  }

  ctx.system = system;
  ctx.systemIsNew = systemIsNew;
  ctx.catalogMsg = catalogMsg;
  return { output: system, next: "assemble-input" };
};
