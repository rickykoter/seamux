//! State history: one JSONL line per change in an agent's state, so a view
//! can show who waited and for how long, even across a time the app was
//! closed. Hooks write the lines they see (ask, answered, prompt, stop...),
//! the app's poll writes the ones no hook sees.
//!
//! ```text
//! ~/.claude/crew/history/<YYYY-MM-DD>.jsonl   (one file per UTC day)
//! {"at": 1792627120000, "ws": "<uuid>", "surface": "<uuid>|", "state": "needs_input",
//!  "source": "hook|poll", "detail": "ask"}
//! ```
//!
//! A line is one `write` to a file opened for append and kept under
//! `LINE_MAX` bytes, so writers in several processes never interleave and
//! never take a lock. Readers skip any line they cannot parse. Files older
//! than `KEEP_DAYS` are removed by `prune`.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::py::{civil_from_days, days_from_civil, env_or, home};

/// Days of files kept.
pub const KEEP_DAYS: i64 = 14;
/// The most bytes one line may take, newline included: under PIPE_BUF, so an
/// append is one atomic write on macOS and Linux.
pub const LINE_MAX: usize = 512;
const DAY_MS: u64 = 86_400_000;

/// The states a line may name: the wall's own words for an agent pane.
pub const STATES: [&str; 4] = ["working", "needs_input", "idle", "ended"];

/// CREW_HISTORY_DIR, else ~/.claude/crew/history (ADR 0024: durable crew
/// state lives in ~/.claude/crew).
pub fn dir() -> PathBuf {
    env_or("CREW_HISTORY_DIR").map(PathBuf::from).unwrap_or_else(|| home().join(".claude/crew/history"))
}

/// One change of state.
#[derive(Clone, Debug, PartialEq)]
pub struct Entry {
    /// Milliseconds since the epoch.
    pub at: u64,
    /// The cmux workspace UUID.
    pub ws: String,
    /// The pane's surface UUID, when the writer knew it.
    pub surface: String,
    /// One of `STATES`.
    pub state: String,
    /// `hook` or `poll`.
    pub source: String,
    /// What caused it: the hook event, or a short reason.
    pub detail: String,
}

impl Entry {
    fn to_json(&self) -> Value {
        json!({"at": self.at, "ws": self.ws, "surface": self.surface, "state": self.state,
               "source": self.source, "detail": self.detail})
    }

    fn from_json(v: &Value) -> Option<Entry> {
        let s = |k: &str| v.get(k).and_then(Value::as_str).map(str::to_string);
        let state = s("state")?;
        if !STATES.contains(&state.as_str()) {
            return None;
        }
        Some(Entry {
            at: v.get("at")?.as_u64()?,
            ws: s("ws").filter(|w| !w.is_empty())?,
            surface: s("surface").unwrap_or_default(),
            state,
            source: s("source").unwrap_or_default(),
            detail: s("detail").unwrap_or_default(),
        })
    }

    /// The line as written: the detail cut, at a character boundary, until
    /// the whole line fits in LINE_MAX.
    pub fn line(&self) -> String {
        let mut e = self.clone();
        loop {
            let line = format!("{}\n", e.to_json());
            if line.len() <= LINE_MAX || e.detail.is_empty() {
                return line;
            }
            // Escaping makes bytes per character vary: drop a quarter and retry.
            let n = e.detail.chars().count();
            e.detail = e.detail.chars().take(n * 3 / 4).collect();
        }
    }
}

/// Milliseconds since the epoch now.
pub fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// The UTC day file a moment falls in.
pub fn file_for(dir: &Path, at_ms: u64) -> PathBuf {
    let (y, m, d) = civil_from_days((at_ms / DAY_MS) as i64);
    dir.join(format!("{y:04}-{m:02}-{d:02}.jsonl"))
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
/// A line longer than LINE_MAX even with no detail is refused.
pub fn append(dir: &Path, e: &Entry) -> std::io::Result<()> {
    let line = e.line();
    if line.len() > LINE_MAX {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "history line too long"));
    }
    fs::create_dir_all(dir)?;
    let mut f = OpenOptions::new().append(true).create(true).open(file_for(dir, e.at))?;
    f.write_all(line.as_bytes())
}

/// Append to the default directory, ignoring any failure: history never
/// breaks the hook or poll that writes it.
pub fn record(ws: &str, surface: &str, state: &str, source: &str, detail: &str) {
    record_in(&dir(), ws, surface, state, source, detail)
}

/// `record` into `dir`.
pub fn record_in(dir: &Path, ws: &str, surface: &str, state: &str, source: &str, detail: &str) {
    if ws.is_empty() || !STATES.contains(&state) {
        return;
    }
    let e = Entry {
        at: now_ms(),
        ws: ws.into(),
        surface: surface.into(),
        state: state.into(),
        source: source.into(),
        detail: detail.into(),
    };
    let _ = append(dir, &e);
}

