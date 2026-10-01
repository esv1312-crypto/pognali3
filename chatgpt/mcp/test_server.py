import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
"""In-process smoke test for the ChatGPT-facing MCP server."""
import asyncio
from mcp import Client
from chatgpt.mcp.server import mcp

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
        assert not result.is_error
        import json
        assert result.content
        payload = json.loads(result.content[0].text)
        events = payload.get("events", payload.get("result", {}).get("events", []))
        assert any(event["id"] == "demo-football-1" for event in events)

        detail = await client.call_tool("get_event", {"event_id": "demo-football-1"})
        assert not detail.is_error
        assert detail.content
        detail_payload = json.loads(detail.content[0].text)
        if isinstance(detail_payload.get("result"), dict):
            detail_payload = detail_payload["result"]
        assert detail_payload["id"] == "demo-football-1"

    print("MCP smoke test: PASS")

if __name__ == "__main__":
    asyncio.run(main())
