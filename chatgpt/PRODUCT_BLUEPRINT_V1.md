# POGNALI × ChatGPT — Product & UX Blueprint v1

## Goal
POGNALI is a real-world activity layer for ChatGPT. Core loop: conversation → discover/create → choose → join → invite → meet → real life.
POGNALI is not a social feed and not a classic social network.

## Contextual surfaces
1. Discover: “Ну что, погнали?”, today's nearby/relevant events, list/cards, optional map context.
2. Event: title, emoji, date/time, place, distance when available, participant count/capacity, age range, description, JOIN, WRITE, INVITE.
3. Create: natural-language first; ask only missing mandatory fields; confirm/create.
4. Invitations: pending invitations with accept/decline.
5. Event chat: coordination between event participants.
6. Minimal profile/identity: display name, city, about, private age data needed for age-gated participation.

## Core tools
Discovery: search_events, get_event, get_messages, get_user_invites.
Actions: join_event, create_event, send_message, create_invite, accept_invite, decline_invite.
Preparation: prepare_invite.

## DISCOVER
search_events accepts optional city, event_date, category, user_age and location context when legitimately provided by the host.
Prefer nearby/relevant events. Never invent location. If precise location is unavailable, use city/profile context or ask the user.

## JOIN
join_event takes event_id, user identity and age. Capacity and age rules are enforced server-side. Return updated participant count. After joining, offer INVITE and WRITE.

## CREATE
Required: title, date, time, place, max participants, min age, max age.
Optional: category, emoji, description.
Natural-language examples: “Хочу футбол завтра в 19:00.” and “Создай прогулку в субботу на 8 человек.”
Ask only for missing required fields. Never invent date, time, place, capacity or age limits.
After creation, show the event, make it discoverable, and offer INVITE as a separate action.

## INVITE
CREATE and INVITE are separate actions.
Supported flows: creator creates → invite; user joins → invite; existing participant → invite another person.
Invitation tools: prepare_invite, create_invite, get_user_invites, accept_invite, decline_invite.
Invitation text must use actual event data. Transport such as WhatsApp/share can be added separately from the core invitation object.

## EVENT CHAT
get_messages and send_message. Chat is scoped to an event and exists to coordinate the real-world activity, not to become a global feed.

## LOCATION
Location is discovery context, not authentication.
Possible sources: host-provided location when explicitly available; user-supplied city/neighborhood; saved profile city; otherwise ask.
Event place may contain name, address, city, latitude/longitude and optional map metadata.
Show distance only when both event and user coordinates are legitimately available.

## DATA MODEL
Event: id, title, emoji, category, description, date, time, place, max_participants, participant_count, min_age, max_age, creator_id, status, created_at.
Participant: event_id, user_id, display_name, joined_at, role/status.
Invitation: id, event_id, sender_user_id, recipient_user_id, status, invite_text, created_at, responded_at.
Message: id, event_id, user_id, text, created_at.
User: id, display_name, city, about, private birth/age data, location preference/context.

## RULES
Age and capacity are server-enforced. Never fabricate events, people, locations, attendance or invitation responses. Minimize private profile exposure. Do not create a global social feed. The successful flow ends in an offline activity.

## MVP FLOWS
A. Discover → Join: user asks what to do → search → cards → event → JOIN → updated count → INVITE/WRITE.
B. Natural-language Create: user describes activity/time → collect missing fields → create_event → render event → offer INVITE.
C. Join → Invite: resolve event → verify participation as needed → prepare/create invitation → track invitation independently.
D. Invitation: recipient accepts or declines; acceptance updates event participation.
E. Chat: participant opens WRITE → sends message → sees it in event chat.

## LOCATION/PRIVACY PRINCIPLE
Do not assume precise device location. ChatGPT-provided location hints are context only. Authentication and permissions belong to the backend/host.

## ARCHITECTURE
ChatGPT → Apps SDK/MCP → POGNALI ChatGPT App → POGNALI Core/API → Users / Events / Participants / Invitations / Event Chat / Locations → Database.
Android and Web should use the same Core/API. MCP remains a thin ChatGPT-facing adapter; business rules stay in the shared core.

## ANDROID RELATION
ChatGPT is not a pixel-for-pixel port. Android can keep richer maps, profile, settings, notifications and navigation. ChatGPT must preserve the meaning and essential mechanics: discover, create, join, invite, coordinate, go.

## DEFINITION OF DONE
A user can complete inside ChatGPT: find something → see real events → open one → JOIN → INVITE → coordinate in event chat.
A user can also complete: describe an activity → answer missing questions → CREATE → see the event → INVITE.

## Product principle
Technology should help people build their real lives, not spend their lives watching other people live theirs.