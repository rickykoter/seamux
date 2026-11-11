//! The notification log: one JSONL line per banner seamux posts, and per
//! banner it chose not to show, so the board's footer, crew-digest and the
//! app's search can say what you were told (docs/adr: the log lives in
//! ~/.claude/crew/notifications; each sender logs where it posts).
//!
//! ```text
//! ~/.claude/crew/notifications/<YYYY-MM-DD>.jsonl   (one file per UTC day)
//! {"at": 1792627120000, "ws": "<uuid>", "pane": "<uuid>|", "kind": "waiting",
//!  "title": "api · waiting on you", "body": "Merge now?", "shown": true,
//!  "why": "", "source": "app"}
//! ```
//!
//! Written like state history (history.rs): a line is one `write` to a file
//! opened for append, kept under `LINE_MAX` bytes, so hooks and the app never
//! interleave and never lock. Readers skip what they cannot parse.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::history::{file_for, now_ms, LINE_MAX};
use crate::py::{days_from_civil, env_or, home};

/// Days of files kept.
pub const KEEP_DAYS: i64 = 14;
/// How far back the footer and the palette look.
pub const RECENT_HOURS: u64 = 5;
const DAY_MS: u64 = 86_400_000;

/// Why a banner was not shown.
pub const ON_SCREEN: &str = "on screen";
pub const NO_BANNER_ON_CMUX: &str = "no banner on cmux";

/// CREW_NOTIFICATIONS_DIR, else ~/.claude/crew/notifications (ADR 0024).
pub fn dir() -> PathBuf {
    env_or("CREW_NOTIFICATIONS_DIR").map(PathBuf::from).unwrap_or_else(|| home().join(".claude/crew/notifications"))
}

/// One banner, posted or skipped.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Entry {
    /// Milliseconds since the epoch.
    pub at: u64,
    /// The workspace a click goes to; "" when the sender knew none.
    pub ws: String,
    /// The pane a click shows; "" when the sender knew none.
    pub pane: String,
    /// waiting, reminder, finished, blocked, turn, limit, resume.
    pub kind: String,
    pub title: String,
    pub body: String,
    /// Whether a banner reached the screen.
    pub shown: bool,
    /// When not shown, why: `ON_SCREEN` or `NO_BANNER_ON_CMUX`.
    pub why: String,
    /// `hook` or `app`.
    pub source: String,
}

impl Entry {
    pub fn to_json(&self) -> Value {
        json!({"at": self.at, "ws": self.ws, "pane": self.pane, "kind": self.kind, "title": self.title,
               "body": self.body, "shown": self.shown, "why": self.why, "source": self.source})
    }

    pub fn from_json(v: &Value) -> Option<Entry> {
        let s = |k: &str| v.get(k).and_then(Value::as_str).unwrap_or("").to_string();
        let title = s("title");
        if title.is_empty() {
            return None;
        }
        Some(Entry {
            at: v.get("at")?.as_u64()?,
            ws: s("ws"),
            pane: s("pane"),
            kind: s("kind"),
            title,
            body: s("body"),
            shown: v.get("shown").and_then(Value::as_bool).unwrap_or(true),
            why: s("why"),
            source: s("source"),
        })
    }

    /// The line as written: the body cut, then the title, at a character
    /// boundary, until the whole line fits in LINE_MAX.
    pub fn line(&self) -> String {
        let mut e = self.clone();
        loop {
            let line = format!("{}\n", e.to_json());
            if line.len() <= LINE_MAX {
                return line;
            }
            // Escaping makes bytes per character vary: drop a quarter and retry.
            let cut = |s: &str| -> String { s.chars().take(s.chars().count() * 3 / 4).collect() };
            if !e.body.is_empty() {
                e.body = cut(&e.body);
            } else if e.title.chars().count() > 1 {
                e.title = cut(&e.title);
            } else {
                return line;
            }
        }
    }
}

