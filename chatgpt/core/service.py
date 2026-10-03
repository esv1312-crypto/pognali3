"""Shared Pognali business service.

The service keeps business rules in one place so HTTP, MCP, Android and web clients
share the same event/participant/invitation semantics. If DATABASE_URL is configured,
state is persisted in PostgreSQL; otherwise an in-process store is used for local
development.
"""
from datetime import date, datetime
import os
import threading

try:
    import psycopg
    from psycopg.rows import dict_row
except ImportError:  # local skeleton can still run without Postgres
    psycopg = None
    dict_row = None

LOCK = threading.RLock()
DATABASE_URL = os.environ.get("DATABASE_URL")

EVENTS = [
    {"id": "demo-football-1", "title": "Футбол", "emoji": "⚽", "category": "sport", "date": "2026-10-01", "time": "20:30",
     "place": {"name": "Парк", "city": "Екатеринбург"}, "description": "Дружеская игра. Собираем компанию.",
     "max_participants": 10, "min_age": 18, "max_age": 35, "creator_id": "demo-organizer",
     "participant_ids": [f"demo-football-user-{i}" for i in range(1, 8)]},
    {"id": "demo-run-1", "title": "Пробежка", "emoji": "🏃", "category": "sport", "date": "2026-10-01", "time": "19:00",
     "place": {"name": "Центральный парк", "city": "Екатеринбург"}, "description": "Спокойная совместная пробежка.",
     "max_participants": 12, "min_age": 18, "max_age": 45, "creator_id": "demo-organizer-2",
     "participant_ids": [f"demo-run-user-{i}" for i in range(1, 6)]},
]
MESSAGES = {}
INVITES = []
QUESTIONS = []
USERS = {"chatgpt-user": {"id": "chatgpt-user", "name": "Пользователь"}}
_INITIALIZED = False


def _db():
    return psycopg.connect(DATABASE_URL, row_factory=dict_row) if DATABASE_URL and psycopg else None


def _init_db():
    global _INITIALIZED
    if _INITIALIZED or not DATABASE_URL or not psycopg:
        return
    with _db() as conn:
        conn.execute("""
        CREATE TABLE IF NOT EXISTS pognali_events (
          id TEXT PRIMARY KEY, title TEXT NOT NULL, emoji TEXT NOT NULL, category TEXT NOT NULL,
          event_date DATE NOT NULL, event_time TEXT NOT NULL, place JSONB NOT NULL,
          description TEXT NOT NULL DEFAULT '', max_participants INTEGER NOT NULL,
          min_age INTEGER NOT NULL, max_age INTEGER NOT NULL, creator_id TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'open'
        )""")
        conn.execute("""
        CREATE TABLE IF NOT EXISTS pognali_participants (
          event_id TEXT NOT NULL REFERENCES pognali_events(id) ON DELETE CASCADE,
          user_id TEXT NOT NULL, joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY(event_id,user_id)
        )""")
        conn.execute("""
        CREATE TABLE IF NOT EXISTS pognali_messages (
          id BIGSERIAL PRIMARY KEY, event_id TEXT NOT NULL REFERENCES pognali_events(id) ON DELETE CASCADE,
          user_id TEXT NOT NULL, text TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )""")
        conn.execute("""
        CREATE TABLE IF NOT EXISTS pognali_invites (
          id TEXT PRIMARY KEY, event_id TEXT NOT NULL REFERENCES pognali_events(id) ON DELETE CASCADE,
          sender_user_id TEXT NOT NULL, recipient_user_id TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending', created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )""")
        conn.execute("""
        CREATE TABLE IF NOT EXISTS pognali_questions (
          id BIGSERIAL PRIMARY KEY, event_id TEXT NOT NULL REFERENCES pognali_events(id) ON DELETE CASCADE,
          user_id TEXT NOT NULL, text TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )""")
        conn.commit()
    _INITIALIZED = True


def _using_db():
    _init_db()
    return bool(DATABASE_URL and psycopg)


def _status(event):
    if event.get("completed") or event.get("status") == "completed":
        return "completed"
    now = datetime.now()
    try:
        starts = datetime.strptime(f"{event['date']} {event['time']}", "%Y-%m-%d %H:%M")
    except (TypeError, ValueError):
        return "open"
    # Event duration is intentionally a product-level approximation until an explicit end time exists.
    if now < starts:
        return "full" if _count(event) >= event["max_participants"] else "open"
    return "live" if (now - starts).total_seconds() < 3 * 3600 else "completed"


