//! Everything that outlives a launch: meetings, the transcript and its
//! full-text index, the map, highlights (ARCHITECTURE §3.1).
//!
//! One SQLite file in the app data folder, opened in WAL mode. The Rust core
//! is the only writer: segments are saved as they are transcribed, and the
//! map engine in the webview saves each of its commits through one command,
//! in one transaction.

mod schema;

use std::path::Path;
use std::str::FromStr;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use specta::Type;
use sqlx::sqlite::{
    SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteRow, SqliteSynchronous,
};
use sqlx::{Row, SqlitePool};

use crate::ipc::SegmentFinal;

pub type Result<T> = std::result::Result<T, sqlx::Error>;

/// An enum stored as text in SQLite and sent as the same text to the UI.
macro_rules! text_enum {
    ($(#[$meta:meta])* $name:ident { $($variant:ident => $text:literal),+ $(,)? }) => {
        $(#[$meta])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
        pub enum $name {
            $(#[serde(rename = $text)] $variant),+
        }

        impl $name {
            pub const fn as_str(self) -> &'static str {
                match self { $(Self::$variant => $text),+ }
            }

            // Not every enum is read back from a column.
            #[allow(dead_code)]
            fn parse(text: &str) -> std::result::Result<Self, sqlx::Error> {
                match text {
                    $($text => Ok(Self::$variant),)+
                    other => Err(sqlx::Error::Decode(
                        format!("{} is not a {}", other, stringify!($name)).into(),
                    )),
                }
            }
        }
    };
}

text_enum!(MeetingMode { Group => "group", Solo => "solo" });
text_enum!(TopicKind { Header => "header", Topic => "topic" });
text_enum!(TopicStatus { Active => "active", Pinned => "pinned", Done => "done" });
text_enum!(CardKind {
    Note => "note",
    Decision => "decision",
    Action => "action",
    Research => "research",
    Quote => "quote",
});
text_enum!(CardStatus { Proposed => "proposed", Accepted => "accepted", Dismissed => "dismissed" });
text_enum!(
    /// Who made a change to the map.
    ChangeSource { Engine => "engine", User => "user", Scribe => "scribe" }
);
text_enum!(SuggestionKind { Move => "move", Merge => "merge", Pin => "pin" });
text_enum!(SuggestionStatus { Open => "open", Accepted => "accepted", Dismissed => "dismissed" });
text_enum!(MapEntity { Topic => "topic", Card => "card", Suggestion => "suggestion" });

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct NewMeeting {
    pub title: String,
    /// Agenda headers, in order.
    pub agenda: Vec<String>,
    pub mode: MeetingMode,
    /// Names of the people expected, for owner matching.
    pub participants: Vec<String>,
}

/// A meeting as the UI lists it. Wall-clock times are milliseconds since
/// 1970 as `f64`, which holds them exactly and crosses to TypeScript as a
/// number.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct MeetingInfo {
    pub id: String,
    pub title: String,
    pub created_at_ms: f64,
    pub started_at_ms: Option<f64>,
    pub ended_at_ms: Option<f64>,
    /// Length of the recording on the meeting clock.
    pub duration_ms: u32,
    pub mode: MeetingMode,
    pub agenda: Vec<String>,
    pub participants: Vec<String>,
    /// Whether system audio was recorded as well as the microphone.
    pub loopback: bool,
}

impl MeetingInfo {
    /// Started and never stopped: a meeting to recover after a crash.
    pub fn is_unfinished(&self) -> bool {
        self.started_at_ms.is_some() && self.ended_at_ms.is_none()
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct TopicRow {
    pub id: String,
    pub meeting_id: String,
    pub parent_id: Option<String>,
    pub title: String,
    pub kind: TopicKind,
    pub order_key: f64,
    pub status: TopicStatus,
    pub off_agenda: bool,
    pub created_t_ms: u32,
    pub pinned_t_ms: Option<u32>,
    pub revisited_t_ms: Option<u32>,
    pub scheduled_t_ms: Option<u32>,
    pub segment_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct CardRow {
    pub id: String,
    pub meeting_id: String,
    pub topic_id: String,
    pub kind: CardKind,
    pub text: String,
    pub owner: Option<String>,
    pub due_text: Option<String>,
    pub segment_ids: Vec<String>,
    pub status: CardStatus,
    pub source: ChangeSource,
    pub created_t_ms: u32,
    pub confirmed: bool,
    pub order_key: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct SuggestionRow {
    pub id: String,
    pub meeting_id: String,
    pub kind: SuggestionKind,
    /// The suggestion's payload as JSON; its shape belongs to the engine.
    pub payload_json: String,
    pub status: SuggestionStatus,
    pub created_t_ms: u32,
}

/// The saved map of one meeting.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, Type)]
pub struct MapRows {
    pub topics: Vec<TopicRow>,
    pub cards: Vec<CardRow>,
    pub suggestions: Vec<SuggestionRow>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct DeletedRow {
    pub entity: MapEntity,
    pub id: String,
}

/// One commit of the map engine: the rows as they are now, and the rows that
/// are gone. Saved in one transaction.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, Type)]
pub struct MapPatch {
    pub topics: Vec<TopicRow>,
    pub cards: Vec<CardRow>,
    pub suggestions: Vec<SuggestionRow>,
    pub deleted: Vec<DeletedRow>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct Highlight {
    pub id: String,
    pub meeting_id: String,
    pub t0_ms: u32,
    pub t1_ms: u32,
    pub label: String,
}

pub fn now_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as f64)
        .unwrap_or(0.0)
}

fn json_list(items: &[String]) -> String {
    serde_json::to_string(items).unwrap_or_else(|_| "[]".to_string())
}

fn list_from(json: &str) -> Vec<String> {
    serde_json::from_str(json).unwrap_or_default()
}

fn ms(row: &SqliteRow, column: &str) -> Result<u32> {
    Ok(row.try_get::<i64, _>(column)?.max(0) as u32)
}

fn opt_ms(row: &SqliteRow, column: &str) -> Result<Option<u32>> {
    Ok(row
        .try_get::<Option<i64>, _>(column)?
        .map(|value| value.max(0) as u32))
}

fn wall(row: &SqliteRow, column: &str) -> Result<Option<f64>> {
    Ok(row
        .try_get::<Option<i64>, _>(column)?
        .map(|value| value as f64))
}

fn segment_from(row: &SqliteRow) -> Result<SegmentFinal> {
    Ok(SegmentFinal {
        id: row.try_get("id")?,
        meeting_id: row.try_get("meeting_id")?,
        t0_ms: ms(row, "t0_ms")?,
        t1_ms: ms(row, "t1_ms")?,
        speaker_label: row.try_get("speaker_label")?,
        source: row.try_get("source")?,
        text: row.try_get("text")?,
        confidence: row.try_get::<f64, _>("confidence")? as f32,
    })
}

/// Turns what someone typed into an FTS5 query: every word must be there,
/// and the last one may be a prefix. Quoting keeps FTS5's own syntax
/// (`AND`, `-`, `:`, `*`) from being read out of the user's words.
pub fn fts_query(typed: &str) -> Option<String> {
    let words: Vec<String> = typed
        .split_whitespace()
        .map(|word| word.replace('"', ""))
        .filter(|word| word.chars().any(char::is_alphanumeric))
        .collect();
    let (last, rest) = words.split_last()?;
    let mut query: Vec<String> = rest.iter().map(|word| format!("\"{word}\"")).collect();
    query.push(format!("\"{last}\"*"));
    Some(query.join(" "))
}

#[derive(Clone)]
pub struct Store {
    pool: SqlitePool,
}

impl Store {
    /// Opens the database file, creating and migrating it as needed.
    pub async fn open(path: &Path) -> Result<Self> {
        let options = SqliteConnectOptions::new()
            .filename(path)
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Wal)
            .synchronous(SqliteSynchronous::Normal)
            .foreign_keys(true)
            .busy_timeout(Duration::from_secs(5));
        let pool = SqlitePoolOptions::new()
            .max_connections(4)
            .connect_with(options)
            .await?;
        let store = Self { pool };
        store.migrate().await?;
        Ok(store)
    }

    /// A private database in memory, for tests.
    pub async fn in_memory() -> Result<Self> {
        let options = SqliteConnectOptions::from_str("sqlite::memory:")?.foreign_keys(true);
        // One connection: each connection to `:memory:` is its own database.
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await?;
        let store = Self { pool };
        store.migrate().await?;
        Ok(store)
    }

    async fn migrate(&self) -> Result<()> {
        let version: i64 = sqlx::query_scalar("PRAGMA user_version")
            .fetch_one(&self.pool)
            .await?;
        for (index, sql) in schema::MIGRATIONS.iter().enumerate().skip(version as usize) {
            let mut tx = self.pool.begin().await?;
            sqlx::raw_sql(sql).execute(&mut *tx).await?;
            sqlx::raw_sql(&format!("PRAGMA user_version = {}", index + 1))
                .execute(&mut *tx)
                .await?;
            tx.commit().await?;
        }
        Ok(())
    }

    // ---- meetings -------------------------------------------------------

    pub async fn create_meeting(&self, id: &str, new: &NewMeeting) -> Result<MeetingInfo> {
        let mut tx = self.pool.begin().await?;
        sqlx::query(
            "INSERT INTO meetings (id, title, created_at_ms, mode, agenda_json) VALUES (?, ?, ?, ?, ?)",
        )
        .bind(id)
        .bind(&new.title)
        .bind(now_ms() as i64)
        .bind(new.mode.as_str())
        .bind(json_list(&new.agenda))
        .execute(&mut *tx)
        .await?;
        for (index, name) in new.participants.iter().enumerate() {
            sqlx::query("INSERT INTO participants (id, meeting_id, name) VALUES (?, ?, ?)")
                .bind(format!("{id}_p{index}"))
                .bind(id)
                .bind(name)
                .execute(&mut *tx)
                .await?;
        }
        tx.commit().await?;
        self.meeting(id).await?.ok_or(sqlx::Error::RowNotFound)
    }

    async fn meeting_from(&self, row: &SqliteRow) -> Result<MeetingInfo> {
        let id: String = row.try_get("id")?;
        let participants: Vec<String> =
            sqlx::query_scalar("SELECT name FROM participants WHERE meeting_id = ? ORDER BY id")
                .bind(&id)
                .fetch_all(&self.pool)
                .await?;
        Ok(MeetingInfo {
            title: row.try_get("title")?,
            created_at_ms: row.try_get::<i64, _>("created_at_ms")? as f64,
            started_at_ms: wall(row, "started_at_ms")?,
            ended_at_ms: wall(row, "ended_at_ms")?,
            duration_ms: ms(row, "duration_ms")?,
            mode: MeetingMode::parse(row.try_get("mode")?)?,
            agenda: list_from(row.try_get("agenda_json")?),
            participants,
            loopback: row.try_get::<i64, _>("loopback")? != 0,
            id,
        })
    }

    pub async fn meeting(&self, id: &str) -> Result<Option<MeetingInfo>> {
        let row = sqlx::query("SELECT * FROM meetings WHERE id = ?")
            .bind(id)
            .fetch_optional(&self.pool)
            .await?;
        match row {
            Some(row) => Ok(Some(self.meeting_from(&row).await?)),
            None => Ok(None),
        }
    }

    /// Every meeting, newest first.
    pub async fn meetings(&self) -> Result<Vec<MeetingInfo>> {
        let rows = sqlx::query("SELECT * FROM meetings ORDER BY created_at_ms DESC, id DESC")
            .fetch_all(&self.pool)
            .await?;
        let mut meetings = Vec::with_capacity(rows.len());
        for row in &rows {
            meetings.push(self.meeting_from(row).await?);
        }
        Ok(meetings)
    }

    pub async fn mark_started(&self, id: &str, loopback: bool) -> Result<()> {
        sqlx::query(
            "UPDATE meetings SET started_at_ms = COALESCE(started_at_ms, ?), loopback = ? WHERE id = ?",
        )
        .bind(now_ms() as i64)
        .bind(loopback)
        .bind(id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn set_duration(&self, id: &str, duration_ms: u32) -> Result<()> {
        sqlx::query("UPDATE meetings SET duration_ms = ? WHERE id = ?")
            .bind(duration_ms)
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn mark_ended(&self, id: &str, duration_ms: u32) -> Result<()> {
        sqlx::query("UPDATE meetings SET ended_at_ms = ?, duration_ms = ? WHERE id = ?")
            .bind(now_ms() as i64)
            .bind(duration_ms)
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    // ---- transcript -----------------------------------------------------

    pub async fn insert_segment(&self, segment: &SegmentFinal) -> Result<()> {
        sqlx::query(
            "INSERT INTO segments (id, meeting_id, t0_ms, t1_ms, speaker_label, source, text, confidence) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&segment.id)
        .bind(&segment.meeting_id)
        .bind(segment.t0_ms)
        .bind(segment.t1_ms)
        .bind(&segment.speaker_label)
        .bind(&segment.source)
        .bind(&segment.text)
        .bind(segment.confidence as f64)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// A meeting's transcript in meeting order.
    pub async fn segments(&self, meeting_id: &str) -> Result<Vec<SegmentFinal>> {
        sqlx::query("SELECT * FROM segments WHERE meeting_id = ? ORDER BY t0_ms, id")
            .bind(meeting_id)
            .fetch_all(&self.pool)
            .await?
            .iter()
            .map(segment_from)
            .collect()
    }

    /// Where the transcript ends, or 0 when there is none: of the whole
    /// meeting, or of one source.
    pub async fn last_segment_end(&self, meeting_id: &str, source: Option<&str>) -> Result<u32> {
        let end: Option<i64> = sqlx::query_scalar(
            "SELECT MAX(t1_ms) FROM segments WHERE meeting_id = ?1 AND (?2 IS NULL OR source = ?2)",
        )
        .bind(meeting_id)
        .bind(source)
        .fetch_one(&self.pool)
        .await?;
        Ok(end.unwrap_or(0).max(0) as u32)
    }

    /// Full-text search over the transcript: one meeting, or all of them.
    /// Best matches first.
    pub async fn search_segments(
        &self,
        meeting_id: Option<&str>,
        typed: &str,
        limit: u32,
    ) -> Result<Vec<SegmentFinal>> {
        let Some(query) = fts_query(typed) else {
            return Ok(Vec::new());
        };
        sqlx::query(
            "SELECT s.* FROM segments_fts f JOIN segments s ON s.rowid = f.rowid \
             WHERE segments_fts MATCH ?1 AND (?2 IS NULL OR s.meeting_id = ?2) \
             ORDER BY f.rank, s.t0_ms LIMIT ?3",
        )
        .bind(query)
        .bind(meeting_id)
        .bind(limit)
        .fetch_all(&self.pool)
        .await?
        .iter()
        .map(segment_from)
        .collect()
    }

    // ---- the map --------------------------------------------------------

    pub async fn map_load(&self, meeting_id: &str) -> Result<MapRows> {
        let topics = sqlx::query("SELECT * FROM topics WHERE meeting_id = ? ORDER BY id")
            .bind(meeting_id)
            .fetch_all(&self.pool)
            .await?
            .iter()
            .map(|row| {
                Ok(TopicRow {
                    id: row.try_get("id")?,
                    meeting_id: row.try_get("meeting_id")?,
                    parent_id: row.try_get("parent_id")?,
                    title: row.try_get("title")?,
                    kind: TopicKind::parse(row.try_get("kind")?)?,
                    order_key: row.try_get("order_key")?,
                    status: TopicStatus::parse(row.try_get("status")?)?,
                    off_agenda: row.try_get::<i64, _>("off_agenda")? != 0,
                    created_t_ms: ms(row, "created_t_ms")?,
                    pinned_t_ms: opt_ms(row, "pinned_t_ms")?,
                    revisited_t_ms: opt_ms(row, "revisited_t_ms")?,
                    scheduled_t_ms: opt_ms(row, "scheduled_t_ms")?,
                    segment_ids: list_from(row.try_get("segment_ids_json")?),
                })
            })
            .collect::<Result<Vec<_>>>()?;
        let cards = sqlx::query("SELECT * FROM cards WHERE meeting_id = ? ORDER BY id")
            .bind(meeting_id)
            .fetch_all(&self.pool)
            .await?
            .iter()
            .map(|row| {
                Ok(CardRow {
                    id: row.try_get("id")?,
                    meeting_id: row.try_get("meeting_id")?,
                    topic_id: row.try_get("topic_id")?,
                    kind: CardKind::parse(row.try_get("kind")?)?,
                    text: row.try_get("text")?,
                    owner: row.try_get("owner")?,
                    due_text: row.try_get("due_text")?,
                    segment_ids: list_from(row.try_get("segment_ids_json")?),
                    status: CardStatus::parse(row.try_get("status")?)?,
                    source: ChangeSource::parse(row.try_get("source")?)?,
                    created_t_ms: ms(row, "created_t_ms")?,
                    confirmed: row.try_get::<i64, _>("confirmed")? != 0,
                    order_key: row.try_get("order_key")?,
                })
            })
            .collect::<Result<Vec<_>>>()?;
        let suggestions = sqlx::query("SELECT * FROM suggestions WHERE meeting_id = ? ORDER BY id")
            .bind(meeting_id)
            .fetch_all(&self.pool)
            .await?
            .iter()
            .map(|row| {
                Ok(SuggestionRow {
                    id: row.try_get("id")?,
                    meeting_id: row.try_get("meeting_id")?,
                    kind: SuggestionKind::parse(row.try_get("kind")?)?,
                    payload_json: row.try_get("payload_json")?,
                    status: SuggestionStatus::parse(row.try_get("status")?)?,
                    created_t_ms: ms(row, "created_t_ms")?,
                })
            })
            .collect::<Result<Vec<_>>>()?;
        Ok(MapRows {
            topics,
            cards,
            suggestions,
        })
    }

    /// Saves one commit of the map. All of it lands, or none of it.
    pub async fn map_save(&self, patch: &MapPatch) -> Result<()> {
        let mut tx = self.pool.begin().await?;
        for topic in &patch.topics {
            sqlx::query(
                "INSERT OR REPLACE INTO topics (id, meeting_id, parent_id, title, kind, order_key, status, \
                 off_agenda, created_t_ms, pinned_t_ms, revisited_t_ms, scheduled_t_ms, segment_ids_json) \
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(&topic.id)
            .bind(&topic.meeting_id)
            .bind(&topic.parent_id)
            .bind(&topic.title)
            .bind(topic.kind.as_str())
            .bind(topic.order_key)
            .bind(topic.status.as_str())
            .bind(topic.off_agenda)
            .bind(topic.created_t_ms)
            .bind(topic.pinned_t_ms)
            .bind(topic.revisited_t_ms)
            .bind(topic.scheduled_t_ms)
            .bind(json_list(&topic.segment_ids))
            .execute(&mut *tx)
            .await?;
        }
        for card in &patch.cards {
            sqlx::query(
                "INSERT OR REPLACE INTO cards (id, meeting_id, topic_id, kind, text, owner, due_text, \
                 segment_ids_json, status, source, created_t_ms, confirmed, order_key) \
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(&card.id)
            .bind(&card.meeting_id)
            .bind(&card.topic_id)
            .bind(card.kind.as_str())
            .bind(&card.text)
            .bind(&card.owner)
            .bind(&card.due_text)
            .bind(json_list(&card.segment_ids))
            .bind(card.status.as_str())
            .bind(card.source.as_str())
            .bind(card.created_t_ms)
            .bind(card.confirmed)
            .bind(card.order_key)
            .execute(&mut *tx)
            .await?;
        }
        for suggestion in &patch.suggestions {
            sqlx::query(
                "INSERT OR REPLACE INTO suggestions (id, meeting_id, kind, payload_json, status, created_t_ms) \
                 VALUES (?, ?, ?, ?, ?, ?)",
            )
            .bind(&suggestion.id)
            .bind(&suggestion.meeting_id)
            .bind(suggestion.kind.as_str())
            .bind(&suggestion.payload_json)
            .bind(suggestion.status.as_str())
            .bind(suggestion.created_t_ms)
            .execute(&mut *tx)
            .await?;
        }
        for gone in &patch.deleted {
            let sql = match gone.entity {
                MapEntity::Topic => "DELETE FROM topics WHERE id = ?",
                MapEntity::Card => "DELETE FROM cards WHERE id = ?",
                MapEntity::Suggestion => "DELETE FROM suggestions WHERE id = ?",
            };
            sqlx::query(sql).bind(&gone.id).execute(&mut *tx).await?;
        }
        tx.commit().await
    }

    // ---- highlights -----------------------------------------------------

    pub async fn save_highlight(&self, highlight: &Highlight) -> Result<()> {
        sqlx::query(
            "INSERT OR REPLACE INTO highlights (id, meeting_id, t0_ms, t1_ms, label) VALUES (?, ?, ?, ?, ?)",
        )
        .bind(&highlight.id)
        .bind(&highlight.meeting_id)
        .bind(highlight.t0_ms)
        .bind(highlight.t1_ms)
        .bind(&highlight.label)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn delete_highlight(&self, id: &str) -> Result<()> {
        sqlx::query("DELETE FROM highlights WHERE id = ?")
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn highlights(&self, meeting_id: &str) -> Result<Vec<Highlight>> {
        sqlx::query("SELECT * FROM highlights WHERE meeting_id = ? ORDER BY t0_ms, id")
            .bind(meeting_id)
            .fetch_all(&self.pool)
            .await?
            .iter()
            .map(|row| {
                Ok(Highlight {
                    id: row.try_get("id")?,
                    meeting_id: row.try_get("meeting_id")?,
                    t0_ms: ms(row, "t0_ms")?,
                    t1_ms: ms(row, "t1_ms")?,
                    label: row.try_get("label")?,
                })
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn new_meeting(title: &str) -> NewMeeting {
        NewMeeting {
            title: title.to_string(),
            agenda: vec!["A".into(), "B".into(), "C".into()],
            mode: MeetingMode::Group,
            participants: vec!["Matt".into(), "Kabs".into()],
        }
    }

    fn segment(id: &str, meeting: &str, t0_ms: u32, text: &str) -> SegmentFinal {
        SegmentFinal {
            id: id.to_string(),
            meeting_id: meeting.to_string(),
            t0_ms,
            t1_ms: t0_ms + 2_000,
            speaker_label: "Room".to_string(),
            source: "laptop".to_string(),
            text: text.to_string(),
            confidence: 1.0,
        }
    }

    fn topic(id: &str, title: &str) -> TopicRow {
        TopicRow {
            id: id.to_string(),
            meeting_id: "m_1".to_string(),
            parent_id: None,
            title: title.to_string(),
            kind: TopicKind::Header,
            order_key: 0.0,
            status: TopicStatus::Active,
            off_agenda: false,
            created_t_ms: 0,
            pinned_t_ms: None,
            revisited_t_ms: None,
            scheduled_t_ms: None,
            segment_ids: vec![],
        }
    }

    fn card(id: &str, topic_id: &str, text: &str) -> CardRow {
        CardRow {
            id: id.to_string(),
            meeting_id: "m_1".to_string(),
            topic_id: topic_id.to_string(),
            kind: CardKind::Action,
            text: text.to_string(),
            owner: Some("Kabs".to_string()),
            due_text: Some("tomorrow".to_string()),
            segment_ids: vec!["s_1".into(), "s_2".into()],
            status: CardStatus::Accepted,
            source: ChangeSource::Engine,
            created_t_ms: 4_200,
            confirmed: false,
            order_key: 1.5,
        }
    }

    #[tokio::test]
    async fn a_meeting_is_created_started_and_ended() {
        let store = Store::in_memory().await.unwrap();
        let created = store
            .create_meeting("m_1", &new_meeting("Bench 60"))
            .await
            .unwrap();
        assert_eq!(created.title, "Bench 60");
        assert_eq!(created.agenda, ["A", "B", "C"]);
        assert_eq!(created.participants, ["Matt", "Kabs"]);
        assert!(!created.is_unfinished(), "not started yet");

        store.mark_started("m_1", true).await.unwrap();
        let started = store.meeting("m_1").await.unwrap().unwrap();
        assert!(started.is_unfinished());
        assert!(started.loopback);

        store.set_duration("m_1", 10_000).await.unwrap();
        store.mark_ended("m_1", 12_345).await.unwrap();
        let ended = store.meeting("m_1").await.unwrap().unwrap();
        assert!(!ended.is_unfinished());
        assert_eq!(ended.duration_ms, 12_345);
        assert_eq!(store.meeting("m_none").await.unwrap(), None);
    }

    #[tokio::test]
    async fn meetings_are_listed_newest_first() {
        let store = Store::in_memory().await.unwrap();
        store
            .create_meeting("m_1", &new_meeting("First"))
            .await
            .unwrap();
        store
            .create_meeting("m_2", &new_meeting("Second"))
            .await
            .unwrap();
        let titles: Vec<String> = store
            .meetings()
            .await
            .unwrap()
            .into_iter()
            .map(|meeting| meeting.title)
            .collect();
        assert_eq!(titles, ["Second", "First"]);
    }

    #[tokio::test]
    async fn the_transcript_comes_back_in_meeting_order() {
        let store = Store::in_memory().await.unwrap();
        store
            .create_meeting("m_1", &new_meeting("One"))
            .await
            .unwrap();
        store
            .insert_segment(&segment("s_2", "m_1", 5_000, "second"))
            .await
            .unwrap();
        store
            .insert_segment(&segment("s_1", "m_1", 1_000, "first"))
            .await
            .unwrap();
        let texts: Vec<String> = store
            .segments("m_1")
            .await
            .unwrap()
            .into_iter()
            .map(|segment| segment.text)
            .collect();
        assert_eq!(texts, ["first", "second"]);
        assert_eq!(store.last_segment_end("m_1", None).await.unwrap(), 7_000);
        assert_eq!(
            store.last_segment_end("m_1", Some("laptop")).await.unwrap(),
            7_000
        );
        assert_eq!(
            store.last_segment_end("m_1", Some("system")).await.unwrap(),
            0
        );
        assert_eq!(store.last_segment_end("m_none", None).await.unwrap(), 0);
    }

    #[tokio::test]
    async fn full_text_search_finds_words_and_prefixes() {
        let store = Store::in_memory().await.unwrap();
        store
            .create_meeting("m_1", &new_meeting("One"))
            .await
            .unwrap();
        store
            .create_meeting("m_2", &new_meeting("Two"))
            .await
            .unwrap();
        store
            .insert_segment(&segment(
                "s_1",
                "m_1",
                0,
                "The Guangzhou factory pushed the polo lead time",
            ))
            .await
            .unwrap();
        store
            .insert_segment(&segment(
                "s_2",
                "m_1",
                3_000,
                "Caps are fine, still twelve days",
            ))
            .await
            .unwrap();
        store
            .insert_segment(&segment(
                "s_3",
                "m_2",
                0,
                "Lead times from both factories by Friday",
            ))
            .await
            .unwrap();

        let ids = |found: Vec<SegmentFinal>| -> Vec<String> {
            let mut ids: Vec<String> = found.into_iter().map(|segment| segment.id).collect();
            ids.sort();
            ids
        };
        // Every word, any order; the last word may be unfinished.
        assert_eq!(
            ids(store
                .search_segments(Some("m_1"), "lead guang", 20)
                .await
                .unwrap()),
            ["s_1"]
        );
        // Across all meetings.
        assert_eq!(
            ids(store.search_segments(None, "lead", 20).await.unwrap()),
            ["s_1", "s_3"]
        );
        assert_eq!(
            ids(store.search_segments(None, "factor", 20).await.unwrap()),
            ["s_1", "s_3"]
        );
        // FTS syntax in what was typed is text, not a query.
        assert!(store
            .search_segments(None, "caps AND -days\"", 20)
            .await
            .unwrap()
            .is_empty());
        assert!(store
            .search_segments(None, "   ", 20)
            .await
            .unwrap()
            .is_empty());
        assert!(store
            .search_segments(None, "\"*", 20)
            .await
            .unwrap()
            .is_empty());
    }

    #[test]
    fn a_typed_search_becomes_a_quoted_prefix_query() {
        assert_eq!(
            fts_query("lead time").as_deref(),
            Some("\"lead\" \"time\"*")
        );
        assert_eq!(fts_query("  UDO ").as_deref(), Some("\"UDO\"*"));
        assert_eq!(fts_query(" - \" "), None);
    }

    #[tokio::test]
    async fn the_map_round_trips_and_a_commit_replaces_and_deletes() {
        let store = Store::in_memory().await.unwrap();
        store
            .create_meeting("m_1", &new_meeting("One"))
            .await
            .unwrap();
        assert_eq!(store.map_load("m_1").await.unwrap(), MapRows::default());

        let first = MapPatch {
            topics: vec![topic("t_1", "CLA quote"), topic("t_2", "Suppliers")],
            cards: vec![card("c_1", "t_1", "Call Ross")],
            suggestions: vec![SuggestionRow {
                id: "g_1".into(),
                meeting_id: "m_1".into(),
                kind: SuggestionKind::Pin,
                payload_json:
                    r#"{"kind":"pin","topic_id":"t_2","title":"Aircon","reason":"off agenda"}"#
                        .into(),
                status: SuggestionStatus::Open,
                created_t_ms: 9_000,
            }],
            deleted: vec![],
        };
        store.map_save(&first).await.unwrap();
        let loaded = store.map_load("m_1").await.unwrap();
        assert_eq!(loaded.topics, first.topics);
        assert_eq!(loaded.cards, first.cards);
        assert_eq!(loaded.suggestions, first.suggestions);

        // A later commit: the card moves and is edited, a topic goes.
        let mut moved = card("c_1", "t_2", "Call Ross tomorrow");
        moved.owner = None;
        store
            .map_save(&MapPatch {
                cards: vec![moved.clone()],
                deleted: vec![DeletedRow {
                    entity: MapEntity::Topic,
                    id: "t_1".into(),
                }],
                ..MapPatch::default()
            })
            .await
            .unwrap();
        let loaded = store.map_load("m_1").await.unwrap();
        assert_eq!(loaded.topics, [topic("t_2", "Suppliers")]);
        assert_eq!(loaded.cards, [moved]);
    }

    #[tokio::test]
    async fn a_commit_that_fails_saves_nothing() {
        let store = Store::in_memory().await.unwrap();
        store
            .create_meeting("m_1", &new_meeting("One"))
            .await
            .unwrap();
        let mut orphan = card("c_2", "t_1", "No such meeting");
        orphan.meeting_id = "m_missing".into();
        let result = store
            .map_save(&MapPatch {
                topics: vec![topic("t_1", "CLA quote")],
                cards: vec![orphan],
                ..MapPatch::default()
            })
            .await;
        assert!(result.is_err());
        assert_eq!(store.map_load("m_1").await.unwrap(), MapRows::default());
    }

    #[tokio::test]
    async fn highlights_are_saved_listed_and_deleted() {
        let store = Store::in_memory().await.unwrap();
        store
            .create_meeting("m_1", &new_meeting("One"))
            .await
            .unwrap();
        let highlight = Highlight {
            id: "h_1".into(),
            meeting_id: "m_1".into(),
            t0_ms: 61_000,
            t1_ms: 66_500,
            label: "The price".into(),
        };
        store.save_highlight(&highlight).await.unwrap();
        assert_eq!(store.highlights("m_1").await.unwrap(), [highlight]);
        store.delete_highlight("h_1").await.unwrap();
        assert!(store.highlights("m_1").await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn the_database_file_survives_a_reopen() {
        let path = std::env::temp_dir().join(format!("scribe-store-{}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        {
            let store = Store::open(&path).await.unwrap();
            store
                .create_meeting("m_1", &new_meeting("Kept"))
                .await
                .unwrap();
            store
                .insert_segment(&segment("s_1", "m_1", 0, "still here"))
                .await
                .unwrap();
            store.pool.close().await;
        }
        let store = Store::open(&path).await.unwrap();
        assert_eq!(store.meetings().await.unwrap().len(), 1);
        assert_eq!(
            store.search_segments(None, "still", 5).await.unwrap().len(),
            1
        );
        store.pool.close().await;
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
        }
    }
}
