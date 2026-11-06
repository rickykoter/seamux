//! Muted, snoozed and tucked worktrees on the board: the app's tucked.json
//! (written by seamux-app's tuck.rs), read here so the Dock shows what the
//! app's views show. A tucked row goes to the Dock's collapsed "tucked"
//! section; a muted one is dimmed until it needs you; a snoozed one carries
//! its `until` and is dropped here once that passes, before the app wakes it
//! in the store. The board only reads the file.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime};

use serde_json::Value;

/// ~/.claude/crew/tucked.json (CREW_DURABLE_DIR overrides), as tuck.rs keeps it.
pub fn file() -> PathBuf {
    PathBuf::from(crew_store::Paths::from_env().crew_home).join("tucked.json")
}

/// Its mtime, for the feed's change watch.
pub fn stamp() -> Option<SystemTime> {
    std::fs::metadata(file()).and_then(|m| m.modified()).ok()
}

/// How a worktree is quieted: "mute" | "snooze" | "tuck", and when a snooze
/// ends (ms since the epoch).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Quiet {
    pub level: String,
    pub until: Option<u64>,
}

/// worktree root -> its level, from `text` (tucked.json's contents), at
/// `now_ms`: a snooze without an end, or whose end has passed, is left out.
pub fn levels(text: &str, now_ms: u64) -> HashMap<String, Quiet> {
    let Ok(v) = serde_json::from_str::<Value>(text) else { return HashMap::new() };
    v.get("entries")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|e| {
            let path = e.get("path")?.as_str()?;
            let level = e.get("level")?.as_str()?;
            let until = match level {
                "mute" | "tuck" => None,
                "snooze" => Some(e.get("until")?.as_u64().filter(|u| *u > now_ms)?),
                _ => return None,
            };
            Some((path.to_string(), Quiet { level: level.to_string(), until }))
        })
        .collect()
}

static ROOTS: Mutex<Option<HashMap<String, (String, Instant)>>> = Mutex::new(None);
const ROOT_TTL: Duration = Duration::from_secs(300);

/// The worktree a row's cwd is in, keyed as tuck.rs keys it: git's top level
/// (else the cwd), through crew_store::wskey. Cached per cwd.
fn root_of(cwd: &str) -> String {
    if let Some((r, at)) = ROOTS.lock().unwrap_or_else(|p| p.into_inner()).as_ref().and_then(|m| m.get(cwd)) {
        if at.elapsed() < ROOT_TTL {
            return r.clone();
        }
    }
    let run = crew_core::py::run("git", &["-C", cwd, "rev-parse", "--show-toplevel"], Duration::from_secs(3));
    let top = run
        .as_ref()
        .filter(|(code, _, _)| *code == 0)
        .map(|(_, out, _)| out.trim().to_string())
        .filter(|t| !t.is_empty() && std::path::Path::new(t).is_dir());
    let root = crew_store::wskey(top.as_deref().unwrap_or(cwd));
    if run.is_some() {
        ROOTS.lock().unwrap_or_else(|p| p.into_inner()).get_or_insert_with(HashMap::new).insert(cwd.to_string(), (root.clone(), Instant::now()));
    }
    root
}

/// Mark each row whose worktree is quieted: `"tuck": "mute"|"snooze"|"tuck"`,
/// and on a snoozed row `"until"` (ms since the epoch).
pub fn mark(rows: &mut [Value], levels: &HashMap<String, Quiet>, root: impl Fn(&str) -> String) {
    if levels.is_empty() {
        return;
    }
    for r in rows.iter_mut() {
        let Some(cwd) = r.get("cwd").and_then(Value::as_str).filter(|c| !c.is_empty()) else { continue };
        if let Some(q) = levels.get(&root(cwd)) {
            if let Some(o) = r.as_object_mut() {
                o.insert("tuck".into(), Value::String(q.level.clone()));
                if let Some(u) = q.until {
                    o.insert("until".into(), Value::from(u));
                }
            }
        }
    }
}

/// A row that needs you (the attend tier) breaks its snooze: it loses its
/// snooze mark and shows in its tier. Any other tier waits out the snooze.
pub fn break_snoozes(rows: &mut [Value]) {
    for r in rows.iter_mut() {
        let snoozed = r.get("tuck").and_then(Value::as_str) == Some("snooze");
        if snoozed && r.get("kind").and_then(Value::as_str) == Some("attend") {
            if let Some(o) = r.as_object_mut() {
                o.remove("tuck");
                o.remove("until");
            }
        }
    }
}

/// The live store, laid over `rows`.
pub fn mark_live(rows: &mut [Value]) {
    let text = std::fs::read_to_string(file()).unwrap_or_default();
    mark(rows, &levels(&text, crew_core::history::now_ms()), root_of);
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn rows_in_a_quieted_worktree_carry_its_level() {
        let lv = levels(r#"{"version":1,"entries":[{"path":"/w/a","level":"tuck","at":1,"name":"a"},{"path":"/w/b","level":"mute","at":1},{"path":"/w/c","level":"loud"}]}"#, 0);
        assert_eq!(lv.len(), 2);
        let mut rows = vec![json!({"id": "1", "cwd": "/w/a/sub"}), json!({"id": "2", "cwd": "/w/b"}), json!({"id": "3", "cwd": "/w/z"}), json!({"id": "4"})];
        mark(&mut rows, &lv, |c| if c.starts_with("/w/a") { "/w/a".into() } else { c.into() });
        let got: Vec<_> = rows.iter().map(|r| r.get("tuck").and_then(Value::as_str).unwrap_or("")).collect();
        assert_eq!(got, vec!["tuck", "mute", "", ""]);
        assert!(levels("not json", 0).is_empty());
    }

    #[test]
    fn a_snoozed_row_carries_its_end_until_it_passes() {
        let text = r#"{"version":1,"entries":[{"path":"/w/a","level":"snooze","at":1,"until":100},{"path":"/w/b","level":"snooze","at":1},{"path":"/w/c","level":"snooze","at":1,"until":50}]}"#;
        let lv = levels(text, 50);
        assert_eq!(lv.keys().collect::<Vec<_>>(), vec!["/w/a"], "no end, or an end passed: left out");
        let mut rows = vec![json!({"id": "1", "cwd": "/w/a"}), json!({"id": "2", "cwd": "/w/c"})];
        mark(&mut rows, &lv, |c| c.into());
        assert_eq!((rows[0]["tuck"].as_str(), rows[0]["until"].as_u64()), (Some("snooze"), Some(100)));
        assert!(rows[1].get("tuck").is_none() && rows[1].get("until").is_none());
        assert!(levels(text, 100).is_empty(), "at its end it is over");
    }

    #[test]
    fn a_row_that_needs_you_breaks_its_snooze_and_a_broken_one_waits() {
        let mut rows = vec![
            json!({"id": "1", "kind": "attend", "tuck": "snooze", "until": 9}),
            json!({"id": "2", "kind": "wilt", "tuck": "snooze", "until": 9}),
            json!({"id": "3", "kind": "attend", "tuck": "mute"}),
        ];
        break_snoozes(&mut rows);
        assert!(rows[0].get("tuck").is_none() && rows[0].get("until").is_none());
        assert_eq!((rows[1]["tuck"].as_str(), rows[1]["until"].as_u64()), (Some("snooze"), Some(9)));
        assert_eq!(rows[2]["tuck"].as_str(), Some("mute"));
    }
}