/// The UTC day a file name names, as days since the epoch.
fn day_of(name: &str) -> Option<i64> {
    let stem = name.strip_suffix(".jsonl")?;
    let mut parts = stem.splitn(3, '-');
    let y: i64 = parts.next()?.parse().ok()?;
    let m: u32 = parts.next()?.parse().ok()?;
    let d: u32 = parts.next()?.parse().ok()?;
    if stem.len() != 10 || !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    Some(days_from_civil(y, m, d))
}

/// Append one entry to its day's file, making the directory when needed.
pub fn append(dir: &Path, e: &Entry) -> std::io::Result<()> {
    let line = e.line();
    if line.len() > LINE_MAX {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "notification line too long"));
    }
    fs::create_dir_all(dir)?;
    let mut f = OpenOptions::new().append(true).create(true).open(file_for(dir, e.at))?;
    f.write_all(line.as_bytes())
}

/// Log `e` now in the default directory, ignoring any failure: the log never
/// breaks the hook or the app that writes it. `at` 0 means now.
pub fn record(e: Entry) {
    record_in(&dir(), e)
}

/// `record` into `dir`.
pub fn record_in(dir: &Path, mut e: Entry) {
    if e.title.is_empty() {
        return;
    }
    if e.at == 0 {
        e.at = now_ms();
    }
    let _ = append(dir, &e);
}

/// Every entry at or after `since_ms`, oldest first. Unreadable files and
/// lines are skipped.
pub fn read_since(dir: &Path, since_ms: u64) -> Vec<Entry> {
    let first = (since_ms / DAY_MS) as i64;
    let mut files: Vec<(i64, PathBuf)> = fs::read_dir(dir)
        .map(|rd| {
            rd.filter_map(|d| d.ok())
                .filter_map(|d| day_of(&d.file_name().to_string_lossy()).filter(|day| *day >= first).map(|day| (day, d.path())))
                .collect()
        })
        .unwrap_or_default();
    files.sort();
    let mut out: Vec<Entry> = files
        .iter()
        .filter_map(|(_, p)| fs::read_to_string(p).ok())
        .flat_map(|text| {
            text.lines().filter_map(|l| serde_json::from_str::<Value>(l).ok()).filter_map(|v| Entry::from_json(&v)).collect::<Vec<_>>()
        })
        .filter(|e| e.at >= since_ms)
        .collect();
    // Writers in different processes may land a little out of order.
    out.sort_by_key(|e| e.at);
    out
}

/// The last `hours` before `now_ms`, newest first, at most `cap`.
pub fn recent(dir: &Path, now_ms: u64, hours: u64, cap: usize) -> Vec<Entry> {
    let mut v = read_since(dir, now_ms.saturating_sub(hours * 3_600_000));
    v.reverse();
    v.truncate(cap);
    v
}

/// Remove day files older than `keep_days` before `now_ms`'s day. Returns
/// how many went.
pub fn prune(dir: &Path, now_ms: u64, keep_days: i64) -> usize {
    let cutoff = (now_ms / DAY_MS) as i64 - keep_days;
    let Ok(rd) = fs::read_dir(dir) else { return 0 };
    rd.filter_map(|d| d.ok())
        .filter(|d| day_of(&d.file_name().to_string_lossy()).is_some_and(|day| day < cutoff))
        .filter(|d| fs::remove_file(d.path()).is_ok())
        .count()
}

// --- note files (ADR 0087) ------------------------------------------------------

/// A note older than this when the app reads it is dropped unposted: it was
/// written while no app ran, and its news is stale.
pub const NOTE_MAX_AGE_MS: u64 = 10 * 60_000;

