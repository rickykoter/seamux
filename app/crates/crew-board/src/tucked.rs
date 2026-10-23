//! Muted and tucked worktrees on the board: the app's tucked.json (written by
//! seamux-app's tuck.rs), read here so the Dock shows what the app's views
//! show. A tucked row goes to the Dock's collapsed "tucked" section; a muted
//! one is dimmed until it needs you. The board only reads the file.

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

/// worktree root -> "mute" | "tuck", from `text` (tucked.json's contents).
pub fn levels(text: &str) -> HashMap<String, String> {
    let Ok(v) = serde_json::from_str::<Value>(text) else { return HashMap::new() };
    v.get("entries")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|e| {
            let path = e.get("path")?.as_str()?;
            let level = e.get("level")?.as_str()?;
            matches!(level, "mute" | "tuck").then(|| (path.to_string(), level.to_string()))
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

/// Mark each row whose worktree is muted or tucked: `"tuck": "mute"|"tuck"`.
pub fn mark(rows: &mut [Value], levels: &HashMap<String, String>, root: impl Fn(&str) -> String) {
    if levels.is_empty() {
        return;
    }
    for r in rows.iter_mut() {
        let Some(cwd) = r.get("cwd").and_then(Value::as_str).filter(|c| !c.is_empty()) else { continue };
        if let Some(level) = levels.get(&root(cwd)) {
            if let Some(o) = r.as_object_mut() {
                o.insert("tuck".into(), Value::String(level.clone()));
            }
        }
    }
}

/// The live store, laid over `rows`.
pub fn mark_live(rows: &mut [Value]) {
    let text = std::fs::read_to_string(file()).unwrap_or_default();
    mark(rows, &levels(&text), root_of);
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn rows_in_a_quieted_worktree_carry_its_level() {
        let lv = levels(r#"{"version":1,"entries":[{"path":"/w/a","level":"tuck","at":1,"name":"a"},{"path":"/w/b","level":"mute","at":1},{"path":"/w/c","level":"loud"}]}"#);
        assert_eq!(lv.len(), 2);
        let mut rows = vec![json!({"id": "1", "cwd": "/w/a/sub"}), json!({"id": "2", "cwd": "/w/b"}), json!({"id": "3", "cwd": "/w/z"}), json!({"id": "4"})];
        mark(&mut rows, &lv, |c| if c.starts_with("/w/a") { "/w/a".into() } else { c.into() });
        let got: Vec<_> = rows.iter().map(|r| r.get("tuck").and_then(Value::as_str).unwrap_or("")).collect();
        assert_eq!(got, vec!["tuck", "mute", "", ""]);
        assert!(levels("not json").is_empty());
    }
}
