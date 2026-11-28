import test from "node:test";
import assert from "node:assert/strict";
import {
  channelEnv,
  channelServiceMode,
  channelServiceEndpoint,
} from "../../lib/channel-service/mode.js";

const yunhu = { id: "ami-yunhu", instanceId: "ami-yunhu", type: "yunhu", options: { mode: "ws" } };
const qq = { id: "alice-qq", instanceId: "alice-qq", type: "qq", options: {} };

test("embedded is the default for non-QQ drivers", () => {
  assert.equal(channelServiceMode(yunhu, { CHANNEL_SERVICE_ENDPOINT: "http://q:1" }), "embedded");
  assert.equal(channelServiceEndpoint(yunhu, { CHANNEL_SERVICE_ENDPOINT: "http://q:1" }), "");
});

test("explicit service mode needs an instance endpoint", () => {
  const service = { ...yunhu, options: { ...yunhu.options, serviceMode: "service" } };
  assert.equal(channelServiceMode(service, {}), "service");
  assert.equal(channelServiceEndpoint(service, {}), "");
  assert.equal(
    channelServiceEndpoint(service, { CHANNEL_AMI_YUNHU_SERVICE_ENDPOINT: "http://127.0.0.1:18767/" }),
    "http://127.0.0.1:18767/",
  );
  assert.equal(
    channelServiceEndpoint(
      { ...yunhu, options: { serviceMode: "service", serviceEndpoint: "http://127.0.0.1:1" } },
      {},
    ),
    "http://127.0.0.1:1",
  );
});

test("QQ keeps the legacy global endpoint and can opt back into embedded", () => {
  const env = { CHANNEL_SERVICE_ENDPOINT: "http://127.0.0.1:18080" };
  assert.equal(channelServiceMode(qq, env), "service");
  assert.equal(channelServiceEndpoint(qq, env), "http://127.0.0.1:18080");
  assert.equal(channelServiceMode({ ...qq, options: { serviceMode: "embedded" } }, env), "embedded");
  assert.equal(channelEnv("ami-yunhu", "SERVICE_PORT"), "CHANNEL_AMI_YUNHU_SERVICE_PORT");
});

test("microservice is an alias for service", () => {
  assert.equal(channelServiceMode({ ...yunhu, options: { serviceMode: "microservice" } }, {}), "service");
});