/// One banner for the app's notifier to post: `note-<id>.json` in `dir`
/// (crew's state dir, beside bash-guard's blocked files). Written whole,
/// then renamed in, so the notifier never reads half a note.
pub fn write_note(dir: &Path, kind: &str, title: &str, body: &str, ws: &str, pane: &str) -> bool {
    use std::sync::atomic::{AtomicU64, Ordering};
    static N: AtomicU64 = AtomicU64::new(0);
    if title.is_empty() {
        return false;
    }
    let id = format!("{}-{}-{}", now_ms(), std::process::id(), N.fetch_add(1, Ordering::Relaxed));
    let note = json!({"kind": kind, "title": title, "body": body, "ws": ws, "pane": pane, "at": now_ms()});
    let _ = fs::create_dir_all(dir);
    prune_notes(dir, now_ms());
    crate::py::write_atomic(&dir.join(format!("note-{id}.json")), note.to_string().as_bytes()).is_ok()
}

/// Delete note files older than NOTE_MAX_AGE_MS, by their file time. With
/// the app on cmux nothing takes notes, so a writer keeps the pile bounded.
fn prune_notes(dir: &Path, now: u64) {
    let max = std::time::Duration::from_millis(NOTE_MAX_AGE_MS);
    let now = std::time::UNIX_EPOCH + std::time::Duration::from_millis(now);
    for e in fs::read_dir(dir).into_iter().flatten().flatten() {
        let name = e.file_name();
        let name = name.to_string_lossy();
        if !(name.starts_with("note-") && name.ends_with(".json")) {
            continue;
        }
        let old = e.metadata().and_then(|m| m.modified()).ok().and_then(|m| now.duration_since(m).ok()).is_some_and(|a| a > max);
        if old {
            let _ = fs::remove_file(e.path());
        }
    }
}

/// Every note file in `dir`, oldest first, each read and deleted once. A
/// note that cannot be read, or is older than NOTE_MAX_AGE_MS at `now`, is
/// deleted and not returned, so nothing is retried forever.
pub fn take_notes(dir: &Path, now: u64) -> Vec<Value> {
    let mut files: Vec<PathBuf> = fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with("note-") && n.ends_with(".json")))
        .collect();
    files.sort();
    files
        .into_iter()
        .filter_map(|p| {
            let v = fs::read_to_string(&p).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok());
            let _ = fs::remove_file(&p);
            let v = v?;
            let at = v.get("at").and_then(Value::as_u64).unwrap_or(0);
            (now.saturating_sub(at) <= NOTE_MAX_AGE_MS).then_some(v)
        })
        .collect()
}

