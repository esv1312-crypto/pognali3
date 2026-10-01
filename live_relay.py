#!/usr/bin/env python3
import os, time, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

TOKEN = os.environ.get("LIVE_TOKEN", "")
PORT = int(os.environ.get("PORT", "10000"))

latest = {"png": None, "ts": 0.0}
lock = threading.Lock()

INDEX = b"""<!doctype html>
<html>
<head>
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Cache-Control" content="no-store">
<title>Pognali emulator live</title>
<style>
html,body{margin:0;background:#111;color:#eee;font-family:sans-serif}
header{padding:10px;font-size:16px}
#status{padding:0 10px 10px;color:#aaa}
img{display:block;width:100%;height:auto}
</style>
</head>
<body>
<header>POGNALI — EMULATOR LIVE</header>
<div id="status">connecting…</div>
<img id="screen" alt="emulator">
<script>
const img=document.getElementById('screen');
const status=document.getElementById('status');
let last=0;
async function tick(){
  try{
    const r=await fetch('/snapshot.png?t='+Date.now(),{cache:'no-store'});
    if(!r.ok) throw new Error('no frame');
    const b=await r.blob();
    const u=URL.createObjectURL(b);
    img.onload=()=>URL.revokeObjectURL(u);
    img.src=u;
    last=Date.now();
    status.textContent='LIVE • '+new Date().toLocaleTimeString();
  }catch(e){
    status.textContent='WAITING FOR EMULATOR…';
  }
  setTimeout(tick,500);
}
tick();
</script>
</body>
</html>"""

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        return

    def auth(self):
        return self.headers.get("X-Live-Token", "") == TOKEN

    def do_GET(self):
        if self.path == "/":
            self.send_response(200)
            self.send_header("Content-Type","text/html; charset=utf-8")
            self.send_header("Cache-Control","no-store")
            self.end_headers()
            self.wfile.write(INDEX)
            return

        if self.path.startswith("/snapshot.png"):
            with lock:
                data = latest["png"]
            if not data:
                self.send_response(404)
                self.end_headers()
                return
            self.send_response(200)
            self.send_header("Content-Type","image/png")
            self.send_header("Content-Length",str(len(data)))
            self.send_header("Cache-Control","no-store, no-cache, must-revalidate")
            self.end_headers()
            self.wfile.write(data)
            return

        self.send_response(404)
        self.end_headers()

    def do_POST(self):
        if self.path != "/frame" or not self.auth():
            self.send_response(401)
            self.end_headers()
            return

        n = int(self.headers.get("Content-Length", "0"))
        if n <= 0 or n > 8_000_000:
            self.send_response(400)
            self.end_headers()
            return

        data = self.rfile.read(n)
        with lock:
            latest["png"], latest["ts"] = data, time.time()

        self.send_response(204)
        self.end_headers()

ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
