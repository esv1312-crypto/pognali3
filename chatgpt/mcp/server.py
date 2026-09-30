"""Pognali MCP server exposed through the official Python SDK."""
from mcp.server.mcpserver import MCPServer
from chatgpt.mcp import adapter as core

mcp = MCPServer(
    "Pognali",
    instructions="Find, join, create and discuss real-world Pognali events.",
)

@mcp.tool()
def search_events(city: str | None = None, event_date: str | None = None,
                  category: str | None = None, user_age: int | None = None) -> dict:
    """Find Pognali events for a date, optionally filtered by city, category and age."""
    return core.search_events(city, event_date, category, user_age)

@mcp.tool()
def get_event(event_id: str) -> dict:
    """Get the full current card for one Pognali event."""
    return core.get_event(event_id)

@mcp.tool()
def join_event(event_id: str, user_id: str, user_age: int) -> dict:
    """Join an event after checking capacity, age range, expiry and duplicates."""
    return core.join_event(event_id, user_id, user_age)

@mcp.tool()
def create_event(title: str, event_date: str, time: str, place: dict,
                 max_participants: int, min_age: int, max_age: int,
                 category: str = "other", emoji: str = "📍",
                 description: str = "", creator_id: str = "chatgpt-user") -> dict:
    """Create a real-world event with capacity and age constraints."""
    return core.create_event(title, event_date, time, place, max_participants,
                             min_age, max_age, category, emoji, description,
                             creator_id)

@mcp.tool()
def send_message(event_id: str, user_id: str, text: str) -> dict:
    """Send a message to an event chat."""
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
