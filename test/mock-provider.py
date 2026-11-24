#!/usr/bin/env python3
"""极简 OpenAI 兼容 mock 服务，用于在没有真实 API Key 的情况下验证 agent 主链路。"""

import json
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

REPLY = "我是本地 mock 模型。收到你的消息了，链路是通的：transport → core → agent → model → 返回。"


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        print("[mock]", fmt % args, flush=True)

    def do_POST(self):
        if not self.path.endswith("/chat/completions"):
            self.send_response(404)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return

        length = int(self.headers.get("Content-Length", "0"))
        body = json.loads(self.rfile.read(length) or b"{}")
        stream = bool(body.get("stream"))

        if stream:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "keep-alive")
            self.end_headers()
            for chunk in [REPLY[i:i + 12] for i in range(0, len(REPLY), 12)]:
                payload = {
                    "id": "mock-1",
                    "object": "chat.completion.chunk",
                    "choices": [{"index": 0, "delta": {"content": chunk}, "finish_reason": None}],
                }
                self.wfile.write(b"data: " + json.dumps(payload, ensure_ascii=False).encode() + b"\n\n")
                self.wfile.flush()
                time.sleep(0.02)
            done = {
                "id": "mock-1",
                "object": "chat.completion.chunk",
                "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
            }
            self.wfile.write(b"data: " + json.dumps(done, ensure_ascii=False).encode() + b"\n\n")
            self.wfile.write(b"data: [DONE]\n\n")
            self.wfile.flush()
            return

        payload = {
            "id": "mock-1",
            "object": "chat.completion",
            "created": int(time.time()),
            "model": body.get("model", "mock"),
            "choices": [{"index": 0, "message": {"role": "assistant", "content": REPLY}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 10, "completion_tokens": 20, "total_tokens": 30},
        }
        data = json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


if __name__ == "__main__":
    print("[mock] listening on http://127.0.0.1:9099", flush=True)
    ThreadingHTTPServer(("127.0.0.1", 9099), Handler).serve_forever()