/// Post a banner from a sender that is not a hook (crew-sync, the digest,
/// cachefacts): through cmux notify on the cmux backend, else as a note
/// file the seamux app's notifier posts and logs (ADR 0087). `kind` is
/// pr, digest or stale.
pub fn post(kind: &str, title: &str, body: &str, ws: &str) -> bool {
    let on_cmux = crate::backend::pick_kind(&|k| env_or(k), &|| cmux::Cmux::connect().is_ok()) == crate::backend::Kind::Cmux;
    if on_cmux {
        let Ok(c) = cmux::Cmux::connect() else { return false };
        return c
            .notify(&cmux::Notify {
                title: title.into(),
                subtitle: Some(format!("crew:{}", if kind == "stale" { "blocked" } else { kind })),
                body: Some(body.into()),
                workspace: Some(ws.to_string()).filter(|w| !w.is_empty()),
            })
            .is_ok();
    }
    write_note(&crate::home::home_cache(), kind, title, body, ws, "")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("crew-notes-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        d
    }

    fn entry(at: u64, title: &str) -> Entry {
        Entry { at, ws: "WS".into(), pane: "P".into(), kind: "waiting".into(), title: title.into(), body: "b".into(),
                shown: true, why: String::new(), source: "app".into() }
    }

    #[test]
    fn append_then_read_in_order_across_days_skipping_junk() {
        let d = tmp("rw");
        let base = days_from_civil(2026, 11, 6) as u64 * DAY_MS;
        append(&d, &entry(base + DAY_MS + 5, "c")).unwrap();
        append(&d, &entry(base + 10, "a")).unwrap();
        append(&d, &entry(base + DAY_MS + 1, "b")).unwrap();
        let mut f = OpenOptions::new().append(true).open(file_for(&d, base)).unwrap();
        f.write_all(b"not json\n{\"at\":1,\"title\":\"\"}\n").unwrap();
        fs::write(d.join("notes.txt"), "junk").unwrap();
        let got: Vec<String> = read_since(&d, base).iter().map(|e| e.title.clone()).collect();
        assert_eq!(got, vec!["a", "b", "c"]);
        let newest: Vec<String> = recent(&d, base + DAY_MS + 6, 24, 2).iter().map(|e| e.title.clone()).collect();
        assert_eq!(newest, vec!["c", "b"]);
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn a_skipped_banner_round_trips_with_its_reason() {
        let mut e = entry(7, "api · done");
        e.shown = false;
        e.why = ON_SCREEN.into();
        let back = Entry::from_json(&serde_json::from_str(e.line().trim_end()).unwrap()).unwrap();
        assert_eq!(back, e);
    }

    #[test]
    fn a_long_body_then_title_is_cut_to_fit_one_write() {
        let mut e = entry(1, &"t".repeat(900));
        e.body = "é".repeat(2000);
        let line = e.line();
        assert!(line.len() <= LINE_MAX, "{}", line.len());
        let v: Value = serde_json::from_str(line.trim_end()).unwrap();
        assert_eq!(v["body"], "");
        assert!(!v["title"].as_str().unwrap().is_empty());
    }

    #[test]
    fn record_fills_in_now_and_drops_an_untitled_entry() {
        let d = tmp("rec");
        record_in(&d, Entry { title: String::new(), ..entry(0, "") });
        assert!(!d.exists());
        record_in(&d, entry(0, "x"));
        let got = read_since(&d, 0);
        assert_eq!(got.len(), 1);
        assert!(got[0].at > 0);
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn prune_keeps_the_last_days() {
        let d = tmp("prune");
        let today = days_from_civil(2026, 11, 7) as u64 * DAY_MS;
        for back in [0u64, 13, 14, 15, 40] {
            append(&d, &entry(today - back * DAY_MS, "x")).unwrap();
        }
        assert_eq!(prune(&d, today, KEEP_DAYS), 2);
        assert_eq!(fs::read_dir(&d).unwrap().count(), 3);
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn a_note_is_read_once_and_a_stale_or_bad_one_is_dropped() {
        let d = std::env::temp_dir().join(format!("notes-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        assert!(write_note(&d, "pr", "api", "#12 CI red: build", "W", ""));
        assert!(!write_note(&d, "pr", "", "no title", "W", ""));
        fs::write(d.join("note-0-bad.json"), "{not json").unwrap();
        fs::write(d.join("note-1-old.json"), json!({"kind": "pr", "title": "old", "at": 1}).to_string()).unwrap();
        let got = take_notes(&d, now_ms());
        assert_eq!(got.len(), 1);
        assert_eq!((got[0]["kind"].as_str(), got[0]["title"].as_str(), got[0]["ws"].as_str()), (Some("pr"), Some("api"), Some("W")));
        assert!(take_notes(&d, now_ms()).is_empty());
        assert_eq!(fs::read_dir(&d).unwrap().count(), 0);
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn a_write_prunes_notes_nobody_took() {
        let d = std::env::temp_dir().join(format!("notes-prune-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        let old = d.join("note-1-old.json");
        fs::write(&old, "{}").unwrap();
        let an_hour_ago = std::time::SystemTime::now() - std::time::Duration::from_secs(3600);
        fs::File::options().write(true).open(&old).unwrap().set_modified(an_hour_ago).unwrap();
        fs::write(d.join("other.json"), "{}").unwrap();
        assert!(write_note(&d, "digest", "t", "b", "W", ""));
        assert!(!old.exists());
        assert_eq!(fs::read_dir(&d).unwrap().count(), 2);
        let _ = fs::remove_dir_all(&d);
    }
}
