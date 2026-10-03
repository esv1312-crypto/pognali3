"""ChatGPT-facing adapter over the shared Pognali service."""
from chatgpt.core import service

search_events = service.search_events
get_event = service.get_event
join_event = service.join_event
leave_event = service.leave_event
my_events = service.my_events
create_event = service.create_event
delete_event = service.delete_event
complete_event = service.complete_event
send_message = service.send_message
get_messages = service.get_messages
prepare_invite = service.prepare_invite
create_invite = service.create_invite
get_user_invites = service.get_user_invites
accept_invite = service.accept_invite
decline_invite = service.decline_invite
ask_organizer = service.ask_organizer
