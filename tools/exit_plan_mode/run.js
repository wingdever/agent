"use strict";

// exit_plan_mode: present the plan for approval. Approval leaves plan mode;
// rejection keeps plan mode active and returns the user's feedback as an error
// so the model revises and presents again.

module.exports = {
  async run(args = {}, exec = {}) {
    if (typeof exec.isPlanMode !== "function" || !exec.isPlanMode()) {
      throw new Error("exit_plan_mode is only available in plan mode");
    }
    const plan = typeof args.plan === "string" ? args.plan : "";
    if (!/^#\s+\S/.test(plan.trim())) {
      throw new Error("exit_plan_mode requires a non-empty markdown plan starting with a # heading");
    }
    if (typeof exec.reviewPlan !== "function") {
      throw new Error("no plan review channel is available; switch the session mode instead");
    }
    const answer = await exec.reviewPlan(plan);
    if (answer && answer.approved) {
      return {
        text: "Plan approved — plan mode exited; carry out the plan starting with your next step.",
        meta: { approved: true },
      };
    }
    const feedback = answer && typeof answer.feedback === "string" ? answer.feedback.trim() : "";
    throw new Error(
      feedback
        ? "The user chose to keep planning; their feedback: " + feedback
        : "The user chose to keep planning; revise the plan and present it again."
    );
  },
};