def _count(event):
    return len(event.get("participant_ids", []))


def _public(event):
    result = dict(event)
    result.pop("participant_ids", None)
    result["participant_count"] = _count(event)
    result["age_range"] = {"min": event["min_age"], "max": event["max_age"]}
    result["status"] = _status(event)
    result["remaining_slots"] = max(event["max_participants"] - result["participant_count"], 0)
    return result


def _local_events():
    return EVENTS


def _db_events(city=None, event_date=None, category=None, user_age=None):
    clauses, params = [], []
    if event_date:
        clauses.append("e.event_date = %s"); params.append(event_date)
    if city:
        clauses.append("LOWER(e.place->>'city') = LOWER(%s)"); params.append(city)
    if category:
        clauses.append("e.category = %s"); params.append(category)
    where = (" WHERE " + " AND ".join(clauses)) if clauses else ""
    with _db() as conn:
        rows = conn.execute("""
          SELECT e.*, COALESCE(array_agg(p.user_id) FILTER (WHERE p.user_id IS NOT NULL), ARRAY[]::text[]) AS participant_ids
          FROM pognali_events e LEFT JOIN pognali_participants p ON p.event_id=e.id
        """ + where + " GROUP BY e.id ORDER BY e.event_date,e.event_time", params).fetchall()
    result = []
    for row in rows:
        row["date"] = row.pop("event_date").isoformat()
        row["time"] = row["event_time"]
        if user_age is not None and not row["min_age"] <= user_age <= row["max_age"]:
            continue
        result.append(dict(row))
    return result


def search_events(city=None, event_date=None, category=None, user_age=None):
    # None means all dates; "weekend" means the nearest Saturday/Sunday pair.
    if event_date == "weekend":
        today = date.today()
        days_to_sat = (5 - today.weekday()) % 7
        saturday = today.fromordinal(today.toordinal() + days_to_sat)
        sunday = saturday.fromordinal(saturday.toordinal() + 1)
        allowed_dates = {saturday.isoformat(), sunday.isoformat()}
    elif event_date:
        allowed_dates = {event_date}
    else:
        allowed_dates = None
    if _using_db():
        if allowed_dates is None:
            rows = _db_events(city, None, category, user_age)
        else:
            rows = []
            for d in sorted(allowed_dates):
                rows.extend(_db_events(city, d, category, user_age))
        return {"events": [_public(e) for e in rows]}
    items = []
    for event in _local_events():
        if allowed_dates is not None and event["date"] not in allowed_dates:
            continue
        if city and event["place"].get("city", "").lower() != city.lower():
            continue
        if category and event["category"] != category:
            continue
        if user_age is not None and (not isinstance(user_age, int) or not event["min_age"] <= user_age <= event["max_age"]):
            continue
        items.append(_public(event))
    return {"events": items}


def _find_event(event_id):
    if _using_db():
        rows = _db_events()
        return next((e for e in rows if e["id"] == event_id), None)
    return next((e for e in EVENTS if e["id"] == event_id), None)


def get_event(event_id):
    event = _find_event(event_id)
    if not event:
        return {"error": "EVENT_NOT_FOUND"}
    result = _public(event)
    if _using_db():
        with _db() as conn:
            users = conn.execute("SELECT user_id FROM pognali_participants WHERE event_id=%s ORDER BY joined_at", (event_id,)).fetchall()
        result["participants"] = [{"id": u["user_id"], "name": USERS.get(u["user_id"], {}).get("name", u["user_id"])} for u in users]
    else:
        result["participants"] = [{"id": u, "name": USERS.get(u, {}).get("name", u)} for u in event["participant_ids"]]
    return result


