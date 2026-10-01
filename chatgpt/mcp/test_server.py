import sys\nfrom pathlib import Path\nsys.path.insert(0, str(Path(__file__).resolve().parents[2]))\n"""In-process smoke test for the ChatGPT-facing MCP server."""
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
        assert result.structured_content is not None
        events = result.structured_content["events"]
        assert any(event["id"] == "demo-football-1" for event in events)

        detail = await client.call_tool("get_event", {"event_id": "demo-football-1"})
        assert not detail.is_error
        assert detail.structured_content["id"] == "demo-football-1"

    print("MCP smoke test: PASS")

if __name__ == "__main__":
    asyncio.run(main())
