CREATE TABLE IF NOT EXISTS users (
  id BIGINT PRIMARY KEY,
  username TEXT,
  first_name TEXT NOT NULL DEFAULT '',
  last_name TEXT NOT NULL DEFAULT '',
  display_name TEXT,
  photo_url TEXT,
  photo_data BYTEA,
  photo_mime TEXT,
  avatar_key TEXT,
  birth_date DATE,
  birth_day SMALLINT CHECK (birth_day IS NULL OR birth_day BETWEEN 1 AND 31),
  birth_month SMALLINT CHECK (birth_month IS NULL OR birth_month BETWEEN 1 AND 12),
  birth_year SMALLINT CHECK (birth_year IS NULL OR birth_year BETWEEN 1900 AND 2100),
  city TEXT,
  bio TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS photo_data BYTEA;
ALTER TABLE users ADD COLUMN IF NOT EXISTS photo_mime TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS users_avatar_key_idx ON users(avatar_key) WHERE avatar_key IS NOT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS birth_date DATE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS birth_day SMALLINT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS birth_month SMALLINT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS birth_year SMALLINT;

CREATE TABLE IF NOT EXISTS events (
  id BIGSERIAL PRIMARY KEY,
  creator_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL CHECK (char_length(title) BETWEEN 3 AND 120),
  description TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'other',
  emoji TEXT NOT NULL DEFAULT '',
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
ALTER TABLE events ADD COLUMN IF NOT EXISTS emoji TEXT NOT NULL DEFAULT '';
ALTER TABLE events ADD COLUMN IF NOT EXISTS age_range TEXT NOT NULL DEFAULT 'Любой возраст';
ALTER TABLE events ADD COLUMN IF NOT EXISTS live_note TEXT NOT NULL DEFAULT '';
ALTER TABLE events DROP CONSTRAINT IF EXISTS events_status_check;
ALTER TABLE events ADD CONSTRAINT events_status_check CHECK (status IN ('published','pending_review','cancelled','completed'));
ALTER TABLE events ADD COLUMN IF NOT EXISTS moderation_decision TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE events ADD COLUMN IF NOT EXISTS moderation_reason TEXT NOT NULL DEFAULT '';
ALTER TABLE events ADD COLUMN IF NOT EXISTS moderated_at TIMESTAMPTZ;

-- Saved events and recurring meetups. Additive migration: existing events and participants remain untouched.
CREATE TABLE IF NOT EXISTS event_favorites (
  event_id BIGINT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (event_id, user_id)
);
CREATE INDEX IF NOT EXISTS event_favorites_user_idx ON event_favorites(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS event_series (
  id BIGSERIAL PRIMARY KEY,
  creator_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  base_event_id BIGINT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  recurrence_rule TEXT NOT NULL CHECK (recurrence_rule IN ('daily','weekly','monthly')),
  interval_count SMALLINT NOT NULL DEFAULT 1 CHECK (interval_count BETWEEN 1 AND 4),
  occurrence_count SMALLINT NOT NULL CHECK (occurrence_count BETWEEN 2 AND 52),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE events ADD COLUMN IF NOT EXISTS series_id BIGINT REFERENCES event_series(id) ON DELETE SET NULL;
ALTER TABLE event_series DROP CONSTRAINT IF EXISTS event_series_recurrence_rule_check;
ALTER TABLE event_series ADD CONSTRAINT event_series_recurrence_rule_check CHECK (recurrence_rule IN ('daily','weekly','monthly','custom'));
ALTER TABLE events ADD COLUMN IF NOT EXISTS series_index SMALLINT;
CREATE INDEX IF NOT EXISTS events_series_idx ON events(series_id, series_index) WHERE series_id IS NOT NULL;


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

-- Organizer-approved exceptions to an event's suggested age range.
CREATE TABLE IF NOT EXISTS event_age_approvals (
  event_id BIGINT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  approved_by BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  approved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (event_id, user_id)
);
CREATE INDEX IF NOT EXISTS event_age_approvals_approver_idx ON event_age_approvals(approved_by, approved_at DESC);

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

-- Append-only history of moderator decisions for each report.
CREATE TABLE IF NOT EXISTS event_report_actions (
 id BIGSERIAL PRIMARY KEY,
 report_id BIGINT NOT NULL REFERENCES event_reports(id) ON DELETE CASCADE,
 actor_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 previous_status TEXT NOT NULL CHECK (previous_status IN ('open','reviewing','resolved','dismissed')),
 new_status TEXT NOT NULL CHECK (new_status IN ('open','reviewing','resolved','dismissed')),
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS event_report_actions_report_created_idx ON event_report_actions(report_id, created_at DESC);
CREATE INDEX IF NOT EXISTS event_report_actions_actor_created_idx ON event_report_actions(actor_id, created_at DESC);

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


-- Durable Telegram notification outbox. Pending jobs survive application restarts.
CREATE TABLE IF NOT EXISTS telegram_notification_outbox (
  id BIGSERIAL PRIMARY KEY,
  chat_id TEXT NOT NULL,
  message_text TEXT NOT NULL,
  reply_markup JSONB,
  dedupe_key TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sending','failed')),
  attempts SMALLINT NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE telegram_notification_outbox ADD COLUMN IF NOT EXISTS reply_markup JSONB;
CREATE INDEX IF NOT EXISTS telegram_notification_outbox_ready_idx
  ON telegram_notification_outbox(status, available_at, id) WHERE status='pending';
CREATE UNIQUE INDEX IF NOT EXISTS telegram_notification_outbox_active_dedupe_idx
  ON telegram_notification_outbox(dedupe_key)
  WHERE dedupe_key IS NOT NULL AND status IN ('pending','sending');

CREATE TABLE IF NOT EXISTS telegram_notification_dedup (
  dedupe_key TEXT PRIMARY KEY,
  last_sent_at TIMESTAMPTZ NOT NULL
);


-- Audit trail for moderator actions that remove events from public listings.
CREATE TABLE IF NOT EXISTS event_moderation_actions (
 id BIGSERIAL PRIMARY KEY,
 event_id BIGINT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
 actor_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 action TEXT NOT NULL CHECK (action IN ('cancelled_by_moderator','kept_published_by_moderator')),
 previous_status TEXT NOT NULL CHECK (previous_status IN ('published')),
 new_status TEXT NOT NULL CHECK (new_status IN ('published','cancelled')),
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE event_moderation_actions ALTER COLUMN actor_id DROP NOT NULL;
ALTER TABLE event_moderation_actions ADD COLUMN IF NOT EXISTS actor_type TEXT NOT NULL DEFAULT 'admin';
ALTER TABLE event_moderation_actions ADD COLUMN IF NOT EXISTS reason TEXT NOT NULL DEFAULT '';
ALTER TABLE event_moderation_actions DROP CONSTRAINT IF EXISTS event_moderation_actions_action_check;
ALTER TABLE event_moderation_actions ADD CONSTRAINT event_moderation_actions_action_check CHECK (action IN (
 'cancelled_by_moderator','kept_published_by_moderator','auto_published','auto_sent_to_review','auto_blocked',
 'approved_by_moderator','rejected_by_moderator','restored_by_moderator'
));
ALTER TABLE event_moderation_actions DROP CONSTRAINT IF EXISTS event_moderation_actions_previous_status_check;
ALTER TABLE event_moderation_actions ADD CONSTRAINT event_moderation_actions_previous_status_check CHECK (previous_status IN ('new','published','pending_review','cancelled'));
ALTER TABLE event_moderation_actions DROP CONSTRAINT IF EXISTS event_moderation_actions_new_status_check;
ALTER TABLE event_moderation_actions ADD CONSTRAINT event_moderation_actions_new_status_check CHECK (new_status IN ('published','pending_review','cancelled'));
ALTER TABLE event_moderation_actions DROP CONSTRAINT IF EXISTS event_moderation_actions_actor_type_check;
ALTER TABLE event_moderation_actions ADD CONSTRAINT event_moderation_actions_actor_type_check CHECK (actor_type IN ('system','admin'));
CREATE INDEX IF NOT EXISTS event_moderation_actions_event_created_idx
 ON event_moderation_actions(event_id, created_at DESC);
CREATE INDEX IF NOT EXISTS event_moderation_actions_actor_created_idx
 ON event_moderation_actions(actor_id, created_at DESC);
