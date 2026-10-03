# POGNALI ChatGPT App — Implementation Contract v1

## Required user journeys
1. Discover nearby/relevant events.
2. Open event details.
3. Join event.
4. Create event from natural language.
5. Invite a friend after creating or joining.
6. Accept/decline incoming invitation.
7. Coordinate in event chat.

## Tool contract
search_events: read-only discovery; must not fabricate events.
get_event: full event state.
join_event: enforce age/capacity and return updated participation state.
create_event: enforce required fields and create a discoverable event.
prepare_invite: produce invitation from actual event data.
create_invite: create invitation record.
get_user_invites: list pending/known invitations.
accept_invite / decline_invite: update invitation and participation state.
get_messages / send_message: event-scoped coordination.

## UI contract
Event cards must show title, time, place, participants/capacity and age range.
Primary action is JOIN / ТЫ ИДЁШЬ.
After joining, surface INVITE and WRITE.
Creation is initiated by natural language and may use a compact form only for missing required values.
Do not reproduce Android bottom navigation inside ChatGPT unless it is needed for an action.

## Geolocation contract
Use only location context legitimately supplied by ChatGPT/host or the user.
Fallback order: precise host-provided context → user-provided neighborhood/city → profile city → ask.
Do not claim precise location when unavailable.
Distance is optional and requires coordinates for both sides.

## Separation of concerns
ChatGPT layer: intent mapping, conversational questions, UI rendering.
POGNALI Core: validation, authorization, capacity, age rules, persistence, participant state, invitation state.
Transport: MCP/Apps SDK.
Android and Web: clients of the same Core/API.

## v1 non-goals
No global social feed.
No followers/likes system.
No requirement to migrate every Android screen into ChatGPT.
No fabricated maps, users, events or attendance.

## Release gate
Do not call the ChatGPT App complete until the full Discover → Join → Invite flow and Create → Invite flow work against real persistent data through the deployed MCP endpoint.