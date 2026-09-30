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

This is intentionally an MVP boundary. Replace the in-memory store with a
persistent repository without changing the API contracts.
"""
from datetime import date
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from urllib.parse import parse_qs, urlparse

EVENTS = [
    {
        "id": "demo-football-1",
        "title": "Футбол",
        "emoji": "⚽",
        "category": "sport",
        "date": "2026-10-01",
        "time": "20:30",
        "place": {"name": "Парк", "city": "Екатеринбург"},
        "description": "Дружеская игра. Собираем компанию.",
        "max_participants": 10,
        "min_age": 18,
        "max_age": 35,
        "creator_id": "demo-organizer",
        "participant_count": 7,
        "participant_ids": []
    },
    {
        "id": "demo-run-1",
        "title": "Пробежка",
        "emoji": "🏃",
        "category": "sport",
        "date": "2026-10-01",
        "time": "19:00",
        "place": {"name": "Центральный парк", "city": "Екатеринбург"},
        "description": "Спокойная совместная пробежка.",
        "max_participants": 12,
        "min_age": 18,
        "max_age": 45,
        "creator_id": "demo-organizer-2",
        "participant_count": 5,
        "participant_ids": []
    }
]

MESSAGES = {}

def public_event(event):
    result = dict(event)
    result.pop("participant_ids", None)
    result["age_range"] = {"min": event["min_age"], "max": event["max_age"]}
    return result

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
            target_date = qs.get("date", [date.today().isoformat()])[0]
            items = [
                public_event(e) for e in EVENTS
                if e["date"] == target_date and (not city or e["place"]["city"].lower() == city.lower())
            ]
            return self.send_json(200, {"events": items})
        if parsed.path.startswith("/events/"):
            event_id = parsed.path.split("/")[2]
            event = next((e for e in EVENTS if e["id"] == event_id), None)
            if not event:
                return self.send_json(404, {"error": "EVENT_NOT_FOUND"})
            return self.send_json(200, public_event(event))
        return self.send_json(404, {"error": "NOT_FOUND"})

    def do_POST(self):
        parsed = urlparse(self.path)
        data = self.body()

        if parsed.path == "/events":
            required = ["title", "date", "time", "place", "max_participants", "min_age", "max_age"]
            missing = [key for key in required if key not in data]
            if missing:
                return self.send_json(400, {"error": "VALIDATION_ERROR", "missing": missing})
            if data["max_participants"] < 1 or data["min_age"] < 0 or data["max_age"] < data["min_age"]:
                return self.send_json(400, {"error": "VALIDATION_ERROR"})
            event = {
                "id": "event-" + str(len(EVENTS) + 1),
                "title": data["title"],
                "emoji": data.get("emoji", "📍"),
                "category": data.get("category", "other"),
                "date": data["date"],
                "time": data["time"],
                "place": data["place"],
                "description": data.get("description", ""),
                "max_participants": data["max_participants"],
                "min_age": data["min_age"],
                "max_age": data["max_age"],
                "creator_id": data.get("creator_id", "chatgpt-user"),
                "participant_count": 0,
                "participant_ids": []
            }
            EVENTS.append(event)
            return self.send_json(201, public_event(event))

        if parsed.path.startswith("/events/") and parsed.path.endswith("/join"):
            event_id = parsed.path.split("/")[2]
            event = next((e for e in EVENTS if e["id"] == event_id), None)
            if not event:
                return self.send_json(404, {"error": "EVENT_NOT_FOUND"})
            user_id = data.get("user_id")
            user_age = data.get("user_age")
            if not user_id or user_age is None:
                return self.send_json(400, {"error": "VALIDATION_ERROR"})
            if event["date"] < date.today().isoformat():
                return self.send_json(409, {"error": "EVENT_EXPIRED"})
            if user_id in event["participant_ids"]:
                return self.send_json(409, {"error": "ALREADY_JOINED"})
            if event["participant_count"] >= event["max_participants"]:
                return self.send_json(409, {"error": "EVENT_FULL"})
            if not event["min_age"] <= user_age <= event["max_age"]:
                return self.send_json(409, {"error": "AGE_RESTRICTED"})
            event["participant_ids"].append(user_id)
            event["participant_count"] += 1
            return self.send_json(200, {"event_id": event_id, "joined": True, "participant_count": event["participant_count"], "max_participants": event["max_participants"]})

        if parsed.path.startswith("/events/") and parsed.path.endswith("/messages"):
            event_id = parsed.path.split("/")[2]
            if not any(e["id"] == event_id for e in EVENTS):
                return self.send_json(404, {"error": "EVENT_NOT_FOUND"})
            if not data.get("user_id") or not data.get("text"):
                return self.send_json(400, {"error": "VALIDATION_ERROR"})
            MESSAGES.setdefault(event_id, []).append({"user_id": data["user_id"], "text": data["text"]})
            return self.send_json(201, MESSAGES[event_id][-1])

        return self.send_json(404, {"error": "NOT_FOUND"})

if __name__ == "__main__":
    print("Pognali Core listening on http://127.0.0.1:8080")
    ThreadingHTTPServer(("127.0.0.1", 8080), Handler).serve_forever()
