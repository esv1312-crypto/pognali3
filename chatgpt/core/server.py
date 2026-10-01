"""Minimal framework-free Pognali Core HTTP API for the ChatGPT contour.

Run:
  python3 chatgpt/core/server.py

Endpoints:
  GET  /health
  GET  /events?city=...&date=...
  GET  /events/<id>
  POST /events/<id>/join
  POST /events
  POST /events/<id>/messages

The HTTP transport delegates to the same in-process business service used by
the ChatGPT MCP adapter, keeping product rules in one place.
"""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from urllib.parse import parse_qs, urlparse

from chatgpt.core import service


class Handler(BaseHTTPRequestHandler):
    def send_json(self, status, payload):
        raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def body(self):
        length = int(self.headers.get("Content-Length", "0"))
        return json.loads(self.rfile.read(length) or b"{}")

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/health":
            return self.send_json(200, {"ok": True, "service": "pognali-core"})

        if parsed.path == "/events":
            qs = parse_qs(parsed.query)
            city = qs.get("city", [None])[0]
            event_date = qs.get("date", [None])[0]
            category = qs.get("category", [None])[0]
            age_raw = qs.get("user_age", [None])[0]
            user_age = int(age_raw) if age_raw is not None else None
            return self.send_json(
                200,
                service.search_events(city, event_date, category, user_age),
            )

        if parsed.path.startswith("/events/"):
            event_id = parsed.path.split("/")[2]
            result = service.get_event(event_id)
            if result.get("error"):
                return self.send_json(404, result)
            return self.send_json(200, result)

        return self.send_json(404, {"error": "NOT_FOUND"})

    def do_POST(self):
        parsed = urlparse(self.path)
        data = self.body()

        if parsed.path == "/events":
            result = service.create_event(
                title=data.get("title"),
                event_date=data.get("date"),
                time=data.get("time"),
                place=data.get("place"),
                max_participants=data.get("max_participants"),
                min_age=data.get("min_age"),
                max_age=data.get("max_age"),
                category=data.get("category", "other"),
                emoji=data.get("emoji", "📍"),
                description=data.get("description", ""),
                creator_id=data.get("creator_id", "chatgpt-user"),
            )
            if result.get("error"):
                return self.send_json(400, result)
            return self.send_json(201, result)

        if parsed.path.startswith("/events/") and parsed.path.endswith("/join"):
            event_id = parsed.path.split("/")[2]
            result = service.join_event(
                event_id,
                data.get("user_id"),
                data.get("user_age"),
            )
            errors = {
                "EVENT_NOT_FOUND": 404,
                "VALIDATION_ERROR": 400,
                "EVENT_EXPIRED": 409,
                "ALREADY_JOINED": 409,
                "EVENT_FULL": 409,
                "AGE_RESTRICTED": 409,
            }
            return self.send_json(errors.get(result.get("error"), 200), result)

        if parsed.path.startswith("/events/") and parsed.path.endswith("/messages"):
            event_id = parsed.path.split("/")[2]
            result = service.send_message(
                event_id,
                data.get("user_id"),
                data.get("text"),
            )
            if result.get("error"):
                status = 404 if result["error"] == "EVENT_NOT_FOUND" else 400
                return self.send_json(status, result)
            return self.send_json(201, result)

        return self.send_json(404, {"error": "NOT_FOUND"})


if __name__ == "__main__":
    print("Pognali Core listening on http://127.0.0.1:8080")
    ThreadingHTTPServer(("127.0.0.1", 8080), Handler).serve_forever()
