"use strict";

import test from "node:test";
import assert from "assert/strict";

import { createChannelManager } from "../../channels/manager.js";
import { createChannel as createFakeChannel } from "../../channels/fake/index.js";
import { acquireChannelLock } from "../../lib/channel-lock.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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

test("publish hook receives accepted inbound messages", async () => {
  const fake = createFakeChannel({ instance: { id: "bot" } });
  const published = [];
  const manager = createChannelManager({
    channels: [fake],
    publish: (m) => published.push(m.eventId),
  });
  manager.setSink(createSink());
  await manager.start("bot");

  await fake.inject(message({ eventId: "evt-pub-1" }));
  await fake.inject(message({ eventId: "evt-pub-2" }));
  await manager.idle();
  assert.deepEqual(published, ["evt-pub-1", "evt-pub-2"]);
  await manager.stopAll();
});

test("publish hook skips duplicate eventIds", async () => {
  const fake = createFakeChannel({ instance: { id: "bot" } });
  const published = [];
  const manager = createChannelManager({
    channels: [fake],
    publish: (m) => published.push(m.eventId),
  });
  manager.setSink(createSink());
  await manager.start("bot");

  await fake.inject(message({ eventId: "evt-dup-pub" }));
  await fake.inject(message({ eventId: "evt-dup-pub" }));
  await manager.idle();
  assert.deepEqual(published, ["evt-dup-pub"]);
  await manager.stopAll();
});

test("without a sink the service still dedupes and publishes inbound messages", async () => {
  const fake = createFakeChannel({ instance: { id: "bot" } });
  const published = [];
  const manager = createChannelManager({
    channels: [fake],
    publish: (m) => published.push(m.eventId),
  });
  assert.equal((await manager.start("bot")).status, "running");
  await fake.inject(message({ eventId: "standalone-1" }));
  await fake.inject(message({ eventId: "standalone-1" }));
  await manager.idle();
  assert.deepEqual(published, ["standalone-1"], "no sink, no turn, dedupe still works");
  assert.equal(manager.status("bot").turns, 0);
  await manager.stopAll();
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

test("an unknown channel and a driver failure are explicit errors", async () => {
  const manager = createChannelManager({ channels: [createFakeChannel({ instance: { id: "bot" } })] });
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

test("subscribe sends the roster immediately, then a full snapshot on every status change", async () => {
  const fake = createFakeChannel({ instance: { id: "bot" } });
  const manager = createChannelManager({ channels: [fake], sink: createSink() });
  const snapshots = [];
  const unsubscribe = manager.subscribe((rows) => snapshots.push(rows));

  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0][0].status, "stopped");

  await manager.start("bot");
  assert.equal(snapshots[snapshots.length - 1][0].status, "running");
  await manager.stop("bot");
  assert.equal(snapshots[snapshots.length - 1][0].status, "stopped");

  const before = snapshots.length;
  unsubscribe();
  await manager.start("bot");
  assert.equal(snapshots.length, before);
});

test("a button callback goes to the sink's interact, not into a turn, and duplicates are dropped", async () => {
  const fake = createFakeChannel({ instance: { id: "bot" } });
  const manager = createChannelManager({ channels: [fake] });
  const interactions = [];
  manager.setSink({
    async runTurn() {},
    async interact(interaction) {
      interactions.push(interaction);
    },
  });
  await manager.start("bot");

  await fake.injectInteraction({ kind: "approval", id: 1, decision: "approve", eventId: "int-1" });
  await fake.injectInteraction({ kind: "approval", id: 1, decision: "approve", eventId: "int-1" });
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(interactions.length, 1);
  assert.equal(interactions[0].id, 1);
  assert.equal(manager.status("bot").interactions, 1);
  // A callback is not a message: no turn was opened.
  assert.equal(manager.status("bot").turns, 0);
});

test("the sink receives the channel instance so it can choose supervised vs autonomous", async () => {
  const fake = createFakeChannel({ instance: { id: "bot" } });
  const manager = createChannelManager({ channels: [fake] });
  let seen = null;
  manager.setSink({
    async runTurn(_message, _emit, context) {
      seen = context;
    },
  });
  await manager.start("bot");
  await fake.inject(message({ eventId: "ctx" }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(seen.channel.type, "fake");
  assert.equal(seen.channel.capabilities.canPromptUser, false);
});

test("a standalone interaction publisher receives button callbacks without a sink", async () => {
  const fake = createFakeChannel({ instance: { id: "bot" } });
  const interactions = [];
  const manager = createChannelManager({
    channels: [fake],
    publishInteraction: (i) => interactions.push(i),
  });
  await manager.start("bot");
  await fake.injectInteraction({ kind: "approval", id: 3, decision: "deny", eventId: "i3" });
  assert.equal(interactions.length, 1);
  assert.equal(interactions[0].id, 3);
  await manager.stopAll();
});

test("the instance lock prevents a second manager from opening the same channel", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "channel-lock-test-"));
  const lockFactory = (id) => acquireChannelLock(id, { dir });
  const a = createChannelManager({ channels: [createFakeChannel({ instance: { id: "bot" } })], lockFactory });
  const b = createChannelManager({ channels: [createFakeChannel({ instance: { id: "bot" } })], lockFactory });
  try {
    assert.equal((await a.start("bot")).status, "running");
    await assert.rejects(() => b.start("bot"), /already running/);
    assert.equal(b.status("bot").status, "error");
    await a.stopAll();
    assert.equal(fs.existsSync(path.join(dir, "run-bot.lock")), false);
    assert.equal((await b.start("bot")).status, "running", "lock is released after stop");
    await b.stopAll();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a service-mode instance is not startable in the local manager", async () => {
  const fake = createFakeChannel({ instance: { id: "svc" } });
  const manager = createChannelManager({ channels: [fake], externalServiceIds: ["svc"] });
  manager.setSink(createSink());
  await assert.rejects(manager.start("svc"), /standalone service/);
  assert.equal(fake.started, false);
  assert.equal(manager.status("svc").status, "stopped");
});
