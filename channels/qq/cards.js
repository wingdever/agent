"use strict";

// QQ message buttons: the platform's only actionable message UI.
//
// A button is not a card. It is a `keyboard` attached to the bottom of a
// Markdown message: max 5 rows, max 5 buttons per row, and a button label is
// about 10 characters. Everything here is deliberately pure so the API layer
// and the tests can share the exact wire shape.

const MAX_LABEL = 10;
const MAX_OPTIONS = 5;

function cut(value, limit) {
  const text = String(value == null ? "" : value).replace(/\s+/g, " ").trim();
  if (text.length <= limit) return text;
  return text.slice(0, Math.max(1, limit - 1)) + "…";
}

function button({ id, label, data, visited, style = 1 }) {
  return {
    id,
    render_data: {
      label: cut(label, MAX_LABEL),
      visited_label: cut(visited || label, MAX_LABEL),
      style,
    },
    action: {
      type: 1, // callback; URL and command buttons are not useful for approvals
      permission: { type: 2 }, // everyone; the driver checks the actor server-side
      data,
      unsupport_tips: "请升级 QQ 后重试",
    },
  };
}

function keyboard(rows) {
  return { content: { rows: rows.map((buttons) => ({ buttons })) } };
}

function summarizeArgs(args) {
  if (args == null) return "";
  if (typeof args === "string") return cut(args, 80);
  try {
    return cut(JSON.stringify(args), 120);
  } catch (_) {
    return cut(String(args), 120);
  }
}

/** Approval card: allow once / deny / details (details is a plain text hint). */
export function buildApprovalCard({ id, name, args, permission }) {
  const tool = name || "工具调用";
  const summary = summarizeArgs(args);
  const text = [
    `需要你确认：${tool}`,
    summary ? `参数：${summary}` : "",
    permission === "ask" ? "" : `权限：${permission}`,
  ]
    .filter(Boolean)
    .join("\n");

  return {
    text,
    keyboard: keyboard([
      [
        button({ id: "allow", label: "允许一次", data: `qq:a:${id}:approve`, visited: "已允许" }),
        button({ id: "deny", label: "拒绝", data: `qq:a:${id}:deny`, visited: "已拒绝" }),
      ],
    ]),
  };
}

/** A single-select question with up to five options becomes one button row. */
export function buildQuestionCard({ id, question }) {
  const options = Array.isArray(question.options) ? question.options.slice(0, MAX_OPTIONS) : [];
  const header = question.header ? `${question.header}\n` : "";
  const list = options.map((option, index) => `${index + 1}. ${option.label}`).join("\n");
  const text = `${header}${question.question}${list ? `\n\n${list}` : ""}`;

  if (!options.length) return { text, keyboard: null };
  return {
    text,
    keyboard: keyboard([
      options.map((option, index) =>
        button({
          id: `q_${index + 1}`,
          label: option.label,
          data: `qq:q:${id}:${encodeURIComponent(question.id)}:${index}`,
          visited: `已选：${option.label}`,
          })
      ),
    ]),
  };
}

/** Plan review: approve / reject / edit. Edit opens a text prompt in the bot. */
export function buildPlanReviewCard({ id, title, plan }) {
  const text = [`计划审批：${title || "Plan"}`, "", cut(plan, 1800)].join("\n");
  return {
    text,
    keyboard: keyboard([
      [
        button({ id: "approve", label: "批准", data: `qq:p:${id}:approve`, visited: "已批准" }),
        button({ id: "reject", label: "退回", data: `qq:p:${id}:reject`, visited: "已退回" }),
        button({ id: "edit", label: "我要修改", data: `qq:p:${id}:edit`, visited: "等待修改" }),
      ],
    ]),
  };
}

/**
 * Decode a button `data` value. Returns null for buttons this driver did not
 * create, so a stray callback can be acknowledged without touching core.
 *
 * @param {string} raw
 * @returns {null | {kind:"approval",id:number,decision:"approve"|"deny"} |
 *   {kind:"question",id:number,questionId:string,index:number} |
 *   {kind:"plan-review",id:number,action:"approve"|"reject"|"edit"}}
 */
export function parseButtonData(raw) {
  const parts = String(raw == null ? "" : raw).split(":");
  if (parts.length < 4 || parts[0] !== "qq") return null;

  const id = Number(parts[2]);
  if (!Number.isInteger(id) || id <= 0) return null;

  if (parts[1] === "a") {
    const decision = parts[3] === "approve" ? "approve" : parts[3] === "deny" ? "deny" : null;
    return decision ? { kind: "approval", id, decision } : null;
  }

  if (parts[1] === "q") {
    if (parts.length < 5) return null;
    const index = Number(parts[4]);
    if (!Number.isInteger(index) || index < 0) return null;
    let questionId = "";
    try {
      questionId = decodeURIComponent(parts[3]);
    } catch (_) {
      return null;
    }
    return questionId ? { kind: "question", id, questionId, index } : null;
  }

  if (parts[1] === "p") {
    const action = parts[3];
    if (action !== "approve" && action !== "reject" && action !== "edit") return null;
    return { kind: "plan-review", id, action };
  }

  return null;
}

export const LIMITS = Object.freeze({ MAX_LABEL, MAX_OPTIONS });
