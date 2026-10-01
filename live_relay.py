#!/usr/bin/env python3
import os, time, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

TOKEN = os.environ.get("LIVE_TOKEN", "XjxBKzfj6jd8st75NbOr6I9DKEhOpPDK")
PORT = int(os.environ.get("PORT", "10000"))

latest = {"jpeg": None, "ts": 0.0}
lock = threading.Lock()

INDEX = b"""<!doctype html><html><head><meta name='viewport' content='width=device-width,initial-scale=1'><title>Pognali emulator live</title><style>html,body{margin:0;background:#111;color:#eee;font-family:sans-serif}header{padding:10px}img{display:block;width:100%;height:auto}</style></head><body><header>POGNALI — EMULATOR LIVE</header><img src='/stream.mjpg'></body></html>"""

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        return

    def auth(self):
        return self.headers.get("X-Live-Token", "") == TOKEN

    def do_GET(self):
        if self.path == "/":
            self.send_response(200); self.send_header("Content-Type","text/html; charset=utf-8"); self.end_headers(); self.wfile.write(INDEX); return
        if self.path == "/snapshot.jpg":
            with lock: data = latest["jpeg"]
            if not data:
                self.send_response(404); self.end_headers(); return
            self.send_response(200); self.send_header("Content-Type","image/jpeg"); self.send_header("Cache-Control","no-store"); self.end_headers(); self.wfile.write(data); return
        if self.path == "/stream.mjpg":
            self.send_response(200)
            self.send_header("Content-Type","multipart/x-mixed-replace; boundary=frame")
            self.send_header("Cache-Control","no-store")
            self.send_header("Connection","close")
            self.end_headers()
            last_ts = -1
            try:
                while True:
                    with lock:
                        data, ts = latest["jpeg"], latest["ts"]
                    if data and ts != last_ts:
                        self.wfile.write(b"--frame\r\nContent-Type: image/jpeg\r\nCache-Control: no-cache\r\n\r\n")
                        self.wfile.write(data); self.wfile.write(b"\r\n"); self.wfile.flush(); last_ts = ts
                    time.sleep(0.35)
            except (BrokenPipeError, ConnectionResetError):
                pass
            return
        self.send_response(404); self.end_headers()

    def do_POST(self):
        if self.path != "/frame" or not self.auth():
            self.send_response(401); self.end_headers(); return
        n = int(self.headers.get("Content-Length", "0"))
        if n <= 0 or n > 8_000_000:
            self.send_response(400); self.end_headers(); return
        data = self.rfile.read(n)
        with lock:
            latest["jpeg"] = data
            latest["ts"] = time.time()
        self.send_response(204); self.end_headers()

ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
