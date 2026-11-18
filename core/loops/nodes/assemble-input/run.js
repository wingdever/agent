"use strict";

// Node assemble-input: validate the last user message, resolve @references and
// build the request conversation (surface projection or in-memory history).
const { TurnError } = require("../../../turn-error");

module.exports = async function run(input, ctx) {
  const { services, session, input: turnInput } = ctx;
  const messages = turnInput.messages;
  const lastInput = Array.isArray(messages) && messages.length ? messages[messages.length - 1] : null;
  if (!lastInput || lastInput.role !== "user") {
    throw new TurnError("invalid-input", "the last message must be a user message");
  }

  const pendingUser = {
    role: "user",
    content: ctx.translatedUser != null ? ctx.translatedUser : lastInput.content,
  };
  const prepared = await services.context.prepareInput({
    text: lastInput.content,
    cwd: ctx.cwd,
    references: turnInput.references,
    sessionId: session.id,
    persist: session.persist,
  });
  const pendingRefs = prepared.refs;

  let conv;
  if (session.persist) {
    conv = await services.context.requestMessages(session.id, ctx.system, [...pendingRefs, pendingUser]);
  } else {
    conv = [{ role: "system", content: ctx.system }, ...messages];
    if (ctx.catalogMsg) conv.splice(1, 0, ctx.catalogMsg);
    if (ctx.translatedUser != null && conv.length > 1) {
      conv[conv.length - 1] = Object.assign({}, conv[conv.length - 1], { content: ctx.translatedUser });
    }
  }

  if (Array.isArray(turnInput.contextMessages) && turnInput.contextMessages.length) {
    const last = conv.length - 1;
    const at = last > 0 && conv[last] && conv[last].role === "user" ? last : 1;
    conv.splice(at, 0, ...turnInput.contextMessages);
  }

  ctx.request.messages = conv;
  ctx.pendingUser = pendingUser;
  ctx.pendingRefs = pendingRefs;
  ctx.pendingTurnMessages = () =>
    ctx.turn.steps === 0 && !(ctx.step && ctx.step.userPersisted) ? [...ctx.pendingRefs, ctx.pendingUser] : [];
  return { output: conv, next: "pre-step" };
};
