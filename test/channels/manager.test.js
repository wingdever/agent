"use strict";

import test from "node:test";
import assert from "assert/strict";

import { createChannelManager } from "../../channels/manager.js";
import { createChannel as createFakeChannel } from "../../channels/fake/index.js";

function message(overrides = {}) {
  return {
    type: "fake",
    instanceId: "bot",
    conversationKey: "chat-1",
    eventId: "evt-1",
    senderId: "user-1",
    messages: [{ role: "user", content: "hello" }],
    ...overrides,
  };
}

/** A sink that records turns and replays one final event per turn. */
function createSink() {
  const turns = [];
  return {
    turns,
    async runTurn(inbound, emit) {
      turns.push(inbound.messages[0].content);
      emit({ type: "final", content: `echo: ${inbound.messages[0].content}` });
    },
  };
}

test("channels are built but never started on their own", () => {
  const fake = createFakeChannel({ instance: { id: "bot" } });
  const manager = createChannelManager({ channels: [fake] });

  assert.equal(fake.started, false);
  const [entry] = manager.list();
  assert.equal(entry.instanceId, "bot");
  assert.equal(entry.type, "fake");
  assert.equal(entry.status, "stopped");
  assert.equal(entry.eventMode, "ws");
});

test("start opens the channel and an inbound message reaches the sink and projects", async () => {
  const fake = createFakeChannel({ instance: { id: "bot" } });
  const manager = createChannelManager({ channels: [fake] });
  manager.setSink(createSink());

  const started = await manager.start("bot");
  assert.equal(started.status, "running");
  assert.equal(fake.started, true);

  await fake.inject(message());
  // Projection is awaited by the pipeline, but injection only waits for the ack.
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.equal(manager.status("bot").deliveries, 1);
  assert.deepEqual(fake.projections.map((entry) => entry.event.type), ["final"]);
  assert.equal(fake.projections[0].event.content, "echo: hello");
});

test("a re-delivered event id runs one turn, not two", async () => {
  const fake = createFakeChannel({ instance: { id: "bot" } });
  const manager = createChannelManager({ channels: [fake] });
  const sink = createSink();
  manager.setSink(sink);
  await manager.start("bot");
  await fake.inject(message({ eventId: "evt-dup" }));
  await fake.inject(message({ eventId: "evt-dup" }));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(sink.turns.length, 1);
});

test("starting twice does not open a second connection", async () => {
  let starts = 0;
  const fake = createFakeChannel({ instance: { id: "bot" } });
  const originalStart = fake.start;
  fake.start = async (handler) => {
    starts++;
    return originalStart(handler);
  };
  const manager = createChannelManager({ channels: [fake] });
  manager.setSink(createSink());

  const [a, b] = await Promise.all([manager.start("bot"), manager.start("bot")]);
  assert.equal(starts, 1);
  assert.equal(a.status, "running");
  assert.equal(b.status, "running");
  // A later third call is also a no-op.
  const third = await manager.start("bot");
  assert.equal(third.status, "running");
  assert.equal(starts, 1);
});

test("stop closes the channel and later messages stop arriving", async () => {
  const fake = createFakeChannel({ instance: { id: "bot" } });
  const manager = createChannelManager({ channels: [fake] });
  const sink = createSink();
  manager.setSink(sink);
  await manager.start("bot");
  await fake.inject(message({ eventId: "evt-a" }));
  await new Promise((resolve) => setTimeout(resolve, 30));

  const stopped = await manager.stop("bot");
  assert.equal(stopped.status, "stopped");
  assert.equal(fake.started, false);
  await assert.rejects(fake.inject(message({ eventId: "evt-b" })), /not started/);
});

