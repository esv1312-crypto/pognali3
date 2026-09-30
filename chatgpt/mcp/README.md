# Pognali MCP boundary

The adapter in `server.py` is the stable ChatGPT-facing boundary for the MVP.

## Tool contract

- `search_events`: read-only discovery of today's nearby events.
- `get_event`: read-only full event details.
- `join_event`: mutates participation and returns the new count.
- `create_event`: creates an event with capacity and age constraints.
- `send_message`: posts an event-chat message.

## Production transport

The next deployment step is to expose these operations through a real MCP
server/transport and configure the public HTTPS MCP endpoint for ChatGPT.

The transport must delegate to these functions rather than duplicate business
rules. Authentication, persistence, rate limits, observability and HTTPS
belong outside this adapter.

## Location principle

A ChatGPT-provided city/location hint is discovery context, not authentication.
If no location is available, the client can ask the user for a city.

## Compatibility principle

Android remains untouched. This MCP boundary is part of the separate
`chatgpt-mvp-skeleton` contour and can later point at a shared Pognali Core.
