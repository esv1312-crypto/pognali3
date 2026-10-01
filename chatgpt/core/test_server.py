"""Black-box tests for the minimal Pognali Core API."""
import json
import subprocess
import sys
import time
import urllib.error
import urllib.request
from urllib.parse import urlencode

HOST = "127.0.0.1"
PORT = 8080
BASE = f"http://{HOST}:{PORT}"


def request(method, path, payload=None):
    data = None if payload is None else json.dumps(payload).encode()
    req = urllib.request.Request(
        BASE + path,
        data=data,
        method=method,
        headers={"Content-Type": "application/json"} if data else {},
    )
    try:
        with urllib.request.urlopen(req, timeout=3) as response:
            return response.status, json.loads(response.read())
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read())


server = subprocess.Popen(
    [sys.executable, "chatgpt/core/server.py"],
    stdout=subprocess.DEVNULL,
    stderr=subprocess.DEVNULL,
)
try:
    for _ in range(30):
        try:
            status, body = request("GET", "/health")
            if status == 200 and body["ok"]:
                break
        except Exception:
            time.sleep(0.1)
    else:
        raise AssertionError("Core API did not become healthy")

    status, body = request(
        "GET",
        "/events?" + urlencode({"city": "Екатеринбург", "date": "2026-10-01"}),
    )
    assert status == 200
    assert any(e["id"] == "demo-football-1" for e in body["events"])

    status, body = request(
        "GET",
        "/events?" + urlencode(
            {"city": "Екатеринбург", "date": "2026-10-01", "category": "sport", "user_age": 30}
        ),
    )
    assert status == 200
    assert {e["id"] for e in body["events"]} == {"demo-football-1", "demo-run-1"}

    status, body = request(
        "GET",
        "/events?" + urlencode(
            {"city": "Екатеринбург", "date": "2026-10-01", "user_age": 17}
        ),
    )
    assert status == 200
    assert body["events"] == []

    status, body = request("GET", "/events/demo-football-1")
    assert status == 200
    assert body["participant_count"] == 7
    assert body["max_participants"] == 10
    assert body["age_range"] == {"min": 18, "max": 35}

    status, body = request(
        "POST",
        "/events/demo-football-1/join",
        {"user_id": "qa-user", "user_age": 30},
    )
    assert status == 200
    assert body["participant_count"] == 8

    status, body = request(
        "POST",
        "/events/demo-football-1/join",
        {"user_id": "qa-user", "user_age": 30},
    )
    assert status == 409 and body["error"] == "ALREADY_JOINED"

    status, body = request(
        "POST",
        "/events/demo-football-1/join",
        {"user_id": "qa-young", "user_age": 17},
    )
    assert status == 409 and body["error"] == "AGE_RESTRICTED"

    status, body = request(
        "POST",
        "/events/demo-football-1/messages",
        {"user_id": "qa-user", "text": "Я иду!"},
    )
    assert status == 201
    assert body["text"] == "Я иду!"

    status, body = request("POST", "/events", {
        "title": "Настольные игры",
        "emoji": "🎲",
        "category": "games",
        "date": "2026-10-02",
        "time": "19:30",
        "place": {"name": "Кафе", "city": "Екатеринбург"},
        "max_participants": 6,
        "min_age": 18,
        "max_age": 40,
        "description": "Собираемся поиграть.",
        "creator_id": "qa-creator",
    })
    assert status == 201
    created_id = body["id"]

    status, body = request("GET", f"/events/{created_id}")
    assert status == 200
    assert body["participant_count"] == 0
    assert body["max_participants"] == 6

    status, body = request(
        "POST",
        f"/events/{created_id}/join",
        {"user_id": "qa-creator", "user_age": 31},
    )
    assert status == 200 and body["participant_count"] == 1

    status, body = request("GET", "/events/not-found")
    assert status == 404 and body["error"] == "EVENT_NOT_FOUND"

    print("Pognali Core API tests: PASS")
finally:
    server.terminate()
    server.wait(timeout=5)