test("a stop that arrives mid-start still leaves the channel closed", async () => {
  let releaseStart;
  const started = new Promise((resolve) => { releaseStart = resolve; });
  const fake = createFakeChannel({ instance: { id: "bot" } });
  const originalStart = fake.start;
  fake.start = async (handler) => {
    await started;
    return originalStart(handler);
  };
  const manager = createChannelManager({ channels: [fake] });
  manager.setSink(createSink());

  const starting = manager.start("bot");
  const stopping = manager.stop("bot");
  releaseStart();
  await starting;
  const result = await stopping;

  assert.equal(result.status, "stopped");
  assert.equal(fake.started, false);
});

test("start without a sink, an unknown channel and a driver failure are all explicit errors", async () => {
  const manager = createChannelManager({ channels: [createFakeChannel({ instance: { id: "bot" } })] });
  await assert.rejects(manager.start("bot"), /before a sink is attached/);
  await assert.rejects(manager.start("nope"), /unknown channel "nope"/);

  const broken = createFakeChannel({ instance: { id: "broken" } });
  broken.start = async () => {
    throw new Error("connection refused");
  };
  const withSink = createChannelManager({ channels: [broken] });
  withSink.setSink(createSink());
  await assert.rejects(withSink.start("broken"), /failed to start: connection refused/);
  const entry = withSink.status("broken");
  assert.equal(entry.status, "error");
  assert.equal(entry.error, "connection refused");
});

test("a failed channel still reports a terminal error to the caller and can be retried", async () => {
  const fake = createFakeChannel({ instance: { id: "bot" } });
  let attempt = 0;
  const manager = createChannelManager({
    channels: [fake],
    dedupeFactory: () => ({ claim: () => true }),
  });
  manager.setSink({
    async runTurn() {
      attempt++;
      throw new Error("provider down");
    },
  });
  await manager.start("bot");
  await fake.inject(message({ eventId: "evt-err" }));
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.equal(attempt, 1);
  // A failed turn must still end the card, otherwise the user sees "typing…" forever.
  const events = fake.projections.map((entry) => entry.event.type);
  assert.deepEqual(events, ["error"]);
  assert.equal(manager.status("bot").status, "running");
});

test("a channel that declares missing credentials is refused at start, and retried after they appear", async () => {
  const fake = createFakeChannel({ instance: { id: "bot" } });
  let problems = ["credentials.appSecret is missing"];
  fake.check = () => problems;
  const manager = createChannelManager({ channels: [fake] });
  manager.setSink(createSink());

  await assert.rejects(manager.start("bot"), /channel "bot" cannot start: credentials\.appSecret is missing/);
  assert.equal(fake.started, false, "preflight must refuse before the driver connects");
  assert.equal(manager.status("bot").status, "error");

  problems = [];
  const retried = await manager.start("bot");
  assert.equal(retried.status, "running");
  assert.equal(fake.started, true);
});

test("stopAll closes whatever is running and leaves stopped channels alone", async () => {
  const a = createFakeChannel({ instance: { id: "a" } });
  const b = createFakeChannel({ instance: { id: "b" } });
  const manager = createChannelManager({ channels: [a, b] });
  manager.setSink(createSink());
  await manager.start("a");

  await manager.stopAll();
  assert.equal(a.started, false);
  assert.equal(b.started, false);
  assert.deepEqual(manager.list().map((entry) => entry.status), ["stopped", "stopped"]);
});

test("preflight is asked only when a start is requested, never at construction", async () => {
  const fake = createFakeChannel({ instance: { id: "bot" } });
  let checks = 0;
  fake.check = () => {
    checks++;
    return [];
  };
  const manager = createChannelManager({ channels: [fake] });
  manager.setSink(createSink());
  assert.equal(checks, 0, "building a manager must not validate credentials");
  await manager.start("bot");
  assert.equal(checks, 1);
});

test("duplicate instance ids are refused at construction", () => {
  const one = createFakeChannel({ instance: { id: "same" } });
  const two = createFakeChannel({ instance: { id: "same" } });
  assert.throws(() => createChannelManager({ channels: [one, two] }), /duplicate instance "same"/);
});
