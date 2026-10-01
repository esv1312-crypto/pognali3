import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
"""In-process smoke test for the ChatGPT-facing MCP server."""
import asyncio
import json

from mcp import Client
from chatgpt.mcp.server import mcp


def payload_of(result):
    assert not result.is_error
    assert result.content
    value = json.loads(result.content[0].text)
    if isinstance(value.get("result"), dict):
        value = value["result"]
    return value


async def main():
    async with Client(mcp, raise_exceptions=True) as client:
        tools = await client.list_tools()
        names = {tool.name for tool in tools.tools}
        expected = {"search_events", "get_event", "join_event", "create_event", "send_message"}
        assert expected <= names, (expected, names)

        result = await client.call_tool(
            "search_events",
            {"city": "Екатеринбург", "event_date": "2026-10-01"},
        )
        events = payload_of(result).get("events", [])
        assert any(event["id"] == "demo-football-1" for event in events)

        detail = await client.call_tool("get_event", {"event_id": "demo-football-1"})
        detail_payload = payload_of(detail)
        assert detail_payload["id"] == "demo-football-1"

        before = detail_payload["participant_count"]
        joined = await client.call_tool(
            "join_event",
            {"event_id": "demo-football-1", "user_id": "mcp-smoke-user", "user_age": 30},
        )
        joined_payload = payload_of(joined)
        assert joined_payload["joined"] is True
        assert joined_payload["participant_count"] == before + 1

        duplicate = await client.call_tool(
            "join_event",
            {"event_id": "demo-football-1", "user_id": "mcp-smoke-user", "user_age": 30},
        )
        assert payload_of(duplicate)["error"] == "ALREADY_JOINED"

    print("MCP smoke test: PASS")


if __name__ == "__main__":
    asyncio.run(main())
