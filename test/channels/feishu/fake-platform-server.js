"use strict";

// Stand-in for the feishu open platform, for tests and local runs without credentials.
//
// It speaks the three shapes the driver uses: token exchange, message create/patch,
// and an event long connection (plain JSON frames). Faults are switchable so the
// tests can exercise credential expiry and duplicate delivery the same way the real
// platform would produce them.
//
// No third-party dependency: Node 22 ships a WebSocket client, and the server side
// here is the ~60 lines of RFC 6455 needed for server-to-client text frames.

import crypto from "crypto";
import http from "http";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export const TOKEN_PATH = "/open-apis/auth/v3/tenant_access_token/internal";
export const MESSAGE_PATH = "/open-apis/im/v1/messages";

function encodeFrame(text) {
  const payload = Buffer.from(text, "utf8");
  if (payload.length < 126) {
    return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  }
  if (payload.length < 65536) {
    const header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
    return Buffer.concat([header, payload]);
  }
  const header = Buffer.alloc(10);
  header[0] = 0x81;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(payload.length), 2);
  return Buffer.concat([header, payload]);
}

function readJson(request) {
  return new Promise((resolve) => {
    let raw = "";
    request.on("data", (chunk) => {
      raw += chunk;
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(raw || "{}"));
      } catch (_) {
        resolve({});
      }
    });
  });
}

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(payload);
}

/**
 * @param {{appId?: string, appSecret?: string, token?: string}} [options]
 */
export function createFakeFeishuPlatform({ appId = "cli_test", appSecret = "test-secret", token = "tenant-token-1" } = {}) {
  const state = {
    tokenRequests: 0,
    rejectTokenNext: false,
    throttleNext: 0, // how many upcoming message sends answer with 230429
    sent: [],
    patches: [],
    sockets: new Set(),
    messageSeq: 0,
  };

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");

    if (request.method === "POST" && url.pathname === TOKEN_PATH) {
      const body = await readJson(request);
      state.tokenRequests++;
      if (state.rejectTokenNext) {
        state.rejectTokenNext = false;
        send(response, 200, { code: 99991663, msg: "invalid app_secret" });
        return;
      }
      if (body.app_id !== appId || body.app_secret !== appSecret) {
        send(response, 200, { code: 10014, msg: "bad credentials" });
        return;
      }
      send(response, 200, { code: 0, tenant_access_token: token, expire: 7200 });
      return;
    }

    if (request.method === "POST" && url.pathname === MESSAGE_PATH) {
      const body = await readJson(request);
      if (state.throttleNext > 0) {
        // Real platform shape: HTTP 200 with a non-zero code, which is why the
        // status-based classification alone would call this a hard refusal.
        state.throttleNext--;
        send(response, 200, { code: 230429, msg: "This operation triggers the frequency limit." });
        return;
      }
      state.messageSeq++;
      state.sent.push(body);
      send(response, 200, { code: 0, data: { message_id: `om_${state.messageSeq}` } });
      return;
    }

    if (request.method === "PATCH" && url.pathname.startsWith(MESSAGE_PATH + "/")) {
      const body = await readJson(request);
      state.patches.push({ messageId: url.pathname.split("/").pop(), content: body.content });
      send(response, 200, { code: 0, data: {} });
      return;
    }

    send(response, 404, { code: 404, msg: "not found" });
  });

  server.on("upgrade", (request, socket) => {
    const key = request.headers["sec-websocket-key"];
    const accept = crypto.createHash("sha1").update(key + WS_GUID).digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );
    state.sockets.add(socket);
    socket.on("data", (buffer) => {
      // Client close frame (opcode 0x8): acknowledge by ending the TCP channel.
      if (buffer.length && (buffer[0] & 0x0f) === 0x8) socket.end();
    });
    const drop = () => state.sockets.delete(socket);
    socket.on("close", drop);
    socket.on("error", drop);
  });

  let port = 0;

  return {
    state,
    get url() {
      return `http://127.0.0.1:${port}`;
    },
    get wsUrl() {
      return `ws://127.0.0.1:${port}/ws`;
    },
    async start() {
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      port = server.address().port;
      return this;
    },
    async stop() {
      for (const socket of state.sockets) socket.destroy();
      state.sockets.clear();
      await new Promise((resolve) => server.close(resolve));
    },
    /** Push one event envelope to every connected client. */
    deliver(envelope) {
      const frame = encodeFrame(JSON.stringify(envelope));
      for (const socket of state.sockets) socket.write(frame);
      return state.sockets.size;
    },
    async waitForSocket(timeoutMs = 3000) {
      return this.waitFor(() => state.sockets.size > 0, timeoutMs, "no client connected");
    },
    async waitFor(predicate, timeoutMs = 3000, label = "condition") {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (predicate(state)) return true;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`timed out waiting for ${label}`);
    },
  };
}
