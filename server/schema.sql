CREATE TABLE IF NOT EXISTS users (
  id BIGINT PRIMARY KEY,
  username TEXT,
  first_name TEXT NOT NULL DEFAULT '',
  last_name TEXT NOT NULL DEFAULT '',
  display_name TEXT,
  photo_url TEXT,
  city TEXT,
  bio TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name TEXT;

CREATE TABLE IF NOT EXISTS events (
  id BIGSERIAL PRIMARY KEY,
  creator_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL CHECK (char_length(title) BETWEEN 3 AND 120),
  description TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'other',
  city TEXT NOT NULL,
  address TEXT NOT NULL DEFAULT '',
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ,
  capacity INTEGER CHECK (capacity IS NULL OR capacity BETWEEN 1 AND 5000),
  status TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('published','cancelled','completed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ((latitude IS NULL AND longitude IS NULL) OR
         (latitude BETWEEN -90 AND 90 AND longitude BETWEEN -180 AND 180)),
  CHECK (ends_at IS NULL OR ends_at >= starts_at)
);

CREATE INDEX IF NOT EXISTS events_city_starts_idx ON events (LOWER(city), starts_at) WHERE status = 'published';
CREATE INDEX IF NOT EXISTS events_starts_idx ON events (starts_at) WHERE status = 'published';

CREATE TABLE IF NOT EXISTS event_participants (
  event_id BIGINT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'joined' CHECK (status IN ('joined','left')),
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (event_id, user_id)
);
CREATE INDEX IF NOT EXISTS event_participants_user_idx ON event_participants (user_id, status);

CREATE TABLE IF NOT EXISTS event_messages (
  id BIGSERIAL PRIMARY KEY,
  event_id BIGINT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  sender_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS event_messages_event_idx ON event_messages (event_id, created_at);


CREATE TABLE IF NOT EXISTS direct_conversations (
 id BIGSERIAL PRIMARY KEY,user_low BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 user_high BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,requested_by BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','rejected')),
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 CHECK(user_low<user_high),CHECK(requested_by=user_low OR requested_by=user_high),UNIQUE(user_low,user_high));
CREATE INDEX IF NOT EXISTS direct_conversations_inbox_low_idx ON direct_conversations(user_low,status,updated_at DESC);
CREATE INDEX IF NOT EXISTS direct_conversations_inbox_high_idx ON direct_conversations(user_high,status,updated_at DESC);
CREATE TABLE IF NOT EXISTS direct_messages (
 id BIGSERIAL PRIMARY KEY,conversation_id BIGINT NOT NULL REFERENCES direct_conversations(id) ON DELETE CASCADE,
 sender_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,body TEXT NOT NULL CHECK(char_length(body) BETWEEN 1 AND 2000),
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
CREATE INDEX IF NOT EXISTS direct_messages_conversation_idx ON direct_messages(conversation_id,created_at);
CREATE TABLE IF NOT EXISTS user_blocks (
 blocker_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,blocked_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),PRIMARY KEY(blocker_id,blocked_id),CHECK(blocker_id<>blocked_id));
CREATE TABLE IF NOT EXISTS event_contact_conversations (
 id BIGSERIAL PRIMARY KEY,event_id BIGINT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
 participant_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,organizer_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 CHECK(participant_id<>organizer_id),UNIQUE(event_id,participant_id));
CREATE INDEX IF NOT EXISTS event_contact_inbox_participant_idx ON event_contact_conversations(participant_id,updated_at DESC);
CREATE INDEX IF NOT EXISTS event_contact_inbox_organizer_idx ON event_contact_conversations(organizer_id,updated_at DESC);
CREATE TABLE IF NOT EXISTS event_contact_messages (
 id BIGSERIAL PRIMARY KEY,conversation_id BIGINT NOT NULL REFERENCES event_contact_conversations(id) ON DELETE CASCADE,
 sender_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,body TEXT NOT NULL CHECK(char_length(body) BETWEEN 1 AND 2000),
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
CREATE INDEX IF NOT EXISTS event_contact_messages_conversation_idx ON event_contact_messages(conversation_id,created_at);


-- Event reports for moderation
CREATE TABLE IF NOT EXISTS event_reports (
 id BIGSERIAL PRIMARY KEY,
 event_id BIGINT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
 reporter_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 reason TEXT NOT NULL CHECK (reason IN ('spam','fake','inappropriate','unsafe','other')),
 details TEXT CHECK (details IS NULL OR char_length(details) <= 1000),
 status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','reviewing','resolved','dismissed')),
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 UNIQUE(event_id, reporter_id)
);
CREATE INDEX IF NOT EXISTS event_reports_status_created_idx ON event_reports(status, created_at DESC);

-- Event sharing attribution and share/open analytics.
ALTER TABLE event_participants ADD COLUMN IF NOT EXISTS join_source TEXT NOT NULL DEFAULT 'organic';
CREATE INDEX IF NOT EXISTS event_participants_source_idx ON event_participants (event_id, join_source) WHERE status = 'joined';
CREATE TABLE IF NOT EXISTS event_share_events (
 id BIGSERIAL PRIMARY KEY,
 event_id BIGINT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
 user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 action TEXT NOT NULL CHECK (action IN ('share_opened','opened_from_share')),
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS event_share_events_event_idx ON event_share_events (event_id, action, created_at DESC);
CREATE INDEX IF NOT EXISTS event_share_events_user_idx ON event_share_events (user_id, created_at DESC);


-- Per-user read cursor for each conversation; shared conversations need separate cursors per participant.
CREATE TABLE IF NOT EXISTS message_reads (
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_type TEXT NOT NULL CHECK (conversation_type IN ('event','direct','event_contact')),
  conversation_id BIGINT NOT NULL,
  last_read_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, conversation_type, conversation_id)
);