def join_event(event_id, user_id, user_age):
    if not user_id or not isinstance(user_age, int):
        return {"error": "VALIDATION_ERROR"}
    with LOCK:
        event = _find_event(event_id)
        if not event:
            return {"error": "EVENT_NOT_FOUND"}
        if not _valid_iso_date(event["date"]):
            return {"error": "VALIDATION_ERROR"}
        if event["date"] < date.today().isoformat():
            return {"error": "EVENT_EXPIRED"}
        if event["date"] == date.today().isoformat():
            try:
                if datetime.strptime(f"{event['date']} {event['time']}", "%Y-%m-%d %H:%M") < datetime.now():
                    return {"error": "EVENT_STARTED"}
            except ValueError:
                return {"error": "VALIDATION_ERROR"}
        if user_id in event.get("participant_ids", []):
            return {"error": "ALREADY_JOINED"}
        if _count(event) >= event["max_participants"]:
            return {"error": "EVENT_FULL"}
        if not event["min_age"] <= user_age <= event["max_age"]:
            return {"error": "AGE_RESTRICTED"}
        if _using_db():
            with _db() as conn:
                try:
                    conn.execute("INSERT INTO pognali_participants(event_id,user_id) VALUES(%s,%s)", (event_id,user_id))
                    conn.commit()
                except Exception:
                    conn.rollback()
                    return {"error": "ALREADY_JOINED"}
        else:
            event["participant_ids"].append(user_id)
        event = _find_event(event_id)
        return {"event_id": event_id, "joined": True, "participant_count": _count(event), "max_participants": event["max_participants"]}


def leave_event(event_id, user_id):
    with LOCK:
        event = _find_event(event_id)
        if not event:
            return {"error": "EVENT_NOT_FOUND"}
        if user_id == event["creator_id"]:
            return {"error": "CREATOR_CANNOT_LEAVE"}
        if user_id not in event.get("participant_ids", []):
            return {"error": "NOT_JOINED"}
        if _using_db():
            with _db() as conn:
                conn.execute("DELETE FROM pognali_participants WHERE event_id=%s AND user_id=%s", (event_id,user_id))
                conn.commit()
        else:
            event["participant_ids"].remove(user_id)
        event = _find_event(event_id)
        return {"event_id": event_id, "left": True, "participant_count": _count(event), "max_participants": event["max_participants"]}


def my_events(user_id):
    if not isinstance(user_id, str) or not user_id.strip():
        return {"error": "VALIDATION_ERROR"}
    if _using_db():
        with _db() as conn:
            rows = conn.execute("""
              SELECT e.*, COALESCE(array_agg(p.user_id) FILTER (WHERE p.user_id IS NOT NULL), ARRAY[]::text[]) participant_ids
              FROM pognali_events e LEFT JOIN pognali_participants p ON p.event_id=e.id
              WHERE e.creator_id=%s OR EXISTS (SELECT 1 FROM pognali_participants x WHERE x.event_id=e.id AND x.user_id=%s)
              GROUP BY e.id ORDER BY e.event_date,e.event_time
            """,(user_id,user_id)).fetchall()
        for r in rows:
            r["date"]=r.pop("event_date").isoformat(); r["time"]=r["event_time"]
        return {"events":[_public(dict(r)) for r in rows]}
    return {"events":[_public(e) for e in EVENTS if e["creator_id"] == user_id or user_id in e["participant_ids"]]}


def _valid_iso_date(value):
    try: datetime.strptime(value, "%Y-%m-%d"); return True
    except (TypeError, ValueError): return False


def _valid_time(value):
    try: datetime.strptime(value, "%H:%M"); return True
    except (TypeError, ValueError): return False


def create_event(title, event_date, time, place, max_participants, min_age, max_age,
                 category="other", emoji="📍", description="", creator_id="chatgpt-user"):
    if not isinstance(title, str) or not title.strip() or not _valid_iso_date(event_date) or not _valid_time(time):
        return {"error":"VALIDATION_ERROR"}
    if not isinstance(place, dict) or not place.get("name") or not isinstance(max_participants,int) or max_participants < 1:
        return {"error":"VALIDATION_ERROR"}
    if not isinstance(min_age,int) or min_age < 0 or not isinstance(max_age,int) or max_age < min_age:
        return {"error":"VALIDATION_ERROR"}
    if not all(isinstance(x,str) and x.strip() for x in [category,emoji,creator_id]) or not isinstance(description,str):
        return {"error":"VALIDATION_ERROR"}
    event = {"id":"event-"+str(int(datetime.now().timestamp()*1000)), "title":title.strip(),"emoji":emoji.strip(),
             "category":category.strip(),"date":event_date,"time":time,"place":place,
             "description":description.strip(),"max_participants":max_participants,"min_age":min_age,
             "max_age":max_age,"creator_id":creator_id.strip(),"participant_ids":[]}
    with LOCK:
        if _using_db():
            with _db() as conn:
                conn.execute("""INSERT INTO pognali_events
                  (id,title,emoji,category,event_date,event_time,place,description,max_participants,min_age,max_age,creator_id)
                  VALUES(%s,%s,%s,%s,%s,%s,%s::jsonb,%s,%s,%s,%s,%s)""",
                  (event["id"],event["title"],event["emoji"],event["category"],event["date"],event["time"],
                   __import__("json").dumps(event["place"]),event["description"],event["max_participants"],
                   event["min_age"],event["max_age"],event["creator_id"]))
                conn.commit()
        else:
            EVENTS.append(event)
    return _public(event)


