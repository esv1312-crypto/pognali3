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
        expected = {"search_events", "get_event", "join_event", "create_event", "get_messages", "send_message"}
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

        sent = await client.call_tool(
            "send_message",
            {"event_id": "demo-football-1", "user_id": "mcp-smoke-user", "text": "Буду у входа!"},
        )
        sent_payload = payload_of(sent)
        assert sent_payload["text"] == "Буду у входа!"

        history = await client.call_tool(
            "get_messages",
            {"event_id": "demo-football-1", "limit": 10},
        )
        messages = payload_of(history)["messages"]
        assert messages[-1]["text"] == "Буду у входа!"
        assert messages[-1]["event_id"] == "demo-football-1"

        created = await client.call_tool(
            "create_event",
            {
                "title": "Настольный теннис",
                "event_date": "2026-10-02",
                "time": "19:30",
                "place": {"name": "Спортзал", "city": "Екатеринбург"},
                "max_participants": 6,
                "min_age": 18,
                "max_age": 40,
                "category": "sport",
                "emoji": "🏓",
                "description": "Тестовое событие из ChatGPT.",
                "creator_id": "mcp-smoke-creator",
            },
        )
        created_payload = payload_of(created)
        assert created_payload["title"] == "Настольный теннис"
        assert created_payload["participant_count"] == 0
        assert created_payload["max_participants"] == 6

        invalid = await client.call_tool(
            "create_event",
            {
                "title": "Неверное событие",
                "event_date": "2026-10-03",
                "time": "вечером",
                "place": {"name": "Место", "city": "Екатеринбург"},
                "max_participants": 5,
                "min_age": 18,
                "max_age": 40,
            },
        )
        assert payload_of(invalid)["error"] == "VALIDATION_ERROR"

        created_id = created_payload["id"]
        created_detail = await client.call_tool("get_event", {"event_id": created_id})
        assert payload_of(created_detail)["id"] == created_id

        creator_join = await client.call_tool(
            "join_event",
            {"event_id": created_id, "user_id": "mcp-smoke-creator", "user_age": 30},
        )
        assert payload_of(creator_join)["participant_count"] == 1

    print("MCP smoke test: PASS")


if __name__ == "__main__":
    asyncio.run(main())
