"use strict";

import test from "node:test";
import assert from "node:assert/strict";

import { createChannelCallback } from "../../channels/callback.js";
import { createChannelHistory } from "../../lib/channel-history/index.js";
import { createMemoryAdapter } from "../../lib/channel-history/adapters.js";
import channelSendNode from "../../core/loops/nodes/channel-send/run.js";

const projects = [];
function fakeChannel() {
  return {
    type: "qq",
    instanceId: "qq-bot",
    async project(message, event) {
      projects.push({ message, event });
    },
  };
}

test("channel-send node reaches /proactive, which sends to QQ and records outbound history", async () => {
  projects.length = 0;
  const history = createChannelHistory({ db: createMemoryAdapter() });
  let outboundSeq = 0;
  const service = createChannelCallback({
    lookupChannel: () => fakeChannel(),
    getPending: (i) => history.getPending(i),
    onReplay: (msgs) => history.markDelivered(msgs.map((m) => m.eventId)),
    onDeliver: async (payload) => {
      outboundSeq += 1;
      const eventId = `out:${Date.now()}:${outboundSeq}`;
      await history.appendOutbound({
        eventId,
        instanceId: payload.instanceId,
        conversationKey: payload.conversationKey,
        direction: "outbound",
        messages: [{ role: "assistant", content: payload.text }],
      });
    },
    log: () => {},
  });
  const addr = await service.listen();
  try {
    const events = [];
    const ctx = {
      channelDelivery: {
        endpoint: addr.url,
        instanceId: "qq-bot",
        conversationKey: "G1",
        recvType: "group",
      },
      step: { response: { content: "你好，我是机器人" } },
      emit: (e) => events.push(e),
      fetchImpl: globalThis.fetch,
    };
    const result = await channelSendNode({}, ctx);
    assert.equal(result.next, "decide-next");
    assert.equal(projects.length, 1, "QQ send happened");
    assert.equal(projects[0].event.content, "你好，我是机器人");
    assert.deepEqual(events.map((e) => e.phase), ["start", "done"]);

    const pending = await history.getPending("qq-bot");
    assert.deepEqual(pending, [], "outbound not replayed as inbound");
    const rows = await history.forConversation("qq-bot", "G1");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].messages[0].content, "你好，我是机器人");
  } finally {
    await service.close();
  }
});