def delete_event(event_id, user_id):
    event=_find_event(event_id)
    if not event: return {"error":"EVENT_NOT_FOUND"}
    if event["creator_id"] != user_id: return {"error":"NOT_AUTHORIZED"}
    if _using_db():
        with _db() as conn: conn.execute("DELETE FROM pognali_events WHERE id=%s",(event_id,)); conn.commit()
    else: EVENTS.remove(event)
    return {"event_id":event_id,"deleted":True}


def complete_event(event_id, user_id):
    event=_find_event(event_id)
    if not event: return {"error":"EVENT_NOT_FOUND"}
    if event["creator_id"] != user_id: return {"error":"NOT_AUTHORIZED"}
    if _using_db():
        with _db() as conn: conn.execute("UPDATE pognali_events SET status='completed' WHERE id=%s",(event_id,)); conn.commit()
    else: event["completed"]=True
    return {"event_id":event_id,"completed":True}


def send_message(event_id, user_id, text):
    if not _find_event(event_id): return {"error":"EVENT_NOT_FOUND"}
    if not isinstance(text,str) or not text.strip(): return {"error":"VALIDATION_ERROR"}
    event=_find_event(event_id)
    if user_id != event["creator_id"] and user_id not in event.get("participant_ids",[]): return {"error":"NOT_AUTHORIZED"}
    if _using_db():
        with _db() as conn:
            row=conn.execute("INSERT INTO pognali_messages(event_id,user_id,text) VALUES(%s,%s,%s) RETURNING id,created_at",(event_id,user_id,text.strip())).fetchone()
            conn.commit()
        return {"id":"message-"+str(row["id"]),"event_id":event_id,"user_id":user_id,"text":text.strip()}
    msg={"id":"message-"+str(sum(len(x) for x in MESSAGES.values())+1),"event_id":event_id,"user_id":user_id,"text":text.strip()}
    MESSAGES.setdefault(event_id,[]).append(msg); return msg


def get_messages(event_id, limit=50):
    if not _find_event(event_id): return {"error":"EVENT_NOT_FOUND"}
    if not isinstance(limit,int) or limit<1: return {"error":"VALIDATION_ERROR"}
    if _using_db():
        with _db() as conn:
            rows=conn.execute("SELECT id,event_id,user_id,text,created_at FROM pognali_messages WHERE event_id=%s ORDER BY id DESC LIMIT %s",(event_id,limit)).fetchall()
        return {"event_id":event_id,"messages":[{"id":"message-"+str(r["id"]),"event_id":r["event_id"],"user_id":r["user_id"],"text":r["text"],"created_at":r["created_at"].isoformat()} for r in reversed(rows)]}
    return {"event_id":event_id,"messages":MESSAGES.get(event_id,[])[-limit:]}


def create_invite(event_id,sender_user_id,recipient_user_id):
    event=_find_event(event_id)
    if not event: return {"error":"EVENT_NOT_FOUND"}
    if sender_user_id != event["creator_id"] and sender_user_id not in event.get("participant_ids",[]): return {"error":"NOT_AUTHORIZED"}
    if recipient_user_id == sender_user_id: return {"error":"INVALID_RECIPIENT"}
    if recipient_user_id in event.get("participant_ids",[]): return {"error":"ALREADY_JOINED"}
    existing = None
    if _using_db():
        with _db() as conn:
            existing=conn.execute("SELECT id FROM pognali_invites WHERE event_id=%s AND recipient_user_id=%s AND status='pending'",(event_id,recipient_user_id)).fetchone()
        if existing: return {"error":"INVITE_ALREADY_SENT","invite_id":existing["id"]}
    else:
        existing=next((i for i in INVITES if i["event_id"]==event_id and i["recipient_user_id"]==recipient_user_id and i["status"]=="pending"),None)
        if existing: return {"error":"INVITE_ALREADY_SENT","invite_id":existing["id"]}
    invite_id="invite-"+str(int(datetime.now().timestamp()*1000))
    invite={"id":invite_id,"event_id":event_id,"sender_user_id":sender_user_id,"recipient_user_id":recipient_user_id,"status":"pending",
            "invite_text":prepare_invite(event_id,sender_user_id)["invite_text"]}
    if _using_db():
        with _db() as conn:
            conn.execute("INSERT INTO pognali_invites(id,event_id,sender_user_id,recipient_user_id) VALUES(%s,%s,%s,%s)",(invite_id,event_id,sender_user_id,recipient_user_id)); conn.commit()
    else: INVITES.append(invite)
    return invite


