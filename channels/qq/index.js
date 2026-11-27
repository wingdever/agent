"use strict";

// QQ 官方机器人 driver.
//
// Third driver in the slot, and the first one where the credential rotates: appid
// + appsecret are exchanged for an access token with a lifetime, so
// accounts/auth's refresh path does real work instead of being a no-op.
//
// Why the official bot and not OneBot: the platform offers WebSocket delivery
// ("不依赖公网服务器部署"), so no public endpoint is needed, and a bot account
// cannot get banned for protocol abuse the way a personal QQ account can.
//
// Verified live (appid 1906507317): token exchange, `GET /gateway/bot`
// {"url":"wss://api.sgroup.qq.com/websocket","shards":1}, identify, and
// READY {"user":{"id":"10880449181683288941","username":"alice","bot":true}}.
//
// Cards: QQ has no free-form card. A button is a `keyboard` attached to a
// Markdown message, max 5x5. The click arrives as INTERACTION_CREATE on the
// same socket and must be acknowledged with PUT /interactions/{id}; it is not
// a new user message, so it never starts a turn.

import { createQqApi, createQqAuth, DEFAULT_API_BASE } from "./api.js";
import { createQqGateway, INTENTS } from "./gateway.js";
import { parseDispatch, parseInteraction } from "./events.js";
import {
  buildApprovalCard,
  buildPlanReviewCard,
  buildQuestionCard,
  parseButtonData,
} from "./cards.js";

export const type = "qq";

function actorKey(kind, id) {
  return `${kind === "plan-review" ? "p" : kind === "question" ? "q" : "a"}:${id}`;
}

function waitKey(conversationKey, senderId) {
  return `${conversationKey}|${senderId}`;
}

