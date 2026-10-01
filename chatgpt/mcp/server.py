"""Pognali MCP Apps server."""

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
def search_events(city: str | None = None, event_date: str | None = None,
                  category: str | None = None, user_age: int | None = None) -> dict:
    return core.search_events(city, event_date, category, user_age)


@mcp.tool()
def get_event(event_id: str) -> dict:
    return core.get_event(event_id)


@mcp.tool()
def join_event(event_id: str, user_id: str, user_age: int) -> dict:
    return core.join_event(event_id, user_id, user_age)


@mcp.tool()
def create_event(title: str, event_date: str, time: str, place: dict,
                 max_participants: int, min_age: int, max_age: int,
                 category: str = "other", emoji: str = "📍",
                 description: str = "", creator_id: str = "chatgpt-user") -> dict:
    return core.create_event(title, event_date, time, place, max_participants,
                             min_age, max_age, category, emoji, description,
                             creator_id)


@mcp.tool()
def send_message(event_id: str, user_id: str, text: str) -> dict:
    return core.send_message(event_id, user_id, text)


if __name__ == "__main__":
    mcp.run(
        transport="streamable-http",
        host="0.0.0.0",
        port=8000,
        streamable_http_path="/mcp",
        stateless_http=True,
        json_response=True,
    )