def get_user_invites(user_id):
    if _using_db():
        with _db() as conn:
            rows=conn.execute("SELECT * FROM pognali_invites WHERE recipient_user_id=%s ORDER BY created_at DESC",(user_id,)).fetchall()
        result=[]
        for i in rows:
            d=dict(i); d["invite_text"]=prepare_invite(i["event_id"],i["sender_user_id"]).get("invite_text",""); result.append(d)
        return {"invites":result}
    return {"invites":[dict(i) for i in INVITES if i["recipient_user_id"]==user_id]}


def accept_invite(invite_id,user_id,user_age):
    if _using_db():
        with _db() as conn: i=conn.execute("SELECT * FROM pognali_invites WHERE id=%s",(invite_id,)).fetchone()
    else: i=next((x for x in INVITES if x["id"]==invite_id),None)
    if not i: return {"error":"INVITE_NOT_FOUND"}
    if i["recipient_user_id"] != user_id: return {"error":"NOT_AUTHORIZED"}
    if i["status"] != "pending": return {"error":"INVITE_NOT_PENDING"}
    joined=join_event(i["event_id"],user_id,user_age)
    if joined.get("error"): return joined
    if _using_db():
        with _db() as conn: conn.execute("UPDATE pognali_invites SET status='accepted' WHERE id=%s",(invite_id,)); conn.commit()
    else: i["status"]="accepted"
    return {"invite_id":invite_id,"status":"accepted",**joined}


def decline_invite(invite_id,user_id):
    if _using_db():
        with _db() as conn: i=conn.execute("SELECT * FROM pognali_invites WHERE id=%s",(invite_id,)).fetchone()
    else: i=next((x for x in INVITES if x["id"]==invite_id),None)
    if not i: return {"error":"INVITE_NOT_FOUND"}
    if i["recipient_user_id"] != user_id: return {"error":"NOT_AUTHORIZED"}
    if i["status"] != "pending": return {"error":"INVITE_NOT_PENDING"}
    if _using_db():
        with _db() as conn: conn.execute("UPDATE pognali_invites SET status='declined' WHERE id=%s",(invite_id,)); conn.commit()
    else: i["status"]="declined"
    return {"invite_id":invite_id,"status":"declined"}


def prepare_invite(event_id,user_id="chatgpt-user"):
    event=_find_event(event_id)
    if not event: return {"error":"EVENT_NOT_FOUND"}
    if user_id != event["creator_id"] and user_id not in event.get("participant_ids",[]): return {"error":"NOT_AUTHORIZED"}
    remaining=max(event["max_participants"]-_count(event),0)
    place=event["place"].get("name") or event["place"].get("city") or "место уточняется"
    text=f"{event['emoji']} {event['title']} — {event['date']} в {event['time']}, {place}. Уже идут {_count(event)} из {event['max_participants']}. Свободных мест: {remaining}. Погнали?"
    return {"event_id":event_id,"invite_text":text,"remaining_slots":remaining}


def ask_organizer(event_id,user_id,text):
    event=_find_event(event_id)
    if not event: return {"error":"EVENT_NOT_FOUND"}
    if not isinstance(text,str) or not text.strip(): return {"error":"VALIDATION_ERROR"}
    if _using_db():
        with _db() as conn:
            r=conn.execute("INSERT INTO pognali_questions(event_id,user_id,text) VALUES(%s,%s,%s) RETURNING id,created_at",(event_id,user_id,text.strip())).fetchone(); conn.commit()
        return {"id":"question-"+str(r["id"]),"event_id":event_id,"user_id":user_id,"text":text.strip(),"status":"sent"}
    q={"id":"question-"+str(len(QUESTIONS)+1),"event_id":event_id,"user_id":user_id,"text":text.strip(),"status":"sent"}; QUESTIONS.append(q); return q
