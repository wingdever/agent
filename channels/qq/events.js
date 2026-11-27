"use strict";

// QQ dispatch -> the channel's neutral message shape.
//
// Group visibility is the platform's decision, not ours:
//   GROUP_AT_MESSAGE_CREATE   someone @-mentioned the bot (content already has the
//                             mention stripped, per the official event doc)
//   GROUP_MESSAGE_CREATE      every group message -- only delivered when the group
//                             owner allowed the bot to see them all
// So the mention gate that yunhu needed is unnecessary here; what still matters is
// skipping the bot's own messages and payloads that carry neither text nor an
// attachment. Attachments are not decoration: a group file arrives as a message
// attachment (`content_type: "file"`), and there is no group-file API at all, so
// this is the only door those files come through.

export const MESSAGE_EVENTS = ["GROUP_AT_MESSAGE_CREATE", "GROUP_MESSAGE_CREATE", "C2C_MESSAGE_CREATE"];

/**
 * @param {{t: string, d: Object}} frame a gateway dispatch frame
 * @param {{type?: string, instanceId?: string, botId?: string}} [context]
 */
export function parseDispatch(frame, { type = "qq", instanceId = "", botId = "" } = {}) {
  if (!frame || !MESSAGE_EVENTS.includes(frame.t)) return null;
  const d = frame.d || {};

  const author = d.author || {};
  // A bot that answers itself is a loop with real cost.
  if (botId && String(author.id || author.user_openid || "") === String(botId)) return null;
  if (author.bot) return null;

  const text = String(d.content || "").trim();
  const attachments = normalizeAttachments(d.attachments);
  // Empty text with an attachment is a real message (a photo with no caption, a
  // pasted file); empty text with nothing is not.
  if (!text && !attachments.length) return null;

  const groupOpenId = String(d.group_openid || "");
  const senderId = String(author.member_openid || author.id || author.user_openid || "");
  const conversationKey = groupOpenId || String(author.user_openid || author.id || "");
  if (!conversationKey) return null;

  return {
    type,
    instanceId,
    conversationKey,
    eventId: String(d.id || ""),
    senderId,
    recvType: groupOpenId ? "group" : "user",
    // QQ replies are passive: the answer must quote the id of the message it
    // answers, otherwise it counts against the active-push quota.
    replyTo: String(d.id || ""),
    mentioned: frame.t === "GROUP_AT_MESSAGE_CREATE",
    // The model never sees `attachments` directly -- whatever builds the prompt
    // reads `messages` -- so describe them inline, and keep the structured copy
    // (url, mime, size) beside it for anything that wants to download.
    messages: [{ role: "user", content: [text, ...attachments.map(describeAttachment)].filter(Boolean).join("\n") }],
    attachments,
    raw: { event: frame.t, id: d.id, groupOpenId, senderId },
  };
}

/**
 * Normalize the platform's `MessageAttachment` list.
 * Field names are re-mapped once here so nothing downstream has to know that
 * `content_type` is a MIME type except for the string literal "file"/"voice".
 */
export function normalizeAttachments(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((a) => a && a.url)
    .map((a) => {
      const contentType = String(a.content_type || "");
      return {
        url: String(a.url),
        name: String(a.filename || attachmentName(contentType)),
        contentType,
        size: Number(a.size) || 0,
        width: Number(a.width) || 0,
        height: Number(a.height) || 0,
        // Voice messages are SILK; the platform hands us a transcoded WAV too.
        voiceUrl: a.voice_wav_url ? String(a.voice_wav_url) : "",
        kind: attachmentKind(contentType),
      };
    });
}

function attachmentKind(contentType) {
  if (contentType === "file") return "file";
  if (contentType === "voice") return "voice";
  if (contentType.startsWith("image/")) return "image";
  if (contentType.startsWith("video/")) return "video";
  if (contentType) return "other";
  return "unknown";
}

function attachmentName(contentType) {
  const kind = attachmentKind(contentType);
  return kind === "file" ? "attachment" : kind;
}

function humanSize(bytes) {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1048576).toFixed(1)}MB`;
}

/** One line per attachment, deliberately without the signed URL (it is long,
 *  expires, and would dominate the prompt). */
export function describeAttachment(a) {
  const size = humanSize(a.size);
  const dims = a.width && a.height ? ` ${a.width}x${a.height}` : "";
  const type = a.contentType && a.contentType !== "file" ? a.contentType : "file";
  return `[attachment] ${a.name} (${type}${dims}${size ? ", " + size : ""})`;
}

/**
 * Normalize a message-button callback.
 *
 * QQ delivers it on the same gateway as messages (`INTERACTION_CREATE`), but it
 * is not a user message: it must be acknowledged and routed back into the
 * pending interaction, never turned into a fresh turn.
 *
 * @param {{t: string, d: Object}} frame
 * @param {{type?: string, instanceId?: string}} [context]
 */
export function parseInteraction(frame, { type = "qq", instanceId = "" } = {}) {
  if (!frame || frame.t !== "INTERACTION_CREATE") return null;
  const d = frame.d || {};
  if (Number(d.type) !== 11) return null; // 11 = inline keyboard callback

  const resolved = (d.data && d.data.resolved) || {};
  const buttonData = String(resolved.button_data || "");
  if (!buttonData) return null;

  const groupOpenId = String(d.group_openid || "");
  const userOpenId = String(d.user_openid || "");
  const conversationKey = groupOpenId || userOpenId;
  if (!conversationKey) return null;

  return {
    type,
    instanceId,
    conversationKey,
    eventId: String(d.id || ""),
    interactionId: String(d.id || ""),
    buttonId: String(resolved.button_id || ""),
    buttonData,
    senderId: String(d.group_member_openid || d.user_openid || ""),
    recvType: groupOpenId ? "group" : "user",
    scene: String(d.scene || ""),
    raw: { event: frame.t, id: d.id, groupOpenId, senderId: String(d.group_member_openid || d.user_openid || "") },
  };
}

/** Kept for callers that only want the download URLs. */
export function attachmentUrls(dispatchFrame) {
  const d = (dispatchFrame && dispatchFrame.d) || {};
  return Array.isArray(d.attachments) ? d.attachments.map((a) => a && a.url).filter(Boolean) : [];
}
