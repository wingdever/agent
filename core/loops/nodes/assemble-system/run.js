"use strict";

// Node assemble-system: build the session system prompt + skill catalog on the
// first turn and reuse the stored prompt afterwards.
import { DEFAULT_IDENTITY } from "./../../../system-prompt.js";
import _mod0 from "./../../../skills/index.js";
const { isModelInvocable } = _mod0;

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
      identity: typeof settings.identity === "string" ? settings.identity : DEFAULT_IDENTITY,
      persona: typeof settings.persona === "string" ? settings.persona : "",
      tools: request.selected,
      cwd: ctx.cwd,
      model: request.model,
      skills,
      catalogDescriptionMaxLength: settings.skills ? settings.skills.catalogDescriptionMaxLength : undefined,
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
