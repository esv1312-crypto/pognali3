# Погнали · ChatGPT App UI

This directory is the ChatGPT Apps SDK presentation layer for Pognali.

The backend/MCP contract remains in `chatgpt/core` and `chatgpt/mcp`.

## First widget

`pognali-events.html` is the first visual surface:

- today nearby heading;
- event title + emoji;
- time and place;
- participant count / capacity;
- age range;
- description;
- ПОЙТИ action.

It intentionally does not become a social feed.

## Runtime integration

The next wiring step is to expose this HTML as an MCP UI resource and attach it to the read/search event tool using the Apps SDK output-template metadata. The event data should arrive as structured tool output.

The write action (ПОЙТИ) must call the existing `join_event` contract rather than duplicate business logic in the widget.

Official Apps SDK examples use MCP UI resources plus structured tool output for this pattern.
