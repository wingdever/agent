"use strict";

// Map a platform button callback (QQ keyboard / Feishu card action) onto the
// core interaction state machine. The channel driver has already acknowledged
// the platform click; this only resolves the pending promise in core.

export function applyInteraction(core, interaction) {
  if (!core || !core.interactions) throw new Error("channel interaction needs core.interactions");
  const id = Number(interaction && interaction.id);
  if (!Number.isInteger(id) || id <= 0) throw new Error("interaction id is missing");
  const kind = interaction.kind;
  let accepted = false;
  if (kind === "approval") {
    accepted = core.interactions.approve(id, interaction.decision === "approve" ? "approve" : "deny");
  } else if (kind === "question") {
    accepted = core.interactions.answerQuestions(id, interaction.answers || []);
  } else if (kind === "plan-review") {
    accepted = core.interactions.answerPlanReview(id, {
      approved: interaction.approved === true,
      feedback: interaction.feedback || "",
    });
  } else {
    throw new Error(`unknown interaction kind "${kind}"`);
  }
  if (!accepted) throw new Error(`interaction ${kind}:${id} is no longer pending`);
  return { accepted: true };
}

export default { applyInteraction };