/// Every entry at or after `since_ms`, oldest first, from the day files
/// that can hold one. Unreadable files and lines are skipped.
pub fn read_since(dir: &Path, since_ms: u64) -> Vec<Entry> {
    let first = (since_ms / DAY_MS) as i64;
    let mut files: Vec<(i64, PathBuf)> = fs::read_dir(dir)
        .map(|rd| {
            rd.filter_map(|d| d.ok())
                .filter_map(|d| {
                    let name = d.file_name().to_string_lossy().into_owned();
                    day_of(&name).filter(|day| *day >= first).map(|day| (day, d.path()))
                })
                .collect()
        })
        .unwrap_or_default();
    files.sort();
    let mut out: Vec<Entry> = files
        .iter()
        .filter_map(|(_, p)| fs::read_to_string(p).ok())
        .flat_map(|text| {
            text.lines()
                .filter_map(|l| serde_json::from_str::<Value>(l).ok())
                .filter_map(|v| Entry::from_json(&v))
                .collect::<Vec<_>>()
        })
        .filter(|e| e.at >= since_ms)
        .collect();
    // Writers in different processes may land a little out of order.
    out.sort_by_key(|e| e.at);
    out
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

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("crew-history-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        d
    }

    fn entry(at: u64, state: &str) -> Entry {
        Entry { at, ws: "WS".into(), surface: "S".into(), state: state.into(), source: "hook".into(), detail: "ask".into() }
    }

    #[test]
    fn day_files_are_utc_dates() {
        let d = Path::new("/h");
        assert_eq!(file_for(d, 0), d.join("1970-01-01.jsonl"));
        // 2026-10-21T23:59:59.999Z and the next millisecond.
        let late = (days_from_civil(2026, 10, 21) as u64 + 1) * DAY_MS - 1;
        assert_eq!(file_for(d, late), d.join("2026-10-21.jsonl"));
        assert_eq!(file_for(d, late + 1), d.join("2026-10-22.jsonl"));
        assert_eq!(day_of("2026-10-21.jsonl"), Some(days_from_civil(2026, 10, 21)));
        assert_eq!(day_of("notes.jsonl"), None);
        assert_eq!(day_of("2026-13-01.jsonl"), None);
    }

    #[test]
    fn append_then_read_in_order_across_days() {
        let d = tmp("rw");
        let base = days_from_civil(2026, 10, 20) as u64 * DAY_MS;
        append(&d, &entry(base + DAY_MS + 5, "idle")).unwrap();
        append(&d, &entry(base + 10, "working")).unwrap();
        append(&d, &entry(base + DAY_MS + 1, "needs_input")).unwrap();
        fs::write(d.join("2026-10-21.jsonl.bak"), "junk").unwrap();
        let mut f = OpenOptions::new().append(true).open(file_for(&d, base)).unwrap();
        f.write_all(b"not json\n{\"at\":1,\"ws\":\"W\",\"state\":\"bogus\"}\n").unwrap();
        let got: Vec<String> = read_since(&d, base).iter().map(|e| e.state.clone()).collect();
        assert_eq!(got, vec!["working", "needs_input", "idle"]);
        assert_eq!(read_since(&d, base + DAY_MS).len(), 2);
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn a_long_detail_is_cut_to_fit_one_write() {
        let mut e = entry(1, "needs_input");
        e.detail = "é".repeat(2000);
        let line = e.line();
        assert!(line.len() <= LINE_MAX, "{}", line.len());
        assert!(line.ends_with('\n'));
        assert!(serde_json::from_str::<Value>(line.trim_end()).is_ok());
    }

    #[test]
    fn prune_keeps_the_last_days() {
        let d = tmp("prune");
        let today = days_from_civil(2026, 10, 21) as u64 * DAY_MS;
        for back in [0u64, 13, 14, 15, 40] {
            append(&d, &entry(today - back * DAY_MS, "idle")).unwrap();
        }
        assert_eq!(prune(&d, today, KEEP_DAYS), 2);
        assert_eq!(fs::read_dir(&d).unwrap().count(), 3);
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn record_ignores_unknown_states_and_no_workspace() {
        let d = tmp("record");
        record_in(&d, "", "S", "idle", "hook", "stop");
        record_in(&d, "WS", "S", "sleeping", "hook", "stop");
        assert!(!d.exists());
        record_in(&d, "WS", "S", "idle", "hook", "stop");
        assert_eq!(read_since(&d, 0)[0].detail, "stop");
        let _ = fs::remove_dir_all(&d);
    }
}
