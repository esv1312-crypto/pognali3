"""Shared in-process Pognali business service used by HTTP and MCP transports."""
from datetime import date

EVENTS = [
    {"id":"demo-football-1","title":"Футбол","emoji":"⚽","category":"sport","date":"2026-10-01","time":"20:30","place":{"name":"Парк","city":"Екатеринбург"},"description":"Дружеская игра. Собираем компанию.","max_participants":10,"min_age":18,"max_age":35,"creator_id":"demo-organizer","participant_count":7,"participant_ids":[]},
    {"id":"demo-run-1","title":"Пробежка","emoji":"🏃","category":"sport","date":"2026-10-01","time":"19:00","place":{"name":"Центральный парк","city":"Екатеринбург"},"description":"Спокойная совместная пробежка.","max_participants":12,"min_age":18,"max_age":45,"creator_id":"demo-organizer-2","participant_count":5,"participant_ids":[]},
]
MESSAGES = {}

def public_event(event):
    result = dict(event)
    result.pop("participant_ids", None)
    result["age_range"] = {"min": event["min_age"], "max": event["max_age"]}
    return result

def search_events(city=None, event_date=None, category=None, user_age=None):
    target_date = event_date or date.today().isoformat()
    items = []
    for event in EVENTS:
        if event["date"] != target_date:
            continue
        if city and event["place"].get("city","").lower() != city.lower():
            continue
        if category and event["category"] != category:
            continue
        if user_age is not None and not event["min_age"] <= user_age <= event["max_age"]:
            continue
        items.append(public_event(event))
    return {"events": items}

def get_event(event_id):
    event = next((e for e in EVENTS if e["id"] == event_id), None)
    if not event:
        return {"error":"EVENT_NOT_FOUND"}
    return public_event(event)

def join_event(event_id, user_id, user_age):
    event = next((e for e in EVENTS if e["id"] == event_id), None)
    if not event: return {"error":"EVENT_NOT_FOUND"}
    if event["date"] < date.today().isoformat(): return {"error":"EVENT_EXPIRED"}
    if not user_id or user_age is None: return {"error":"VALIDATION_ERROR"}
    if user_id in event["participant_ids"]: return {"error":"ALREADY_JOINED"}
    if event["participant_count"] >= event["max_participants"]: return {"error":"EVENT_FULL"}
    if not event["min_age"] <= user_age <= event["max_age"]: return {"error":"AGE_RESTRICTED"}
    event["participant_ids"].append(user_id)
    event["participant_count"] += 1
    return {"event_id":event_id,"joined":True,"participant_count":event["participant_count"],"max_participants":event["max_participants"]}

def create_event(title, event_date, time, place, max_participants, min_age, max_age,
                 category="other", emoji="📍", description="", creator_id="chatgpt-user"):
    if not title or not event_date or not time or not place:
        return {"error":"VALIDATION_ERROR"}
    if max_participants < 1 or min_age < 0 or max_age < min_age:
        return {"error":"VALIDATION_ERROR"}
    event = {"id":"event-"+str(len(EVENTS)+1),"title":title,"emoji":emoji,"category":category,
             "date":event_date,"time":time,"place":place,"description":description,
             "max_participants":max_participants,"min_age":min_age,"max_age":max_age,
             "creator_id":creator_id,"participant_count":0,"participant_ids":[]}
    EVENTS.append(event)
    return public_event(event)

def send_message(event_id, user_id, text):
    if not any(e["id"] == event_id for e in EVENTS): return {"error":"EVENT_NOT_FOUND"}
    if not user_id or not text: return {"error":"VALIDATION_ERROR"}
    message = {"user_id":user_id,"text":text}
    MESSAGES.setdefault(event_id, []).append(message)
    return message
