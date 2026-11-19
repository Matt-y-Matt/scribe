//! The SQLite schema, as numbered migrations (ARCHITECTURE §3.1).
//!
//! `PRAGMA user_version` holds the number of the last migration applied. A
//! migration is never edited once it has shipped: add a new one.

pub const MIGRATIONS: &[&str] = &[
    // 1 — M2: meetings, transcript with full-text search, the map, highlights,
    // and the tables later milestones fill (notes, scribe log, jobs, consent
    // log, settings), so their shape is settled in one place.
    r#"
CREATE TABLE meetings (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  started_at_ms INTEGER,
  ended_at_ms INTEGER,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  mode TEXT NOT NULL DEFAULT 'group',
  privacy TEXT NOT NULL DEFAULT 'local',
  agenda_json TEXT NOT NULL DEFAULT '[]',
  loopback INTEGER NOT NULL DEFAULT 0,
  summary_md TEXT,
  layout_instruction TEXT
);

CREATE TABLE participants (
  id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'guest',
  telegram_chat_id TEXT,
  email TEXT
);
CREATE INDEX participants_by_meeting ON participants(meeting_id);

CREATE TABLE segments (
  id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  t0_ms INTEGER NOT NULL,
  t1_ms INTEGER NOT NULL,
  speaker_participant_id TEXT,
  speaker_label TEXT NOT NULL,
  source TEXT NOT NULL,
  text TEXT NOT NULL,
  confidence REAL NOT NULL
);
CREATE INDEX segments_by_meeting ON segments(meeting_id, t0_ms);

CREATE VIRTUAL TABLE segments_fts USING fts5(
  text,
  content='segments',
  content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
);
CREATE TRIGGER segments_ai AFTER INSERT ON segments BEGIN
  INSERT INTO segments_fts(rowid, text) VALUES (new.rowid, new.text);
END;
CREATE TRIGGER segments_ad AFTER DELETE ON segments BEGIN
  INSERT INTO segments_fts(segments_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
END;
CREATE TRIGGER segments_au AFTER UPDATE ON segments BEGIN
  INSERT INTO segments_fts(segments_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
  INSERT INTO segments_fts(rowid, text) VALUES (new.rowid, new.text);
END;

CREATE TABLE topics (
  id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  parent_id TEXT,
  title TEXT NOT NULL,
  kind TEXT NOT NULL,
  order_key REAL NOT NULL,
  status TEXT NOT NULL,
  off_agenda INTEGER NOT NULL,
  created_t_ms INTEGER NOT NULL,
  pinned_t_ms INTEGER,
  revisited_t_ms INTEGER,
  scheduled_t_ms INTEGER,
  segment_ids_json TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX topics_by_meeting ON topics(meeting_id);

CREATE TABLE cards (
  id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  topic_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  owner TEXT,
  owner_participant_id TEXT,
  due_text TEXT,
  due_date TEXT,
  segment_ids_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL,
  source TEXT NOT NULL,
  created_t_ms INTEGER NOT NULL,
  confirmed INTEGER NOT NULL DEFAULT 0,
  order_key REAL NOT NULL
);
CREATE INDEX cards_by_meeting ON cards(meeting_id);

CREATE TABLE suggestions (
  id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL,
  created_t_ms INTEGER NOT NULL
);
CREATE INDEX suggestions_by_meeting ON suggestions(meeting_id);

CREATE TABLE highlights (
  id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  t0_ms INTEGER NOT NULL,
  t1_ms INTEGER NOT NULL,
  label TEXT NOT NULL DEFAULT ''
);
CREATE INDEX highlights_by_meeting ON highlights(meeting_id);

CREATE TABLE notes (
  id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  participant_id TEXT,
  topic_id TEXT,
  t_ms INTEGER NOT NULL,
  text TEXT NOT NULL,
  shared INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE scribe_log (
  id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  t_ms INTEGER NOT NULL,
  query TEXT NOT NULL,
  intent TEXT,
  answer TEXT,
  ok INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  query TEXT NOT NULL,
  status TEXT NOT NULL,
  result_json TEXT,
  card_id TEXT
);

CREATE TABLE consent_log (
  id TEXT PRIMARY KEY,
  meeting_id TEXT,
  participant_id TEXT,
  event TEXT NOT NULL,
  t_ms INTEGER NOT NULL,
  detail TEXT
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL
);
"#,
    // 2 — actions that carry over: when an action was marked done (wall
    // clock, milliseconds since 1970), or NULL while it is still open.
    r#"
ALTER TABLE cards ADD COLUMN done_at_ms INTEGER;
"#,
    // 3 — the transcript cleaned up after Stop by a second speech model:
    // what the live model heard is kept beside the line that replaced it,
    // and the meeting remembers when it was cleaned.
    r#"
ALTER TABLE segments ADD COLUMN live_text TEXT;
ALTER TABLE meetings ADD COLUMN cleaned_at_ms INTEGER;
"#,
];
