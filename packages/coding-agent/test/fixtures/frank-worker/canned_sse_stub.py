import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

mode = sys.argv[1]
release = threading.Event()


def chunk(content, finish=None):
    delta = {"content": content} if content is not None else {}
    payload = {"id": "chatcmpl-fixture", "object": "chat.completion.chunk", "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}
    return b"data: " + json.dumps(payload, separators=(",", ":")).encode() + b"\n\n"


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        self.rfile.read(length)
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.end_headers()
        if mode == "answer":
            self.wfile.write(chunk("fixture answer"))
            self.wfile.flush()
            self.wfile.write(chunk(None, "stop"))
            self.wfile.flush()
            self.wfile.write(b"data: [DONE]\n\n")
            self.wfile.flush()
        elif mode == "error":
            self.wfile.write(chunk("partial"))
            self.wfile.flush()
            self.wfile.write(b"data: {\"error\":{\"message\":\"fixture provider error\",\"type\":\"server_error\"}}\n\n")
            self.wfile.flush()
        elif mode == "slow":
            self.wfile.write(chunk("before cancel"))
            self.wfile.flush()
            release.wait(20)
            self.wfile.write(chunk(" after cancel"))
            self.wfile.flush()
            self.wfile.write(chunk(None, "stop"))
            self.wfile.flush()
            self.wfile.write(b"data: [DONE]\n\n")
            self.wfile.flush()

    def do_GET(self):
        if self.path == "/release":
            release.set()
            self.send_response(200)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        self.send_response(404)
        self.end_headers()


server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
print(server.server_address[1], flush=True)
server.serve_forever()