export function createChannel({ instance = {}, deps = {} } = {}) {
  const options = instance.options || {};
  const credentials = instance.credentials || {};
  const instanceId = instance.id || "qq";
  const appId = String(credentials.appId || "");
  const appSecret = String(credentials.appSecret || "");
  const botId = String(credentials.botId || "");

  // Constructing a driver must not require credentials: a bot that is configured
  // but not connected is a legitimate boot state, and check() is what reports the
  // gap at start time. Placeholders only exist so construction cannot throw.
  const auth = deps.auth || createQqAuth({ appId: appId || "missing-appid", appSecret: appSecret || "missing-secret", fetchImpl: deps.fetch, now: deps.now });
  const api = createQqApi({
    auth,
    baseUrl: options.apiBaseUrl || DEFAULT_API_BASE,
    fetchImpl: deps.fetch,
    qps: options.qps,
  });

  let gateway = null;
  let interactionHandler = async () => {};
  /** platform interaction key -> {conversationKey, senderId} */
  const pendingActors = new Map();
  /** question interaction key -> {questions, answers, needsWeb} */
  const questionBatches = new Map();
  /** question/plan text follow-up: conversation|sender -> wait record */
  const textWaits = new Map();
  /** inbound message id -> number of replies already sent */
  const replySeq = new Map();

  const capabilities = {
    eventMode: "ws",
    // Nobody waits for an ack on a socket; the field is nominal, like yunhu's.
    ackDeadlineMs: 5000,
    maxTextBytes: options.maxTextBytes || 4000,
    outboundQps: options.qps || 3,
    // QQ has no edit-message endpoint for bot messages: one answer per inbound,
    // so streaming degrades to "send the final text once".
    streaming: false,
    // Approval cards are actionable, so a supervised channel turn can wait for
    // a click instead of auto-denying every `ask` tool.
    canPromptUser: true,
    canAttachFiles: true,
  };

  function targetFor(message) {
    return message.recvType === "group"
      ? { groupOpenId: message.conversationKey }
      : { userOpenId: message.senderId };
  }

  function nextSeq(message) {
    const key = String(message.replyTo || message.eventId || message.conversationKey || "");
    const seq = (replySeq.get(key) || 0) + 1;
    replySeq.set(key, seq);
    return { key, seq };
  }

  function replyFields(message) {
    const { key, seq } = nextSeq(message);
    // The platform rejects the same msg_id + msg_seq twice. After five replies
    // the passive quota for one inbound message is exhausted; leave msg_id out
    // and let the active-message quota decide.
    return seq <= 5
      ? { key, msgId: message.replyTo, msgSeq: seq }
      : { key, msgId: undefined, msgSeq: undefined };
  }

  async function sendCard(message, card) {
    const { msgId, msgSeq } = replyFields(message);
    return api.sendMessage({
      ...targetFor(message),
      content: card.text,
      msgType: 2,
      markdown: { content: card.text },
      keyboard: card.keyboard,
      msgId,
      msgSeq,
    });
  }

  async function sendText(message, text) {
    const { msgId, msgSeq } = replyFields(message);
    return api.sendMessage({ ...targetFor(message), content: text, msgId, msgSeq });
  }

  async function ack(interaction, code) {
    try {
      await api.ackInteraction(interaction.interactionId, code);
      return true;
    } catch (err) {
      if (deps.onError) deps.onError(err);
      return false;
    }
  }

  async function handleInteraction(interaction) {
    const parsed = parseButtonData(interaction.buttonData);
    if (!parsed) {
      await ack(interaction, 1);
      return;
    }

    const key = actorKey(parsed.kind, parsed.id);
    const actor = pendingActors.get(key);
    if (!actor) {
      // A callback after a restart, or for an id this process never issued.
      // Acking success would make core silently do nothing; 4 gives the clicker
      // a visible "no permission" toast.
      await ack(interaction, 4);
      return;
    }
    if (actor.conversationKey !== interaction.conversationKey || actor.senderId !== interaction.senderId) {
      // Ack with "no permission" so the clicking user gets a toast instead of
      // an endless spinner. A group member must not answer someone else's
      // approval.
      await ack(interaction, 4);
      return;
    }

    if (parsed.kind === "approval") {
      await ack(interaction, 0);
      pendingActors.delete(key);
      await interactionHandler({
        kind: "approval",
        id: parsed.id,
        decision: parsed.decision,
        conversationKey: interaction.conversationKey,
        senderId: interaction.senderId,
        eventId: interaction.eventId,
      });
      return;
    }

    if (parsed.kind === "question") {
      const batch = questionBatches.get(key);
      const question = batch && batch.questions.find((q) => q && q.id === parsed.questionId);
      const option = question && Array.isArray(question.options) ? question.options[parsed.index] : null;
      if (!batch || !question || !option) {
        await ack(interaction, 1);
        return;
      }
      await ack(interaction, 0);
      batch.answers.set(question.id, { id: question.id, selected: [option.label] });
      if (batch.needsWeb || batch.answers.size < batch.questions.length) return;

      questionBatches.delete(key);
      pendingActors.delete(key);
      await interactionHandler({
        kind: "question",
        id: parsed.id,
        answers: [...batch.answers.values()],
        conversationKey: interaction.conversationKey,
        senderId: interaction.senderId,
        eventId: interaction.eventId,
      });
      return;
    }

    if (parsed.kind === "plan-review") {
      await ack(interaction, 0);
      if (parsed.action === "edit") {
        // Keep the pending actor: the next text from this person is the feedback
        // for the same plan review.
        textWaits.set(waitKey(interaction.conversationKey, interaction.senderId), {
          kind: "plan-review",
          id: parsed.id,
        });
        await api.sendMessage({
          groupOpenId: interaction.recvType === "group" ? interaction.conversationKey : undefined,
          userOpenId: interaction.recvType === "group" ? undefined : interaction.conversationKey,
          content: "请直接回复修改意见；回复后我会把意见带回计划审批。",
          eventId: interaction.eventId,
        });
        return;
      }

      pendingActors.delete(key);
      await interactionHandler({
        kind: "plan-review",
        id: parsed.id,
        approved: parsed.action === "approve",
        feedback: "",
        conversationKey: interaction.conversationKey,
        senderId: interaction.senderId,
        eventId: interaction.eventId,
      });
    }
  }

  async function handleTextWait(message) {
    const text = String((message.messages && message.messages[0] && message.messages[0].content) || "").trim();
    if (!text) return false;
    const key = waitKey(message.conversationKey, message.senderId);
    const wait = textWaits.get(key);
    if (!wait) return false;

    textWaits.delete(key);
    if (wait.kind === "plan-review") {
      pendingActors.delete(actorKey("plan-review", wait.id));
      await interactionHandler({
        kind: "plan-review",
        id: wait.id,
        approved: false,
        feedback: text,
        conversationKey: message.conversationKey,
        senderId: message.senderId,
        eventId: message.eventId,
      });
      return true;
    }
    if (wait.kind === "question") {
      questionBatches.delete(actorKey("question", wait.id));
      pendingActors.delete(actorKey("question", wait.id));
      await interactionHandler({
        kind: "question",
        id: wait.id,
        answers: [{ id: wait.questionId, selected: [], custom: text }],
        conversationKey: message.conversationKey,
        senderId: message.senderId,
        eventId: message.eventId,
      });
      return true;
    }
    return false;
  }

  const channel = {
    type,
    instanceId,
    capabilities,
    auth,

    check() {
      const problems = [];
      const env = (field) => `CHANNEL_${String(instanceId).toUpperCase().replace(/[^A-Z0-9]/g, "_")}_${field}`;
      if (!appId) problems.push(`credentials.appId is missing (or ${env("APPID")})`);
      if (!appSecret) problems.push(`credentials.appSecret is missing (or ${env("APPSECRET")})`);
      return problems;
    },

    async start(onMessage, onInteraction = async () => {}) {
      if (typeof onMessage !== "function") throw new TypeError("start requires an onMessage handler");
      if (typeof onInteraction !== "function") throw new TypeError("start onInteraction must be a function");
      if (gateway) throw new Error("qq channel is already started");

      const problems = this.check();
      if (problems.length) throw new Error(`channel "${instanceId}" cannot start: ${problems.join("; ")}`);

      interactionHandler = onInteraction;
      gateway = createQqGateway({
        auth,
        call: api.call,
        dial: deps.dial,
        intents: options.intents || (INTENTS.GROUP_AND_C2C | INTENTS.INTERACTION),
        onError: deps.onError,
        schedule: deps.schedule,
        setIntervalImpl: deps.setInterval,
        clearIntervalImpl: deps.clearInterval,
        onDispatch: (frame) => {
          const interaction = parseInteraction(frame, { type, instanceId });
          if (interaction) {
            handleInteraction(interaction).catch((err) => deps.onError && deps.onError(err));
            return;
          }

          const message = parseDispatch(frame, { type, instanceId, botId });
          if (!message) return;
          // A plain text reply can be the answer to a free-text question or a
          // plan's "edit" branch. Consume it before the normal turn path.
          handleTextWait(message)
            .then((consumed) => {
              if (!consumed) onMessage(message);
            })
            .catch((err) => deps.onError && deps.onError(err));
        },
      });

      try {
        await gateway.connect();
      } catch (err) {
        gateway = null;
        throw err;
      }
    },

    /** Turn event stream -> one text answer, or one button card per interaction. */
    async project(message, event) {
      const kind = event && event.type;
      if (kind === "token") return; // no edit endpoint: partial text would be a second message

      if (kind === "approval-request" && event.id != null) {
        const id = Number(event.id);
        if (!Number.isInteger(id) || id <= 0) return;
        pendingActors.set(actorKey("approval", id), {
          conversationKey: message.conversationKey,
          senderId: message.senderId,
        });
        await sendCard(message, buildApprovalCard({
          id,
          name: event.name,
          args: event.arguments,
          permission: event.permission,
        }));
        return;
      }

      if (kind === "ask-user-question" && event.id != null) {
        const id = Number(event.id);
        if (!Number.isInteger(id) || id <= 0) return;
        const questions = Array.isArray(event.questions) ? event.questions : [];
        if (!questions.length) return;

        const key = actorKey("question", id);
        const batch = { questions, answers: new Map(), needsWeb: false };
        questionBatches.set(key, batch);
        pendingActors.set(key, {
          conversationKey: message.conversationKey,
          senderId: message.senderId,
        });

        for (const question of questions) {
          const answerable =
            Array.isArray(question.options) &&
            question.options.length > 0 &&
            question.options.length <= 5 &&
            question.multi_select !== true;
          if (answerable) {
            await sendCard(message, buildQuestionCard({ id, question }));
            continue;
          }

          batch.needsWeb = true;
          if (questions.length === 1) {
            // A single free-text question can be answered by a plain reply.
            await sendText(message, `${question.header ? question.header + "\n" : ""}${question.question}\n\n请直接回复你的答案。`);
            textWaits.set(waitKey(message.conversationKey, message.senderId), {
              kind: "question",
              id,
              questionId: question.id,
            });
          }
        }
        if (batch.needsWeb && questions.length > 1) {
          await sendText(message, "其中部分问题需要文本或多选，请在 Web 端完成；其余选项可直接点按钮。");
        }
        return;
      }

      if (kind === "plan-review" && event.id != null) {
        const id = Number(event.id);
        if (!Number.isInteger(id) || id <= 0) return;
        pendingActors.set(actorKey("plan-review", id), {
          conversationKey: message.conversationKey,
          senderId: message.senderId,
        });
        await sendCard(message, buildPlanReviewCard({
          id,
          title: event.title,
          plan: event.plan,
        }));
        return;
      }

      if (kind !== "final" && kind !== "done" && kind !== "error") return;

      const text =
        kind === "error"
          ? `⚠️ 这轮没有跑完：${(event && (event.message || event.kind)) || "unknown error"}`
          : String((event && (event.content || (event.message && event.message.content))) || "").trim();
      if (!text) return;

      const reply = replyFields(message);
      await api.sendMessage({
        ...targetFor(message),
        content: text,
        msgId: reply.msgId,
        msgSeq: reply.msgSeq,
      });
      replySeq.delete(reply.key);
    },

    async stop() {
      if (gateway) await gateway.close();
      gateway = null;
      interactionHandler = async () => {};
      pendingActors.clear();
      questionBatches.clear();
      textWaits.clear();
      replySeq.clear();
    },

    get stats() {
      return gateway ? { mode: "ws", ...gateway.stats } : { mode: "ws", connects: 0, dispatches: 0 };
    },
    get api() {
      return api;
    },
    get gateway() {
      return gateway;
    },
  };

  return channel;
}
