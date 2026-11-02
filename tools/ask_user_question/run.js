"use strict";

// Model-facing interactive question. The tool body blocks until the UI submits
// a batch; core owns the pending promise and the event/answer transport.

function validateQuestions(questions) {
  if (!Array.isArray(questions) || questions.length === 0) {
    throw new Error("questions must contain at least one question");
  }
  const seen = new Set();
  for (const question of questions) {
    if (!question || typeof question !== "object") {
      throw new Error("each question must be an object");
    }
    const id = typeof question.id === "string" ? question.id : "";
    if (!id.trim()) throw new Error("each question must have a non-empty id");
    if (seen.has(id)) throw new Error('question id "' + id + '" must be unique within this call');
    seen.add(id);
    if (typeof question.question !== "string" || !question.question.trim()) {
      throw new Error("each question must have a non-empty question");
    }
    if (question.options !== undefined) {
      if (!Array.isArray(question.options)) throw new Error("options must be an array when given");
      for (const option of question.options) {
        if (!option || typeof option.label !== "string" || !option.label.trim()) {
          throw new Error("each option must have a non-empty label");
        }
      }
    }
  }
}

module.exports = {
  async run(args = {}, exec = {}) {
    validateQuestions(args.questions);
    if (typeof exec.askUserQuestion !== "function") {
      throw new Error("ask_user_question is not available in this context");
    }
    const result = await exec.askUserQuestion(args.questions);
    const answers = result && Array.isArray(result.answers) ? result.answers : [];
    return {
      text: JSON.stringify({ answers }),
      meta: { answers },
    };
  },
};
