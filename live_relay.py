#!/usr/bin/env python3
import json, os, time, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

TOKEN = os.environ.get("LIVE_TOKEN", "")
PORT = int(os.environ.get("PORT", "10000"))

state = {"png": None, "frame_ts": 0.0, "log_ts": 0.0, "logs": []}
lock = threading.Lock()

INDEX = b"""<!doctype html>
<html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Cache-Control" content="no-store"><title>Pognali emulator live</title>
<style>html,body{margin:0;background:#111;color:#eee;font-family:sans-serif}header{padding:10px;font-size:16px}#status,#step{padding:0 10px 8px;color:#aaa}#step{color:#fff;font-weight:600}#logs{padding:0 10px 10px;font:12px monospace;white-space:pre-wrap;max-height:180px;overflow:auto}img{display:block;width:100%;height:auto}</style>
</head><body><header>POGNALI — EMULATOR LIVE</header>
<div id="status">connecting…</div><div id="step">waiting for telemetry…</div><div id="logs"></div>
<img id="screen" alt="emulator">
<script>
const img=document.getElementById('screen'), status=document.getElementById('status'), step=document.getElementById('step'), logs=document.getElementById('logs');
async function tick(){
 try{const r=await fetch('/snapshot.png?t='+Date.now(),{cache:'no-store'}); if(!r.ok) throw 0; const u=URL.createObjectURL(await r.blob()); img.onload=()=>URL.revokeObjectURL(u); img.src=u; status.textContent='SCREEN LIVE • '+new Date().toLocaleTimeString();}
 catch(e){status.textContent='SCREEN OFFLINE / WAITING…';}
 try{const r=await fetch('/state.json?t='+Date.now(),{cache:'no-store'}); const s=await r.json();
   const age=s.frame_age_sec; const live=age>=0 && age<5;
   status.textContent=(live?'SCREEN LIVE':'SCREEN STALE')+' • frame '+(age<0?'never':age.toFixed(1)+'s ago');
   step.textContent=s.current_step||'waiting for telemetry…';
   logs.textContent=(s.logs||[]).slice(-18).join('\n');
 }catch(e){}
 setTimeout(tick,500);
} tick();
</script></body></html>""";

class Handler(BaseHTTPRequestHandler):
    def log_message(self,*args): return
    def auth(self): return self.headers.get("X-Live-Token","") == TOKEN
    def do_GET(self):
        path=self.path.split("?")[0]
        if path=="/":
            self.send_response(200); self.send_header("Content-Type","text/html; charset=utf-8"); self.send_header("Cache-Control","no-store"); self.end_headers(); self.wfile.write(INDEX); return
        if path=="/snapshot.png":
            with lock: data=state["png"]
            if not data: self.send_response(404); self.end_headers(); return
            self.send_response(200); self.send_header("Content-Type","image/png"); self.send_header("Content-Length",str(len(data))); self.send_header("Cache-Control","no-store"); self.end_headers(); self.wfile.write(data); return
        if path=="/state.json":
            with lock:
                now=time.time()
                payload={"frame_age_sec":(-1 if not state["frame_ts"] else round(now-state["frame_ts"],2)),
                         "log_age_sec":(-1 if not state["log_ts"] else round(now-state["log_ts"],2)),
                         "current_step":(state["logs"][-1] if state["logs"] else ""),
                         "logs":list(state["logs"])}
            data=json.dumps(payload,ensure_ascii=False).encode()
            self.send_response(200); self.send_header("Content-Type","application/json; charset=utf-8"); self.send_header("Cache-Control","no-store"); self.end_headers(); self.wfile.write(data); return
        self.send_response(404); self.end_headers()
    def do_POST(self):
        if not self.auth():
            self.send_response(401); self.end_headers(); return
        path=self.path.split("?")[0]
        n=int(self.headers.get("Content-Length","0"))
        if n<=0 or n>8_000_000: self.send_response(400); self.end_headers(); return
        data=self.rfile.read(n)
        with lock:
            if path=="/frame": state["png"],state["frame_ts"]=data,time.time()
            elif path=="/log":
                line=data.decode("utf-8","replace").strip()
                if line:
                    state["logs"].append(line); state["logs"]=state["logs"][-80:]; state["log_ts"]=time.time()
                else: self.send_response(400); self.end_headers(); return
            else: self.send_response(404); self.end_headers(); return
        self.send_response(204); self.end_headers()

ThreadingHTTPServer(("0.0.0.0",PORT),Handler).serve_forever()
