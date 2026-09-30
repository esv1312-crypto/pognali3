"""ChatGPT-facing adapter over the shared Pognali service."""
from chatgpt.core import service

search_events = service.search_events
get_event = service.get_event
join_event = service.join_event
create_event = service.create_event
send_message = service.send_message
