"""Pognali MCP Apps server."""

import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from mcp.server.mcpserver import MCPServer
from mcp.server.apps import Apps

from chatgpt.mcp import adapter as core

UI_URI = "ui://pognali/events-v1.html"
UI_FILE = ROOT / "chatgpt" / "app" / "pognali-events.html"

apps = Apps()
mcp = MCPServer(
    "Pognali",
    instructions=(
        "Find, join, create and discuss real-world Pognali events. "
        "For creation requests expressed in natural language, collect only "
        "missing mandatory fields before calling create_event."
    ),
    extensions=[apps],
)

apps.add_html_resource(
    UI_URI,
    UI_FILE.read_text(encoding="utf-8"),
    name="Pognali events",
    title="Погнали ⚡",
    description="События Погнали для выхода в реальную жизнь.",
    prefers_border=True,
)


@apps.tool(
    resource_uri=UI_URI,
    description="Find Pognali events for a date, optionally filtered by city, category and age.",
)
@mcp.tool()
def search_events(city: str | None = None, event_date: str | None = None,
                  category: str | None = None, user_age: int | None = None) -> dict:
    return core.search_events(city, event_date, category, user_age)


@mcp.tool()
def get_event(event_id: str) -> dict:
    return core.get_event(event_id)


@mcp.tool()
def join_event(event_id: str, user_id: str, user_age: int) -> dict:
    return core.join_event(event_id, user_id, user_age)


@apps.tool(
    resource_uri=UI_URI,
    description=(
        "Create a Pognali event. Required: title, date (YYYY-MM-DD), time (HH:MM), "
        "place, max participants, minimum age and maximum age. When the user gives "
        "a natural-language creation request, ask only for missing required fields "
        "before calling this tool. Do not invent missing date, time, place or limits."
    ),
)
@mcp.tool()
def create_event(title: str, event_date: str, time: str, place: dict,
                 max_participants: int, min_age: int, max_age: int,
                 category: str = "other", emoji: str = "📍",
                 description: str = "", creator_id: str = "chatgpt-user") -> dict:
    return core.create_event(title, event_date, time, place, max_participants,
                             min_age, max_age, category, emoji, description,
                             creator_id)


@mcp.tool()
def get_messages(event_id: str, limit: int = 50) -> dict:
    """Get recent messages for a Pognali event chat."""
    return core.get_messages(event_id, limit)


@apps.tool(
    resource_uri=UI_URI,
    description=(
        "Prepare a short invitation for a Pognali event so the creator can share it "
        "with friends or use it to gather a company. Do not invent event details."
    ),
)
@mcp.tool()
def prepare_invite(event_id: str, user_id: str = "chatgpt-user") -> dict:
    return core.prepare_invite(event_id, user_id)


@mcp.tool()
def send_message(event_id: str, user_id: str, text: str) -> dict:
    return core.send_message(event_id, user_id, text)


@mcp.tool()
def create_invite(event_id: str, sender_user_id: str, recipient_user_id: str) -> dict:
    """Send a stateful invitation to another Pognali user."""
    return core.create_invite(event_id, sender_user_id, recipient_user_id)


@mcp.tool()
def get_user_invites(user_id: str) -> dict:
    """Get pending and historical invitations for a Pognali user."""
    return core.get_user_invites(user_id)


@mcp.tool()
def accept_invite(invite_id: str, user_id: str, user_age: int) -> dict:
    """Accept an incoming Pognali invitation and join its event."""
    return core.accept_invite(invite_id, user_id, user_age)


@mcp.tool()
def decline_invite(invite_id: str, user_id: str) -> dict:
    """Decline an incoming Pognali invitation."""
    return core.decline_invite(invite_id, user_id)





@mcp.tool()
def openai_connection_status() -> dict:
    """Safely verify that Render has a working OPENAI_API_KEY without exposing it."""
    api_key = os.environ.get("OPENAI_API_KEY", "").strip()
    if not api_key:
        return {"ok": False, "configured": False, "reason": "OPENAI_API_KEY is not configured"}

    from urllib.request import Request, urlopen
    from urllib.error import HTTPError, URLError

    request = Request(
        "https://api.openai.com/v1/models",
        headers={"Authorization": "Bearer " + api_key, "Accept": "application/json"},
        method="GET",
    )
    try:
        with urlopen(request, timeout=15) as response:
            return {"ok": response.status == 200, "configured": True, "status": response.status}
    except HTTPError as exc:
        return {"ok": False, "configured": True, "status": exc.code, "reason": "OpenAI authentication/request failed"}
    except URLError:
        return {"ok": False, "configured": True, "reason": "Could not reach OpenAI API"}


def verify_openai_on_startup() -> None:
    """Check OpenAI authentication at startup without exposing the secret."""
    api_key = os.environ.get("OPENAI_API_KEY", "").strip()
    if not api_key:
        print("OPENAI_CONNECTION: NOT_CONFIGURED", flush=True)
        return
    from urllib.request import Request, urlopen
    from urllib.error import HTTPError, URLError
    request = Request(
        "https://api.openai.com/v1/models",
        headers={"Authorization": "Bearer " + api_key, "Accept": "application/json"},
        method="GET",
    )
    try:
        with urlopen(request, timeout=15) as response:
            print(f"OPENAI_CONNECTION: {'PASS' if response.status == 200 else 'FAIL'} STATUS={response.status}", flush=True)
    except HTTPError as exc:
        print(f"OPENAI_CONNECTION: FAIL STATUS={exc.code}", flush=True)
    except URLError:
        print("OPENAI_CONNECTION: FAIL NETWORK", flush=True)


if __name__ == "__main__":
    verify_openai_on_startup()
    mcp.run(
        transport="streamable-http",
        host="0.0.0.0",
        port=int(os.environ.get("PORT", "8000")),
        streamable_http_path="/mcp",
        stateless_http=True,
        json_response=True,
    )
